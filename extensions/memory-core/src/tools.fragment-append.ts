import {
  asToolParamsRecord,
  jsonResult,
  readStringParam,
  resolveCronStyleNow,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { formatDateStampInTimezone, formatTimeOfDayInTimezone } from "./date-stamp.js";
import {
  MEMORY_FRAGMENT_MAX_CHARS,
  MEMORY_FRAGMENT_TITLE_MAX_CHARS,
} from "./fragment-memory-write.js";
import {
  MEMORY_FRAGMENT_APPEND_TOOL_CONTRACT,
  type MemoryToolOptions,
} from "./memory-tool-contract.js";
import { resolveMemoryCoreNowMs } from "./time.js";
import { createMemoryTool, loadMemoryToolRuntime } from "./tools.shared.js";

/**
 * Fragment append is the only conversation-time memory write. The host-minted
 * audience supplies the admitted Channel/Thread scope and day-file path
 * encoder; the tool never accepts a caller-supplied path. Notes from one day
 * append sequentially to that scope's single dated file.
 */
export function createMemoryFragmentAppendTool(options: MemoryToolOptions) {
  const fragment = options.memoryAudience?.context?.fragment;
  const assertMemoryAudienceCurrent = options.assertMemoryAudienceCurrent;
  if (!fragment || !assertMemoryAudienceCurrent) {
    return null;
  }
  return createMemoryTool({
    options,
    contract: MEMORY_FRAGMENT_APPEND_TOOL_CONTRACT,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params, callerSignal) => {
        const rawParams = asToolParamsRecord(params);
        const content = readStringParam(rawParams, "content", { required: true });
        if (content.length > MEMORY_FRAGMENT_MAX_CHARS) {
          throw new Error(`content must be at most ${MEMORY_FRAGMENT_MAX_CHARS} characters`);
        }
        const title = readStringParam(rawParams, "title");
        if (title && title.length > MEMORY_FRAGMENT_TITLE_MAX_CHARS) {
          throw new Error(`title must be at most ${MEMORY_FRAGMENT_TITLE_MAX_CHARS} characters`);
        }
        // Re-check authority after parameter validation but before the write;
        // the host may have revoked or re-scoped the audience mid-turn.
        assertMemoryAudienceCurrent();
        callerSignal?.throwIfAborted();
        const nowMs = resolveMemoryCoreNowMs();
        const { userTimezone } = resolveCronStyleNow(cfg, nowMs);
        const createdDate = formatDateStampInTimezone(nowMs, userTimezone);
        const timeLabel = formatTimeOfDayInTimezone(nowMs, userTimezone);
        const relativePath = fragment.resolveRelativePath({ createdDate });
        const { appendAgentMemoryFragmentFile } = await loadMemoryToolRuntime();
        const result = await appendAgentMemoryFragmentFile({
          cfg,
          agentId,
          relPath: relativePath,
          content,
          timeLabel,
          ...(title ? { title } : {}),
          ...(options.memoryAudience?.kind === "conversation"
            ? {
                source: {
                  sessionKey: options.memoryAudience.sessionKey,
                  sessionId: options.memoryAudience.sessionId,
                  createdAtMs: nowMs,
                },
              }
            : {}),
          assertCurrent: () => {
            assertMemoryAudienceCurrent();
            callerSignal?.throwIfAborted();
          },
        });
        assertMemoryAudienceCurrent();
        callerSignal?.throwIfAborted();
        return jsonResult({
          scope: fragment.scope.kind,
          path: result.relativePath,
          createdAtMs: nowMs,
          entryTime: timeLabel,
          maxChars: MEMORY_FRAGMENT_MAX_CHARS,
        });
      },
  });
}
