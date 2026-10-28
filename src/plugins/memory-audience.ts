import { getLoadedChannelPluginById } from "../channels/plugins/registry-loaded.js";
import {
  isSessionDeliveryGenerationRevokedError,
  prepareSessionGenerationFacts,
} from "../config/sessions/session-delivery-generation.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { MemoryContextReadContext } from "../memory/scoped-memory.js";
import {
  captureMemorySourceSession,
  resolveMemoryContext,
  type MemorySourceSession,
} from "../memory/session-memory-context.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { sessionDeliveryOrigin } from "../utils/delivery-context.read.js";
import type { MemoryAudience, MemoryCallerContext } from "./memory-provider-types.js";

const MAX_LINEAGE_HOPS = 64;
const SESSION_ID_PATTERN = /^[a-f0-9-]{36}$/;

type GenerationLease = Awaited<ReturnType<typeof prepareSessionGenerationFacts>>;

// One record per minted audience. A delegated record owns its child-session
// lease and borrows its parent's record, so either side going stale rejects it.
type AudienceRecord = {
  parent?: AudienceRecord;
  leases: GenerationLease[];
  state: "current" | "stale" | "released";
  holders: number;
  execution: AbortController;
  releases?: Array<() => void>;
  assertContextCurrent?: () => void;
};

/** A host-minted audience plus the owner-held release for its session leases. */
export type MemoryAudienceGrant = { audience: MemoryAudience; release: () => void };

/** Resolution outcome; a denial names why no memory audience was granted. */
export type MemoryAudienceResolution =
  | ({ status: "granted" } & MemoryAudienceGrant)
  | { status: "denied"; reason: string; legacyLineage?: true };

const hostAudiences = new WeakSet<object>();
const audienceRecords = new WeakMap<object, AudienceRecord>();
const audienceSessionKeys = new WeakMap<object, string>();

function releaseRecordLeases(record: AudienceRecord): void {
  record.execution.abort(new Error("memory audience was released by its owner"));
  for (const release of record.releases?.splice(0) ?? []) {
    release();
  }
  for (const lease of record.leases.splice(0)) {
    lease.release();
  }
}

// Owners release leases deterministically; collection is only the backstop
// for an owner that threw before its release ran.
const collectedAudienceRecords = new FinalizationRegistry<AudienceRecord>((record) => {
  for (let current: AudienceRecord | undefined = record; current; current = current.parent) {
    current.holders -= 1;
    if (current.holders > 0) {
      return;
    }
    releaseRecordLeases(current);
  }
});

function isAgentSessionKey(sessionKey: string, agentId: string): boolean {
  return parseAgentSessionKey(sessionKey)?.agentId === agentId;
}

function isSessionId(sessionId: string | undefined): sessionId is string {
  return typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId);
}

function resolveGenerationStorePath(agentId: string, sessionKey: string, storePath: string) {
  return isIncognitoSessionKey(sessionKey)
    ? resolveIncognitoOpenClawAgentSqlitePath({ agentId })
    : storePath;
}

// Canonical session reads run on the read-only worker, never the Gateway main thread.
async function readEntryInWorker(params: {
  agentId: string;
  sessionKey: string;
  storePath: string;
  assertCallerCurrent: () => void;
}): Promise<SessionEntry | undefined> {
  const read = await withSessionEntryReadOnlyInWorker(
    { agentId: params.agentId, sessionKey: params.sessionKey, storePath: params.storePath },
    params.assertCallerCurrent,
    async (result) => result,
  );
  if (!read.ok) {
    throw read.error;
  }
  return read.value;
}

// The session owner's generation lease keeps later currency checks synchronous
// and read-free: committed row publications advance or revoke its facts.
async function leaseSessionGeneration(params: {
  agentId: string;
  sessionKey: string;
  storePath: string;
  /** Undefined leases the row's absence: any later row for the key revokes it. */
  entry: Pick<SessionEntry, "sessionId" | "lifecycleRevision"> | undefined;
  onRevoked?: (reason: unknown) => void;
}): Promise<GenerationLease | undefined> {
  try {
    return await prepareSessionGenerationFacts(
      {
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        storePath: resolveGenerationStorePath(params.agentId, params.sessionKey, params.storePath),
        sessionId: params.entry?.sessionId ?? null,
        lifecycleRevision: params.entry?.lifecycleRevision ?? null,
      },
      params.onRevoked,
    );
  } catch (error) {
    if (isSessionDeliveryGenerationRevokedError(error)) {
      return undefined;
    }
    throw error;
  }
}

