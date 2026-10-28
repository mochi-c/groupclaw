/** Doctor checks and repairs for workspace memory files and legacy workspace hints. */
import fs from "node:fs";
import path from "node:path";
import { readRegularFile } from "@openclaw/fs-safe/advanced";
import { safeStatSync } from "@openclaw/fs-safe/path";
import { note } from "../../packages/terminal-core/src/note.js";
import { DEFAULT_AGENTS_FILENAME } from "../agents/workspace.js";
import { safeRealpathSync } from "../infra/boundary-path.js";
import { formatErrorMessage } from "../infra/errors.js";
import { findGitRoot } from "../infra/git-root.js";
import {
  LEGACY_UPPERCASE_ROOT_MEMORY_FILENAME,
  LEGACY_ROOT_MEMORY_FILENAME,
  resolveCanonicalWorkspaceMemoryPath,
  resolveLegacyUppercaseRootMemoryPath,
  resolveLegacyRootMemoryPath,
  resolveRootMemoryRepairDir,
} from "../memory/root-memory-files.js";
import { WORKSPACE_MEMORY_RELATIVE_PATH } from "../memory/scoped-memory.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

// AGENTS.md is only scanned for a memory-system reference; a small cap prevents
// a huge file from being buffered just for one regex check.
const AGENTS_MD_MAX_BYTES = 1024 * 1024;
// Root memory files are markdown journals; 8 MiB is generous while preventing
// a runaway file from OOMing the migration path.
const ROOT_MEMORY_FILE_MAX_BYTES = 8 * 1024 * 1024;

export const MEMORY_SYSTEM_PROMPT = [
  "Memory system not found in workspace.",
  "Paste this into your agent:",
  "",
  "Install the memory system by applying:",
  "https://github.com/openclaw/openclaw/commit/9ffea23f31ca1df5183b25668f8f814bee0fb34e",
  "https://github.com/openclaw/openclaw/commit/7d1fee70e76f2f634f1b41fca927ee663914183a",
].join("\n");

/** Returns the workspace git-backup tip when the workspace exists but is not a git repo. */
export function collectWorkspaceBackupTip(workspaceDir: string): string | null {
  if (!safeStatSync(workspaceDir)?.isDirectory()) {
    return null;
  }
  const resolvedWorkspaceDir = safeRealpathSync(workspaceDir);
  if (!resolvedWorkspaceDir || findGitRoot(resolvedWorkspaceDir)) {
    return null;
  }
  return "- Tip: back up the agent workspace in a private git repo; keep ~/.openclaw out of git (credentials, sessions). Details: /concepts/agent-workspace#git-backup-recommended-private";
}

export async function shouldSuggestMemorySystem(workspaceDir: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(resolveCanonicalWorkspaceMemoryPath(workspaceDir));
    if (stat.isFile()) {
      return false;
    }
  } catch {
    // keep scanning
  }

  const agentsPath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);
  try {
    // Workspace instruction files may intentionally be symlinked. Resolve the
    // final target first, then keep the descriptor-backed read bounded.
    const resolvedAgentsPath = await fs.promises.realpath(agentsPath);
    const { buffer } = await readRegularFile({
      filePath: resolvedAgentsPath,
      maxBytes: AGENTS_MD_MAX_BYTES,
    });
    if (buffer.toString("utf-8").includes(WORKSPACE_MEMORY_RELATIVE_PATH)) {
      return false;
    }
  } catch {
    // no AGENTS.md or unreadable; treat as missing memory guidance
  }

  return true;
}

type RootMemoryFilesDetection = {
  workspaceDir: string;
  canonicalPath: string;
  canonicalExists: boolean;
  canonicalBytes?: number;
  legacyFiles: Array<{ name: string; path: string; bytes?: number }>;
};

type RootMemoryStatResult = {
  exists: boolean;
  bytes?: number;
};

async function statIfExists(filePath: string): Promise<RootMemoryStatResult> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      return { exists: false };
    }
    return { exists: true, bytes: stat.size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { exists: false };
    }
    throw err;
  }
}

