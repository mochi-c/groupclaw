import { listAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  deleteSessionEntry,
  listSessionEntriesAsync,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * Closes the Discord conversation sessions routed to {@link threadId}.
 * The explicit lifecycle deletion archives the old transcript and guarantees
 * that a later inbound message starts a fresh session in every reset mode.
 */
export async function closeDiscordThreadSessions(params: {
  cfg: OpenClawConfig;
  threadId: string;
}): Promise<number> {
  const { cfg, threadId } = params;

  const normalizedThreadId = normalizeOptionalLowercaseString(threadId) ?? "";
  if (!normalizedThreadId) {
    return 0;
  }

  // Bind the conversation segment, not a member id or another channel's
  // peer id. Native and parent-routed Threads have distinct key shapes.
  const segmentRe = new RegExp(
    `^agent:[^:]+:discord:channel:(?:${normalizedThreadId}|[^:]+:thread:${normalizedThreadId})(?::|$)`,
    "i",
  );

  // Session keys are agent-scoped (agent:<agentId>:discord:...), so the store
  // must resolve per routed agent — resolving with the channel account id
  // would target a nonexistent agent's store and silently close nothing.
  let resetCount = 0;

  for (const agentId of listAgentIds(cfg)) {
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    // agentId selects the owner DB: with a fixed custom store every agent
    // resolves the same storePath, so storePath alone re-reads the default
    // owner. The read-only listing keeps this fleet-wide scan from creating or registering
    // agent databases while handling a thread archive/delete event.
    for (const { sessionKey, entry } of await listSessionEntriesAsync({
      agentId,
      storePath,
    })) {
      if (!segmentRe.test(sessionKey)) {
        continue;
      }
      const deleted = await deleteSessionEntry({
        agentId,
        archiveTranscript: true,
        expectedSessionId: entry.sessionId ?? null,
        expectedUpdatedAt: entry.updatedAt,
        sessionKey,
        storePath,
        lifecycle: { cfg, reason: "thread-closed" },
      });
      if (deleted) {
        resetCount += 1;
      }
    }
  }

  return resetCount;
}
