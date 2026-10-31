import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_MEMORY_RELATIVE_PATH } from "../memory/scoped-memory.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { createDoctorPrompter, type DoctorPrompter } from "./doctor-prompter.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/terminal-core/src/note.js")>()),
  note,
}));

import {
  collectWorkspaceBackupTip,
  maybeRepairWorkspaceMemoryHealth,
  noteWorkspaceMemoryHealth,
  shouldSuggestMemorySystem,
} from "./doctor-workspace.js";

const WORKSPACE_BACKUP_TIP =
  "- Tip: back up the agent workspace in a private git repo; keep ~/.openclaw out of git (credentials, sessions). Details: /concepts/agent-workspace#git-backup-recommended-private";

describe("workspace backup tip", () => {
  it("recognizes direct, deeply nested, and symlinked Git workspaces without duplicate tips", async () => {
    await withTestDir({ prefix: "openclaw-doctor-workspace-git-" }, async (tempDir) => {
      const repoRoot = path.join(tempDir, "repo");
      const nestedWorkspace = path.join(repoRoot, "agents", "direct");
      const deeplyNestedWorkspace = path.join(
        repoRoot,
        ...Array.from({ length: 12 }, (_, index) => `workspace-level-${index}`),
      );
      const linkedWorkspace = path.join(tempDir, "linked-workspace");
      await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
      await fs.mkdir(nestedWorkspace, { recursive: true });
      await fs.mkdir(deeplyNestedWorkspace, { recursive: true });
      await fs.symlink(
        nestedWorkspace,
        linkedWorkspace,
        process.platform === "win32" ? "junction" : "dir",
      );

      expect(collectWorkspaceBackupTip(repoRoot)).toBeNull();
      expect(collectWorkspaceBackupTip(nestedWorkspace)).toBeNull();
      expect(collectWorkspaceBackupTip(deeplyNestedWorkspace)).toBeNull();
      expect(collectWorkspaceBackupTip(linkedWorkspace)).toBeNull();
      expect(collectWorkspaceBackupTip(path.parse(tempDir).root)).toBe(WORKSPACE_BACKUP_TIP);
      expect(collectWorkspaceBackupTip(path.join(tempDir, "missing"))).toBeNull();
    });
  });
});

