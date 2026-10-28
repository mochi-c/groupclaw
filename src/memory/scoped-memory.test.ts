import path from "node:path";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { describe, expect, it } from "vitest";
import {
  resolveCanonicalMemoryChannelId,
  resolveCanonicalMemoryThreadId,
  resolveMemoryArtifactRelativePath,
  resolveMemoryContextReadContext,
} from "./scoped-memory.js";

describe("scoped memory paths", () => {
  it("maps workspace, channel, thread, and user memory to one canonical hierarchy", () => {
    const channelSegment = `id-${sha256Hex("discord:default:family")}`;
    const threadSegment = `id-${sha256Hex("trip-planning")}`;
    const userSegment = `id-${sha256Hex("user:alice")}`;

    expect(
      resolveMemoryArtifactRelativePath({
        scope: { kind: "channel", channelId: "discord:default:family" },
        artifactKind: "memory",
      }),
    ).toBe(path.posix.join("memory", "Channel", channelSegment, "MEMORY.md"));
    expect(
      resolveMemoryArtifactRelativePath({
        scope: {
          kind: "thread",
          channelId: "discord:default:family",
          threadId: "trip-planning",
        },
        artifactKind: "memory",
      }),
    ).toBe(
      path.posix.join("memory", "Channel", channelSegment, "Thread", threadSegment, "MEMORY.md"),
    );
    expect(
      resolveMemoryArtifactRelativePath({
        scope: { kind: "user", userId: "user:alice" },
        artifactKind: "memory",
      }),
    ).toBe(path.posix.join("memory", "User", userSegment, "MEMORY.md"));
  });

  it("creates deterministic Event and Archive names without trusting display names as paths", () => {
    expect(
      resolveMemoryArtifactRelativePath({
        scope: { kind: "channel", channelId: "discord:default:family" },
        artifactKind: "event",
        artifactName: "Calendar / Reminder Triggered",
        createdDate: "2026-10-07",
        createdAtMs: 1791345600000,
      }),
    ).toMatch(/\/Event\/2026-10-07_calendar-reminder-triggered_1791345600000\.md$/u);

    expect(() =>
      resolveMemoryArtifactRelativePath({
        scope: { kind: "user", userId: "user:alice" },
        artifactKind: "archive",
        artifactName: "Conversation",
        createdDate: "2026-10-07",
        createdAtMs: 1791345600000,
      }),
    ).toThrow("user-scoped archives are not supported");
  });

  it("appends Fragment notes to one date-only file per Channel or Thread day", () => {
    const channelSegment = `id-${sha256Hex("discord:default:family")}`;
    const threadSegment = `id-${sha256Hex("trip-planning")}`;

    // Repeated notes on the same day resolve to the same append-only file;
    // the name carries no slug or millisecond discriminator.
    for (const call of [1, 2]) {
      expect(
        resolveMemoryArtifactRelativePath({
          scope: {
            kind: "thread",
            channelId: "discord:default:family",
            threadId: "trip-planning",
          },
          artifactKind: "fragment",
          artifactName: "Planning Time",
          createdDate: "2026-10-24",
          createdAtMs: 1792800000000 + call,
        }),
      ).toBe(
        path.posix.join(
          "memory",
          "Channel",
          channelSegment,
          "Thread",
          threadSegment,
          "Fragment",
          "2026-10-24.md",
        ),
      );
    }

    expect(
      resolveMemoryArtifactRelativePath({
        scope: { kind: "channel", channelId: "discord:default:family" },
        artifactKind: "fragment",
        createdDate: "2026-10-24",
      }),
    ).toMatch(/\/Channel\/[^/]+\/Fragment\/2026-10-24\.md$/u);

    expect(() =>
      resolveMemoryArtifactRelativePath({
        scope: { kind: "workspace" },
        artifactKind: "fragment",
        createdDate: "2026-10-24",
      }),
    ).toThrow("only for channel and thread scopes");
    expect(() =>
      resolveMemoryArtifactRelativePath({
        scope: { kind: "user", userId: "user:alice" },
        artifactKind: "fragment",
        createdDate: "2026-10-24",
      }),
    ).toThrow("only for channel and thread scopes");
    expect(() =>
      resolveMemoryArtifactRelativePath({
        scope: { kind: "channel", channelId: "discord:default:family" },
        artifactKind: "fragment",
        createdDate: "2026-10-24-10",
      }),
    ).toThrow("createdDate must use YYYY-MM-DD");
  });

  it("rejects ambiguous or path-shaped identifiers", () => {
    expect(() =>
      resolveMemoryArtifactRelativePath({
        scope: { kind: "channel", channelId: "../family" },
        artifactKind: "memory",
      }),
    ).toThrow("without path separators");
    expect(() =>
      resolveMemoryArtifactRelativePath({
        scope: { kind: "user", userId: "   " },
        artifactKind: "memory",
      }),
    ).toThrow("non-empty canonical id");
  });

  it("builds deterministic current-context artifacts with all participants", () => {
    const channelId = resolveCanonicalMemoryChannelId({
      provider: "discord",
      accountId: "family-bot",
      channelId: "123456",
    });
    const context = resolveMemoryContextReadContext({
      conversation: { kind: "thread", channelId, threadId: "trip-planning" },
      participants: [
        { userId: "user:bob", userName: "Bob" },
        { userId: "user:alice", userName: "Alice / Mom" },
        { userId: "user:bob", userName: "Duplicate Bob" },
      ],
      participantCoverage: "partial",
    });

    expect(context.participantCoverage).toBe("partial");
    expect(context.artifacts.map(({ layer, userName }) => ({ layer, userName }))).toEqual([
      { layer: "workspace", userName: undefined },
      { layer: "channel", userName: undefined },
      { layer: "thread", userName: undefined },
      { layer: "users", userName: "Alice / Mom" },
      { layer: "users", userName: "Bob" },
    ]);
    expect(context.artifacts.every(({ relativePath }) => relativePath.endsWith("MEMORY.md"))).toBe(
      true,
    );
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.artifacts)).toBe(true);
  });

  it("mints the current conversation Fragment location from the admitted scope", () => {
    const channelId = resolveCanonicalMemoryChannelId({
      provider: "discord",
      accountId: "family-bot",
      channelId: "123456",
    });
    const threadId = resolveCanonicalMemoryThreadId("trip-planning");
    const threadContext = resolveMemoryContextReadContext({
      conversation: { kind: "thread", channelId, threadId },
      participantCoverage: "complete",
    });
    expect(threadContext.fragment?.scope).toEqual({
      kind: "thread",
      channelId,
      threadId: resolveCanonicalMemoryThreadId("trip-planning"),
    });
    expect(
      threadContext.fragment?.resolveRelativePath({
        createdDate: "2026-10-24",
      }),
    ).toMatch(/\/Fragment\/2026-10-24\.md$/u);
    expect(Object.isFrozen(threadContext.fragment)).toBe(true);

    const channelContext = resolveMemoryContextReadContext({
      conversation: { kind: "channel", channelId },
      participantCoverage: "partial",
    });
    expect(channelContext.fragment?.scope).toEqual({ kind: "channel", channelId });
    expect(
      channelContext.fragment?.resolveRelativePath({
        createdDate: "2026-10-24",
      }),
    ).toMatch(/\/Channel\/[^/]+\/Fragment\/2026-10-24\.md$/u);
  });

  it("folds provider and account identity into opaque Channel ids", () => {
    expect(
      resolveCanonicalMemoryChannelId({
        provider: "discord",
        accountId: "family/bot",
        channelId: "guild/channel/123",
      }),
    ).toMatch(/^channel-v1-[a-f0-9]{64}$/u);
    expect(
      resolveCanonicalMemoryChannelId({
        provider: "slack",
        accountId: "family/bot",
        channelId: "guild/channel/123",
      }),
    ).not.toBe(
      resolveCanonicalMemoryChannelId({
        provider: "discord",
        accountId: "family/bot",
        channelId: "guild/channel/123",
      }),
    );
  });
});
