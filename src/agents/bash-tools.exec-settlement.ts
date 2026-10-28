import {
  resolveEventSessionKeyForPolicy,
  scopedHeartbeatWakeOptionsForPolicy,
} from "../infra/event-session-routing.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import { enqueueSystemEventWithReceipt } from "../infra/system-events.js";
import { isSubagentSessionKey } from "../sessions/session-key-utils.js";
import {
  markExited,
  recordNotifyOnExitRemoval,
  settleExecSessionFinalization,
  tail,
  type ProcessSession,
} from "./bash-process-registry.js";
import {
  appendExecTimeoutRetryGuidance,
  compactNotifyOutput,
  renderExecExitLabel,
} from "./bash-tools.exec-output.js";
import type { ExecProcessOutcome } from "./bash-tools.exec-types.js";

const DEFAULT_NOTIFY_TAIL_CHARS = 400;

function maybeNotifyOnExit(
  session: ProcessSession,
  status: "completed" | "failed",
  subagentSession: boolean,
) {
  if (
    !session.backgrounded ||
    !session.notifyOnExit ||
    session.exitNotified ||
    session.terminalPollObserved
  ) {
    return;
  }
  const sessionKey = session.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  session.exitNotified = true;
  // Requested stops must not wake another turn to relay leftover output.
  if (session.exitReason === "manual-cancel" && session.finalizationFailed !== true) {
    return;
  }
  const exitLabel = renderExecExitLabel(session);
  const output = compactNotifyOutput(
    tail(session.tail || session.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS),
  );
  if (
    status === "completed" &&
    session.exitCode === 0 &&
    !output &&
    session.notifyOnExitEmptySuccess !== true
  ) {
    return;
  }
  const summary = output
    ? `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel}) :: ${output}`
    : `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel})`;
  const eventText = appendExecTimeoutRetryGuidance(summary, session.exitReason);
  const eventRouting = session.eventRouting ?? {};
  const eventSessionKey = resolveEventSessionKeyForPolicy(sessionKey, eventRouting);
  const eventOptions = {
    sessionKey: eventSessionKey,
    contextKey: `exec:${session.id}`,
    deliveryContext: session.notifyDeliveryContext,
    fromConversationTurn: session.notifyFromConversationTurn,
  };
  const remove = enqueueSystemEventWithReceipt(
    eventText,
    session.agentId ? withSystemEventOwner(eventOptions, session.agentId) : eventOptions,
    { allowDuplicate: true },
  );
  if (remove) {
    recordNotifyOnExitRemoval(session, remove);
  }
  // Subagent sessions receive exec results via process poll and announce flow;
  // the heartbeat would fall back to the main session and cause spurious wakes.
  if (!subagentSession && !isSubagentSessionKey(sessionKey)) {
    const wakeOptions = scopedHeartbeatWakeOptionsForPolicy(
      sessionKey,
      {
        source: "exec-event" as const,
        intent: "event" as const,
        reason: "exec-event",
        coalesceMs: 0,
      },
      eventRouting,
    );
    requestHeartbeat(
      sessionKey === "global" && session.agentId
        ? { ...wakeOptions, agentId: session.agentId }
        : wakeOptions,
    );
  }
}

/** Settle the process owner's ledger and notifications before releasing scope joins. */
export async function settleExecProcessExit({
  session,
  outcome,
  onSettledBeforeNotify,
  subagentSession,
  failureOutcome,
}: {
  session: ProcessSession;
  outcome: ExecProcessOutcome;
  onSettledBeforeNotify?: (outcome: ExecProcessOutcome) => void | Promise<void>;
  subagentSession: boolean;
  failureOutcome: (error: unknown) => ExecProcessOutcome;
}): Promise<ExecProcessOutcome> {
  let finalOutcome = outcome;
  // Task and notification failures do not change the observed process exit.
  const {
    exitCode,
    exitSignal,
    status: processStatus,
    exitReason,
    noOutputTimedOut,
  } = finalOutcome;
  const markProcessExited = () =>
    markExited(session, exitCode, exitSignal, processStatus, exitReason, noOutputTimedOut);
  try {
    const shouldNotify = !session.exited;
    const settlement = onSettledBeforeNotify?.(finalOutcome);
    if (settlement instanceof Promise) {
      await settlement;
    }
    if (shouldNotify) {
      markProcessExited();
      maybeNotifyOnExit(session, finalOutcome.status, subagentSession);
    }
  } catch (error) {
    session.finalizationFailed = true;
    // Keep the exact process owner through failed-outcome correction, including
    // notification failures after the process moved into completed retention.
    finalOutcome = failureOutcome(error);
    const settlement = onSettledBeforeNotify?.(finalOutcome);
    if (settlement instanceof Promise) {
      await settlement;
    }
  } finally {
    try {
      if (!session.exited) {
        markProcessExited();
      }
    } finally {
      // Notifications need start-time routing, but completed logs must not
      // retain it, including when a task callback or notification throws.
      delete session.sessionKey;
      delete session.agentId;
      delete session.eventRouting;
      delete session.notifyDeliveryContext;
      delete session.notifyFromConversationTurn;
      delete session.notifyOnExit;
      delete session.notifyOnExitEmptySuccess;
      settleExecSessionFinalization(session);
    }
  }
  return finalOutcome;
}
