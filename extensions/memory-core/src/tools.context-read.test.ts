import "./tools.session-catalog.test-mocks.js";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getReadAgentMemoryFileMockParams,
  resetMemoryToolMockState,
  setMemoryReadFileImpl,
} from "./memory-tool-manager.test-mocks.js";
import { createMemoryContextReadToolOrThrow } from "./tools.test-helpers.js";

type MemoryAudience = NonNullable<OpenClawPluginToolContext["memoryAudience"]>;

function audience(params?: {
  participantCoverage?: "complete" | "partial";
  duplicateBob?: boolean;
}): MemoryAudience {
  return {
    kind: "conversation",
    agentId: "main",
    sessionKey: "agent:main:discord:family",
    sessionId: "00000000-0000-4000-8000-000000000001",
    context: {
      participantCoverage: params?.participantCoverage ?? "complete",
      artifacts: [
        {
          layer: "workspace",
          scope: { kind: "workspace" },
          relativePath: "memory/MEMORY.md",
        },
        {
          layer: "channel",
          scope: { kind: "channel", channelId: "channel-1" },
          relativePath: "memory/Channel/id-channel/MEMORY.md",
        },
        {
          layer: "thread",
          scope: { kind: "thread", channelId: "channel-1", threadId: "thread-1" },
          relativePath: "memory/Channel/id-channel/Thread/id-thread/MEMORY.md",
        },
        {
          layer: "users",
          scope: { kind: "user", userId: "user-alice" },
          userName: "Alice",
          relativePath: "memory/User/id-alice/MEMORY.md",
        },
        {
          layer: "users",
          scope: { kind: "user", userId: "user-bob" },
          userName: "Bob",
          relativePath: "memory/User/id-bob/MEMORY.md",
        },
        ...(params?.duplicateBob
          ? [
              {
                layer: "users" as const,
                scope: { kind: "user" as const, userId: "user-bob-2" },
                userName: "BOB",
                relativePath: "memory/User/id-bob-2/MEMORY.md",
              },
            ]
          : []),
      ],
      fragment: {
        scope: { kind: "thread", channelId: "channel-1", threadId: "thread-1" },
        resolveRelativePath: ({ createdDate }) =>
          `memory/Channel/id-channel/Thread/id-thread/Fragment/${createdDate}.md`,
      },
    },
  };
}

describe("memory_context_read", () => {
  beforeEach(() => resetMemoryToolMockState());

  it("reads every current curated layer and participant by default", async () => {
    const assertCurrent = vi.fn();
    setMemoryReadFileImpl(async ({ relPath, from, lines }) => ({
      status: "ok",
      path: relPath,
      text: `contents:${relPath}`,
      from: from ?? 1,
      lines: lines ?? 120,
    }));
    const tool = createMemoryContextReadToolOrThrow({
      memoryAudience: audience(),
      assertMemoryAudienceCurrent: assertCurrent,
    });

    const result = await tool.execute("context-default", {});

    expect(getReadAgentMemoryFileMockParams().map(({ relPath }) => relPath)).toEqual([
      "memory/MEMORY.md",
      "memory/Channel/id-channel/MEMORY.md",
      "memory/Channel/id-channel/Thread/id-thread/MEMORY.md",
      "memory/User/id-alice/MEMORY.md",
      "memory/User/id-bob/MEMORY.md",
    ]);
    expect(result.details).toMatchObject({
      detail: "full",
      participantCoverage: "complete",
      omittedItems: 0,
      items: [
        { layer: "workspace", scope: "workspace", status: "ok" },
        { layer: "channel", scope: "channel", status: "ok" },
        { layer: "thread", scope: "thread", status: "ok" },
        { layer: "users", scope: "user", userName: "Alice", status: "ok" },
        { layer: "users", scope: "user", userName: "Bob", status: "ok" },
      ],
    });
    expect(JSON.stringify(result.details)).not.toMatch(/Event|Archive/u);
    expect(assertCurrent).toHaveBeenCalledTimes(10);
  });

  it("narrows users by explicit unambiguous names and rejects ambiguous names", async () => {
    const tool = createMemoryContextReadToolOrThrow({
      memoryAudience: audience(),
      assertMemoryAudienceCurrent: () => {},
    });

    const result = await tool.execute("context-user", {
      layers: ["users"],
      userNames: ["bob"],
      detail: "summary",
    });

    expect(getReadAgentMemoryFileMockParams()).toEqual([
      expect.objectContaining({ relPath: "memory/User/id-bob/MEMORY.md" }),
    ]);
    expect(result.details).toMatchObject({
      detail: "summary",
      items: [{ layer: "users", userName: "Bob" }],
    });

    const ambiguousTool = createMemoryContextReadToolOrThrow({
      memoryAudience: audience({ duplicateBob: true }),
      assertMemoryAudienceCurrent: () => {},
    });
    await expect(
      ambiguousTool.execute("context-ambiguous", {
        layers: ["users"],
        userNames: ["Bob"],
      }),
    ).rejects.toThrow("userName is ambiguous");
  });

  it("continues a truncated artifact with an opaque cursor", async () => {
    setMemoryReadFileImpl(async ({ relPath, from }) => ({
      status: "ok",
      path: relPath,
      text: from === 5 ? "workspace-page-2" : "workspace-page-1",
      from: from ?? 1,
      lines: 4,
      ...(from === 5 ? {} : { truncated: true, nextFrom: 5 }),
    }));
    const tool = createMemoryContextReadToolOrThrow({
      memoryAudience: audience({ participantCoverage: "partial" }),
      assertMemoryAudienceCurrent: () => {},
    });

    const first = await tool.execute("context-page-1", { layers: ["workspace"] });
    const firstDetails = first.details as {
      nextCursor?: string;
      warnings?: string[];
      items: Array<{ text: string }>;
    };
    expect(firstDetails.items[0]?.text).toBe("workspace-page-1");
    expect(firstDetails.nextCursor).toEqual(expect.any(String));
    expect(firstDetails.warnings).toBeUndefined();

    const second = await tool.execute("context-page-2", { cursor: firstDetails.nextCursor });
    expect(second.details).toMatchObject({
      omittedItems: 0,
      items: [{ text: "workspace-page-2", from: 5 }],
    });
    expect(getReadAgentMemoryFileMockParams().at(-1)).toEqual(
      expect.objectContaining({ relPath: "memory/MEMORY.md", from: 5 }),
    );
  });

  it("rechecks host authority after each awaited read", async () => {
    let current = true;
    setMemoryReadFileImpl(async ({ relPath }) => {
      current = false;
      return { status: "ok", path: relPath, text: "stale", from: 1, lines: 1 };
    });
    const tool = createMemoryContextReadToolOrThrow({
      memoryAudience: audience(),
      assertMemoryAudienceCurrent: () => {
        if (!current) {
          throw new Error("memory audience is no longer current");
        }
      },
    });

    await expect(tool.execute("context-stale", { layers: ["workspace"] })).rejects.toThrow(
      "memory audience is no longer current",
    );
  });
});
