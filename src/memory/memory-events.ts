import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { MemoryWriteProvenanceObserver } from "../agents/memory-write-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { readRegularFileSync, root } from "../infra/fs-safe.js";
import { resolveMemoryArtifactRelativePath, type MemoryScope } from "./scoped-memory.js";
import { captureMemorySourceSession, type MemorySourceSession } from "./session-memory-context.js";

type MemoryEventStatus = "created" | "processing" | "completed" | "failed";
export type MemoryEventOutcome = "completed" | "failed" | "skipped" | "exhausted";
type MemoryEventUpdate = {
  status: Exclude<MemoryEventStatus, "created">;
  outcome?: MemoryEventOutcome;
};

export type MemoryEventHandle = {
  readonly eventId: string;
  readonly relativePath: string;
  update: (update: MemoryEventUpdate) => Promise<void>;
};

export type MemoryEventSource = {
  id: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  session: MemorySourceSession;
  endedSession: boolean;
  relativePath: string;
  hash: string;
  createdAtMs: number;
  eventType: string;
  scope: MemoryScope;
  settled: boolean;
  payloadTrust: "trusted" | "untrusted";
};

// Captured session excerpts can already reach 8 MiB; allow bounded metadata above that.
const MAX_EVENT_BYTES = 9 * 1024 * 1024;
const RESERVED_FIELDS = new Set([
  "schema",
  "artifactType",
  "eventId",
  "eventType",
  "status",
  "outcome",
  "createdAt",
  "updatedAt",
  "scope",
  "provenance",
]);

/** Create one scoped artifact; its retained handle can update only operation state. */
export async function createMemoryEvent(params: {
  workspaceDir: string;
  scope: MemoryScope;
  eventType: string;
  createdAt: Date;
  createdDate: string;
  slug?: string | null;
  status: MemoryEventStatus;
  outcome?: MemoryEventOutcome;
  metadata: Readonly<Record<string, unknown>>;
  payloadTrust: "trusted" | "untrusted";
  body: string;
  provenanceObserver: MemoryWriteProvenanceObserver;
  source?: {
    agentId: string;
    sessionKey: string;
    entry: SessionEntry;
    endedSession: boolean;
  };
  assertCurrent?: () => void;
}): Promise<MemoryEventHandle> {
  if (!/^[a-z][a-z0-9.-]{0,127}$/u.test(params.eventType)) {
    throw new Error("Memory Event type must be a bounded identifier");
  }
  const eventId = randomUUID();
  const relativePath = resolveMemoryArtifactRelativePath({
    scope: params.scope,
    artifactKind: "event",
    // Keep the whole UUID inside the resolver's 80-character name budget.
    artifactName: `${params.eventType.slice(0, 28)}-${eventId}${params.slug ? `-${params.slug}` : ""}`,
    createdDate: params.createdDate,
    createdAtMs: params.createdAt.getTime(),
  });
  const absolutePath = path.join(params.workspaceDir, relativePath);
  const metadata = Object.entries(params.metadata)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/u.test(key) || RESERVED_FIELDS.has(key)) {
        throw new Error(`Invalid memory Event metadata field: ${key}`);
      }
      return `${key}: ${JSON.stringify(value)}`;
    });
  const immutableHeader = [
    "schema: 1",
    "artifactType: event",
    `eventId: ${JSON.stringify(eventId)}`,
    `eventType: ${params.eventType}`,
    `createdAt: ${JSON.stringify(params.createdAt.toISOString())}`,
    `scope: ${JSON.stringify(params.scope)}`,
    ...metadata,
    "provenance:",
    "  framework: system",
    `  payloadTrust: ${params.payloadTrust}`,
  ].join("\n");
  const body = params.body;
  const render = (
    state: { status: MemoryEventStatus; outcome?: MemoryEventOutcome },
    updatedAt?: Date,
  ) => {
    const content = [
      "---",
      immutableHeader,
      `status: ${state.status}`,
      ...(state.outcome ? [`outcome: ${state.outcome}`] : []),
      ...(updatedAt ? [`updatedAt: ${JSON.stringify(updatedAt.toISOString())}`] : []),
      "---",
      "",
      body,
    ].join("\n");
    if (Buffer.byteLength(content, "utf8") > MAX_EVENT_BYTES) {
      throw new Error("Memory Event exceeds the bounded artifact size");
    }
    return content;
  };
  let status = params.status;
  let content = render(params);
  let updating = false;
  const sourceSession = params.source && captureMemorySourceSession(params.source.entry);
  const reserveSource = async (sourceContent: string, sourceStatus: MemoryEventStatus) => {
    if (!params.source || !sourceSession) {
      return;
    }
    const { getMemoryRuntime } = await import("../plugins/memory-state.js");
    params.assertCurrent?.();
    await getMemoryRuntime()?.recordEventSource?.({
      workspaceDir: params.workspaceDir,
      source: {
        id: eventId,
        agentId: params.source.agentId,
        sessionKey: params.source.sessionKey,
        sessionId: params.source.entry.sessionId,
        session: sourceSession,
        endedSession: params.source.endedSession,
        relativePath,
        hash: createHash("sha256").update(sourceContent).digest("hex"),
        createdAtMs: params.createdAt.getTime(),
        eventType: params.eventType,
        scope: params.scope,
        settled: sourceStatus === "completed" || sourceStatus === "failed",
        payloadTrust: params.payloadTrust,
      },
      assertCurrent: () => params.assertCurrent?.(),
    });
  };
  const memoryRoot = await root(params.workspaceDir, {
    assertBeforeMutation: params.assertCurrent,
    mutationSymlinks: "reject",
  });
  params.assertCurrent?.();
  await params.provenanceObserver.write({
    absolutePath,
    contentBefore: "",
    contentAfter: content,
    commit: async () => {
      await reserveSource(content, status);
      params.assertCurrent?.();
      await memoryRoot.create(relativePath, content, {
        encoding: "utf8",
        mkdir: true,
        atomic: true,
      });
    },
  });
  return Object.freeze({
    eventId,
    relativePath,
    update: async (update: MemoryEventUpdate) => {
      params.assertCurrent?.();
      if (updating || status === "completed" || status === "failed") {
        throw new Error("Memory Event is already settling or settled");
      }
      updating = true;
      try {
        const next = render(update, new Date());
        const expected = Buffer.from(content, "utf8");
        const assertUnchanged = () => {
          params.assertCurrent?.();
          const current = readRegularFileSync({
            filePath: absolutePath,
            maxBytes: MAX_EVENT_BYTES,
          });
          if (!current.buffer.equals(expected)) {
            throw new Error("Memory Event was edited outside its operation; preserving the file");
          }
        };
        assertUnchanged();
        await params.provenanceObserver.write({
          absolutePath,
          contentBefore: content,
          contentAfter: next,
          commit: async () => {
            await reserveSource(next, update.status);
            // Repeat after awaited provenance work and at fs-safe's publication boundary.
            // This detects prior edits; filesystem rename is not a cross-process byte CAS.
            await memoryRoot.write(relativePath, next, {
              encoding: "utf8",
              assertBeforeMutation: assertUnchanged,
            });
          },
        });
        content = next;
        status = update.status;
      } finally {
        updating = false;
      }
    },
  });
}

