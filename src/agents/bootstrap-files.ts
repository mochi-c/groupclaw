import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChatType } from "../channels/chat-type.js";
import { prepareSessionTranscriptHydration } from "../config/sessions/session-transcript-hydration.js";
import type { AgentContextInjection } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRootFileMissingFailure } from "../infra/boundary-file-read.js";
import { isMemoryOriginEligibleForAutomaticInjection } from "../memory-host-sdk/host/types.js";
import { WORKSPACE_MEMORY_RELATIVE_PATH } from "../memory/scoped-memory.js";
import type { MemoryAudience } from "../plugins/memory-provider-types.js";
import { classifyActiveMemoryWorkspacePaths } from "../plugins/memory-runtime.js";
import { resolveUserPath } from "../utils.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "./agent-scope.js";
import { getOrLoadBootstrapFiles } from "./bootstrap-cache.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import type { BootstrapContextRunKind } from "./bootstrap-mode.js";
import { buildBootstrapContextForFiles } from "./embedded-agent-helpers/bootstrap.js";
import type { EmbeddedContextFile } from "./embedded-agent-helpers/context-file.js";
import type { AgentRunSessionTarget } from "./run-session-target.types.js";
import { getAgentWorkspaceAccess } from "./workspace-access.js";
import { resolveWorkspaceBootstrapPath } from "./workspace-bootstrap-policy.js";
import {
  readWorkspaceFileWithGuards,
  setWorkspaceFileSourceIdentity,
} from "./workspace-file-read.js";
import { loadPersonalUserBootstrapFile } from "./workspace-personal-bootstrap.js";
import {
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_USER_FILENAME,
  filterBootstrapFilesForSession,
  getWorkspaceFileSourceRelativePath,
  isWorkspaceSetupCompleted,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
  workspaceFilesShareSourceIdentity,
} from "./workspace.js";

export type BootstrapContextMode = "full" | "lightweight";

const CONTINUATION_SCAN_MAX_RECORDS = 500;
export const FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE = "openclaw:bootstrap-context:full";
const BOOTSTRAP_WARNING_DEDUPE_LIMIT = 1024;
const seenBootstrapWarnings = new Set<string>();

function rememberBootstrapWarning(key: string): boolean {
  // Warning keys include workspace/session/message so repeated setup failures
  // stay quiet without hiding distinct bootstrap problems.
  if (seenBootstrapWarnings.has(key)) {
    return false;
  }
  if (seenBootstrapWarnings.size >= BOOTSTRAP_WARNING_DEDUPE_LIMIT) {
    const oldest = seenBootstrapWarnings.values().next().value;
    if (oldest) {
      seenBootstrapWarnings.delete(oldest);
    }
  }
  seenBootstrapWarnings.add(key);
  return true;
}

/** Resolves the effective bootstrap injection mode for a session agent. */
export function resolveContextInjectionMode(
  config?: OpenClawConfig,
  agentId?: string | null,
): AgentContextInjection {
  const agentMode =
    config && agentId ? resolveAgentConfig(config, agentId)?.contextInjection : undefined;
  if (agentMode === "always" || agentMode === "continuation-skip" || agentMode === "never") {
    return agentMode;
  }
  return config?.agents?.defaults?.contextInjection ?? "always";
}

