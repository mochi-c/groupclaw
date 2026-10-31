import { randomUUID } from "node:crypto";
import { withMemoryDreamSource } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import { patchSessionEntry, type SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendAgentMemoryFragmentFile } from "./fragment-memory-write.js";
import type { createMemoryForgetFixture } from "./memory-forget.test-helpers.js";

export async function appendDreamFragment(
  fixture: Awaited<ReturnType<typeof createMemoryForgetFixture>>,
  channel: string,
  content: string,
  thread?: string,
  visibility: "public" | "private" = "public",
) {
  const sessionId = randomUUID();
  const sessionKey = `agent:main:discord:${thread ?? channel}:${sessionId}`;
  const entry: SessionEntry = {
    sessionId,
    updatedAt: Date.now(),
    chatType: "channel",
    delivery: {
      kind: "external",
      route: {
        channel: "discord",
        accountId: "default",
        target: { to: `channel:${thread ?? channel}`, chatType: "channel" },
        ...(thread ? { thread: { id: thread } } : {}),
      },
      context: {
        channel: "discord",
        accountId: "default",
        to: `channel:${thread ?? channel}`,
        ...(thread ? { threadId: thread } : {}),
      },
      origin: {
        provider: "discord",
        accountId: "default",
        chatType: "channel",
        nativeChannelId: thread ?? channel,
        ...(thread
          ? {
              threadId: thread,
              nativeParentChannelId: channel,
              nativeThreadVisibility: visibility,
            }
          : {}),
      },
    },
    participants: [
      {
        identity: {
          type: "remote",
          pluginId: "discord",
          domain: "discord",
          idKind: "user",
          id: "1",
        },
        label: "Alice",
      },
    ],
  };
  await patchSessionEntry({
    agentId: "main",
    sessionKey,
    fallbackEntry: entry,
    update: () => entry,
    replaceEntry: true,
    skipMaintenance: true,
  });
  // Create upgrade evidence under an earlier, non-launch admission. Current
  // configuration stays authoritative when the background pass reads it.
  const admissionConfig = structuredClone(fixture.cfg);
  if (!thread) {
    admissionConfig.channels!.discord!.guilds!["900"]!.channels![channel]!.threadMode = "auto";
  }
  return withMemoryDreamSource(
    {
      agentId: "main",
      sessionKey,
      sessionId,
      storePath: resolveStorePath(fixture.cfg.session?.store, { agentId: "main" }),
      assertCurrent: () => {},
      cfg: admissionConfig,
    },
    async (facts) => {
      const relPath = facts.context.fragment!.resolveRelativePath({
        createdDate: new Date().toISOString().slice(0, 10),
      });
      await appendAgentMemoryFragmentFile({
        cfg: fixture.cfg,
        agentId: "main",
        relPath,
        timeLabel: "10:00",
        content,
        source: { sessionKey, sessionId, createdAtMs: Date.now() },
        assertCurrent: () => facts.assertCurrent(),
      });
      return { relPath, sessionId, sessionKey, entry };
    },
  );
}
