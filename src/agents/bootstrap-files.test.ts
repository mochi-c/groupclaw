/**
 * Tests agent bootstrap file discovery, filtering, injected context modes, and the
 * doctor-side diagnostics resolution with its bundled hook projection gate.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import {
  upsertSessionEntryCore,
  type SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { resolveMemoryArtifactRelativePath } from "../memory/scoped-memory.js";
import { resolveMemoryAudienceFromEntry } from "../plugins/memory-audience.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { resolveBootstrapContextForDiagnostics } from "./bootstrap-files-diagnostics.js";
import {
  FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
  hasCompletedBootstrapTurn,
  makeBootstrapWarn,
  resolveBootstrapContextForRun,
  resolveBootstrapFilesForRun,
  resolveContextInjectionMode,
} from "./bootstrap-files.js";
import { createRemoteShellSandboxFsBridge } from "./sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "./sandbox/remote-fs-bridge.test-helpers.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";
import { SessionManager } from "./sessions/session-manager.js";
import { registerAgentWorkspaceAccess } from "./workspace-access.js";
import { createWorkspaceBootstrapFilePolicy } from "./workspace-bootstrap-policy.js";
import { resetLegacyWorkspaceStateCheckForTest } from "./workspace-legacy-state.test-support.js";
import { mergeWorkspaceSetupState } from "./workspace-state-store.js";
import {
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_USER_FILENAME,
  loadExtraBootstrapFilesWithDiagnostics,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

const memoryRuntimeMocks = vi.hoisted(() => ({ classifyWorkspacePaths: vi.fn() }));

vi.mock("../plugins/memory-runtime.js", () => ({
  classifyActiveMemoryWorkspacePaths: (...args: unknown[]) =>
    memoryRuntimeMocks.classifyWorkspacePaths(...args),
}));

let testState: OpenClawTestState | undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function registerMalformedBootstrapFileHook() {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    // Hook contracts are extension-facing; malformed entries must warn and drop
    // without breaking normal project bootstrap files.
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "EXTRA.md",
        filePath: path.join(context.workspaceDir, "BROKEN.md"),
        content: "broken",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
      {
        name: "EXTRA.md",
        path: 123,
        content: "broken",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
      {
        name: "EXTRA.md",
        path: "   ",
        content: "broken",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
    ];
  });
}

function registerDuplicateBootstrapFileHook() {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    // Duplicates exercise canonical path dedupe between relative hook entries
    // and resolved workspace files.
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "AGENTS.md",
        path: "AGENTS.md",
        content: "duplicate relative hook content",
        missing: false,
      },
      {
        name: "AGENTS.md",
        path: path.join(context.workspaceDir, ".", "AGENTS.md"),
        content: "duplicate absolute hook content",
        missing: false,
      },
    ];
  });
}

function registerNamedBootstrapFileHook(
  relativePath = DEFAULT_MEMORY_FILENAME,
  name: WorkspaceBootstrapFile["name"] = DEFAULT_MEMORY_FILENAME,
) {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name,
        path: path.join(context.workspaceDir, relativePath),
        content: "hook memory",
        missing: false,
      },
    ];
  });
}

function registerLoadedBootstrapFilesHook(
  relativePaths: string[],
  name?: WorkspaceBootstrapFile["name"],
) {
  registerInternalHook("agent:bootstrap", async (event) => {
    const context = event.context as AgentBootstrapHookContext;
    const { files } = await loadExtraBootstrapFilesWithDiagnostics(
      context.workspaceDir,
      relativePaths,
    );
    if (name) {
      for (const file of files) {
        file.name = name;
      }
    }
    context.bootstrapFiles = [...context.bootstrapFiles, ...files];
  });
}

async function createDirectoryAlias(params: {
  workspaceDir: string;
  targetDir: string;
  aliasName: string;
}): Promise<string> {
  const aliasDir = path.join(params.workspaceDir, params.aliasName);
  await fs.symlink(params.targetDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
  return aliasDir;
}

function registerBootstrapFileHook(relativePath = "BOOTSTRAP.md") {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "BOOTSTRAP.md",
        path: path.join(context.workspaceDir, relativePath),
        content: "stale ritual",
        missing: false,
      },
    ];
  });
}

async function writeCompletedWorkspaceState(workspaceDir: string): Promise<void> {
  await mergeWorkspaceSetupState(workspaceDir, {
    bootstrapSeededAt: "2026-05-16T00:00:00.000Z",
    setupCompletedAt: "2026-05-16T00:00:01.000Z",
  });
}

async function writeWorkspaceMemory(workspaceDir: string, content: string): Promise<string> {
  const memoryPath = path.join(workspaceDir, DEFAULT_MEMORY_FILENAME);
  await fs.mkdir(path.dirname(memoryPath), { recursive: true });
  await fs.writeFile(memoryPath, content, "utf8");
  return memoryPath;
}

describe("resolveBootstrapFilesForRun", () => {
  beforeEach(async () => {
    clearInternalHooks();
    resetLegacyWorkspaceStateCheckForTest();
    memoryRuntimeMocks.classifyWorkspacePaths
      .mockReset()
      .mockResolvedValue({ status: "unavailable" });
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-bootstrap-state-",
    });
  });

  it.runIf(process.platform !== "win32").each(["local", "remote"] as const)(
    "refreshes bounded authorized scoped memory through the %s workspace",
    async (mode) => {
      const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-scoped-");
      const sourceDir =
        mode === "remote"
          ? await fs.realpath(tempDirs.make("openclaw-bootstrap-scoped-remote-"))
          : workspaceDir;
      const sessionKey = "agent:main:bootstrap-scoped";
      const storePath = path.join(
        expectDefined(testState, "bootstrap test state").sessionsDir(),
        "sessions.json",
      );
      const entry = {
        sessionId: randomUUID(),
        lifecycleRevision: randomUUID(),
        updatedAt: 1,
        chatType: "channel" as const,
        delivery: {
          kind: "external" as const,
          route: { channel: "discord", target: { to: "channel:thread-1" } },
          context: { channel: "discord", to: "channel:thread-1", threadId: "thread-1" },
          origin: {
            provider: "discord",
            nativeChannelId: "room-1",
            threadId: "thread-1",
          },
        },
        participants: [
          { identity: { type: "profile" as const, id: "alice" }, label: "Alice" },
          { identity: { type: "profile" as const, id: "bob" }, label: "Bob" },
        ],
      };
      await upsertSessionEntryCore({ storePath, sessionKey }, entry);
      const grant = await resolveMemoryAudienceFromEntry(
        {
          agentId: "main",
          sessionKey,
          sessionId: entry.sessionId,
          storePath,
          senderIsOwner: false,
        },
        entry,
      );
      if (grant.status !== "granted") {
        throw new Error(grant.reason);
      }
      let releaseAccess = () => {};
      try {
        const artifacts = expectDefined(grant.audience.context, "scoped memory context").artifacts;
        const thread = expectDefined(
          artifacts.find((artifact) => artifact.layer === "thread"),
          "current Thread memory artifact",
        );
        for (const artifact of artifacts) {
          const filePath = path.join(sourceDir, artifact.relativePath);
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(
            filePath,
            artifact.layer === "users"
              ? `${artifact.userName} scoped facts.\n`.repeat(300)
              : `${artifact.layer} scoped facts.`,
          );
        }
        await fs.writeFile(
          path.join(sourceDir, "AGENTS.md"),
          "Required operating rules.\n".repeat(100),
        );
        const other = resolveMemoryArtifactRelativePath({
          scope: { kind: "channel", channelId: "other-room" },
          artifactKind: "memory",
        });
        await fs.mkdir(path.dirname(path.join(sourceDir, other)), { recursive: true });
        await fs.writeFile(path.join(sourceDir, other), "Unauthorized sibling facts.");
        const alias = "thread-alias/MEMORY.md";
        await fs.symlink(
          path.dirname(path.join(sourceDir, thread.relativePath)),
          path.join(sourceDir, "thread-alias"),
          "dir",
        );
        registerLoadedBootstrapFilesHook([other, alias], "AGENTS.md");
        if (mode === "remote") {
          const policy = createWorkspaceBootstrapFilePolicy({ workspaceDir });
          expect(policy.canRead(thread.relativePath)).toBe(true);
          expect(policy.canList(path.posix.dirname(thread.relativePath))).toBe(false);
          const bridge = createRemoteShellSandboxFsBridge({
            sandbox: createSandboxTestContext({
              overrides: { workspaceDir, agentWorkspaceDir: workspaceDir },
            }),
            runtime: {
              remoteWorkspaceDir: sourceDir,
              remoteAgentWorkspaceDir: sourceDir,
              runRemoteShellScript: createLocalRemoteShellScriptRunner(),
            },
          });
          releaseAccess = registerAgentWorkspaceAccess(workspaceDir, { bridge });
        }
        const params = {
          workspaceDir,
          sessionKey,
          agentId: "main",
          config: {
            agents: { defaults: { bootstrapMaxChars: 300, bootstrapTotalMaxChars: 300 } },
          },
          memoryAudience: grant.audience,
        };
        const context = await resolveBootstrapContextForRun(params);
        const text = context.contextFiles.map((file) => file.content).join("\n");
        expect(text).toContain("thread scoped facts.");
        expect(text).toContain("channel scoped facts.");
        expect(text).toContain("Alice scoped facts.");
        expect(text).toContain("Bob scoped facts.");
        expect(text).not.toContain("Unauthorized sibling facts.");
        expect(context.bootstrapFiles.map((file) => file.path)).not.toContain(
          path.join(workspaceDir, alias),
        );
        for (const user of artifacts.filter((artifact) => artifact.layer === "users")) {
          const file = expectDefined(
            context.contextFiles.find(
              (item) => item.path === path.join(workspaceDir, user.relativePath),
            ),
            `curated context for ${user.userName}`,
          );
          expect(file.content.length).toBeLessThanOrEqual(1_000);
          expect(file.content).toContain("truncated");
        }
        await fs.writeFile(path.join(sourceDir, thread.relativePath), "Updated thread facts.");
        const refreshed = await resolveBootstrapContextForRun(params);
        expect(refreshed.contextFiles.map((file) => file.content).join("\n")).toContain(
          "Updated thread facts.",
        );
        const ungranted = await resolveBootstrapContextForRun({
          ...params,
          memoryAudience: undefined,
        });
        expect(ungranted.contextFiles.map((file) => file.content).join("\n")).not.toContain(
          "Updated thread facts.",
        );
        registerInternalHook("agent:bootstrap", () => grant.release());
        await expect(resolveBootstrapContextForRun(params)).rejects.toThrow("released");
      } finally {
        releaseAccess();
        grant.release();
      }
    },
  );

  it("excludes lower-trust root memory before hooks while preserving trusted user context", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-memory-provenance-");
    await writeWorkspaceMemory(workspaceDir, "tainted memory");
    await fs.writeFile(path.join(workspaceDir, DEFAULT_USER_FILENAME), "trusted user", "utf8");
    registerNamedBootstrapFileHook(DEFAULT_MEMORY_FILENAME);
    memoryRuntimeMocks.classifyWorkspacePaths.mockResolvedValue({
      status: "classified",
      classifications: [
        { relativePath: DEFAULT_MEMORY_FILENAME, originClass: "untrusted" },
        { relativePath: DEFAULT_USER_FILENAME, originClass: "owner" },
      ],
    });

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config: {},
      agentId: "main",
    });

    expect(files.map((file) => file.name)).not.toContain(DEFAULT_MEMORY_FILENAME);
    expect(files.map((file) => file.name)).toContain(DEFAULT_USER_FILENAME);
  });

  it("fails closed when the memory runtime omits a requested root classification", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-missing-provenance-");
    await writeWorkspaceMemory(workspaceDir, "memory");
    await fs.writeFile(path.join(workspaceDir, DEFAULT_USER_FILENAME), "user", "utf8");
    memoryRuntimeMocks.classifyWorkspacePaths.mockResolvedValue({
      status: "classified",
      classifications: [{ relativePath: DEFAULT_MEMORY_FILENAME, originClass: "agent" }],
    });

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config: {},
      agentId: "main",
    });

    expect(files.map((file) => file.name)).toContain(DEFAULT_MEMORY_FILENAME);
    expect(files.map((file) => file.name)).not.toContain(DEFAULT_USER_FILENAME);
  });

  it("excludes root memory for a selected runtime without provenance support", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-unsupported-provenance-");
    await writeWorkspaceMemory(workspaceDir, "memory");
    await fs.writeFile(path.join(workspaceDir, DEFAULT_USER_FILENAME), "user", "utf8");
    memoryRuntimeMocks.classifyWorkspacePaths.mockResolvedValue({ status: "unsupported" });
    const warnings: string[] = [];

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config: {},
      agentId: "main",
      warn: (message) => warnings.push(message),
    });

    expect(files.map((file) => file.name)).not.toContain(DEFAULT_MEMORY_FILENAME);
    expect(files.map((file) => file.name)).not.toContain(DEFAULT_USER_FILENAME);
    expect(warnings).toContain(
      "excluding automatic memory context: selected memory runtime does not support provenance classification",
    );
  });
  afterEach(async () => {
    clearInternalHooks();
    closeOpenClawStateDatabaseForTest();
    resetLegacyWorkspaceStateCheckForTest();
    await testState?.cleanup();
    testState = undefined;
  });

  it("drops malformed hook files with missing/invalid paths", async () => {
    registerMalformedBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const warnings: string[] = [];
    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      warn: (message) => warnings.push(message),
    });

    expect(files.map((file) => path.relative(workspaceDir, file.path))).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "IDENTITY.md",
      "BOOTSTRAP.md",
    ]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('missing or invalid "path" field');
  });

  it("dedupes hook-injected bootstrap paths relative to the workspace", async () => {
    registerDuplicateBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const agentsPath = path.join(workspaceDir, "AGENTS.md");
    await fs.writeFile(agentsPath, "workspace rules", "utf8");

    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    const agentsFiles = files.filter((file) => file.path === agentsPath);

    expect(agentsFiles).toHaveLength(1);
    expect(agentsFiles[0]?.content).toBe("workspace rules");

    const context = await resolveBootstrapContextForRun({ workspaceDir });
    const agentsContextFiles = context.contextFiles.filter((file) => file.path === agentsPath);
    expect(agentsContextFiles).toHaveLength(1);
    expect(agentsContextFiles[0]?.content).toBe("workspace rules");
  });

  it("refreshes USER.md on every turn for long-lived sessions", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const userPath = path.join(workspaceDir, "USER.md");
    const sessionKey = `agent:main:webchat:direct:${randomUUID()}`;
    await fs.writeFile(userPath, "Prefer concise answers.", "utf8");
    const first = await resolveBootstrapFilesForRun({ workspaceDir, sessionKey });

    await fs.writeFile(userPath, "Prefer detailed answers.", "utf8");
    const second = await resolveBootstrapFilesForRun({ workspaceDir, sessionKey });

    expect(first.find((file) => file.name === "USER.md")?.content).toBe("Prefer concise answers.");
    expect(second.find((file) => file.name === "USER.md")?.content).toBe(
      "Prefer detailed answers.",
    );
  });

  it("ignores stale root BOOTSTRAP.md for home-relative workspace paths", async () => {
    registerBootstrapFileHook();
    const parentDir = await makeTempWorkspace("openclaw-bootstrap-home-");
    const workspaceDir = path.join(parentDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await writeCompletedWorkspaceState(workspaceDir);
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "rules", "utf8");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "stale ritual", "utf8");

    const files = await withEnvAsync({ OPENCLAW_HOME: parentDir }, async () =>
      resolveBootstrapFilesForRun({ workspaceDir: "~/workspace" }),
    );

    expect(files.map((file) => file.name)).toContain("AGENTS.md");
    expect(files.map((file) => file.name)).not.toContain("BOOTSTRAP.md");
  });

  it("keeps hook-added nested BOOTSTRAP.md after setup is completed", async () => {
    registerBootstrapFileHook(path.join("packages", "core", "BOOTSTRAP.md"));
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.mkdir(path.join(workspaceDir, "packages", "core"), { recursive: true });
    await writeCompletedWorkspaceState(workspaceDir);
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "rules", "utf8");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "stale ritual", "utf8");
    await fs.writeFile(
      path.join(workspaceDir, "packages", "core", "BOOTSTRAP.md"),
      "package ritual",
      "utf8",
    );

    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.map((file) => path.relative(workspaceDir, file.path))).toContain(
      path.join("packages", "core", "BOOTSTRAP.md"),
    );
    expect(files.map((file) => file.path)).not.toContain(path.join(workspaceDir, "BOOTSTRAP.md"));
  });

  it.each(["direct", "group", "channel"] as const)(
    "keeps Workspace memory and unrelated aliases for %s chats",
    async (chatType) => {
      const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-shared-alias-");
      const nestedDir = path.join(workspaceDir, "packages", "core");
      await fs.mkdir(nestedDir, { recursive: true });
      await writeWorkspaceMemory(workspaceDir, "workspace memory");
      await writeWorkspaceMemory(nestedDir, "nested memory");
      const rootAliasDir = await createDirectoryAlias({
        workspaceDir,
        targetDir: workspaceDir,
        aliasName: "root-memory-alias",
      });
      const nestedAliasDir = await createDirectoryAlias({
        workspaceDir,
        targetDir: nestedDir,
        aliasName: "nested-memory-alias",
      });
      const rootAliasPath = path.join(rootAliasDir, DEFAULT_MEMORY_FILENAME);
      const nestedAliasPath = path.join(nestedAliasDir, DEFAULT_MEMORY_FILENAME);
      registerLoadedBootstrapFilesHook([
        path.relative(workspaceDir, rootAliasPath),
        path.relative(workspaceDir, nestedAliasPath),
      ]);

      const files = await resolveBootstrapFilesForRun({
        workspaceDir,
        sessionKey: "agent:main:opaque:binding",
        chatType,
      });

      expect(files.map((file) => file.path)).toContain(rootAliasPath);
      expect(files.map((file) => file.path)).toContain(nestedAliasPath);
    },
  );

  it.runIf(process.platform !== "win32").each([
    { mode: "direct", chatType: "direct", sessionKey: "agent:main:opaque:binding" },
    { mode: "group", chatType: "group", sessionKey: "agent:main:opaque:binding" },
    { mode: "channel", chatType: "channel", sessionKey: "agent:main:opaque:binding" },
    { mode: "subagent", chatType: "direct", sessionKey: "agent:main:subagent:worker" },
    { mode: "cron", chatType: "direct", sessionKey: "agent:main:cron:daily:run:run-1" },
  ] as const)(
    "filters remote root-memory sources and keeps equal-byte nested memory for $mode",
    async ({ mode, chatType, sessionKey }) => {
      const workspaceDir = tempDirs.make("openclaw-bootstrap-gateway-");
      const remoteDir = await fs.realpath(tempDirs.make("openclaw-bootstrap-harness-"));
      const nestedDir = path.join(remoteDir, "nested");
      await fs.mkdir(nestedDir);
      await writeWorkspaceMemory(workspaceDir, "Gateway decoy");
      for (const root of [remoteDir, nestedDir]) {
        await writeWorkspaceMemory(root, "same memory bytes");
      }
      await fs.symlink(remoteDir, path.join(remoteDir, "root-alias"), "dir");
      await fs.symlink(nestedDir, path.join(remoteDir, "nested-alias"), "dir");
      const bridge = createRemoteShellSandboxFsBridge({
        sandbox: createSandboxTestContext({
          overrides: { workspaceDir, agentWorkspaceDir: workspaceDir },
        }),
        runtime: {
          remoteWorkspaceDir: remoteDir,
          remoteAgentWorkspaceDir: remoteDir,
          runRemoteShellScript: createLocalRemoteShellScriptRunner(),
        },
      });
      const release = registerAgentWorkspaceAccess(workspaceDir, { bridge });
      try {
        registerLoadedBootstrapFilesHook(
          [
            path.join("root-alias", DEFAULT_MEMORY_FILENAME),
            path.join("nested-alias", DEFAULT_MEMORY_FILENAME),
          ],
          mode === "subagent" ? "AGENTS.md" : mode === "cron" ? "SOUL.md" : undefined,
        );
        const files = await resolveBootstrapFilesForRun({ workspaceDir, sessionKey, chatType });
        const paths = files.map((file) => file.path);
        const rootAliasPath = path.join(workspaceDir, "root-alias", DEFAULT_MEMORY_FILENAME);
        if (mode === "direct" || mode === "group" || mode === "channel") {
          expect(paths).toContain(rootAliasPath);
        } else {
          expect(paths).not.toContain(rootAliasPath);
        }
        expect(
          files.find(
            (file) =>
              file.path === path.join(workspaceDir, "nested-alias", DEFAULT_MEMORY_FILENAME),
          ),
        ).toMatchObject({ content: "same memory bytes", missing: false });
        expect(files.map((file) => file.name)).not.toContain(DEFAULT_USER_FILENAME);
        expect(files.some((file) => file.content === "Gateway decoy")).toBe(false);
      } finally {
        release();
      }
    },
  );

  it("keeps Workspace memory available to shared sessions", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-hook-shared-alias-");
    const rootMemoryPath = await writeWorkspaceMemory(workspaceDir, "workspace memory");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: "agent:main:slack:channel:c1",
    });

    expect(files.map((file) => file.path)).toContain(rootMemoryPath);
  });

  it("keeps missing hook records without source identity when policy allows them", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-missing-hook-record-");
    await writeWorkspaceMemory(workspaceDir, "workspace memory");
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "SOUL.md",
          path: path.join(context.workspaceDir, "generated", "SOUL.md"),
          missing: true,
        },
      ];
    });

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: "agent:main:opaque:binding",
      chatType: "channel",
    });

    expect(files).toContainEqual({
      name: "SOUL.md",
      path: path.join(workspaceDir, "generated", "SOUL.md"),
      missing: true,
    });
  });

  it.each([
    {
      mode: "subagent",
      sessionKey: "agent:main:subagent:worker",
      relabeledName: "AGENTS.md",
      expectedNames: ["AGENTS.md"],
    },
    {
      mode: "cron",
      sessionKey: "agent:main:cron:daily:run:run-1",
      relabeledName: "SOUL.md",
      expectedNames: ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"],
    },
  ] as const)(
    "rejects loader aliases to root memory relabeled under the $mode allowlist",
    async ({ sessionKey, relabeledName, expectedNames }) => {
      const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-restricted-");
      const rootMemoryPath = path.join(workspaceDir, DEFAULT_MEMORY_FILENAME);
      const aliasDir = await createDirectoryAlias({
        workspaceDir,
        targetDir: workspaceDir,
        aliasName: "root-memory-alias",
      });
      registerLoadedBootstrapFilesHook(
        [path.relative(workspaceDir, path.join(aliasDir, DEFAULT_MEMORY_FILENAME))],
        relabeledName,
      );
      await Promise.all(
        [
          ["AGENTS.md", "project rules"],
          ["SOUL.md", "persona"],
          ["IDENTITY.md", "identity"],
          ["USER.md", "user profile"],
          [DEFAULT_MEMORY_FILENAME, "memory"],
          ["HEARTBEAT.md", "heartbeat"],
          ["BOOTSTRAP.md", "setup"],
        ].map(([fileName, content]) =>
          fs
            .mkdir(
              path.dirname(
                path.join(workspaceDir, expectDefined(fileName, "fileName test invariant")),
              ),
              { recursive: true },
            )
            .then(() =>
              fs.writeFile(
                path.join(workspaceDir, expectDefined(fileName, "fileName test invariant")),
                expectDefined(content, "content test invariant"),
                "utf8",
              ),
            ),
        ),
      );

      const files = await resolveBootstrapFilesForRun({ workspaceDir, sessionKey });

      expect(files.map((file) => file.name)).toStrictEqual(expectedNames);
      expect(files.map((file) => file.path)).not.toContain(rootMemoryPath);
    },
  );
});

describe("resolveBootstrapContextForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("keeps bootstrap context empty in lightweight heartbeat mode", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "persona", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      contextMode: "lightweight",
      runKind: "heartbeat",
    });

    // Heartbeat context comes from cron scratch via the heartbeat runner now.
    expect(files).toStrictEqual([]);
  });
});

describe("resolveBootstrapContextForDiagnostics", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  function createExtraFilesConfig(hooksEnabled?: boolean): OpenClawConfig {
    return {
      hooks: {
        internal: {
          enabled: hooksEnabled,
          entries: {
            "bootstrap-extra-files": { enabled: true, paths: ["packages/*/AGENTS.md"] },
          },
        },
      },
    };
  }

  async function makeWorkspaceWithExtraAgentsFile(): Promise<{
    workspaceDir: string;
    extraPath: string;
  }> {
    const workspaceDir = await fs.realpath(await makeTempWorkspace("openclaw-bootstrap-diag-"));
    const extraPath = path.join(workspaceDir, "packages", "core", "AGENTS.md");
    await fs.mkdir(path.dirname(extraPath), { recursive: true });
    await fs.writeFile(extraPath, "extra agents", "utf8");
    return { workspaceDir, extraPath };
  }

  it("does not execute registered hooks while projecting declared files", async () => {
    const { workspaceDir, extraPath } = await makeWorkspaceWithExtraAgentsFile();
    const handler = vi.fn(() => {
      throw new Error("diagnostics must not execute hook code");
    });
    registerInternalHook("agent:bootstrap", handler);

    const result = await resolveBootstrapContextForDiagnostics({
      workspaceDir,
      config: createExtraFilesConfig(),
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result.contextFiles).toContainEqual({ path: extraPath, content: "extra agents" });
  });

  it("projects nothing while the hook system is disabled", async () => {
    const { workspaceDir, extraPath } = await makeWorkspaceWithExtraAgentsFile();

    const result = await resolveBootstrapContextForDiagnostics({
      workspaceDir,
      config: createExtraFilesConfig(false),
    });

    expect(result.bootstrapFiles.map((file) => file.path)).not.toContain(extraPath);
  });

  it.each([
    { label: "an import failure", handler: 'throw new Error("must not import");', projects: false },
    { label: "no readable handler", handler: undefined, projects: true },
  ])(
    "matches fresh-start selection for a managed hook with $label",
    async ({ handler, projects }) => {
      const { workspaceDir, extraPath } = await makeWorkspaceWithExtraAgentsFile();
      const managedHooksDir = await makeTempWorkspace("openclaw-managed-hooks-");
      const replacementDir = path.join(managedHooksDir, "bootstrap-extra-files");
      await fs.mkdir(replacementDir, { recursive: true });
      await fs.writeFile(
        path.join(replacementDir, "HOOK.md"),
        [
          "---",
          "name: bootstrap-extra-files",
          "description: managed replacement",
          'metadata: { "openclaw": { "events": ["agent:bootstrap"] } }',
          "---",
          "",
        ].join("\n"),
        "utf8",
      );
      if (handler !== undefined) {
        await fs.writeFile(path.join(replacementDir, "handler.js"), handler, "utf8");
      }
      const config = createExtraFilesConfig();
      config.hooks!.internal!.load = { extraDirs: [managedHooksDir] };

      const result = await resolveBootstrapContextForDiagnostics({ workspaceDir, config });

      expect(result.bootstrapFiles.some((file) => file.path === extraPath)).toBe(projects);
    },
  );
});

