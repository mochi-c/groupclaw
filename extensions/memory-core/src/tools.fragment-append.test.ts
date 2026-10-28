import "./tools.session-catalog.test-mocks.js";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMORY_FRAGMENT_MAX_CHARS } from "./fragment-memory-write.js";
import {
  getAppendAgentMemoryFragmentFileMockParams,
  resetMemoryToolMockState,
} from "./memory-tool-manager.test-mocks.js";
import { createMemoryFragmentAppendTool } from "./tools.fragment-append.js";
import { createMemoryFragmentAppendToolOrThrow } from "./tools.test-helpers.js";

type MemoryAudience = NonNullable<OpenClawPluginToolContext["memoryAudience"]>;

function audience(kind: "channel" | "thread" = "thread"): MemoryAudience {
  const scopePrefix =
    kind === "thread" ? "memory/Channel/id-channel/Thread/id-thread" : "memory/Channel/id-channel";
  const fragmentScope =
    kind === "thread"
      ? ({ kind: "thread", channelId: "channel-1", threadId: "thread-1" } as const)
      : ({ kind: "channel", channelId: "channel-1" } as const);
  return {
    kind: "conversation",
    agentId: "main",
    sessionKey: "agent:main:discord:family",
    sessionId: "00000000-0000-4000-8000-000000000001",
    context: {
      participantCoverage: "complete",
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
      ],
      fragment: {
        scope: fragmentScope,
        // The host mints one append-only day file per scope; repeated notes
        // share the same path regardless of title or entry time.
        resolveRelativePath: ({ createdDate }) => `${scopePrefix}/Fragment/${createdDate}.md`,
      },
    },
  };
}

describe("memory_fragment_append", () => {
  beforeEach(() => resetMemoryToolMockState());

  it("appends one entry to the admitted thread scope's dated fragment file", async () => {
    const assertCurrent = vi.fn();
    const tool = createMemoryFragmentAppendToolOrThrow({
      memoryAudience: audience("thread"),
      assertMemoryAudienceCurrent: assertCurrent,
    });

    const result = await tool.execute("fragment-thread", {
      content: "  Alice decided to ship on Friday.  ",
      title: "planning-time",
    });

    const calls = getAppendAgentMemoryFragmentFileMockParams();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.content).toBe("Alice decided to ship on Friday.");
    expect(calls[0]?.title).toBe("planning-time");
    expect(calls[0]?.timeLabel).toMatch(/^\d{2}:\d{2}$/u);
    expect(calls[0]?.relPath).toMatch(
      /^memory\/Channel\/id-channel\/Thread\/id-thread\/Fragment\/\d{4}-\d{2}-\d{2}\.md$/u,
    );
    expect(result.details).toMatchObject({
      scope: "thread",
      path: calls[0]?.relPath,
      entryTime: calls[0]?.timeLabel,
      maxChars: MEMORY_FRAGMENT_MAX_CHARS,
    });
    expect(result.details).toHaveProperty("createdAtMs", expect.any(Number));
    // Authority is rechecked before and after the awaited write.
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });

  it("routes channel notes to the channel fragment day file outside a thread", async () => {
    const tool = createMemoryFragmentAppendToolOrThrow({
      memoryAudience: audience("channel"),
      assertMemoryAudienceCurrent: () => {},
    });

    await tool.execute("fragment-channel", {
      content: "Stand-up moved to 09:30.",
      title: "stand-up",
    });

    const call = getAppendAgentMemoryFragmentFileMockParams()[0];
    expect(call?.relPath).toMatch(
      /^memory\/Channel\/id-channel\/Fragment\/\d{4}-\d{2}-\d{2}\.md$/u,
    );
  });

  it("resolves the same day file for repeated notes", async () => {
    const tool = createMemoryFragmentAppendToolOrThrow({
      memoryAudience: audience(),
      assertMemoryAudienceCurrent: () => {},
    });

    await tool.execute("fragment-first", { content: "First note.", title: "one" });
    await tool.execute("fragment-second", { content: "Second note." });

    const calls = getAppendAgentMemoryFragmentFileMockParams();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.relPath).toBe(calls[1]?.relPath);
    expect(calls[1]?.title).toBeUndefined();
  });

  it("rejects empty content without writing", async () => {
    const tool = createMemoryFragmentAppendToolOrThrow({
      memoryAudience: audience(),
      assertMemoryAudienceCurrent: () => {},
    });

    await expect(tool.execute("fragment-empty", { content: "   " })).rejects.toThrow(
      "content required",
    );
    expect(getAppendAgentMemoryFragmentFileMockParams()).toHaveLength(0);
  });

  it("rejects oversized content without writing", async () => {
    const tool = createMemoryFragmentAppendToolOrThrow({
      memoryAudience: audience(),
      assertMemoryAudienceCurrent: () => {},
    });

    await expect(
      tool.execute("fragment-large", { content: "x".repeat(MEMORY_FRAGMENT_MAX_CHARS + 1) }),
    ).rejects.toThrow(`content must be at most ${MEMORY_FRAGMENT_MAX_CHARS} characters`);
    expect(getAppendAgentMemoryFragmentFileMockParams()).toHaveLength(0);
  });

  it("stops when the host revokes audience authority before the write", async () => {
    const tool = createMemoryFragmentAppendToolOrThrow({
      memoryAudience: audience(),
      assertMemoryAudienceCurrent: () => {
        throw new Error("memory audience is no longer current");
      },
    });

    await expect(tool.execute("fragment-stale", { content: "A revoked note." })).rejects.toThrow(
      "memory audience is no longer current",
    );
    expect(getAppendAgentMemoryFragmentFileMockParams()).toHaveLength(0);
  });

  it("is unavailable without an admitted fragment scope", () => {
    expect(
      createMemoryFragmentAppendTool({
        config: { agents: { entries: { main: {} } } } as never,
        assertMemoryAudienceCurrent: () => {},
      }),
    ).toBeNull();
    expect(
      createMemoryFragmentAppendTool({
        config: { agents: { entries: { main: {} } } } as never,
        memoryAudience: audience(),
      }),
    ).toBeNull();
  });
});