describe("Workspace memory migration", () => {
  let workspaceDir = "";
  let scope: Parameters<typeof noteWorkspaceMemoryHealth>[0];
  let prompter: DoctorPrompter;
  let canonicalPath: string;
  let legacyPath: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-memory-"));
    canonicalPath = path.join(workspaceDir, WORKSPACE_MEMORY_RELATIVE_PATH);
    legacyPath = path.join(workspaceDir, "memory.md");
    await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
    scope = { agentId: "main", workspaceDir, labelAgent: false };
    prompter = createDoctorPrompter({
      runtime: createTestRuntime(),
      options: { yes: true },
    });
    vi.spyOn(prompter, "confirmRuntimeRepair");
    note.mockClear();
  });

  async function seedMemory(canonical: string | Buffer = "# Canonical\n", legacy = "# Legacy\n") {
    await fs.writeFile(canonicalPath, canonical);
    await fs.writeFile(legacyPath, legacy);
  }
  const repair = () => maybeRepairWorkspaceMemoryHealth({ scope, prompter });
  function onArchive(
    before?: (source: Parameters<typeof fs.rename>[0]) => Promise<unknown>,
    after?: (...paths: Parameters<typeof fs.rename>) => Promise<unknown>,
  ) {
    const rename = vi.spyOn(fs, "rename");
    rename.mockImplementationOnce(async (source, target) => {
      await before?.(source);
      rename.mockRestore();
      await fs.rename(source, target);
      await after?.(source, target);
    });
  }
  function expectSkipped(reason: string) {
    expect(note).toHaveBeenCalledExactlyOnceWith(
      `Workspace memory root repair skipped (${reason}):\n- canonical: ${canonicalPath}\n- legacy: ${legacyPath}`,
      "Doctor changes",
    );
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  async function listArchivedRootMemory(): Promise<string[]> {
    const repairDir = path.join(workspaceDir, ".openclaw-repair", "root-memory");
    const archiveDirs = await fs.readdir(repairDir);
    const archived = await Promise.all(
      archiveDirs.map(async (directory) =>
        (await fs.readdir(path.join(repairDir, directory))).map((fileName) =>
          path.join(repairDir, directory, fileName),
        ),
      ),
    );
    return archived.flat().toSorted();
  }

  it("moves legacy root MEMORY.md into memory/MEMORY.md with a recovery copy", async () => {
    legacyPath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(legacyPath, "# Family memory\n", "utf8");

    await noteWorkspaceMemoryHealth(scope);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Legacy Workspace memory files detected"),
      "Workspace memory",
    );

    await maybeRepairWorkspaceMemoryHealth({ scope, prompter });

    await expect(fs.readFile(canonicalPath, "utf8")).resolves.toBe("# Family memory\n");
    await expect(fs.access(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    const archived = await listArchivedRootMemory();
    expect(archived).toHaveLength(1);
    await expect(fs.readFile(archived[0]!, "utf8")).resolves.toBe("# Family memory\n");
  });

  it("merges distinct legacy root files into existing Workspace memory", async () => {
    const entries = new Set(await fs.readdir(workspaceDir));
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, WORKSPACE_MEMORY_RELATIVE_PATH), "# Canonical\n");
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Upper legacy\n");
    await fs.writeFile(path.join(workspaceDir, "memory.md"), "# Lower legacy\n");
    const distinctEntries = new Set(await fs.readdir(workspaceDir));
    if (
      entries.size === distinctEntries.size ||
      !distinctEntries.has("MEMORY.md") ||
      !distinctEntries.has("memory.md")
    ) {
      return;
    }

    await maybeRepairWorkspaceMemoryHealth({ scope, prompter });

    const memory = await fs.readFile(
      path.join(workspaceDir, WORKSPACE_MEMORY_RELATIVE_PATH),
      "utf8",
    );
    expect(memory).toContain("# Canonical");
    expect(memory).toContain("# Upper legacy");
    expect(memory).toContain("# Lower legacy");
    expect(await listArchivedRootMemory()).toHaveLength(2);
  });

  it("does not mutate an oversized legacy file", async () => {
    legacyPath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(legacyPath, "# Legacy\n".repeat(1_000_000), "utf8");
    await fs.rm(path.dirname(canonicalPath), { recursive: true });

    await maybeRepairWorkspaceMemoryHealth({ scope, prompter });

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("a file exceeded the safe read limit"),
      "Doctor changes",
    );
    await expect(fs.access(legacyPath)).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(workspaceDir, ...WORKSPACE_MEMORY_RELATIVE_PATH.split("/"))),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recognizes canonical memory and explicit Workspace memory guidance", async () => {
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, WORKSPACE_MEMORY_RELATIVE_PATH), "# Memory\n");
    await expect(shouldSuggestMemorySystem(workspaceDir)).resolves.toBe(false);

    await fs.rm(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      `Read ${WORKSPACE_MEMORY_RELATIVE_PATH} before answering.\n`,
    );
    await expect(shouldSuggestMemorySystem(workspaceDir)).resolves.toBe(false);
  });

  it.each(["invalid UTF-8", "oversized"])(
    "preserves the archive when its content becomes %s after validation",
    async (failure) => {
      await seedMemory();
      const invalid = Buffer.from([0x23, 0x20, 0xff, 0x0a]);
      const oversized = failure === "oversized";
      onArchive(
        oversized ? (source) => fs.appendFile(source, Buffer.alloc(9 * 1024 * 1024)) : undefined,
        (source, target) =>
          oversized
            ? fs.writeFile(source, "# Concurrent replacement\n")
            : fs.writeFile(target, invalid),
      );
      await repair();
      await expect(fs.readFile(canonicalPath, "utf8")).resolves.toBe("# Canonical\n");
      const archives = await listArchivedRootMemory();
      expect(archives).toHaveLength(1);
      const archive = archives[0]!;
      if (!oversized) {
        await expect(fs.readFile(archive)).resolves.toEqual(invalid);
      }
      const message = String(note.mock.calls[0]?.[0]);
      for (const text of [
        oversized ? "safe read limit" : "not valid UTF-8",
        canonicalPath,
        legacyPath,
        `- preserved archive: ${archive}`,
      ]) {
        expect(message).toContain(text);
      }
      expect(message).not.toContain("Workspace memory migrated:");
      if (oversized) {
        await expect(fs.readFile(legacyPath, "utf8")).resolves.toBe("# Concurrent replacement\n");
      } else {
        await expect(fs.access(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("reads legacy content after moving it into the archive", async () => {
    await seedMemory("# Canonical 合法 😀 �\n", "# Legacy 旧版 �\n");
    onArchive((source) => fs.appendFile(source, "# Added before archive\n", "utf8"));
    await repair();
    const canonical = await fs.readFile(canonicalPath, "utf8");
    expect(canonical).toContain("# Canonical 合法 😀 �");
    expect(canonical).toContain("# Legacy 旧版 �");
    expect(canonical).toContain("# Added before archive");
  });

  it("follows a symlinked AGENTS.md while keeping its target bounded", async () => {
    await fs.rm(path.dirname(canonicalPath), { recursive: true });
    const target = path.join(workspaceDir, "agents-target.md");
    await fs.writeFile(target, `Use ${WORKSPACE_MEMORY_RELATIVE_PATH} for durable memory.\n`);
    await fs.symlink(target, path.join(workspaceDir, "AGENTS.md"));
    await expect(shouldSuggestMemorySystem(workspaceDir)).resolves.toBe(false);
    await fs.writeFile(target, `${WORKSPACE_MEMORY_RELATIVE_PATH}\n`.repeat(200_000));
    await expect(shouldSuggestMemorySystem(workspaceDir)).resolves.toBe(true);
  });

  it.each(["symlink", "oversized canonical", "oversized legacy", "archive failure"])(
    "preserves memory when repair is blocked by %s",
    async (failure) => {
      const canonical = "# Canonical\n".repeat(failure === "oversized canonical" ? 1_000_000 : 1);
      const legacy = "# Legacy\n".repeat(failure === "oversized legacy" ? 1_000_000 : 1);
      const target =
        failure === "symlink" ? path.join(workspaceDir, "canonical-target.md") : canonicalPath;
      await fs.writeFile(target, canonical);
      if (failure === "symlink") {
        await fs.symlink(target, canonicalPath);
      }
      await fs.writeFile(legacyPath, legacy);
      if (failure === "archive failure") {
        vi.spyOn(fs, "rename").mockRejectedValueOnce(
          Object.assign(new Error("cross-device rename"), { code: "EXDEV" }),
        );
      }
      await repair();
      expectSkipped(
        failure === "symlink"
          ? "a file could not be read"
          : failure === "archive failure"
            ? "legacy memory could not be archived atomically"
            : "a file exceeded the safe read limit",
      );
      if (failure.startsWith("oversized")) {
        await expect(fs.access(path.join(workspaceDir, ".openclaw-repair"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      await expect(fs.readFile(target, "utf8")).resolves.toBe(canonical);
      await expect(fs.readFile(legacyPath, "utf8")).resolves.toBe(legacy);
    },
  );
});