function assertRecordCurrent(record: AudienceRecord): void {
  for (let current: AudienceRecord | undefined = record; current; current = current.parent) {
    if (current.state === "released") {
      throw new Error("memory audience was released by its owner");
    }
    if (current.state === "stale") {
      throw new Error("memory audience is no longer current");
    }
    try {
      current.assertContextCurrent?.();
    } catch (error) {
      current.execution.abort(error);
      throw error;
    }
    for (const lease of current.leases) {
      try {
        lease.assertCurrent();
      } catch (error) {
        // A changed incarnation is permanent for this grant even if a later
        // write rotates back; a pending publication only fails this check.
        if (isSessionDeliveryGenerationRevokedError(error)) {
          current.state = "stale";
          releaseRecordLeases(current);
          throw new Error("memory audience is no longer current", { cause: error });
        }
        throw new Error("memory audience currency is unavailable; retry the operation", {
          cause: error,
        });
      }
    }
  }
}

function mintMemoryAudience(
  audience: MemoryAudience,
  sessionKey: string,
  record: AudienceRecord,
): MemoryAudienceGrant {
  const frozen = Object.freeze(audience);
  hostAudiences.add(frozen);
  audienceRecords.set(frozen, record);
  audienceSessionKeys.set(frozen, sessionKey);
  for (let current: AudienceRecord | undefined = record; current; current = current.parent) {
    current.holders += 1;
  }
  collectedAudienceRecords.register(frozen, record);
  return {
    audience: frozen,
    release: () => {
      if (record.state !== "current") {
        return;
      }
      record.state = "released";
      releaseRecordLeases(record);
    },
  };
}

type MemoryAudienceResolutionParams = {
  agentId: string;
  sessionKey: string;
  sessionId: string | undefined;
  senderIsOwner: boolean | undefined;
  /** Store that admitted the turn; lineage hops for the same agent share it. */
  storePath: string;
  assertCallerCurrent?: () => void;
  cfg?: OpenClawConfig;
  /** Background work rechecks the current configured audience before effects. */
  getConfig?: () => OpenClawConfig;
};

/**
 * Resolve from the current entry already admitted by the host turn owner.
 * Parent rows are read on the read-only worker; every hop holds a session
 * generation lease that is rechecked after the final await, before minting.
 */
