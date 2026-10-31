import type {
  MemoryEventSource,
  MemorySourceSession,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  DREAMING_FRAGMENT_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
  readMemoryCoreWorkspaceEntry,
  writeMemoryCoreWorkspaceEntry,
  deleteMemoryCoreWorkspaceEntry,
} from "./dreaming-state.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";

/** Host-captured source identity; Markdown alone never grants Dream authority. */
export type DreamFragmentSource = {
  id: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  relativePath: string;
  hash: string;
  createdAtMs: number;
  processed?: boolean;
  lastAttemptAtMs?: number;
} & (
  | { kind: "fragment"; session?: MemorySourceSession; endedSession?: boolean }
  | ({ kind: "event" } & MemoryEventSource)
);

type DreamFragmentPublication = {
  id: string;
  target: string;
  sourceIds: string[];
  coveredSourceIds?: string[];
  before: string;
  after: string;
  verified?: boolean;
  coveredEntries?: string[];
};

type DreamFragmentTopic = {
  text: string;
  sourceIds: string[];
};

export type DreamFragmentNotebook = {
  version: 2;
  topics: DreamFragmentTopic[];
  artifacts?: Array<{ id: string; target: string; sourceIds: string[] }>;
  pending?: {
    evidence: {
      sources: DreamFragmentSource[];
      inputs: Array<{ id: string; hash: string }>;
      targets: Array<{ path: string; hash: string }>;
      curated: Array<{ id: string; path: string; hash: string }>;
      topicsHash: string;
      artifactsHash: string;
    };
    publications: DreamFragmentPublication[];
    /** Absent on older plans whose citations did not establish cleanup coverage. */
    discard?: string[];
    clean: string[];
    cleanup?: Array<{ path: string; sourceIds: string[]; before: string; after: string }>;
    processed: string[];
    topics: DreamFragmentTopic[];
  };
};

export async function readDreamFragmentSources(
  workspaceDir: string,
): Promise<DreamFragmentSource[]> {
  return (
    await readMemoryCoreWorkspaceEntries<DreamFragmentSource | DreamFragmentNotebook>({
      namespace: DREAMING_FRAGMENT_NAMESPACE,
      workspaceDir,
    })
  ).flatMap(({ key, value }) => {
    if (!key.startsWith("source:")) {
      return [];
    }
    if (!("id" in value) || key !== `source:${value.id}`) {
      throw new Error("Dream Fragment source state is invalid; leave sources intact");
    }
    return [value];
  });
}

export async function writeDreamFragmentSource(
  workspaceDir: string,
  source: DreamFragmentSource,
): Promise<void> {
  await writeMemoryCoreWorkspaceEntry({
    namespace: DREAMING_FRAGMENT_NAMESPACE,
    workspaceDir,
    key: `source:${source.id}`,
    value: source,
  });
}

/** Called under the Workspace lock by Event and session-end capture. */
export async function markDreamSessionEnded(params: {
  workspaceDir: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  session: MemorySourceSession;
  assertCurrent(): void;
}): Promise<void> {
  for (const source of await readDreamFragmentSources(params.workspaceDir)) {
    if (
      source.kind === "fragment" &&
      source.agentId === params.agentId &&
      source.sessionKey === params.sessionKey &&
      source.sessionId === params.sessionId
    ) {
      params.assertCurrent();
      await writeDreamFragmentSource(params.workspaceDir, {
        ...source,
        // The departing owner captures the final participants, including people
        // who joined after the Fragment was first recorded.
        session: params.session,
        endedSession: true,
      });
    }
  }
}