async function listWorkspaceEntries(workspaceDir: string): Promise<Set<string>> {
  try {
    return new Set(await fs.promises.readdir(workspaceDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return new Set<string>();
    }
    throw err;
  }
}

async function detectRootMemoryFiles(workspaceDir: string): Promise<RootMemoryFilesDetection> {
  const resolvedWorkspace = path.resolve(workspaceDir);
  const canonicalPath = resolveCanonicalWorkspaceMemoryPath(resolvedWorkspace);
  const entries = await listWorkspaceEntries(resolvedWorkspace);
  const canonical = await statIfExists(canonicalPath);
  const legacyCandidates = [
    {
      name: LEGACY_UPPERCASE_ROOT_MEMORY_FILENAME,
      path: resolveLegacyUppercaseRootMemoryPath(resolvedWorkspace),
    },
    { name: LEGACY_ROOT_MEMORY_FILENAME, path: resolveLegacyRootMemoryPath(resolvedWorkspace) },
  ];
  const legacyFiles = (
    await Promise.all(
      legacyCandidates.map(async (candidate) => {
        if (!entries.has(candidate.name)) {
          return null;
        }
        const result = await statIfExists(candidate.path);
        if (!result.exists) {
          return null;
        }
        const legacy: RootMemoryFilesDetection["legacyFiles"][number] = {
          name: candidate.name,
          path: candidate.path,
        };
        if (typeof result.bytes === "number") {
          legacy.bytes = result.bytes;
        }
        return legacy;
      }),
    )
  ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  return {
    workspaceDir: resolvedWorkspace,
    canonicalPath,
    canonicalExists: canonical.exists,
    legacyFiles,
    ...(typeof canonical.bytes === "number" ? { canonicalBytes: canonical.bytes } : {}),
  };
}

function formatBytes(bytes?: number): string {
  return typeof bytes === "number" ? `${bytes} bytes` : "size unknown";
}

function formatRootMemoryFilesWarning(detection: RootMemoryFilesDetection): string | null {
  if (detection.legacyFiles.length === 0) {
    return null;
  }
  return [
    "Legacy Workspace memory files detected:",
    `- canonical: ${shortenHomePath(detection.canonicalPath)} (${formatBytes(detection.canonicalBytes)})`,
    ...detection.legacyFiles.map(
      (legacy) => `- legacy: ${shortenHomePath(legacy.path)} (${formatBytes(legacy.bytes)})`,
    ),
    `OpenClaw now uses ${WORKSPACE_MEMORY_RELATIVE_PATH} as Workspace-global memory.`,
    `Run "openclaw doctor --fix" to migrate legacy root memory with backups.`,
  ].join("\n");
}

type RootMemoryMigrationResult = {
  changed: boolean;
  canonicalPath: string;
  legacyPaths: string[];
  mergedLegacyPaths: string[];
  archivedLegacyPaths: string[];
  /** True when the repair was skipped because a file exceeded the safe read limit. */
  readLimitExceeded?: boolean;
  /** True when the repair was skipped because a file could not be read. */
  readError?: boolean;
  /** True when the legacy file could not be archived atomically. */
  archiveError?: boolean;
};

async function moveLegacyRootMemoryFileToArchive(params: {
  workspaceDir: string;
  legacyPath: string;
}): Promise<string> {
  const repairDir = resolveRootMemoryRepairDir(params.workspaceDir);
  await fs.promises.mkdir(repairDir, { recursive: true });
  const archiveDir = path.join(
    repairDir,
    new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"),
  );
  await fs.promises.mkdir(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, path.basename(params.legacyPath));
  // Source and repair archive live under one workspace. If a mounted file makes
  // this cross-device, fail before mutation instead of copying an unbounded file.
  await fs.promises.rename(params.legacyPath, archivePath);
  return archivePath;
}

function buildMergedLegacyRootMemorySection(params: {
  legacyName: string;
  legacyText: string;
  archivedLegacyPath: string;
}): string {
  return [
    "",
    `## Imported From Legacy Root ${params.legacyName}`,
    "",
    `<!-- openclaw-root-memory-merge source=${params.legacyName} archived=${params.archivedLegacyPath} -->`,
    `This content came from legacy root \`${params.legacyName}\` during migration to \`${WORKSPACE_MEMORY_RELATIVE_PATH}\`.`,
    "",
    params.legacyText.trim(),
    "",
  ].join("\n");
}

/** Archives and merges a legacy root memory file into canonical memory. */
async function migrateLegacyRootMemoryFiles(
  workspaceDir: string,
): Promise<RootMemoryMigrationResult> {
  const detection = await detectRootMemoryFiles(workspaceDir);
  const unchanged: RootMemoryMigrationResult = {
    changed: false,
    canonicalPath: detection.canonicalPath,
    legacyPaths: detection.legacyFiles.map((entry) => entry.path),
    mergedLegacyPaths: [],
    archivedLegacyPaths: [],
  };
  if (detection.legacyFiles.length === 0) {
    return unchanged;
  }
  const skippedForReadFailure = (err: unknown): RootMemoryMigrationResult => {
    const isTooLarge =
      typeof err === "object" &&
      err !== null &&
      "message" in err &&
      typeof (err as Error).message === "string" &&
      (err as Error).message.startsWith("File exceeds");
    return {
      ...unchanged,
      readLimitExceeded: isTooLarge,
      readError: !isTooLarge,
    };
  };
  try {
    // Reject oversized, unreadable, symlinked, or non-regular inputs before the
    // archive rename. The archived snapshot is read again after the atomic move.
    await Promise.all([
      ...(detection.canonicalExists
        ? [
            readRegularFile({
              filePath: detection.canonicalPath,
              maxBytes: ROOT_MEMORY_FILE_MAX_BYTES,
            }),
          ]
        : []),
      ...detection.legacyFiles.map((legacy) =>
        readRegularFile({ filePath: legacy.path, maxBytes: ROOT_MEMORY_FILE_MAX_BYTES }),
      ),
    ]);
  } catch (err) {
    return skippedForReadFailure(err);
  }
  const archivedLegacyPaths: string[] = [];
  try {
    for (const legacy of detection.legacyFiles) {
      archivedLegacyPaths.push(
        await moveLegacyRootMemoryFileToArchive({
          workspaceDir: detection.workspaceDir,
          legacyPath: legacy.path,
        }),
      );
    }
  } catch {
    return {
      ...unchanged,
      changed: archivedLegacyPaths.length > 0,
      archivedLegacyPaths,
      archiveError: true,
    };
  }
  let canonicalText = "";
  let legacyTexts: string[];
  try {
    if (detection.canonicalExists) {
      canonicalText = await readRegularFile({
        filePath: detection.canonicalPath,
        maxBytes: ROOT_MEMORY_FILE_MAX_BYTES,
      }).then(({ buffer }) => buffer.toString("utf-8"));
    }
    legacyTexts = await Promise.all(
      archivedLegacyPaths.map((archivedPath) =>
        readRegularFile({ filePath: archivedPath, maxBytes: ROOT_MEMORY_FILE_MAX_BYTES }).then(
          ({ buffer }) => buffer.toString("utf-8"),
        ),
      ),
    );
  } catch (err) {
    const skipped = skippedForReadFailure(err);
    // The archive is the independent recovery copy. Do not link or copy it
    // back into the live path: linking lets later in-place writes corrupt the
    // archive, while copying a concurrently growing file would reintroduce an
    // unbounded read. A concurrent replacement at legacyPath stays untouched.
    return {
      ...skipped,
      changed: true,
      archivedLegacyPaths,
    };
  }
  const mergedLegacyPaths: string[] = [];
  let merged = canonicalText;
  for (const [index, legacy] of detection.legacyFiles.entries()) {
    const legacyText = legacyTexts[index] ?? "";
    if (!merged.trim()) {
      merged = legacyText;
      mergedLegacyPaths.push(legacy.path);
    } else if (merged !== legacyText) {
      merged = `${merged.trimEnd()}\n${buildMergedLegacyRootMemorySection({
        legacyName: legacy.name,
        legacyText,
        archivedLegacyPath: shortenHomePath(archivedLegacyPaths[index]!),
      })}`;
      mergedLegacyPaths.push(legacy.path);
    }
  }
  await fs.promises.mkdir(path.dirname(detection.canonicalPath), { recursive: true });
  await fs.promises.writeFile(detection.canonicalPath, merged, "utf-8");
  return {
    changed: true,
    canonicalPath: detection.canonicalPath,
    legacyPaths: detection.legacyFiles.map((entry) => entry.path),
    mergedLegacyPaths,
    archivedLegacyPaths,
  };
}

type WorkspaceMemoryDoctorScope = {
  agentId: string;
  workspaceDir: string;
  labelAgent: boolean;
};

export async function noteWorkspaceMemoryHealth(scope: WorkspaceMemoryDoctorScope): Promise<void> {
  try {
    const rootMemoryWarning = formatRootMemoryFilesWarning(
      await detectRootMemoryFiles(scope.workspaceDir),
    );
    if (rootMemoryWarning) {
      note(
        `${scope.labelAgent ? `Agent "${scope.agentId}":\n` : ""}${rootMemoryWarning}`,
        "Workspace memory",
      );
    }
  } catch (err) {
    const prefix = scope.labelAgent ? `Agent "${scope.agentId}": ` : "";
    note(
      `${prefix}Workspace memory audit could not be completed: ${formatErrorMessage(err)}`,
      "Doctor",
    );
  }
}

/** Prompts to migrate legacy root memory into canonical Workspace memory. */
export async function maybeRepairWorkspaceMemoryHealth(params: {
  prompter: DoctorPrompter;
  scope: WorkspaceMemoryDoctorScope;
}): Promise<void> {
  try {
    const prefix = params.scope.labelAgent ? `Agent "${params.scope.agentId}": ` : "";
    const rootMemoryFiles = await detectRootMemoryFiles(params.scope.workspaceDir);
    if (rootMemoryFiles.legacyFiles.length === 0) {
      return;
    }
    const approvedLegacyMigration = await params.prompter.confirmRuntimeRepair({
      message: `${prefix}Migrate legacy root memory into ${WORKSPACE_MEMORY_RELATIVE_PATH} and preserve backups?`,
      initialValue: true,
    });
    if (!approvedLegacyMigration) {
      return;
    }
    const migration = await migrateLegacyRootMemoryFiles(params.scope.workspaceDir);
    if (migration.readLimitExceeded || migration.readError) {
      const reason = migration.readLimitExceeded
        ? "a file exceeded the safe read limit"
        : "a file could not be read";
      note(
        [
          `${prefix}Workspace memory root repair skipped (${reason}):`,
          `- canonical: ${migration.canonicalPath}`,
          ...migration.legacyPaths.map((legacyPath) => `- legacy: ${legacyPath}`),
          ...migration.archivedLegacyPaths.map(
            (archivedPath) => `- preserved archive: ${archivedPath}`,
          ),
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
        "Doctor changes",
      );
      return;
    }
    if (migration.archiveError) {
      note(
        [
          `${prefix}Workspace memory root repair skipped (legacy memory could not be archived atomically):`,
          `- canonical: ${migration.canonicalPath}`,
          ...migration.legacyPaths.map((legacyPath) => `- legacy: ${legacyPath}`),
        ].join("\n"),
        "Doctor changes",
      );
      return;
    }
    if (!migration.changed) {
      return;
    }
    const lines = [
      `${prefix}Workspace memory migrated:`,
      `- canonical: ${migration.canonicalPath}`,
      ...migration.archivedLegacyPaths.map((archivedPath) => `- backup: ${archivedPath}`),
      ...migration.mergedLegacyPaths.map(
        (legacyPath) => `- merged legacy content from: ${legacyPath}`,
      ),
      ...migration.legacyPaths.map((legacyPath) => `- removed legacy file: ${legacyPath}`),
    ].filter(Boolean);
    note(lines.join("\n"), "Doctor changes");
  } catch (err) {
    const prefix = params.scope.labelAgent ? `Agent "${params.scope.agentId}": ` : "";
    note(
      `${prefix}Workspace memory repair could not be completed: ${formatErrorMessage(err)}`,
      "Doctor",
    );
  }
}