export async function resolveMemoryAudienceFromEntry(
  params: MemoryAudienceResolutionParams,
  admittedEntry: SessionEntry,
): Promise<MemoryAudienceResolution> {
  let { sessionKey, sessionId, senderIsOwner } = params;
  const { agentId, storePath } = params;
  const assertCallerCurrent = params.assertCallerCurrent ?? (() => {});
  const seen = new Set<string>();
  const record: AudienceRecord = {
    leases: [],
    state: "current",
    holders: 0,
    execution: new AbortController(),
  };
  let requiredLifecycleRevision: string | undefined;
  const deny = (reason: string, legacyLineage?: true): MemoryAudienceResolution => {
    releaseRecordLeases(record);
    return { status: "denied", reason, ...(legacyLineage ? { legacyLineage } : {}) };
  };

  try {
    for (let depth = 0; depth < MAX_LINEAGE_HOPS; depth += 1) {
      // Every hop must remain within the configured agent and exact durable
      // session incarnation. Session-key shape alone never grants authority.
      if (
        !isAgentSessionKey(sessionKey, agentId) ||
        !isSessionId(sessionId) ||
        seen.has(sessionKey)
      ) {
        return deny(`session lineage at ${sessionKey} is malformed, cyclic, or cross-agent`);
      }
      seen.add(sessionKey);
      // A turn admission already owns its current row. Reuse that prepared fact
      // at depth zero; only delegated parent hops need another canonical read.
      const entry =
        depth === 0
          ? admittedEntry
          : await readEntryInWorker({ agentId, sessionKey, storePath, assertCallerCurrent });
      if (
        !entry ||
        entry.sessionId !== sessionId ||
        (depth > 0 && entry.lifecycleRevision !== requiredLifecycleRevision)
      ) {
        return deny(`session ${sessionKey} is missing or no longer matches its recorded lineage`);
      }
      // The lease re-verifies this exact incarnation against current storage,
      // so a change between the read above and here denies the grant.
      const lease = await leaseSessionGeneration({
        agentId,
        sessionKey,
        storePath,
        entry,
        onRevoked: (reason) => record.execution.abort(reason),
      });
      if (!lease) {
        return deny(`session ${sessionKey} changed while its memory audience was resolved`);
      }
      record.leases.push(lease);

      if (entry.spawnedBy !== undefined) {
        // A child inherits only the owner bit and exact parent incarnation stamped
        // by the spawn owner. Its launch turn and copied chat metadata are not grants.
        // Every receipt carries the owner bit; a parent row without a lifecycle
        // revision (such as a channel-created row) is recorded by its absence.
        if (typeof entry.spawnedBySenderIsOwner !== "boolean") {
          return deny(
            `spawned session ${sessionKey} predates memory lineage receipts (spawnedBySenderIsOwner), so it has no inherited memory audience. Respawn it from its parent session to restore memory access.`,
            true,
          );
        }
        // Voice consult children record no navigation parent; a recorded one must agree.
        if (
          !entry.spawnedBy ||
          (entry.parentSessionKey !== undefined && entry.parentSessionKey !== entry.spawnedBy) ||
          !isSessionId(entry.spawnedBySessionId) ||
          entry.parentSessionLifecycleRevision === ""
        ) {
          return deny(`spawned session ${sessionKey} has malformed lineage receipts`);
        }
        sessionKey = entry.spawnedBy;
        sessionId = entry.spawnedBySessionId;
        requiredLifecycleRevision = entry.parentSessionLifecycleRevision;
        senderIsOwner = entry.spawnedBySenderIsOwner;
        continue;
      }

      // Revalidate every captured hop after the final await, before minting.
      assertCallerCurrent();
      assertRecordCurrent(record);
      const origin = sessionDeliveryOrigin(entry);
      const provider = origin?.provider ?? origin?.surface;
      const resolvePolicy = provider
        ? getLoadedChannelPluginById(provider)?.groups?.resolveMemoryPolicy
        : undefined;
      const getConfig = params.getConfig;
      const context = resolveMemoryContext(
        entry,
        sessionKey,
        getConfig?.() ?? params.cfg ?? {},
        resolvePolicy,
      );
      if (getConfig) {
        const fingerprint = JSON.stringify(context);
        let contextRevoked = false;
        record.assertContextCurrent = () => {
          if (
            contextRevoked ||
            JSON.stringify(resolveMemoryContext(entry, sessionKey, getConfig(), resolvePolicy)) !==
              fingerprint
          ) {
            contextRevoked = true;
            throw new Error("memory context membership or publication authority changed");
          }
        };
        record.releases = [
          sessionChanges.subscribe((change) => {
            if (!("all" in change)) {
              return;
            }
            try {
              assertRecordCurrent(record);
            } catch (error) {
              record.execution.abort(error);
            }
          }),
        ];
      }
      // Only the durable root chat type selects the partition. Thread-shaped
      // keys intentionally receive no special interpretation here.
      if (entry.chatType === "direct" && senderIsOwner === true) {
        return {
          status: "granted",
          ...mintMemoryAudience(
            { kind: "owner-private", agentId, context },
            params.sessionKey,
            record,
          ),
        };
      }
      if (
        entry.chatType === "direct" ||
        entry.chatType === "group" ||
        entry.chatType === "channel"
      ) {
        return {
          status: "granted",
          ...mintMemoryAudience(
            {
              kind: "conversation",
              agentId,
              sessionKey,
              sessionId,
              context,
            },
            params.sessionKey,
            record,
          ),
        };
      }
      return deny(`root session ${sessionKey} has no durable chat type`);
    }
    return deny(`session lineage exceeds ${MAX_LINEAGE_HOPS} hops`);
  } catch (error) {
    releaseRecordLeases(record);
    // A caller that is no longer current propagates; unavailable session
    // storage denies memory access instead of failing the whole turn.
    assertCallerCurrent();
    return deny(
      `session lineage or memory context could not be verified: ${formatErrorMessage(error)}`,
    );
  }
}