/** Checks the active SQLite transcript branch for a valid full-bootstrap marker. */
export async function hasCompletedBootstrapTurn(
  sessionTarget?: AgentRunSessionTarget,
): Promise<boolean> {
  const { agentId, sessionId, sessionKey, storePath } = sessionTarget ?? {};
  if (!agentId || !sessionId || !sessionKey || !storePath) {
    return false;
  }
  try {
    const reader = prepareSessionTranscriptHydration({ agentId, sessionId, sessionKey, storePath });
    const records = await reader.readRecentActiveEvents(CONTINUATION_SCAN_MAX_RECORDS);
    reader.assertCurrent();
    for (const entry of records.toReversed()) {
      const record = entry as { type?: string; customType?: string } | null | undefined;
      // Context before compaction/reset is not reusable on the active branch.
      if (record?.type === "compaction" || record?.type === "reset") {
        return false;
      }
      if (record?.type === "custom" && record.customType === FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Builds a session-scoped warning sink that dedupes repeated bootstrap warnings. */
export function makeBootstrapWarn(params: {
  sessionLabel: string;
  workspaceDir?: string;
  warn?: (message: string) => void;
}): ((message: string) => void) | undefined {
  const warn = params.warn;
  if (!warn) {
    return undefined;
  }
  const workspacePrefix = params.workspaceDir ?? "";
  return (message: string) => {
    const key = `${workspacePrefix}\u0000${params.sessionLabel}\u0000${message}`;
    if (!rememberBootstrapWarning(key)) {
      return;
    }
    warn(`${message} (sessionKey=${params.sessionLabel})`);
  };
}

function sanitizeBootstrapFiles(
  files: WorkspaceBootstrapFile[],
  workspaceDir: string,
  warn?: (message: string) => void,
): WorkspaceBootstrapFile[] {
  const workspaceRoot = resolveUserPath(workspaceDir);
  const seenPaths = new Set<string>();
  const sanitized: WorkspaceBootstrapFile[] = [];
  for (const file of files) {
    const pathValue = normalizeOptionalString(file.path) ?? "";
    if (!pathValue) {
      warn?.(
        `skipping bootstrap file "${file.name}" — missing or invalid "path" field (hook may have used "filePath" instead)`,
      );
      continue;
    }
    const resolvedPath = resolveWorkspaceBootstrapPath(workspaceRoot, pathValue);
    const dedupeKey = path.normalize(path.relative(workspaceRoot, resolvedPath));
    if (seenPaths.has(dedupeKey)) {
      continue;
    }
    seenPaths.add(dedupeKey);
    sanitized.push({ ...file, path: resolvedPath });
  }
  return sanitized;
}

function filterCompletedWorkspaceBootstrapFile(
  files: WorkspaceBootstrapFile[],
  setupCompleted: boolean,
  workspaceDir: string,
): WorkspaceBootstrapFile[] {
  if (!setupCompleted) {
    return files;
  }
  const workspaceRoot = resolveUserPath(workspaceDir);
  const rootBootstrapPath = path.join(workspaceRoot, DEFAULT_BOOTSTRAP_FILENAME);
  return files.filter((file) => {
    if (file.name !== DEFAULT_BOOTSTRAP_FILENAME) {
      return true;
    }
    const pathValue = normalizeOptionalString(file.path);
    if (!pathValue) {
      return true;
    }
    const resolvedPath = resolveWorkspaceBootstrapPath(workspaceRoot, pathValue);
    return resolvedPath !== rootBootstrapPath;
  });
}

async function isWorkspaceSetupCompletedForContext(
  workspaceDir: string,
  readOnlyState = false,
): Promise<boolean> {
  try {
    return await isWorkspaceSetupCompleted(workspaceDir, readOnlyState ? { readOnly: true } : {});
  } catch {
    return false;
  }
}

function filterBootstrapFilesAfterHooks(params: {
  files: WorkspaceBootstrapFile[];
  session: {
    sessionKey?: string;
    chatType?: ChatType;
    workspaceDir: string;
  };
  protectedFiles?: WorkspaceBootstrapFile[];
}): WorkspaceBootstrapFile[] {
  const sessionFiltered = filterBootstrapFilesForSession(params.files, params.session);
  const protectedFiles = params.protectedFiles ?? [];
  if (protectedFiles.length === 0) {
    return sessionFiltered;
  }
  // Hooks can relabel or alias loader-produced records. Reapply lexical/session
  // policy first, then enforce protected sources captured by the pinned opens.
  return sessionFiltered.filter(
    (file) =>
      !protectedFiles.some((protectedFile) => {
        if (workspaceFilesShareSourceIdentity(file, protectedFile)) {
          return true;
        }
        const filePath = normalizeOptionalString(file.path);
        const protectedPath = normalizeOptionalString(protectedFile.path);
        return Boolean(
          filePath && protectedPath && path.resolve(filePath) === path.resolve(protectedPath),
        );
      }),
  );
}

async function resolveIneligibleAutomaticMemoryFiles(params: {
  files: WorkspaceBootstrapFile[];
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
  warn?: (message: string) => void;
}): Promise<WorkspaceBootstrapFile[]> {
  const candidates = params.files.filter(
    (file) =>
      !file.missing &&
      (file.name === DEFAULT_MEMORY_FILENAME || file.name === DEFAULT_USER_FILENAME),
  );
  if (candidates.length === 0 || !params.config) {
    return [];
  }
  let agentId: string;
  try {
    agentId = params.agentId ?? resolveDefaultAgentId(params.config);
  } catch (error) {
    params.warn?.(`excluding automatic memory context: ${String(error)}`);
    return candidates;
  }
  const relativePaths = candidates.map((file) =>
    path.relative(resolveUserPath(params.workspaceDir), file.path).replaceAll(path.sep, "/"),
  );
  let classificationResult: Awaited<ReturnType<typeof classifyActiveMemoryWorkspacePaths>>;
  try {
    const access = getAgentWorkspaceAccess(params.workspaceDir);
    classificationResult = await classifyActiveMemoryWorkspacePaths({
      cfg: params.config,
      agentId,
      workspaceDir: params.workspaceDir,
      relativePaths,
      ...(access
        ? {
            readSources: candidates.map((file, index) => ({
              relativePath: relativePaths[index]!,
              canonicalRelativePath: getWorkspaceFileSourceRelativePath(file),
            })),
          }
        : {}),
    });
    if (access && getAgentWorkspaceAccess(params.workspaceDir) !== access) {
      throw new Error("Workspace access changed during memory classification");
    }
  } catch (error) {
    params.warn?.(`excluding automatic memory context: ${String(error)}`);
    return candidates;
  }
  if (classificationResult.status === "unavailable") {
    return [];
  }
  if (classificationResult.status === "unsupported") {
    params.warn?.(
      "excluding automatic memory context: selected memory runtime does not support provenance classification",
    );
    return candidates;
  }
  const origins = new Map(
    classificationResult.classifications.map((entry) => [entry.relativePath, entry.originClass]),
  );
  return candidates.filter(
    (_file, index) =>
      !isMemoryOriginEligibleForAutomaticInjection(origins.get(relativePaths[index]!)),
  );
}

/** Resolves hook-adjusted, session-filtered bootstrap files for a run. */
type BootstrapFileResolutionParams = {
  bootstrapUserProfileId?: string;
  memoryAudience?: MemoryAudience;
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  chatType?: ChatType;
  agentId?: string;
  warn?: (message: string) => void;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
  readOnlyState?: boolean;
};

// Diagnostics project declared files without executing registered hook handlers.
type BootstrapHookApplication = "none" | "registered" | { projected: WorkspaceBootstrapFile[] };

/** Prepare the same bounded workspace facts without invoking run-owned bootstrap hooks. */
export async function resolveBootstrapFilesForPreparation(
  params: BootstrapFileResolutionParams,
): Promise<WorkspaceBootstrapFile[]> {
  return resolveBootstrapFiles({ ...params, readOnlyState: true }, "none");
}

export async function resolveBootstrapFilesForRun(
  params: BootstrapFileResolutionParams,
): Promise<WorkspaceBootstrapFile[]> {
  return resolveBootstrapFiles(params, "registered");
}

async function resolveBootstrapFiles(
  params: BootstrapFileResolutionParams,
  hooks: BootstrapHookApplication,
): Promise<WorkspaceBootstrapFile[]> {
  const access = getAgentWorkspaceAccess(params.workspaceDir);
  const audienceOwner = params.memoryAudience
    ? await import("../plugins/memory-audience.js")
    : undefined;
  const assertAudienceCurrent = () => {
    if (params.memoryAudience && audienceOwner) {
      audienceOwner.assertMemoryAudienceSession(params.memoryAudience, params.sessionKey);
      audienceOwner.assertMemoryAudienceCurrent(params.memoryAudience);
      if (params.agentId && params.agentId !== params.memoryAudience.agentId) {
        throw new Error("Memory audience belongs to a different agent");
      }
    }
  };
  assertAudienceCurrent();
  const sessionKey = params.sessionKey ?? params.sessionId;
  const session = {
    sessionKey,
    chatType: params.chatType,
    workspaceDir: params.workspaceDir,
  };
  const workspaceSetupCompleted = await isWorkspaceSetupCompletedForContext(
    params.workspaceDir,
    params.readOnlyState,
  );
  const sharedFiles = params.sessionKey
    ? await getOrLoadBootstrapFiles({
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
      })
    : await loadWorkspaceBootstrapFiles(params.workspaceDir);
  // Personal context is refreshed independently; never write it into the shared session snapshot.
  const personalFile = await loadPersonalUserBootstrapFile(
    params.workspaceDir,
    params.bootstrapUserProfileId,
    params.warn,
  );
  const userIndex = sharedFiles.findIndex((file) => file.name === DEFAULT_USER_FILENAME);
  const rawFiles = [...sharedFiles];
  if (personalFile) {
    rawFiles.splice(userIndex < 0 ? rawFiles.length : userIndex + 1, 0, personalFile);
  }
  // These per-turn records never enter the shared bootstrap cache. The host
  // audience supplies every address, including participants who have not spoken.
  const scopedFiles: WorkspaceBootstrapFile[] = [];
  const artifacts = params.memoryAudience?.context?.artifacts ?? [];
  const layers = ["thread", "channel", "users"] as const;
  if (params.contextMode !== "lightweight") {
    for (const layer of layers) {
      for (const artifact of artifacts.filter((item) => item.layer === layer)) {
        const file: WorkspaceBootstrapFile = {
          name: DEFAULT_MEMORY_FILENAME,
          path: path.resolve(params.workspaceDir, artifact.relativePath),
          missing: false,
        };
        if (!filterBootstrapFilesForSession([file], session).length) {
          continue;
        }
        assertAudienceCurrent();
        const loaded = await readWorkspaceFileWithGuards({
          filePath: file.path,
          workspaceDir: params.workspaceDir,
          rejectAliases: true,
          useCache: false,
        });
        assertAudienceCurrent();
        if (!loaded.ok) {
          if (!isRootFileMissingFailure(loaded)) {
            params.warn?.(`Scoped memory could not be read safely: ${artifact.relativePath}`);
          }
          continue;
        }
        file.content = loaded.content;
        setWorkspaceFileSourceIdentity(file, loaded.sourceIdentity);
        scopedFiles.push(file);
      }
    }
  }
  rawFiles.push(...scopedFiles);
  const ineligibleAutomaticMemoryFiles = await resolveIneligibleAutomaticMemoryFiles({
    files: rawFiles,
    workspaceDir: params.workspaceDir,
    config: params.config,
    agentId: params.agentId,
    warn: params.warn,
  });
  assertAudienceCurrent();
  // Classify complete sources before adding labels or limiting their prompt copy.
  const eligibleScopedFiles = scopedFiles.filter(
    (file) => !ineligibleAutomaticMemoryFiles.includes(file),
  );
  for (const file of eligibleScopedFiles) {
    const artifact = artifacts.find(
      (item) => path.resolve(params.workspaceDir, item.relativePath) === file.path,
    );
    if (artifact?.userName) {
      file.content = `Current User memory for ${JSON.stringify(artifact.userName)}:\n\n${file.content ?? ""}`;
    }
  }
  const boundedScopedFiles = new Map(
    buildBootstrapContextForFiles(eligibleScopedFiles, params).map((file) => [
      file.path,
      file.content,
    ]),
  );
  const scopedSnapshots = eligibleScopedFiles.flatMap((file) => {
    const content = boundedScopedFiles.get(file.path);
    if (content === undefined) {
      return [];
    }
    file.content = content;
    return [{ file, snapshot: { ...file } }];
  });
  const rootMemoryFile = rawFiles.find(
    (file) => file.name === DEFAULT_MEMORY_FILENAME && !file.missing,
  );
  const protectedRootMemoryFile =
    rootMemoryFile && filterBootstrapFilesForSession([rootMemoryFile], session).length === 0
      ? rootMemoryFile
      : undefined;
  const protectedFiles = [
    ...(protectedRootMemoryFile ? [protectedRootMemoryFile] : []),
    ...ineligibleAutomaticMemoryFiles,
  ];
  const sessionFiles = filterCompletedWorkspaceBootstrapFile(
    filterBootstrapFilesForSession(rawFiles, session).filter(
      (file) =>
        !ineligibleAutomaticMemoryFiles.some((ineligible) =>
          workspaceFilesShareSourceIdentity(file, ineligible),
        ),
    ),
    workspaceSetupCompleted,
    params.workspaceDir,
  );
  // Heartbeat scratch is runner-owned; all lightweight runs omit bootstrap context.
  const bootstrapFiles =
    params.contextMode === "lightweight"
      ? []
      : sessionFiles.filter(
          (file) => !scopedFiles.includes(file) || boundedScopedFiles.has(file.path),
        );

  const hooked =
    hooks === "registered"
      ? await applyBootstrapHookOverrides({
          files: bootstrapFiles,
          workspaceDir: params.workspaceDir,
          config: params.config,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          agentId: params.agentId,
        })
      : bootstrapFiles;
  const updated = typeof hooks === "object" ? [...hooked, ...hooks.projected] : hooked;
  const filteredUpdated = filterCompletedWorkspaceBootstrapFile(
    filterBootstrapFilesAfterHooks({
      files: updated,
      session,
      protectedFiles,
    }),
    workspaceSetupCompleted,
    params.workspaceDir,
  );
  if (getAgentWorkspaceAccess(params.workspaceDir) !== access) {
    throw new Error("Workspace access changed while preparing bootstrap context");
  }
  assertAudienceCurrent();
  const workspaceRoot = resolveUserPath(params.workspaceDir);
  const isScopedSource = (relativePath: string | undefined) =>
    relativePath?.startsWith("memory/") && relativePath !== WORKSPACE_MEMORY_RELATIVE_PATH;
  const audienceFiltered = filteredUpdated.flatMap((file) => {
    const filePath = normalizeOptionalString(file.path);
    const relativePath = filePath
      ? path
          .relative(workspaceRoot, resolveWorkspaceBootstrapPath(workspaceRoot, filePath))
          .replaceAll(path.sep, "/")
      : undefined;
    const sourcePath = getWorkspaceFileSourceRelativePath(file);
    if (!isScopedSource(relativePath) && !isScopedSource(sourcePath)) {
      return [file];
    }
    const admitted = scopedSnapshots.find(
      (entry) =>
        entry.snapshot.path === resolveWorkspaceBootstrapPath(workspaceRoot, filePath ?? "") &&
        workspaceFilesShareSourceIdentity(file, entry.file),
    );
    // A hook-created record, alias, relabel, or omitted source cannot replace
    // the exact authorized snapshot captured by the guarded loader.
    return admitted && sourcePath === relativePath ? [admitted.snapshot] : [];
  });
  return sanitizeBootstrapFiles(audienceFiltered, params.workspaceDir, params.warn);
}

/** Resolves both raw bootstrap metadata and bounded context files for a run. */
export async function resolveBootstrapContextForRun(
  params: BootstrapFileResolutionParams,
): Promise<{
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
}> {
  const bootstrapFiles = await resolveBootstrapFilesForRun(params);
  const contextFiles = buildBootstrapContextForFiles(bootstrapFiles, params);
  return { bootstrapFiles, contextFiles };
}

/** Applies declared additions through the normal bootstrap filters and budgets. */
export async function resolveBootstrapContextWithProjectedHookFiles(
  params: Pick<BootstrapFileResolutionParams, "workspaceDir" | "config" | "agentId">,
  projected: WorkspaceBootstrapFile[],
): ReturnType<typeof resolveBootstrapContextForRun> {
  const bootstrapFiles = await resolveBootstrapFiles(
    { ...params, readOnlyState: true },
    { projected },
  );
  const contextFiles = buildBootstrapContextForFiles(bootstrapFiles, params);
  return { bootstrapFiles, contextFiles };
}
