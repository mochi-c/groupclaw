import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { logVerbose } from "../../globals.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { truncateUtf16WithEllipsis } from "../../shared/text-truncate.js";
import { isRenderablePayload } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

const MAX_FLUSH_ERROR_LENGTH = 200;
const MAX_FLUSH_FAILURES = 3;

export function resolveVisibleMemoryFlushErrorPayloads(payloads?: ReplyPayload[]): ReplyPayload[] {
  return (payloads ?? []).filter(
    (payload) => payload.isError === true && isRenderablePayload(payload),
  );
}

export function buildVisibleMemoryFlushFailure(payloads: ReplyPayload[]): Error {
  const message = payloads
    .map((payload) => normalizeOptionalString(payload.text))
    .filter((text): text is string => Boolean(text))
    .join("\n");
  return new Error(message || "Memory flush returned an error response");
}

function truncateMemoryFlushErrorMessage(err: unknown): string {
  const message = normalizeOptionalString(formatErrorMessage(err)) || String(err);
  return truncateUtf16WithEllipsis(message, MAX_FLUSH_ERROR_LENGTH);
}

export async function recordMemoryFlushFailure(
  error: unknown,
  run: {
    abortSignal?: AbortSignal;
    assertCurrent?: () => void;
    sessionKey?: string;
    storePath?: string;
    sessionStore?: Record<string, SessionEntry>;
  },
  initialSessionEntry?: SessionEntry,
): Promise<{ sessionEntry?: SessionEntry; outcome: "failed" | "exhausted" }> {
  let sessionEntry = initialSessionEntry;
  let outcome: "failed" | "exhausted" = "failed";
  // Caller cancellation may use any reason, not only an AbortError instance.
  if (run.abortSignal?.aborted) {
    logVerbose("memory flush cancelled by its owner");
    return { sessionEntry, outcome };
  }
  const truncatedError = truncateMemoryFlushErrorMessage(error);
  const { sessionKey, storePath } = run;
  if (!isAbortError(error) && storePath && sessionKey) {
    try {
      const adoptEntry = (entry: SessionEntry | null) => {
        if (entry) {
          sessionEntry = entry;
          if (run.sessionStore) {
            run.sessionStore[sessionKey] = entry;
          }
        }
      };
      let metadataWritten = false;
      const updateEntry = async (update: Parameters<typeof patchSessionEntryCore>[1]) => {
        metadataWritten = false;
        return await patchSessionEntryCore(
          { storePath, sessionKey },
          (currentEntry, context) =>
            currentEntry.sessionId === initialSessionEntry?.sessionId &&
            currentEntry.lifecycleRevision === initialSessionEntry?.lifecycleRevision &&
            (currentEntry.compactionCount ?? 0) === (initialSessionEntry?.compactionCount ?? 0)
              ? update(currentEntry, context)
              : null,
          {
            skipMaintenance: true,
            takeCacheOwnership: true,
            workerGuard: { assertCurrent: run.assertCurrent },
            onCommitted: (entry) => {
              metadataWritten = true;
              adoptEntry(entry);
            },
          },
        );
      };
      const failedEntry = await updateEntry((currentEntry) => ({
        memoryFlush: {
          kind: "failed",
          ...(currentEntry.memoryFlush?.compactionCount !== undefined
            ? { compactionCount: currentEntry.memoryFlush.compactionCount }
            : {}),
          failureCount:
            (currentEntry.memoryFlush?.kind === "failed"
              ? currentEntry.memoryFlush.failureCount
              : 0) + 1,
        },
      }));
      if (!metadataWritten) {
        logVerbose("memory flush source changed; failure metadata was not recorded");
        return { sessionEntry, outcome };
      }
      const failureCount =
        failedEntry?.memoryFlush?.kind === "failed" ? failedEntry.memoryFlush.failureCount : 0;
      logVerbose(
        `memory flush failed (attempt ${failureCount}/${MAX_FLUSH_FAILURES}): ${truncatedError}`,
      );
      if (failedEntry && failureCount >= MAX_FLUSH_FAILURES) {
        await updateEntry((currentEntry) => ({
          memoryFlush: {
            kind: "succeeded",
            compactionCount: currentEntry.compactionCount ?? 0,
          },
        }));
        if (metadataWritten) {
          outcome = "exhausted";
          logVerbose(
            `memory flush exhausted: skipping flush for this compaction cycle after ${failureCount} consecutive failures`,
          );
        }
      }
    } catch (persistError) {
      logVerbose(`failed to persist memory flush failure metadata: ${String(persistError)}`);
    }
  } else {
    logVerbose(`memory flush run failed: ${String(error)}`);
  }
  return { sessionEntry, outcome };
}