/** Return whether a memory audience was minted by this host process. */
export function isHostMemoryAudience(value: unknown): value is MemoryAudience {
  return typeof value === "object" && value !== null && hostAudiences.has(value);
}

/** Reject an audience presented outside its host-bound invocation session. */
export function assertMemoryAudienceSession(
  audience: MemoryAudience,
  sessionKey: string | undefined,
): void {
  if (!isHostMemoryAudience(audience)) {
    throw new Error("memory audience was not minted by this host");
  }
  if (audienceSessionKeys.get(audience) !== sessionKey) {
    throw new Error("memory audience is bound to a different session");
  }
}

/**
 * Bind a child audience to the child session's current incarnation and to the
 * parent's lineage, so a child reset or reassignment rejects it before provider I/O.
 * A detached child has no row; its grant binds that absence instead.
 */
export async function delegateMemoryAudience(
  audience: MemoryAudience,
  child: {
    sessionKey: string;
    storePath: string;
    detached?: boolean;
    assertCallerCurrent?: () => void;
  },
): Promise<MemoryAudienceGrant> {
  assertMemoryAudienceCurrent(audience);
  const parent = audienceRecords.get(audience)!;
  const { agentId } = audience;
  const assertCallerCurrent = child.assertCallerCurrent ?? (() => {});
  if (!isAgentSessionKey(child.sessionKey, agentId)) {
    throw new Error("memory audience delegation requires a session for the same agent");
  }
  const entry = await readEntryInWorker({
    agentId,
    sessionKey: child.sessionKey,
    storePath: child.storePath,
    assertCallerCurrent,
  });
  // Host-run children (for example recall sessions) use non-UUID session ids;
  // the lease below binds whatever exact incarnation the row holds.
  if (
    entry
      ? typeof entry.sessionId !== "string" || entry.sessionId.length === 0
      : child.detached !== true
  ) {
    throw new Error(
      `memory audience delegation requires an existing child session: ${child.sessionKey}`,
    );
  }
  const execution = new AbortController();
  const lease = await leaseSessionGeneration({
    agentId,
    sessionKey: child.sessionKey,
    storePath: child.storePath,
    entry,
    onRevoked: (reason) => execution.abort(reason),
  });
  if (!lease) {
    throw new Error(`child session changed during memory audience delegation: ${child.sessionKey}`);
  }
  const record: AudienceRecord = {
    parent,
    leases: [lease],
    state: "current",
    holders: 0,
    execution,
  };
  try {
    // The parent can go stale while the child row is read; recheck both after the awaits.
    assertCallerCurrent();
    assertRecordCurrent(record);
  } catch (error) {
    releaseRecordLeases(record);
    throw error;
  }
  return mintMemoryAudience({ ...audience }, child.sessionKey, record);
}

/** Execution borrows cancellation from every live lineage owner, never from caller-supplied IDs. */
export function readMemoryAudienceExecutionSignal(audience: MemoryAudience): AbortSignal {
  assertMemoryAudienceCurrent(audience);
  const signals: AbortSignal[] = [];
  for (let record = audienceRecords.get(audience); record; record = record.parent) {
    signals.push(record.execution.signal);
  }
  return AbortSignal.any(signals);
}

/** Reject a retained audience after any captured session incarnation changes. */
export function assertMemoryAudienceCurrent(audience: MemoryAudience): void {
  const record = audienceRecords.get(audience);
  if (!record) {
    throw new Error("memory audience was not minted by this host");
  }
  assertRecordCurrent(record);
}