/** Event reservations share the Fragment notebook and forget lifecycle. */
export async function recordDreamEventSource(params: {
  workspaceDir: string;
  source: MemoryEventSource;
  assertCurrent(): void;
}): Promise<void> {
  return withMemoryWorkspaceLock(params.workspaceDir, async () => {
    const { findForgottenMemorySessionIds, recordMemoryEntryOrigins } =
      await import("./memory-entry-origins.js");
    const tombstones = await findForgottenMemorySessionIds({
      agentId: params.source.agentId,
      sessionIds: [params.source.sessionId],
    });
    params.assertCurrent();
    if (tombstones.size) {
      throw new Error("Dream Event belongs to an explicitly forgotten session");
    }
    await recordMemoryEntryOrigins({
      agentId: params.source.agentId,
      entryKey: params.source.id,
      origins: [
        {
          entryKey: params.source.id,
          agentId: params.source.agentId,
          sessionKey: params.source.sessionKey,
          sessionId: params.source.sessionId,
          observedAt: params.source.createdAtMs,
          originClass: params.source.payloadTrust === "trusted" ? "agent" : "untrusted",
        },
      ],
    });
    params.assertCurrent();
    await writeDreamFragmentSource(params.workspaceDir, { kind: "event", ...params.source });
    if (params.source.endedSession) {
      await markDreamSessionEnded({
        workspaceDir: params.workspaceDir,
        ...params.source,
        assertCurrent: () => params.assertCurrent(),
      });
    }
  });
}

export async function readDreamFragmentNotebook(
  workspaceDir: string,
): Promise<DreamFragmentNotebook> {
  const notebook = await readMemoryCoreWorkspaceEntry<DreamFragmentNotebook>({
    namespace: DREAMING_FRAGMENT_NAMESPACE,
    workspaceDir,
    key: "notebook",
  });
  if (notebook && notebook.version !== 2) {
    throw new Error("Unsupported Dream notebook version; leave sources intact");
  }
  return notebook ?? { version: 2, topics: [] };
}

export async function writeDreamFragmentNotebook(
  workspaceDir: string,
  notebook: DreamFragmentNotebook,
): Promise<void> {
  if (
    notebook.topics.reduce((sum, topic) => sum + topic.text.length, 0) > 16_000 ||
    Buffer.byteLength(JSON.stringify(notebook)) > 900_000
  ) {
    throw new Error("Dream notebook capacity exceeded; preserve sources and pending work");
  }
  await writeMemoryCoreWorkspaceEntry({
    namespace: DREAMING_FRAGMENT_NAMESPACE,
    workspaceDir,
    key: "notebook",
    value: notebook,
  });
}

export async function forgetDreamFragmentState(params: {
  workspaceDir: string;
  agentId: string;
  sessionIds: ReadonlySet<string>;
}): Promise<void> {
  const sources = await readDreamFragmentSources(params.workspaceDir);
  const removed = new Set(
    sources
      .filter(
        (source) => source.agentId === params.agentId && params.sessionIds.has(source.sessionId),
      )
      .map((source) => source.id),
  );
  if (!removed.size) {
    return;
  }
  const notebook = await readDreamFragmentNotebook(params.workspaceDir);
  const topics = notebook.topics.filter((topic) => !topic.sourceIds.some((id) => removed.has(id)));
  // A pending plan is one evidence-dependent unit. Discard it before deleting
  // receipts so recovery cannot restore explicitly forgotten content.
  const pending = notebook.pending;
  const affected =
    pending &&
    [
      ...pending.evidence.sources.map((source) => source.id),
      ...pending.processed,
      ...pending.clean,
      ...pending.topics.flatMap((topic) => topic.sourceIds),
      ...pending.publications.flatMap((publication) => publication.sourceIds),
    ].some((id) => removed.has(id));
  const artifacts = notebook.artifacts?.filter(
    (artifact) => !artifact.sourceIds.some((id) => removed.has(id)),
  );
  await writeDreamFragmentNotebook(params.workspaceDir, {
    version: 2,
    topics,
    ...(artifacts?.length ? { artifacts } : {}),
    ...(pending && !affected ? { pending } : {}),
  });
  for (const id of removed) {
    await deleteMemoryCoreWorkspaceEntry({
      namespace: DREAMING_FRAGMENT_NAMESPACE,
      workspaceDir: params.workspaceDir,
      key: `source:${id}`,
    });
  }
}
