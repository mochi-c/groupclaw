import os from "node:os";
import path from "node:path";
import {
  normalizeOptionalString,
  readNonBlankString,
} from "@openclaw/normalization-core/string-coerce";
import {
  resolveAgentIdByWorkspacePath,
  resolveAgentWorkspaceDir,
} from "../../../agents/agent-scope.js";
import { resolveUserTimezone } from "../../../agents/date-time.js";
import { createMemoryWriteProvenanceObserver } from "../../../agents/memory-write-provenance.js";
import { resolveStateDir } from "../../../config/paths.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isVitestRuntimeEnv } from "../../../infra/env.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { createMemoryEvent } from "../../../memory/memory-events.js";
import { resolveMemoryEventScopeFromEntry } from "../../../memory/session-memory-context.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../../process/gateway-work-admission.js";
import {
  isIncognitoSessionKey,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "../../../routing/session-key.js";
import { shortenHomePath } from "../../../utils.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import { generateSlugViaLLM } from "../../llm-slug-generator.js";
import { isSessionAutoResetReason } from "../../session-auto-reset.js";
import { captureSessionMemoryTranscript, type SessionMemoryTranscript } from "./capture.js";

const log = createSubsystemLogger("hooks/session-memory");

function pickDateTimePart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string | undefined {
  return parts.find((part) => part.type === type)?.value;
}

function formatLocalSessionTimestamp(
  date: Date,
  timeZone: string,
): {
  date: string;
  time: string;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const year = pickDateTimePart(parts, "year") ?? String(date.getFullYear()).padStart(4, "0");
  const month = pickDateTimePart(parts, "month") ?? String(date.getMonth() + 1).padStart(2, "0");
  const day = pickDateTimePart(parts, "day") ?? String(date.getDate()).padStart(2, "0");
  const hour = pickDateTimePart(parts, "hour") ?? String(date.getHours()).padStart(2, "0");
  const minute = pickDateTimePart(parts, "minute") ?? String(date.getMinutes()).padStart(2, "0");
  const second = pickDateTimePart(parts, "second") ?? String(date.getSeconds()).padStart(2, "0");
  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}:${second}`,
  };
}

function resolveDisplaySessionKey(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  sessionKey: string;
}): string {
  if (!params.cfg || !params.workspaceDir) {
    return params.sessionKey;
  }
  const workspaceAgentId = resolveAgentIdByWorkspacePath(params.cfg, params.workspaceDir);
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (!workspaceAgentId || !parsed || workspaceAgentId === parsed.agentId) {
    return params.sessionKey;
  }
  return toAgentStoreSessionKey({
    agentId: workspaceAgentId,
    requestKey: parsed.rest,
  });
}

const pendingSessionMemoryWrites = new Set<Promise<void>>();

function requireSessionMemoryAgentId(event: Parameters<HookHandler>[0]): string {
  const agentId = normalizeOptionalString(event.context?.agentId);
  if (!agentId) {
    throw new Error("Session memory hook contract requires context.agentId");
  }
  return agentId;
}

export async function flushSessionMemoryWritesForTest(): Promise<void> {
  await Promise.allSettled(pendingSessionMemoryWrites);
}

async function saveSessionMemoryNow(
  event: Parameters<HookHandler>[0],
  agentId: string,
  transcript: SessionMemoryTranscript,
): Promise<void> {
  try {
    log.debug("Session memory hook triggered", { action: event.action, type: event.type });

    const context = event.context || {};
    const cfg = context.cfg as OpenClawConfig | undefined;
    const contextWorkspaceDir = readNonBlankString(context.workspaceDir);
    const workspaceDir =
      contextWorkspaceDir ||
      (cfg
        ? resolveAgentWorkspaceDir(cfg, agentId)
        : path.join(resolveStateDir(process.env, os.homedir), "workspace"));
    const displaySessionKey = resolveDisplaySessionKey({
      cfg,
      workspaceDir: contextWorkspaceDir,
      sessionKey: event.sessionKey,
    });
    // Session-memory artifacts share the same configured user-day boundary as daily memory files.
    const now = new Date(event.timestamp);
    const userTimezone = resolveUserTimezone(cfg?.agents?.defaults?.userTimezone ?? process.env.TZ);
    const localTimestamp = formatLocalSessionTimestamp(now, userTimezone);
    const dateStr = localTimestamp.date;

    // Manual commands carry the prior entry separately; automatic rollover
    // events already identify the ended session as sessionEntry.
    const sessionEntry = (
      event.type === "command"
        ? (context.previousSessionEntry ?? context.sessionEntry)
        : context.sessionEntry
    ) as SessionEntry | undefined;
    const flush = event.action === "memory-flush" ? context.memoryFlush : undefined;
    const scope = flush
      ? context.memoryEventScope
      : resolveMemoryEventScopeFromEntry(sessionEntry, event.sessionKey, cfg ?? {});
    if (!scope) {
      log.debug("Session Event excluded by launch Channel memory policy");
      return;
    }
    if (event.action === "closed" && scope.kind !== "thread") {
      throw new Error("Thread closure Event requires canonical Thread identity");
    }
    const currentSessionId = normalizeOptionalString(sessionEntry?.sessionId);
    const eventType = flush
      ? "memory.pre-compaction-flush"
      : event.type === "command"
        ? "session.reset"
        : event.action === "compacted"
          ? "session.compacted"
          : event.action === "closed"
            ? "thread.closed"
            : "session.rollover";
    log.debug("Session context resolved", {
      sessionId: currentSessionId,
      hasCfg: Boolean(cfg),
    });

    const hookConfig = resolveHookConfig(cfg, "session-memory");
    let slug: string | null = null;
    if (transcript.status === "unavailable") {
      log.warn("Session transcript unavailable for memory capture", {
        sessionKey: event.sessionKey,
        error: transcript.reason,
      });
    }
    if (currentSessionId) {
      // Avoid calling the model provider in unit tests; keep hooks fast and deterministic.
      const isTestEnv = isVitestRuntimeEnv();
      const allowLlmSlug = !isTestEnv && hookConfig?.llmSlug === true;

      if (transcript.status === "available" && transcript.content && cfg && allowLlmSlug) {
        log.debug("Calling generateSlugViaLLM...");
        const slugModel = typeof hookConfig?.model === "string" ? hookConfig.model : undefined;
        slug = await generateSlugViaLLM({
          sessionContent: transcript.content,
          cfg,
          agentId,
          model: slugModel,
        });
        log.debug("Generated slug", { slug });
      }
    }

    const timeStr = localTimestamp.time;

    const sessionId = currentSessionId || "unknown";
    const boundaryDetail =
      event.type === "session"
        ? `- **Reason**: ${(context.reason as string) || "unknown"}`
        : `- **Source**: ${(context.commandSource as string) || "unknown"}`;

    const entryParts = [
      `# Session: ${dateStr} ${timeStr} ${userTimezone}`,
      "",
      `- **Session Key**: ${displaySessionKey}`,
      `- **Session ID**: ${sessionId}`,
      boundaryDetail,
      "",
    ];

    if (transcript.status === "available" && transcript.content) {
      entryParts.push("## Conversation Summary", "", transcript.content, "");
    } else if (transcript.status === "unavailable") {
      entryParts.push(
        "## Conversation Summary",
        "",
        `> Transcript content was unavailable: ${JSON.stringify(transcript.reason)}`,
        "",
      );
    }

    // Reserve provenance before exposing the file. A restricted projection
    // must never fall back to an untracked artifact that later reads as trusted.
    const provenanceObserver = createMemoryWriteProvenanceObserver({
      mutationRoot: workspaceDir,
      workspaceDir,
      resolveOriginClass: () =>
        transcript.status === "available" ? transcript.originClass : "agent",
      sessionId: currentSessionId,
      sessionKey: event.sessionKey,
      now: () => now.getTime(),
    });
    const handle = await createMemoryEvent({
      workspaceDir,
      scope,
      eventType,
      createdAt: now,
      createdDate: dateStr,
      slug,
      status:
        flush && !flush.outcome
          ? "processing"
          : flush?.outcome === "failed" || flush?.outcome === "exhausted"
            ? "failed"
            : "completed",
      outcome: flush?.outcome,
      metadata: {
        sessionId,
        sessionKey: event.sessionKey,
        ...(flush
          ? { flushId: flush.flushId, runId: flush.runId, compactionCount: flush.compactionCount }
          : {}),
        ...(event.action === "compacted"
          ? {
              metrics: {
                messageCount: context.messageCount,
                compactedCount: context.compactedCount,
                tokensBefore: context.tokensBefore,
                tokensAfter: context.tokensAfter,
                firstKeptEntryId: context.firstKeptEntryId,
              },
            }
          : {}),
        ...(event.action === "closed" ? { sourceArchives: context.sourceArchives ?? [] } : {}),
        captureStatus: transcript.status,
      },
      payloadTrust:
        transcript.status === "available" && transcript.originClass === "agent"
          ? "trusted"
          : "untrusted",
      body: entryParts.join("\n"),
      provenanceObserver,
      ...(cfg && sessionEntry
        ? {
            source: {
              agentId,
              sessionKey: event.sessionKey,
              entry: sessionEntry,
              endedSession:
                event.type === "command" ||
                event.action === "auto-reset" ||
                event.action === "closed",
            },
          }
        : {}),
      assertCurrent: context.assertCurrent,
    });
    context.onMemoryEventCreated?.(handle);
    log.debug("Memory file written successfully");

    const relPath = shortenHomePath(path.join(workspaceDir, handle.relativePath));
    log.info(`Session context saved to ${relPath}`);
  } catch (err) {
    if (err instanceof Error) {
      log.error("Failed to save session memory", {
        errorName: err.name,
        errorMessage: err.message,
        stack: err.stack,
      });
    } else {
      log.error("Failed to save session memory", { error: String(err) });
    }
  }
}

