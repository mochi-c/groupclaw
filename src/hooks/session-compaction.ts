import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../process/gateway-work-admission.js";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { getRecentSessionProjectionFromEvents } from "./bundled/session-memory/transcript.js";
import {
  createInternalHookEvent,
  hasInternalHookListeners,
  triggerInternalHook,
} from "./internal-hooks.js";

const log = createSubsystemLogger("hooks/session-compaction");

/** Capture the committed source before detached memory work can observe its successor. */
export async function emitSessionCompactedHook(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  sessionEntry?: SessionEntry;
  storePath?: string;
  workspaceDir?: string;
  messages?: readonly unknown[];
  messageCount?: number;
  compactedCount?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  firstKeptEntryId?: string;
  assertCurrent?: () => void;
}): Promise<void> {
  const { sessionKey, sessionId } = params;
  if (
    !sessionKey ||
    !sessionId ||
    isIncognitoSessionKey(sessionKey) ||
    !hasInternalHookListeners("session", "compacted")
  ) {
    return;
  }
  try {
    params.assertCurrent?.();
    const cfg = params.cfg ?? {};
    const agentId = params.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
    const storePath =
      params.storePath ?? resolveSessionStorePathCore(cfg.session?.store, { agentId });
    const sessionEntry =
      params.sessionEntry ??
      (await readSessionEntryReadOnlyInWorker(
        { agentId, sessionKey, storePath },
        params.assertCurrent,
      ));
    params.assertCurrent?.();
    if (!sessionEntry || sessionEntry.sessionId !== sessionId) {
      throw new Error("Compaction Event source is missing or replaced");
    }
    if (sessionEntry.incognito) {
      return;
    }
    const hookConfig = cfg.hooks?.internal?.entries?.["session-memory"];
    const messages = hookConfig?.messages;
    const projection = params.messages
      ? getRecentSessionProjectionFromEvents(
          params.messages.slice(-4_096).map((message) => ({ type: "message", message })),
          typeof messages === "number" && messages > 0 ? messages : 15,
        )
      : null;
    const event = createInternalHookEvent("session", "compacted", sessionKey, {
      cfg,
      agentId,
      storePath,
      workspaceDir: params.workspaceDir ?? resolveAgentWorkspaceDir(cfg, agentId),
      sessionEntry,
      messageCount: params.messageCount,
      compactedCount: params.compactedCount,
      tokensBefore: params.tokensBefore,
      tokensAfter: params.tokensAfter,
      firstKeptEntryId: params.firstKeptEntryId,
      assertCurrent: params.assertCurrent,
      previousSessionMemory: projection
        ? { status: "available", ...projection }
        : {
            status: "unavailable",
            reason: "No conversation excerpt captured; the source transcript remains available",
          },
    });
    await runWithGatewayIndependentRootWorkContinuation(
      () => triggerInternalHook(event),
      "hooks:session-compacted",
    );
  } catch (error) {
    log.warn(`session:compacted memory capture failed: ${String(error)}`);
  }
}
