import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { formatErrorStackWithMessage } from "@openclaw/normalization-core/error-coercion";
import {
  normalizeOptionalString,
  normalizeLowercaseStringOrEmpty,
  readNonBlankString,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { prepareSystemAgentRunAdmission } from "../../../agents/admitted-run-context.js";
import {
  resolveAgentIdByWorkspacePath,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../../../agents/agent-scope.js";
import { resolveUserTimezone } from "../../../agents/date-time.js";
import { runEmbeddedAgent } from "../../../agents/embedded-agent.js";
import { createMemoryWriteProvenanceObserver } from "../../../agents/memory-write-provenance.js";
import { SessionManager } from "../../../agents/sessions/index.js";
import { resolveAgentTimeoutMs } from "../../../agents/timeout.js";
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
import {
  extractLeadingHttpStatus,
  parseApiErrorPayload,
} from "../../../shared/assistant-error-format.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { shortenHomePath } from "../../../utils.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import { isSessionAutoResetReason } from "../../session-auto-reset.js";
import { captureSessionMemoryTranscript, type SessionMemoryTranscript } from "./capture.js";

const log = createSubsystemLogger("hooks/session-memory");
const slugGeneratorLog = createSubsystemLogger("llm-slug-generator");
const PROVIDER_ERROR_PREFIX_RE =
  /^(?:provider\s+)?(?:api|llm|model|openai|anthropic|codex|gateway)\s+(?:request\s+)?(?:error|failed|failure)\b/i;
const PROVIDER_ERROR_DETAIL_RE =
  /\b(?:insufficient[_ -]?quota|quota (?:exceeded|exhausted)|exceeded your current quota|payment required|insufficient credits|credit balance|insufficient[_ -]?(?:balance|funds)|rate[_ -]?limit(?:ed)?|too many requests|invalid[_ -]?api[_ -]?key|incorrect api key|authentication failed|oauth token refresh failed|missing (?:token|projectid|credentials)|google cloud credentials|re-?authenticate|unauthorized|forbidden|permission_error|billing hard limit|spend(?:ing)? limit)\b/i;

function isErrorSlugPayload(payload: { text?: string; isError?: boolean } | undefined): boolean {
  if (!payload) {
    return false;
  }
  if (payload.isError === true) {
    return true;
  }
  const text = payload.text?.trim();
  if (!text) {
    return false;
  }
  if (parseApiErrorPayload(text)) {
    return true;
  }
  const leadingStatus = extractLeadingHttpStatus(text);
  if (leadingStatus) {
    if ([401, 402, 403, 429].includes(leadingStatus.code)) {
      return true;
    }
    if (
      leadingStatus.code === 400 &&
      (parseApiErrorPayload(leadingStatus.rest) ||
        PROVIDER_ERROR_PREFIX_RE.test(leadingStatus.rest) ||
        PROVIDER_ERROR_DETAIL_RE.test(leadingStatus.rest))
    ) {
      return true;
    }
  }
  return PROVIDER_ERROR_PREFIX_RE.test(text) || PROVIDER_ERROR_DETAIL_RE.test(text);
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

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  const second = parts.find((part) => part.type === "second")?.value;
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
        try {
          const helperWorkspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
          const agentDir = resolveAgentDir(cfg, agentId);
          const sessionId = `slug-generator-${randomUUID()}`;
          const sessionKey = `agent:${agentId}:helper:incognito-${sessionId}`;
          const prompt = `Based on this conversation, generate a short 1-2 word filename slug (lowercase, hyphen-separated, no file extension).

Conversation summary:
${truncateUtf16Safe(transcript.content, 2000)}

Reply with ONLY the slug, nothing else. Examples: "vendor-pitch", "api-design", "bug-fix"`;
          const timeoutMs =
            cfg.agents?.defaults?.timeoutSeconds === undefined
              ? 15_000
              : resolveAgentTimeoutMs({ cfg });
          const runId = `slug-gen-${Date.now()}`;
          const preparedRunAdmission = prepareSystemAgentRunAdmission(
            cfg,
            runId,
            agentId,
            "hooks.slug-generator",
          );
          try {
            const result = await runEmbeddedAgent({
              preparedRunAdmission,
              sessionId,
              sessionKey,
              sessionManager: SessionManager.inMemory(helperWorkspaceDir),
              agentId,
              workspaceDir: helperWorkspaceDir,
              agentDir,
              config: cfg,
              prompt,
              model: typeof hookConfig?.model === "string" ? hookConfig.model : undefined,
              timeoutMs,
              runId,
              // Conversation-derived utility input must never regain caller-denied capabilities.
              disableTools: true,
              toolsAllow: [],
              disableTrajectory: true,
              cleanupBundleMcpOnRunEnd: true,
              // Internal helper run: route failures lane-local so an upstream 400/billing
              // here cannot poison the shared profile (#71709).
              authProfileFailurePolicy: "local",
            });
            const payload = result.payloads?.[0];
            const text = payload?.text;
            if (text && !isErrorSlugPayload(payload)) {
              slug =
                normalizeLowercaseStringOrEmpty(text)
                  .replace(/[^a-z0-9-]/g, "-")
                  .replace(/-+/g, "-")
                  .replace(/^-+|-+$/g, "")
                  .slice(0, 30)
                  .replace(/^-+|-+$/g, "") || null;
            }
          } finally {
            preparedRunAdmission.close();
          }
        } catch (err) {
          const message = err instanceof Error ? formatErrorStackWithMessage(err) : String(err);
          slugGeneratorLog.error(`Failed to generate slug: ${message}`);
        }
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

const saveSessionToMemory: HookHandler = async (event) => {
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
  const captureComplete = createDeferredCore();
  const captureAndSave = async () => {
    // Chat resets carry their pre-mutation excerpt; other hooks capture before returning.
    const transcript =
      (context.previousSessionMemory as SessionMemoryTranscript | undefined) ??
      (sessionEntry?.sessionId
        ? await captureSessionMemoryTranscript(
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
    captureComplete.resolve();
    await saveSessionMemoryNow(event, agentId, transcript);
  };
  // Reserve follow-up admission and register its settlement before capture can yield.
  const writePromise =
    isAutoReset || isLifecycle
      ? captureAndSave()
      : runWithGatewayIndependentRootWorkContinuation(captureAndSave, "hooks:session-memory");
  pendingSessionMemoryWrites.add(writePromise);
  void writePromise.then(
    () => pendingSessionMemoryWrites.delete(writePromise),
    (error: unknown) => {
      pendingSessionMemoryWrites.delete(writePromise);
      captureComplete.reject(error);
    },
  );
  // Manual reset waits for its excerpt but retains detached filename generation and writing.
  await captureComplete.promise;
  if (isAutoReset || isLifecycle) {
    return writePromise;
  }
  return undefined;
};

export default saveSessionToMemory;
