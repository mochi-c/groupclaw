import { createHash } from "node:crypto";
import {
  asToolParamsRecord,
  jsonResult,
  readStringParam,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  MEMORY_CONTEXT_READ_TOOL_CONTRACT,
  type MemoryToolOptions,
} from "./memory-tool-contract.js";
import { createMemoryTool, loadMemoryToolRuntime } from "./tools.shared.js";

type MemoryContextReadContext = NonNullable<
  NonNullable<MemoryToolOptions["memoryAudience"]>["context"]
>;
type MemoryContextLayer = MemoryContextReadContext["artifacts"][number]["layer"];

const MEMORY_CONTEXT_LAYERS: readonly MemoryContextLayer[] = [
  "workspace",
  "channel",
  "thread",
  "users",
];
const MEMORY_CONTEXT_READ_MAX_ITEMS = 8;
const MEMORY_CONTEXT_READ_MAX_CHARS = 24_000;
const MEMORY_CONTEXT_SUMMARY_LINES = 24;

type MemoryContextReadCursor = {
  version: 1;
  fingerprint: string;
  index: number;
  from?: number;
  layers: MemoryContextLayer[];
  userNames?: string[];
  detail: "summary" | "full";
};

function isMemoryContextLayer(value: unknown): value is MemoryContextLayer {
  return MEMORY_CONTEXT_LAYERS.some((layer) => layer === value);
}

function fingerprintMemoryContextSelection(
  artifacts: MemoryContextReadContext["artifacts"],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        artifacts.map((artifact) => [artifact.layer, artifact.relativePath, artifact.userName]),
      ),
    )
    .digest("hex");
}

function summarizeMemoryText(text: string): { text: string; lines: number; truncated: boolean } {
  const sourceLines = text.split("\n");
  const lines = sourceLines.slice(0, MEMORY_CONTEXT_SUMMARY_LINES);
  return {
    text: lines.join("\n"),
    lines: lines.length,
    truncated: sourceLines.length > lines.length,
  };
}

function readStringArrayParam(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${key} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((entry) => entry.trim()))];
}

function encodeMemoryContextCursor(cursor: MemoryContextReadCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeMemoryContextCursor(value: string): MemoryContextReadCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("cursor is invalid or expired");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("cursor is invalid or expired");
  }
  const { version, fingerprint, index, from, layers, userNames, detail } =
    asToolParamsRecord(parsed);
  if (
    version !== 1 ||
    typeof fingerprint !== "string" ||
    !fingerprint ||
    typeof index !== "number" ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    (from !== undefined && (typeof from !== "number" || !Number.isSafeInteger(from) || from < 1)) ||
    !Array.isArray(layers) ||
    !layers.every(isMemoryContextLayer) ||
    (userNames !== undefined &&
      (!Array.isArray(userNames) ||
        !userNames.every(
          (name): name is string => typeof name === "string" && Boolean(name.trim()),
        ))) ||
    (detail !== "summary" && detail !== "full")
  ) {
    throw new Error("cursor is invalid or expired");
  }
  return {
    version,
    fingerprint,
    index,
    ...(from !== undefined ? { from } : {}),
    layers,
    ...(userNames !== undefined ? { userNames } : {}),
    detail,
  };
}

function resolveMemoryContextReadSelection(params: {
  context: MemoryContextReadContext;
  layers: MemoryContextLayer[];
  userNames?: string[];
}) {
  const layers = new Set(params.layers);
  if (params.userNames && !layers.has("users")) {
    throw new Error("userNames requires the users layer");
  }
  const userArtifacts = params.context.artifacts.filter((artifact) => artifact.layer === "users");
  let selectedUserNames: Set<string> | undefined;
  if (params.userNames) {
    const byNormalizedName = new Map<string, typeof userArtifacts>();
    for (const artifact of userArtifacts) {
      const key = artifact.userName?.trim().toLocaleLowerCase();
      if (!key) {
        continue;
      }
      byNormalizedName.set(key, [...(byNormalizedName.get(key) ?? []), artifact]);
    }
    selectedUserNames = new Set<string>();
    for (const requestedName of params.userNames) {
      const matches = byNormalizedName.get(requestedName.toLocaleLowerCase()) ?? [];
      if (matches.length === 0) {
        throw new Error(`userName is not a current participant: ${requestedName}`);
      }
      if (matches.length > 1) {
        throw new Error(`userName is ambiguous in the current participants: ${requestedName}`);
      }
      selectedUserNames.add(matches[0]!.userName!);
    }
  }
  return params.context.artifacts.filter(
    (artifact) =>
      layers.has(artifact.layer) &&
      (artifact.layer !== "users" ||
        !selectedUserNames ||
        selectedUserNames.has(artifact.userName!)),
  );
}

