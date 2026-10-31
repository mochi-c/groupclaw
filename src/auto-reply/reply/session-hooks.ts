import type { SessionResetBoundaryWrite } from "../../config/sessions/session-accessor.lifecycle-types.js";
import {
  createSessionResetBoundaryId,
  type SessionResetBoundaryRequest,
} from "../../config/sessions/session-reset-boundary-event.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  forgetActiveSessionForShutdown,
  noteActiveSessionForShutdown,
} from "../../gateway/active-sessions-shutdown-tracker.js";
import { createResetBoundaryTranscriptSource } from "../../gateway/session-end-transcript-reader.js";
import { captureMemorySourceSession } from "../../memory/session-memory-context.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type {
  PluginHookSessionEndEvent,
  PluginHookSessionEndReason,
  PluginHookSessionStartEvent,
} from "../../plugins/hook-types.js";
import type { HookRunner } from "../../plugins/hooks.js";
import {
  attachSessionEndTranscriptSource,
  type SessionEndTranscriptSource,
} from "../../plugins/session-end-transcript.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import { runWithSessionControllerCleanup } from "../../sessions/session-controller.owner-context.js";
import { runOutsideStoreWriterContext } from "../../shared/store-writer-queue.js";

type ReplySessionEndReason = Extract<
  PluginHookSessionEndReason,
  "new" | "reset" | "idle" | "daily" | "unknown"
>;

export function resolveExplicitSessionEndReason(
  matchedResetTriggerLower?: string,
): Extract<ReplySessionEndReason, "new" | "reset"> {
  return matchedResetTriggerLower === "/reset" ? "reset" : "new";
}

export function createReplySessionResetBoundary(params: {
  cwd: string;
  explicitReason: Extract<SessionResetBoundaryRequest["reason"], "new" | "reset">;
  previousReason?: ReplySessionEndReason;
  resetTriggered: boolean;
}): SessionResetBoundaryWrite {
  const continuityReason =
    params.previousReason === "idle" || params.previousReason === "daily"
      ? params.previousReason
      : "reset";
  const request: SessionResetBoundaryRequest = params.resetTriggered
    ? { context: "clear", reason: params.explicitReason }
    : { context: "preserve-tail", reason: continuityReason };
  return {
    boundaryId: createSessionResetBoundaryId(),
    cwd: params.cwd,
    ...request,
  };
}

type SessionHookContext = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
};

function buildSessionHookContext(params: SessionHookContext): SessionHookContext {
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  };
}

export function buildSessionStartHookPayload(
  params: SessionHookContext & PluginHookSessionStartEvent,
): {
  event: PluginHookSessionStartEvent;
  context: SessionHookContext;
} {
  return {
    event: {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      resumedFrom: params.resumedFrom,
    },
    context: buildSessionHookContext(params),
  };
}

function emitReplySessionStartHook(
  hookRunner: HookRunner,
  params: Parameters<typeof buildSessionStartHookPayload>[0],
): void {
  const payload = buildSessionStartHookPayload(params);
  // Lifecycle hooks outlive their requester and must not inherit its writer
  // lane or controller ownership while their detached work keeps drain alive.
  void runWithSessionControllerCleanup(() =>
    runWithGatewayDetachedWorkContinuation(async () => {
      await runOutsideStoreWriterContext(() =>
        hookRunner.runSessionStart(payload.event, payload.context),
      );
    }, "hooks:session-start"),
  ).catch(() => {});
}

export function buildSessionEndHookPayload(
  params: SessionHookContext &
    Partial<PluginHookSessionEndEvent> & {
      sessionEntry?: SessionEntry;
      endedTranscript?: SessionEndTranscriptSource;
    },
): {
  event: PluginHookSessionEndEvent;
  context: SessionHookContext;
} {
  const context = buildSessionHookContext(params);
  const session =
    params.sessionEntry?.sessionId === params.sessionId
      ? captureMemorySourceSession(params.sessionEntry)
      : undefined;
  attachSessionEndTranscriptSource(context, {
    ...(params.endedTranscript ?? { available: false, reason: "unsupported-source" }),
    ...(session ? { session } : {}),
  });
  return {
    event: {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      messageCount: params.messageCount ?? 0,
      durationMs: params.durationMs,
      reason: params.reason,
      sessionFile: params.sessionFile,
      transcriptArchived: params.transcriptArchived,
      nextSessionId: params.nextSessionId,
      nextSessionKey: params.nextSessionKey,
    },
    context,
  };
}

function emitReplySessionEndHook(params: {
  hookRunner: HookRunner;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  storePath: string;
  reason?: PluginHookSessionEndReason;
  nextSessionId?: string;
  resetBoundaryId?: string;
  sessionEntry?: SessionEntry;
}): void {
  const endedTranscript = params.resetBoundaryId
    ? createResetBoundaryTranscriptSource(
        {
          agentId: params.agentId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        },
        params.resetBoundaryId,
      )
    : { available: false as const, reason: "unsupported-source" as const };
  const payload = buildSessionEndHookPayload({ ...params, endedTranscript });
  void runWithSessionControllerCleanup(() =>
    runWithGatewayDetachedWorkContinuation(async () => {
      await runOutsideStoreWriterContext(() =>
        params.hookRunner.runSessionEnd(payload.event, payload.context),
      );
    }, "hooks:session-end"),
  ).catch(() => {});
}

export function emitReplySessionLifecycleHooks(
  params: SessionHookContext & {
    cfg: OpenClawConfig;
    storePath: string;
    isFirstSessionTurn: boolean;
    previousSessionEntry?: SessionEntry;
    previousSessionEndReason?: PluginHookSessionEndReason;
    resetBoundaryId?: string;
  },
): void {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner || !params.isFirstSessionTurn) {
    return;
  }
  const { agentId, sessionId, sessionKey, storePath, previousSessionEntry } = params;
  if (previousSessionEntry?.sessionId) {
    // The shutdown finalizer must not re-fire session_end for a session
    // that is being replaced here; forget unconditionally so the next drain
    // skips this id even when no session_end plugin is currently attached.
    forgetActiveSessionForShutdown(previousSessionEntry.sessionId);
    if (hookRunner.hasHooks("session_end")) {
      emitReplySessionEndHook({
        hookRunner,
        sessionId: previousSessionEntry.sessionId,
        sessionEntry: previousSessionEntry,
        sessionKey,
        agentId,
        storePath,
        reason: params.previousSessionEndReason,
        nextSessionId: sessionId,
        resetBoundaryId: params.resetBoundaryId,
      });
    }
  }
  if (sessionId) {
    // Track the new session so the shutdown finalizer fires a typed
    // session_end if the Gateway stops while this session is still active.
    noteActiveSessionForShutdown({
      sessionKey,
      sessionId,
      storePath,
      sessionFile: sessionKey,
      agentId,
    });
  }
  if (hookRunner.hasHooks("session_start")) {
    emitReplySessionStartHook(hookRunner, {
      sessionId,
      sessionKey,
      agentId,
      resumedFrom: previousSessionEntry?.sessionId,
    });
  }
}