/** Materialize a bounded lifecycle tail through the same Event and provenance owners. */
export async function createMemorySessionEndEvent(params: {
  workspaceDir: string;
  scope: MemoryScope;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  session: MemorySourceSession;
  reason?: string;
  messages: readonly unknown[];
  totalMessages: number;
  truncated: boolean;
  assertCurrent(): void;
}): Promise<MemoryEventHandle | undefined> {
  const { getRecentSessionProjectionFromEvents } =
    await import("../hooks/bundled/session-memory/transcript.js");
  const projection = getRecentSessionProjectionFromEvents(
    params.messages.map((message) => ({ type: "message", message })),
    params.messages.length,
  );
  params.assertCurrent();
  if (!projection) {
    return undefined;
  }
  const { createMemoryWriteProvenanceObserver } =
    await import("../agents/memory-write-provenance.js");
  const now = new Date();
  return createMemoryEvent({
    workspaceDir: params.workspaceDir,
    scope: params.scope,
    eventType: "session.ended",
    createdAt: now,
    createdDate: now.toISOString().slice(0, 10),
    status: "completed",
    metadata: {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      reason: params.reason,
      totalMessages: params.totalMessages,
      truncated: params.truncated,
    },
    payloadTrust: projection.originClass === "agent" ? "trusted" : "untrusted",
    body: projection.content,
    provenanceObserver: createMemoryWriteProvenanceObserver({
      mutationRoot: params.workspaceDir,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      resolveOriginClass: () => projection.originClass,
    }),
    source: {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      entry: { ...params.session, sessionId: params.sessionId, updatedAt: now.getTime() },
      endedSession: true,
    },
    assertCurrent: () => params.assertCurrent(),
  });
}
