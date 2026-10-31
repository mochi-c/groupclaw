import { resolveSessionAgentIdStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  asToolParamsRecord,
  type AnyAgentTool,
  resolveMemorySearchIndexConfig,
  type MemoryPromptSectionBuilder,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { TSchema } from "typebox";
import { MEMORY_ARTIFACT_REFERENCE_MAX_LENGTH } from "./memory-artifact-reference.js";
import type { MemoryCoreAcquireLocalService } from "./memory/embedding-local-service.js";
import type { MemoryCoreRuntimeHost } from "./memory/runtime-host.js";

export type MemoryToolOptions = {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  oneShotCliRun?: boolean;
  conversationRecall?: OpenClawPluginToolContext["conversationRecall"];
  memoryAudience?: OpenClawPluginToolContext["memoryAudience"];
  assertMemoryAudienceCurrent?: OpenClawPluginToolContext["assertMemoryAudienceCurrent"];
  activeProjectKeys?: readonly string[];
  acquireLocalService?: MemoryCoreAcquireLocalService;
  runInBackgroundContext?: MemoryCoreRuntimeHost["runInBackgroundContext"];
};

const MemorySearchSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    maxResults: { type: "integer", minimum: 1 },
    minScore: { type: "number" },
    corpus: { type: "string", enum: ["memory", "wiki", "all", "sessions"] },
  },
  required: ["query"],
  additionalProperties: false,
} as const satisfies TSchema;

const MemoryGetSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    from: { type: "integer", minimum: 1 },
    lines: { type: "integer", minimum: 1 },
    corpus: { type: "string", enum: ["memory", "wiki", "all"] },
  },
  required: ["path"],
  additionalProperties: false,
} as const satisfies TSchema;

const MemoryReadSchema = {
  type: "object",
  properties: {
    ref: { type: "string", minLength: 1, maxLength: MEMORY_ARTIFACT_REFERENCE_MAX_LENGTH },
    from: { type: "integer", minimum: 1 },
    lines: { type: "integer", minimum: 1 },
  },
  required: ["ref"],
  additionalProperties: false,
} as const satisfies TSchema;