describe("hasCompletedBootstrapTurn", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-bootstrap-turn-");
  let tmpDir: string;
  let sessionTarget: SessionTranscriptRuntimeTarget;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = sessionDirs.make();
    sessionTarget = {
      agentId: "main",
      sessionId: randomUUID(),
      sessionKey: "agent:main:bootstrap-turn",
      storePath: path.join(tmpDir, "sessions.json"),
    };
    await upsertSessionEntryCore(sessionTarget, {
      sessionId: sessionTarget.sessionId,
      updatedAt: Date.now(),
    });
    sessionManager = SessionManager.open(sessionTarget, tmpDir);
  });

  it("returns false without a complete SQLite transcript identity", async () => {
    expect(await hasCompletedBootstrapTurn()).toBe(false);
    expect(await hasCompletedBootstrapTurn({ ...sessionTarget, storePath: undefined })).toBe(false);
  });

  it("returns false when no full bootstrap marker has been recorded", async () => {
    sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    sessionManager.appendCustomEntry("openclaw:unrelated", { timestamp: 2 });

    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(false);
  });

  it("invalidates a completion marker after compaction", async () => {
    const firstEntryId = sessionManager.appendMessage(makeUserMessage("hello", 1));
    sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, { timestamp: 2 });
    sessionManager.appendCompaction("trimmed", firstEntryId, 10);

    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(false);
  });

  it("accepts a newer full bootstrap marker after compaction", async () => {
    const firstEntryId = sessionManager.appendMessage(makeUserMessage("hello", 1));
    sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, { timestamp: 2 });
    sessionManager.appendCompaction("trimmed", firstEntryId, 10);
    sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, { timestamp: 3 });

    const hostExec = vi.spyOn(DatabaseSync.prototype, "exec");
    try {
      expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(true);
      expect(hostExec.mock.calls.filter(([sql]) => /^BEGIN\b/iu.test(sql))).toEqual([]);
    } finally {
      hostExec.mockRestore();
    }
  });

  it("invalidates a completion marker after a session reset", async () => {
    sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, { timestamp: 2 });
    sessionManager.appendResetBoundary("reset");

    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(false);
  });

  it("ignores completion markers on an inactive transcript branch", async () => {
    const firstEntryId = sessionManager.appendMessage(makeUserMessage("hello", 1));
    sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, { timestamp: 2 });
    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(true);

    sessionManager.appendLeafControl({
      targetId: firstEntryId,
      appendParentId: firstEntryId,
    });
    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(false);
  });
});