const saveSessionToMemory: HookHandler = (event) => {
  // Manual commands retain their shipped hook contract, including /reset soft.
  // Automatic rollover uses a distinct lifecycle event so command hooks do not
  // receive synthetic commands and manual reset cannot double-write memory.
  const isResetCommand = event.action === "new" || event.action === "reset";
  const isAutoReset =
    event.type === "session" &&
    event.action === "auto-reset" &&
    isSessionAutoResetReason(event.context.reason);
  const isLifecycle =
    event.type === "session" &&
    (event.action === "compacted" ||
      event.action === "memory-flush" ||
      (event.action === "closed" && event.context.reason === "thread-closed"));
  if ((event.type !== "command" || !isResetCommand) && !isAutoReset && !isLifecycle) {
    return undefined;
  }
  const context = event.context;
  const sessionEntry = (
    event.type === "command"
      ? (context.previousSessionEntry ?? context.sessionEntry)
      : context.sessionEntry
  ) as { sessionId?: string; incognito?: boolean } | undefined;
  // Reset hooks run before the process-local session is retired. Never turn its
  // live transcript or a previously captured excerpt into durable workspace memory.
  if (isIncognitoSessionKey(event.sessionKey) || sessionEntry?.incognito === true) {
    return undefined;
  }
  const agentId = requireSessionMemoryAgentId(event);
  const cfg = context.cfg as OpenClawConfig | undefined;
  // Gateway and soft-reset hooks already run before mutation; chat resets carry
  // the snapshot captured by session initialization before closing the window.
  const transcript =
    (context.previousSessionMemory as SessionMemoryTranscript | undefined) ??
    (sessionEntry?.sessionId
      ? captureSessionMemoryTranscript(
          {
            agentId,
            sessionId: sessionEntry.sessionId,
            sessionKey: event.sessionKey,
            storePath:
              normalizeOptionalString(context.storePath) ??
              resolveSessionStorePathCore(cfg?.session?.store, { agentId }),
          },
          cfg,
        )
      : ({ status: "available", content: null, originClass: "agent" } as const));
  const writePromise =
    isAutoReset || isLifecycle
      ? saveSessionMemoryNow(event, agentId, transcript)
      : runWithGatewayIndependentRootWorkContinuation(
          () => saveSessionMemoryNow(event, agentId, transcript),
          "hooks:session-memory",
        );
  pendingSessionMemoryWrites.add(writePromise);
  void writePromise.finally(() => {
    pendingSessionMemoryWrites.delete(writePromise);
  });
  // Automatic rollover dispatch is already detached from the successor turn.
  // Keep its gateway admission alive until nested slug/model work finishes.
  if (isAutoReset || isLifecycle) {
    return writePromise;
  }
  return undefined;
};

export default saveSessionToMemory;
