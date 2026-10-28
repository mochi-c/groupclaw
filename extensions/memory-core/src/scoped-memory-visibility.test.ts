import { describe, expect, it } from "vitest";
import {
  filterMemorySearchHitsByConversationScope,
  isConversationScopedMemoryPath,
  type ScopedMemoryContext,
} from "./scoped-memory-visibility.js";

const context: ScopedMemoryContext = {
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
  ],
  fragment: {
    scope: { kind: "thread", channelId: "channel-1", threadId: "thread-1" },
    resolveRelativePath: ({ createdDate }) =>
      `memory/Channel/id-channel/Thread/id-thread/Fragment/${createdDate}.md`,
  },
};

describe("conversation-scoped memory visibility", () => {
  it.each([
    ["workspace memory", "memory/MEMORY.md"],
    ["channel memory", "memory/Channel/id-channel/MEMORY.md"],
    ["channel fragment", "memory/Channel/id-channel/Fragment/2026-10-24.md"],
    ["channel event", "memory/Channel/id-channel/Event/2026-10-24_joined_1.md"],
    ["channel archive", "memory/Channel/id-channel/Archive/2026-09_summary_1.md"],
    ["thread memory", "memory/Channel/id-channel/Thread/id-thread/MEMORY.md"],
    ["thread fragment", "memory/Channel/id-channel/Thread/id-thread/Fragment/2026-10-24.md"],
    ["participant user memory", "memory/User/id-alice/MEMORY.md"],
    ["configured shared source", "docs/reference/project.md"],
    ["normalized relative prefix", "./memory/MEMORY.md"],
  ])("allows %s", (_label, relativePath) => {
    expect(isConversationScopedMemoryPath(relativePath, context)).toBe(true);
  });

  it.each([
    ["other channel memory", "memory/Channel/id-other/MEMORY.md"],
    ["other channel fragment", "memory/Channel/id-other/Fragment/2026-10-24.md"],
    ["sibling thread", "memory/Channel/id-channel/Thread/id-other-thread/MEMORY.md"],
    ["other participant memory", "memory/User/id-bob/MEMORY.md"],
    ["legacy loose daily note", "memory/2026-04-01.md"],
    ["workspace event evidence", "memory/Event/2026-10-24_x_1.md"],
    ["workspace archive evidence", "memory/Archive/2026-09_x_1.md"],
    ["dreaming auxiliary", "memory/dreaming/report.md"],
    ["path traversal", "memory/Channel/id-channel/../../MEMORY.md"],
    ["absolute path", "/memory/MEMORY.md"],
    ["windows separators escape", "memory\\..\\MEMORY.md"],
  ])("denies %s", (_label, relativePath) => {
    expect(isConversationScopedMemoryPath(relativePath, context)).toBe(false);
  });

  it("excludes all launch Channel artifacts while preserving its current Thread and Users", () => {
    const launchContext = {
      ...context,
      artifacts: context.artifacts.filter((artifact) => artifact.layer !== "channel"),
    };
    for (const relativePath of [
      "memory/Channel/id-channel/MEMORY.md",
      "memory/Channel/id-channel/Fragment/2026-10-24.md",
      "memory/Channel/id-channel/Event/2026-10-24_joined_1.md",
      "memory/Channel/id-channel/Archive/2026-09_summary_1.md",
    ]) {
      expect(isConversationScopedMemoryPath(relativePath, launchContext)).toBe(false);
    }
    expect(
      isConversationScopedMemoryPath(
        "memory/Channel/id-channel/Thread/id-thread/MEMORY.md",
        launchContext,
      ),
    ).toBe(true);
    expect(isConversationScopedMemoryPath("memory/User/id-alice/MEMORY.md", launchContext)).toBe(
      true,
    );
  });

  it("filters only out-of-scope memory hits and leaves other sources untouched", () => {
    const hit = (source: "memory" | "sessions" | "wiki", p: string) =>
      ({ source, path: p, startLine: 1, endLine: 1, score: 1, snippet: "" }) as never;
    const hits = [
      hit("memory", "memory/Channel/id-channel/Thread/id-thread/Fragment/2026-10-24.md"),
      hit("memory", "memory/Channel/id-other/Fragment/2026-10-24.md"),
      hit("sessions", "sessions/other-transcript.jsonl"),
      hit("wiki", "wiki/summary.md"),
    ];

    const filtered = filterMemorySearchHitsByConversationScope({ hits, context });

    expect(filtered.map((entry) => entry.path)).toEqual([
      "memory/Channel/id-channel/Thread/id-thread/Fragment/2026-10-24.md",
      "sessions/other-transcript.jsonl",
      "wiki/summary.md",
    ]);
  });
});