const MemoryContextReadSchema = {
  type: "object",
  properties: {
    layers: {
      type: "array",
      items: { type: "string", enum: ["workspace", "channel", "thread", "users"] },
      uniqueItems: true,
    },
    userNames: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
    detail: { type: "string", enum: ["summary", "full"] },
    cursor: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const satisfies TSchema;

const MemoryFragmentAppendSchema = {
  type: "object",
  properties: {
    content: { type: "string", minLength: 1, maxLength: 8_000 },
    title: { type: "string", minLength: 1, maxLength: 120 },
  },
  required: ["content"],
  additionalProperties: false,
} as const satisfies TSchema;

type MemorySourceContract = Readonly<{ files: string; search: string }>;

function resolveMemorySourceContract(
  settings: NonNullable<ReturnType<typeof resolveMemorySearchIndexConfig>>,
): MemorySourceContract {
  const files = [
    "MEMORY.md, USER.md, Markdown files recursively under memory/",
    settings.extraPaths.length > 0 ? "configured extra paths" : "",
  ]
    .filter(Boolean)
    .join(", ");
  return {
    files,
    search: settings.searchSources.includes("sessions")
      ? `${files}, indexed session transcripts`
      : files,
  };
}

export function resolveMemoryToolContext(options: MemoryToolOptions) {
  const cfg = options.getConfig ? options.getConfig() : options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentIdStrict({
    sessionKey: options.agentSessionKey,
    config: cfg,
    agentId: options.agentId,
  });
  // Tool schemas and guidance need source policy; provider validation belongs to execution.
  const settings = resolveMemorySearchIndexConfig(cfg, agentId);
  return settings
    ? { cfg, agentId, settings, sources: resolveMemorySourceContract(settings) }
    : null;
}

const SEARCH_CORPUS_OUTCOME_GUIDANCE =
  "Corpus outcomes cover each requested corpus; only a top-level corpus warning means results are partial and must be surfaced to the user. An optional corpus outcome of not-registered in a multi-corpus result is informational.";
const GET_READ_OUTCOME_GUIDANCE =
  "status=ok means the requested excerpt was read; status=not_found means every requested available corpus missed; status=error means the requested read failed, not that memory is disabled.";
const MEMORY_CLARIFICATION_GUIDANCE =
  "If the subject, identity, scope, confidentiality, or meaning of a claim is ambiguous, ask a focused clarification before writing; never assume the latest sender is the subject. When a participant clearly corrects a fact, append it without asking for redundant confirmation. For every contradiction, preserve both statements, their contributors and source links, and the resolution or remaining uncertainty; ask any needed follow-up in the conversation. Dream reconciles the memory representation later, but does not decide the group's plan. Never persist confidential facts in shared memory. If no authorized private write is available, explain that the fact cannot be retained there; changing its visibility requires explicit authorization.";

export const MEMORY_SEARCH_TOOL_CONTRACT = {
  label: "Memory Search",
  name: "memory_search",
  parameters: MemorySearchSchema,
  prepareArguments: (args: unknown) => {
    const params = asToolParamsRecord(args);
    const aliases = [
      ["min_score", "minScore"],
      ["max_results", "maxResults"],
      ["limit", "maxResults"],
    ] as const;
    if (!aliases.some(([alias]) => Object.hasOwn(params, alias))) {
      return args;
    }
    const normalized = { ...params };
    // Precedence: maxResults > max_results > limit, even for invalid values validation must reject.
    for (const [alias, key] of aliases) {
      if (Object.hasOwn(normalized, alias) && !Object.hasOwn(normalized, key)) {
        normalized[key] = normalized[alias];
      }
      delete normalized[alias];
    }
    return normalized;
  },
  describe: ({ search }: MemorySourceContract) =>
    `Semantically search ${search} when an answer depends on prior work, decisions, dates, people, preferences, or todos not already present in the current turn. Do not repeat memory retrieval when supplied context fully answers the question. Omit \`corpus\` to search those configured sources. Session results are transcript search references, not readable memory-file paths. Optional \`corpus=wiki\` or \`corpus=all\` also searches registered compiled-wiki supplements; use \`corpus=all\` only when compiled wiki supplements are needed. \`corpus=memory\` restricts hits to indexed memory files (excludes session transcript chunks from ranking). \`corpus=sessions\` searches indexed session transcripts under the same visibility rules as session history tools and returns unavailable when semantic session indexing is disabled. ${SEARCH_CORPUS_OUTCOME_GUIDANCE} If response has disabled=true or stale=true, tell the user and include the warning/action guidance.`,
} as const;

export const MEMORY_GET_TOOL_CONTRACT = {
  label: "Memory Get",
  name: "memory_get",
  parameters: MemoryGetSchema,
  describe: ({ files }: MemorySourceContract) =>
    `Safe exact excerpt read from ${files}. Session transcript paths are unsupported; use the available session-history workflow for session hits. Defaults to a bounded excerpt when lines are omitted and includes truncation/continuation info when more content exists. \`corpus=wiki\` reads registered compiled-wiki supplements. ${GET_READ_OUTCOME_GUIDANCE} ${SEARCH_CORPUS_OUTCOME_GUIDANCE}`,
} as const;

export const MEMORY_READ_TOOL_CONTRACT = {
  label: "Memory Read",
  name: "memory_read",
  parameters: MemoryReadSchema,
  describe: () =>
    `Expand a memory-file ref returned by memory_search or a nextRef returned by this tool. Defaults to the referenced excerpt; optional from and lines select another bounded range in the same artifact. Follow nextRef to continue. References locate the current file, not a frozen snapshot or an access grant: every read checks current agent and conversation access. Session transcript and wiki hits do not supply memory-file refs. ${GET_READ_OUTCOME_GUIDANCE}`,
} as const;

export const MEMORY_CONTEXT_READ_TOOL_CONTRACT = {
  label: "Memory Context Read",
  name: "memory_context_read",
  parameters: MemoryContextReadSchema,
  describe: () =>
    "Read the current Workspace, Channel, optional Thread, and participating User curated memories without supplying paths or scope IDs. Defaults to every available current-context layer and participant. Use layers or userNames only to narrow the current context, detail=summary for a shorter excerpt, and cursor to continue a truncated response. Events and Archives are excluded; use memory_search for broad discovery.",
} as const;

export const MEMORY_FRAGMENT_APPEND_TOOL_CONTRACT = {
  label: "Memory Fragment Append",
  name: "memory_fragment_append",
  parameters: MemoryFragmentAppendSchema,
  describe: () =>
    `Append one dated situation note (a Fragment) to the current channel or thread conversation memory; this is the only memory write available during the conversation, and the target file is fixed to the admitted conversation's current date. Notes from one day append in sequence to the same dated file, so write a Fragment whenever participants make a decision, state a durable preference or constraint, correct the assistant, agree on conventions, or share a situation worth remembering later. Content rules: one self-contained Markdown note in the participants' language with the situation, who said or decided what, and source message links/URLs when available; keep it factual and timestamp-relative rather than a transcript copy; never include secrets or anything a participant asked not to retain. Durable curated memories (MEMORY.md) are consolidated later by the offline Dream pass from Fragments, so do not attempt to write or edit curated memory yourself. ${MEMORY_CLARIFICATION_GUIDANCE} Optional title labels the note's entry heading. Returns the dated file path; an unavailable result means Fragment writing is disabled.`,
} as const;

export type MemoryToolContract = (
  | typeof MEMORY_SEARCH_TOOL_CONTRACT
  | typeof MEMORY_GET_TOOL_CONTRACT
  | typeof MEMORY_READ_TOOL_CONTRACT
  | typeof MEMORY_CONTEXT_READ_TOOL_CONTRACT
  | typeof MEMORY_FRAGMENT_APPEND_TOOL_CONTRACT
) & { prepareArguments?: AnyAgentTool["prepareArguments"] };

export function buildMemoryPromptSection({
  availableTools,
  citationsMode,
}: Parameters<MemoryPromptSectionBuilder>[0]): string[] {
  const hasMemorySearch = availableTools.has("memory_search");
  const hasMemoryGet = availableTools.has("memory_get");
  const hasMemoryRead = availableTools.has("memory_read");
  const hasMemoryContextRead = availableTools.has("memory_context_read");
  const hasMemoryFragmentAppend = availableTools.has("memory_fragment_append");
  if (
    !hasMemorySearch &&
    !hasMemoryGet &&
    !hasMemoryRead &&
    !hasMemoryContextRead &&
    !hasMemoryFragmentAppend
  ) {
    return [];
  }

  const lines: string[] = ["## Memory Recall"];
  if (hasMemorySearch || hasMemoryGet || hasMemoryRead || hasMemoryContextRead) {
    // Code mode may defer tool descriptions; recall and disclosure policy must stay here.
    const guidance = hasMemorySearch
      ? `When an answer depends on prior work, decisions, dates, people, preferences, or todos not already present in the current turn: ${
          hasMemoryContextRead
            ? "use memory_context_read for the current Workspace, Channel, Thread, and participant memories; use memory_search without corpus when broader discovery is needed"
            : "run memory_search without corpus to search the configured sources"
        }${
          hasMemoryRead
            ? "; for memory-file hits with ref, use memory_read to expand the needed excerpt and nextRef to continue"
            : hasMemoryGet
              ? "; for memory-file hits, use memory_get to pull only the needed lines"
              : ""
        }. Do not repeat memory retrieval when supplied context fully answers the question. Use corpus=all only when compiled wiki supplements are needed. If low confidence after search, say you checked.`
      : hasMemoryContextRead
        ? `Use memory_context_read to refresh or expand the current Workspace, Channel, Thread, and participant memories.${
            hasMemoryRead
              ? " Use memory_read for a known memory-file ref and nextRef to continue."
              : hasMemoryGet
                ? " Use memory_get only for a known memory-file path."
                : ""
          }`
        : hasMemoryRead
          ? "Use memory_read with a known memory-file ref to pull only the needed lines; follow nextRef to continue. If low confidence after reading, say you checked."
          : "When an answer depends on prior work, decisions, dates, people, preferences, or todos not already present in the current turn and points to a specific memory file, run memory_get to pull only the needed lines. Do not repeat memory retrieval when supplied context fully answers the question. If low confidence after reading, say you checked.";
    lines.push(guidance);
    if (hasMemorySearch) {
      lines.push(
        availableTools.has("sessions_search")
          ? `For session hits, use sessions_search with distinctive snippet text (and sessionKey set to the transcript ID when known)${
              availableTools.has("sessions_history")
                ? ", then sessions_history with the returned sessionKey, messageId, and sessionId for a bounded sanitized excerpt"
                : "; exact session history is unavailable with the enabled tools"
            }.`
          : availableTools.has("sessions_history")
            ? "For session hits, use sessions_history with a known session key or transcript ID and a small limit; paginate its returned history metadata to locate the excerpt."
            : "Session hits are search snippets only; exact session history is unavailable with the enabled tools.",
        "Session search line numbers are not history offsets. Never read raw transcript files to expand session hits.",
      );
    }
    lines.push(
      "Report recall as partial, unavailable, or stale when the result includes a top-level warning or action guidance, or explicitly sets disabled=true or stale=true. In a multi-corpus result without a top-level warning or action guidance, treat an optional corpus outcome of not-registered as informational.",
      citationsMode === "off"
        ? "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks."
        : "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
  }
  if (hasMemoryFragmentAppend) {
    // The tool description carries the entry contract; this carries the
    // when-to-write and announce policy that must survive deferred descriptions.
    lines.push(
      `memory_fragment_append is the only way to persist new memory during this conversation; never create or edit memory files yourself. Append one self-contained note when participants make a decision, state a durable preference or constraint, correct you, or agree on a convention, then briefly say what you noted. Notes share one file per day, so write each decision as it happens. ${MEMORY_CLARIFICATION_GUIDANCE}`,
    );
  }
  lines.push("");
  return lines;
}

/** Ask agents to tag repository-specific curated entries with the run's safe project key. */
export function buildProjectMemoryWriteInstruction(projectKey: string | undefined): string[] {
  // Keys become HTML comments in curated Markdown, so line breaks or angle brackets are unsafe.
  return projectKey && !/[\r\n<>]/u.test(projectKey)
    ? [
        `For every repository-specific memory entry you write, add <!-- project: ${projectKey} --> on the same line. Do not project-scope user-level preferences, standing intents, or facts that are not specific to this repository.`,
        "",
      ]
    : [];
}
