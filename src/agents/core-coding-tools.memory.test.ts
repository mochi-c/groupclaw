import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real audience owner mints grants; only its committed session facts are fake.
// mock-isolation: keep the file-tool fixture independent of loaded channel runtimes and transports.
vi.mock("../channels/plugins/registry-loaded.js", () => ({
  getLoadedChannelPluginById: () => undefined,
  listLoadedChannelPluginsForRegistry: () => [],
}));
// mock-isolation: the in-memory session owner supplies revocation without a live SQLite store.
vi.mock("../config/sessions/session-delivery-generation.js", async () => {
  const { fakeSessionGenerationModule } =
    await import("../plugins/memory-audience.test-support.js");
  return fakeSessionGenerationModule;
});
// mock-isolation: share the same in-memory session facts instead of reading an operator session store.
vi.mock("../config/sessions/session-entry-read-runtime.js", async () => {
  const { fakeSessionEntryReadModule } = await import("../plugins/memory-audience.test-support.js");
  return fakeSessionEntryReadModule;
});

import { resolveMemoryArtifactRelativePath } from "../memory/scoped-memory.js";
import {
  resolveMemoryAudienceFromEntry,
  type MemoryAudienceGrant,
} from "../plugins/memory-audience.js";
import { fakeSessionOwner } from "../plugins/memory-audience.test-support.js";
import { getAgentToolActionDescriptor } from "./agent-tool-metadata.js";
import { createCoreCodingTools } from "./core-coding-tools.js";
import {
  createSandbox,
  createSandboxFsBridge,
  installFsBridgeTestHarness,
  mockedExecDockerRaw,
  mockContainerCanonicalPaths,
} from "./sandbox/fs-bridge.test-helpers.js";
import { getTextContent } from "./test-helpers/agent-tools-fs-helpers.js";

const SESSION_KEY = "agent:main:discord:channel:101";
let workspace: string;
let grant: MemoryAudienceGrant;
let ownPath: string;
let otherPath: string;