describe("makeBootstrapWarn", () => {
  it("deduplicates repeated warnings for the same session and message", () => {
    const warnings: string[] = [];
    const warn = makeBootstrapWarn({
      sessionLabel: "agent:main:test-session",
      workspaceDir: `/tmp/${randomUUID()}`,
      warn: (message) => warnings.push(message),
    });

    warn?.("workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating");
    warn?.("workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating");

    expect(warnings).toEqual([
      "workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating (sessionKey=agent:main:test-session)",
    ]);
  });
});

describe("resolveContextInjectionMode", () => {
  it("defaults to always when config is missing", () => {
    expect(resolveContextInjectionMode(undefined)).toBe("always");
  });

  it("uses per-agent contextInjection before defaults", () => {
    expect(
      resolveContextInjectionMode(
        {
          agents: {
            defaults: { contextInjection: "continuation-skip" },
            entries: { strict: { contextInjection: "always" } },
          },
        } as never,
        "strict",
      ),
    ).toBe("always");
  });

  it("falls back to defaults when the agent has no contextInjection override", () => {
    expect(
      resolveContextInjectionMode(
        {
          agents: {
            defaults: { contextInjection: "never" },
            entries: { worker: {} },
          },
        } as never,
        "worker",
      ),
    ).toBe("never");
  });
});
