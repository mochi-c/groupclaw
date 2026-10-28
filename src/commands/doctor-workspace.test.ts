import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_MEMORY_RELATIVE_PATH } from "../memory/scoped-memory.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { createDoctorPrompter, type DoctorPrompter } from "./doctor-prompter.js";

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

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-memory-"));
    scope = { agentId: "main", workspaceDir, labelAgent: false };
    prompter = createDoctorPrompter({
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { yes: true },
    });
    vi.spyOn(prompter, "confirmRuntimeRepair");
    note.mockClear();
  });

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
    const legacyPath = path.join(workspaceDir, "MEMORY.md");
    const canonicalPath = path.join(workspaceDir, ...WORKSPACE_MEMORY_RELATIVE_PATH.split("/"));
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
    const legacyPath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(legacyPath, "# Legacy\n".repeat(1_000_000), "utf8");

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
});
