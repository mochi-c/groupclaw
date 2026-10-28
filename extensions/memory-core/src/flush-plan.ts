import {
  resolveCronStyleNow,
  SILENT_REPLY_TOKEN,
  type MemoryFlushToolsPlan,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryCoreNowMs } from "./time.js";

const MEMORY_FLUSH_TARGET_HINT =
  "Use memory_fragment_append to append concise memory candidates to the current Channel or Thread Fragment. The host chooses the destination and records source provenance; do not supply a path.";
const MEMORY_FLUSH_READ_ONLY_HINT =
  "Treat existing memory and workspace reference files as read-only. Do not write curated Memory, Events, or Archives; Dream owns semantic consolidation.";
const DEFAULT_MEMORY_FLUSH_PROMPT = [
  "Pre-compaction memory flush.",
  MEMORY_FLUSH_TARGET_HINT,
  MEMORY_FLUSH_READ_ONLY_HINT,
  "Use memory_context_read if you need existing scoped memory. Avoid repeating notes already captured.",
  "Record clear corrections with their source and preserve unresolved uncertainty. Do not infer a subject or broader destination when it is ambiguous.",
  `If nothing to store, reply with ${SILENT_REPLY_TOKEN}.`,
].join(" ");

const DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT = [
  "Pre-compaction memory flush turn.",
  "The session is near auto-compaction; capture worthwhile context as Fragment candidates.",
  MEMORY_FLUSH_TARGET_HINT,
  MEMORY_FLUSH_READ_ONLY_HINT,
  `You may reply, but usually ${SILENT_REPLY_TOKEN} is correct.`,
].join(" ");

export function buildMemoryFlushPlan(
  params: {
    cfg?: OpenClawConfig;
    nowMs?: number;
  } = {},
): MemoryFlushToolsPlan | null {
  const nowMs = resolveMemoryCoreNowMs(params.nowMs);
  const cfg = params.cfg;
  if (cfg?.agents?.defaults?.compaction?.memoryFlush?.enabled === false) {
    return null;
  }
  const { timeLine } = resolveCronStyleNow(cfg ?? {}, nowMs);
  return {
    prompt: `${DEFAULT_MEMORY_FLUSH_PROMPT}\n${timeLine}`,
    systemPrompt: DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT,
    persistenceToolNames: ["memory_fragment_append"],
    lookupToolNames: ["memory_context_read"],
  };
}