export function createMemoryContextReadTool(options: MemoryToolOptions) {
  const context = options.memoryAudience?.context;
  const assertMemoryAudienceCurrent = options.assertMemoryAudienceCurrent;
  if (!context || !assertMemoryAudienceCurrent) {
    return null;
  }
  return createMemoryTool({
    options,
    contract: MEMORY_CONTEXT_READ_TOOL_CONTRACT,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params, callerSignal) => {
        const rawParams = asToolParamsRecord(params);
        const cursorValue = readStringParam(rawParams, "cursor");
        if (
          cursorValue &&
          ["layers", "userNames", "detail"].some((key) => Object.hasOwn(rawParams, key))
        ) {
          throw new Error("cursor cannot be combined with layers, userNames, or detail");
        }
        const cursor = cursorValue ? decodeMemoryContextCursor(cursorValue) : undefined;
        const layers = cursor?.layers ??
          readStringArrayParam(rawParams, "layers") ?? [...MEMORY_CONTEXT_LAYERS];
        if (!layers.every(isMemoryContextLayer)) {
          throw new Error(`layers must contain only: ${MEMORY_CONTEXT_LAYERS.join(", ")}`);
        }
        const userNames = cursor?.userNames ?? readStringArrayParam(rawParams, "userNames");
        const detailParam = readStringParam(rawParams, "detail");
        if (detailParam !== undefined && detailParam !== "summary" && detailParam !== "full") {
          throw new Error("detail must be summary or full");
        }
        const detail = cursor?.detail ?? detailParam ?? "full";
        const selected = resolveMemoryContextReadSelection({ context, layers, userNames });
        const fingerprint = fingerprintMemoryContextSelection(selected);
        if (cursor && cursor.fingerprint !== fingerprint) {
          throw new Error("cursor is invalid or expired");
        }
        const startIndex = cursor?.index ?? 0;
        if (startIndex > selected.length) {
          throw new Error("cursor is invalid or expired");
        }
        const { readAgentMemoryFile } = await loadMemoryToolRuntime();
        const items: Array<Record<string, unknown>> = [];
        let totalChars = 0;
        let index = startIndex;
        let from = cursor?.from;
        let nextCursor: string | undefined;
        let omittedItems = 0;
        while (index < selected.length && items.length < MEMORY_CONTEXT_READ_MAX_ITEMS) {
          callerSignal?.throwIfAborted();
          assertMemoryAudienceCurrent();
          const artifact = selected[index]!;
          const read = await readAgentMemoryFile({
            cfg,
            agentId,
            relPath: artifact.relativePath,
            from,
            rejectAliases: true,
          });
          assertMemoryAudienceCurrent();
          callerSignal?.throwIfAborted();
          const presented =
            detail === "summary" && read.status === "ok"
              ? summarizeMemoryText(read.text)
              : read.status === "ok"
                ? { text: read.text, lines: read.lines, truncated: read.truncated === true }
                : undefined;
          if (
            items.length > 0 &&
            totalChars + (presented?.text.length ?? 0) > MEMORY_CONTEXT_READ_MAX_CHARS
          ) {
            nextCursor = encodeMemoryContextCursor({
              version: 1,
              fingerprint,
              index,
              ...(from ? { from } : {}),
              layers,
              ...(userNames ? { userNames } : {}),
              detail,
            });
            omittedItems = selected.length - index;
            break;
          }
          items.push({
            layer: artifact.layer,
            scope: artifact.scope.kind,
            ...(artifact.userName ? { userName: artifact.userName } : {}),
            status: read.status,
            ...(read.status === "ok"
              ? {
                  text: presented!.text,
                  from: read.from,
                  lines: presented!.lines,
                  ...(presented!.truncated ? { truncated: true } : {}),
                }
              : {}),
          });
          totalChars += presented?.text.length ?? 0;
          if (detail === "full" && read.status === "ok" && read.nextFrom) {
            nextCursor = encodeMemoryContextCursor({
              version: 1,
              fingerprint,
              index,
              from: read.nextFrom,
              layers,
              ...(userNames ? { userNames } : {}),
              detail,
            });
            omittedItems = selected.length - index - 1;
            break;
          }
          index += 1;
          from = undefined;
        }
        if (!nextCursor && index < selected.length) {
          nextCursor = encodeMemoryContextCursor({
            version: 1,
            fingerprint,
            index,
            layers,
            ...(userNames ? { userNames } : {}),
            detail,
          });
          omittedItems = selected.length - index;
        }
        const warnings =
          context.participantCoverage === "partial" && layers.includes("users")
            ? [
                "The retained participant directory is partial, so some participating User memories may be omitted.",
              ]
            : [];
        return jsonResult({
          detail,
          items,
          participantCoverage: context.participantCoverage,
          omittedItems: Math.max(0, omittedItems),
          ...(nextCursor ? { nextCursor } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      },
  });
}