beforeEach(async () => {
  fakeSessionOwner.reset();
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-file-tools-"));
  const entry = {
    sessionId: randomUUID(),
    lifecycleRevision: randomUUID(),
    updatedAt: 1,
    chatType: "channel" as const,
    delivery: {
      kind: "external" as const,
      route: { channel: "discord", target: { to: "channel:101" } },
      context: { channel: "discord", to: "channel:101" },
      origin: {
        provider: "discord",
        nativeChannelId: "101",
        nativeParentChannelId: "100",
        threadId: "101",
      },
    },
  };
  fakeSessionOwner.rows.set(SESSION_KEY, entry);
  const resolved = await resolveMemoryAudienceFromEntry(
    {
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionId: entry.sessionId,
      senderIsOwner: false,
      storePath: path.join(workspace, "unused.sqlite"),
    },
    entry,
  );
  if (resolved.status !== "granted") {
    throw new Error(resolved.reason);
  }
  grant = resolved;
  const own = grant.audience.context!.artifacts.find((artifact) => artifact.layer === "thread")!;
  ownPath = own.relativePath;
  otherPath = resolveMemoryArtifactRelativePath({
    scope: {
      kind: "thread",
      channelId: own.scope.kind === "thread" ? own.scope.channelId : "",
      threadId: "other",
    },
    artifactKind: "memory",
  });
  for (const [filePath, content] of [
    [ownPath, "OWN_MEMORY"],
    [otherPath, "OTHER_MEMORY"],
    ["source.txt", "SOURCE"],
  ] as const) {
    await fs.mkdir(path.dirname(path.join(workspace, filePath)), { recursive: true });
    await fs.writeFile(path.join(workspace, filePath), content);
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  grant?.release();
  await fs.rm(workspace, { recursive: true, force: true });
});

function tools(
  workspaceOnly = true,
  withAudience = true,
  shellTools: "full" | "patch-only" = "patch-only",
) {
  const result = createCoreCodingTools({
    codingRoot: workspace,
    containmentRoot: workspace,
    memoryWorkspaceDir: workspace,
    memorySessionKey: SESSION_KEY,
    memoryAudience: withAudience ? grant.audience : undefined,
    includeBaseCodingTools: true,
    shellTools,
    workspaceOnly,
    readOnly: false,
    applyPatchEnabled: true,
    applyPatchWorkspaceOnly: workspaceOnly,
    execDefaults: {},
    processDefaults: {},
  });
  return (name: string) => result.find((tool) => tool.name === name)!;
}

describe("ordinary coding tools with an admitted memory audience", () => {
  it("refuses an unsandboxed full shell for a conversation audience", () => {
    expect(() => tools(true, true, "full")).toThrow("isolated project sandbox");
  });

  it.each([true, false])(
    "restricts reads and listings and preserves source editing with workspaceOnly=%s",
    async (workspaceOnly) => {
      const tool = tools(workspaceOnly);
      expect(getAgentToolActionDescriptor(tool("read"))).toEqual({
        family: "data",
        operation: "filesystem",
      });
      expect(getAgentToolActionDescriptor(tool("apply_patch"))).toEqual({
        family: "tool",
        operation: "process",
      });
      expect(getTextContent(await tool("read").execute("own", { path: ownPath }))).toContain(
        "OWN_MEMORY",
      );
      await expect(tool("read").execute("other", { path: otherPath })).rejects.toThrow(
        "conversation audience",
      );
      const threadRoot = path.dirname(path.dirname(ownPath));
      const listing = getTextContent(await tool("ls").execute("list", { path: threadRoot }));
      expect(listing).toContain(path.basename(path.dirname(ownPath)));
      expect(listing).not.toContain(path.basename(path.dirname(otherPath)));
      await tool("write").execute("source", { path: "source.txt", content: "CHANGED" });
      await tool("edit").execute("source-edit", {
        path: "source.txt",
        edits: [{ oldText: "CHANGED", newText: "EDITED" }],
      });
      await tool("apply_patch").execute("source-patch", {
        input: "*** Begin Patch\n*** Update File: source.txt\n@@\n-EDITED\n+PATCHED\n*** End Patch",
      });
      expect(await fs.readFile(path.join(workspace, "source.txt"), "utf8")).toBe("PATCHED");
    },
  );

  it("blocks direct writes, edits, patch deletion and moves into curated memory", async () => {
    const tool = tools();
    await expect(
      tool("write").execute("write", { path: ownPath, content: "LOST" }),
    ).rejects.toThrow("memory_fragment_append");
    await expect(
      tool("edit").execute("edit", {
        path: ownPath,
        edits: [{ oldText: "OWN_MEMORY", newText: "LOST" }],
      }),
    ).rejects.toThrow("memory_fragment_append");
    for (const input of [
      `*** Begin Patch\n*** Delete File: ${ownPath}\n*** End Patch`,
      `*** Begin Patch\n*** Update File: source.txt\n*** Move to: ${path.dirname(ownPath)}/new.md\n@@\n-SOURCE\n+LOST\n*** End Patch`,
    ]) {
      await expect(tool("apply_patch").execute("patch", { input })).rejects.toThrow(
        "memory_fragment_append",
      );
    }
    expect(await fs.readFile(path.join(workspace, ownPath), "utf8")).toBe("OWN_MEMORY");
    expect(await fs.readFile(path.join(workspace, "source.txt"), "utf8")).toBe("SOURCE");
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlink and hardlink aliases to another discussion",
    async () => {
      const tool = tools(false);
      await fs.symlink(path.join(workspace, otherPath), path.join(workspace, "alias.txt"));
      await fs.link(path.join(workspace, otherPath), path.join(workspace, "hardlink.txt"));
      for (const alias of ["alias.txt", "hardlink.txt"]) {
        await expect(tool("read").execute("alias-read", { path: alias })).rejects.toThrow();
        await expect(
          tool("write").execute("alias-write", { path: alias, content: "LOST" }),
        ).rejects.toThrow();
      }
      expect(await fs.readFile(path.join(workspace, otherPath), "utf8")).toBe("OTHER_MEMORY");
    },
  );

  it("withholds a read result after its session generation changes during I/O", async () => {
    const tool = tools();
    const access = fs.access.bind(fs);
    vi.spyOn(fs, "access").mockImplementation(async (...args) => {
      await access(...args);
      fakeSessionOwner.rows.delete(SESSION_KEY);
    });
    await expect(tool("read").execute("stale", { path: ownPath })).rejects.toThrow(
      "no longer current",
    );
  });

  it("denies memory paths when audience admission failed while ordinary source remains readable", async () => {
    const tool = tools(true, false);
    await expect(tool("read").execute("unadmitted", { path: ownPath })).rejects.toThrow(
      "conversation audience",
    );
    expect(getTextContent(await tool("read").execute("source", { path: "source.txt" }))).toContain(
      "SOURCE",
    );
  });
});

describe("sandbox memory file boundaries", () => {
  installFsBridgeTestHarness();

  it("checks the actual read source and final mutation authority in the sandbox bridge", async () => {
    const sandbox = createSandbox({
      workspaceDir: workspace,
      agentWorkspaceDir: workspace,
      workspaceAccess: "rw",
    });
    let reachedMutation = false;
    sandbox.backend = {
      id: "test",
      runtimeId: "owned-fixture",
      runtimeLabel: "owned-fixture",
      workdir: "/workspace",
      supportsCommandAuthority: true,
      buildExecSpec: async () => {
        throw new Error("No execution in this fixture");
      },
      runShellCommand: async (command) => {
        if (command.assertCurrent) {
          reachedMutation = true;
          fakeSessionOwner.rows.delete(SESSION_KEY);
          command.assertCurrent();
        }
        return mockedExecDockerRaw(
          [
            "exec",
            "-i",
            sandbox.containerName,
            "sh",
            "-c",
            command.script,
            "openclaw-sandbox-fs",
            ...(command.args ?? []),
          ],
          { input: command.stdin, allowFailure: command.allowFailure, signal: command.signal },
        );
      },
    };
    sandbox.fsBridge = createSandboxFsBridge({ sandbox });
    const result = createCoreCodingTools({
      codingRoot: workspace,
      containmentRoot: workspace,
      memoryWorkspaceDir: workspace,
      memorySessionKey: SESSION_KEY,
      memoryAudience: grant.audience,
      sandbox,
      includeBaseCodingTools: true,
      shellTools: "patch-only",
      workspaceOnly: true,
      readOnly: false,
      applyPatchEnabled: true,
      applyPatchWorkspaceOnly: true,
      execDefaults: {},
      processDefaults: {},
    });
    const tool = (name: string) => result.find((entry) => entry.name === name)!;
    expect(getTextContent(await tool("read").execute("sandbox-read", { path: ownPath }))).toContain(
      "OWN_MEMORY",
    );
    await fs.symlink(path.join(workspace, otherPath), path.join(workspace, "alias"));
    mockContainerCanonicalPaths({ "/workspace/alias": `/workspace/${otherPath}` });
    await expect(tool("read").execute("sandbox-alias", { path: "alias" })).rejects.toThrow(
      "conversation audience",
    );
    await expect(
      tool("write").execute("sandbox-memory", { path: ownPath, content: "LOST" }),
    ).rejects.toThrow("memory_fragment_append");
    await expect(
      tool("write").execute("sandbox-source", { path: "source.txt", content: "LOST" }),
    ).rejects.toThrow("no longer current");
    expect(reachedMutation).toBe(true);
    expect(await fs.readFile(path.join(workspace, "source.txt"), "utf8")).toBe("SOURCE");
    expect(await fs.readFile(path.join(workspace, otherPath), "utf8")).toBe("OTHER_MEMORY");
  });
});