/**
 * Check a memory caller's whole authority: its own currency, its audience's
 * session binding and currency, and its abort signal. Final guards before
 * provider I/O or prompt publication use this, never the caller's check alone.
 */
export function assertMemoryCallerCurrent(context: MemoryCallerContext): void {
  context.assertCurrent();
  const { authority } = context;
  if (authority.kind === "session" && authority.audience) {
    assertMemoryAudienceSession(authority.audience, authority.sessionKey);
    assertMemoryAudienceCurrent(authority.audience);
  }
  context.signal?.throwIfAborted();
}

/** Admit background source facts through the same session-generation owner as tools. */
export async function withMemoryDreamSource<T>(
  params: {
    agentId: string;
    sessionKey: string;
    sessionId: string;
    storePath: string;
    assertCurrent: () => void;
    cfg?: OpenClawConfig;
    getConfig?: () => OpenClawConfig;
    /** Host-captured departing facts supplied by the durable source owner. */
    endedSession?: MemorySourceSession;
  },
  consume: (facts: {
    context: MemoryContextReadContext;
    origin: NonNullable<ReturnType<typeof sessionDeliveryOrigin>>;
    session: MemorySourceSession;
    assertCurrent(this: void): void;
  }) => Promise<T>,
): Promise<T> {
  const entry = await readEntryInWorker({
    ...params,
    assertCallerCurrent: params.assertCurrent,
  });
  params.assertCurrent();
  if (isIncognitoSessionKey(params.sessionKey) || entry?.incognito) {
    throw new Error("Dream cannot persist incognito session evidence");
  }
  if (params.endedSession) {
    if (!isAgentSessionKey(params.sessionKey, params.agentId) || !isSessionId(params.sessionId)) {
      throw new Error("Dream ended source has malformed session identity");
    }
    // Bind the present row (or its absence) to the existing generation owner.
    // Archived facts describe the source, never revive its former turn authority.
    const lease = await leaseSessionGeneration({ ...params, entry });
    if (!lease) {
      throw new Error("Dream source binding changed during admission");
    }
    try {
      const session = params.endedSession;
      const origin = sessionDeliveryOrigin(session);
      if (!origin || !session.chatType) {
        throw new Error("Dream ended source has no canonical conversation facts");
      }
      const provider = origin.provider ?? origin.surface;
      const resolvePolicy = provider
        ? getLoadedChannelPluginById(provider)?.groups?.resolveMemoryPolicy
        : undefined;
      const getContext = () =>
        resolveMemoryContext(
          { ...session, sessionId: params.sessionId, updatedAt: 0 },
          params.sessionKey,
          params.getConfig?.() ?? params.cfg ?? {},
          resolvePolicy,
        );
      const context = getContext();
      const fingerprint = JSON.stringify(context);
      const assertCurrent = () => {
        params.assertCurrent();
        lease.assertCurrent();
        if (JSON.stringify(getContext()) !== fingerprint) {
          throw new Error("memory context membership or publication authority changed");
        }
      };
      assertCurrent();
      return await consume({ context, origin, session, assertCurrent });
    } finally {
      lease.release();
    }
  }
  if (!entry || entry.sessionId !== params.sessionId || entry.spawnedBy) {
    throw new Error("Dream source session is missing, replaced, or delegated");
  }
  const origin = sessionDeliveryOrigin(entry);
  if (!origin) {
    throw new Error("Dream source has no canonical delivery origin");
  }
  const grant = await resolveMemoryAudienceFromEntry(
    { ...params, senderIsOwner: undefined, assertCallerCurrent: params.assertCurrent },
    entry,
  );
  if (grant.status !== "granted") {
    throw new Error(grant.reason);
  }
  try {
    const context = grant.audience.context;
    if (!context) {
      throw new Error("Dream source has no admitted memory context");
    }
    return await consume({
      context,
      origin,
      session: captureMemorySourceSession(entry)!,
      assertCurrent: () => {
        params.assertCurrent();
        assertMemoryAudienceCurrent(grant.audience);
      },
    });
  } finally {
    grant.release();
  }
}
