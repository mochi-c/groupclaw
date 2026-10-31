import { getLoadedChannelPluginById } from "../channels/plugins/registry-loaded.js";
import type { ChannelGroupAdapter } from "../channels/plugins/types.adapters.js";
import {
  participantIdentityNamespace,
  readParticipantIdentity,
} from "../config/sessions/session-participant-identity.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveLinkedDirectPeerId } from "../routing/session-key.js";
import { prepareUserChannelIdentityAuthority } from "../state/user-channel-identity-operations.js";
import { readUserProfileAliasRevision } from "../state/user-profile-events.js";
import { sessionDeliveryOrigin } from "../utils/delivery-context.read.js";
import {
  resolveCanonicalMemoryChannelId,
  resolveCanonicalMemoryThreadId,
  resolveCanonicalMemoryUserId,
  resolveMemoryContextReadContext,
  type MemoryContextParticipant,
  type MemoryContextReadContext,
  type MemoryScope,
} from "./scoped-memory.js";

export type MemorySourceSession = Pick<SessionEntry, "chatType" | "delivery" | "participants">;

/** Persist only source facts; current configuration still owns every later grant. */
export function captureMemorySourceSession(entry: SessionEntry): MemorySourceSession | undefined {
  if (entry.spawnedBy || entry.incognito || !entry.chatType || !sessionDeliveryOrigin(entry)) {
    return undefined;
  }
  return structuredClone({
    chatType: entry.chatType,
    delivery: entry.delivery,
    ...(entry.participants ? { participants: entry.participants } : {}),
  });
}

function resolveMemoryParticipant(
  participant: Pick<NonNullable<SessionEntry["participants"]>[number], "identity" | "label">,
  cfg: OpenClawConfig,
  prepared?: ReadonlyMap<string, MemoryContextParticipant>,
): MemoryContextParticipant | undefined {
  const { identity } = participant;
  if (
    identity.type === "agent" ||
    (identity.type === "observation" && identity.senderKind !== "human")
  ) {
    return undefined;
  }
  if (identity.type === "legacy" && !/^(human|user|owner)$/iu.test(identity.actorType.trim())) {
    return undefined;
  }
  const verified = prepared?.get(
    JSON.stringify(readParticipantIdentity(participantIdentityNamespace(identity), identity.id)),
  );
  if (verified) {
    return { ...verified, userName: participant.label?.trim() || verified.userName };
  }
  const linkedId =
    (identity.type === "observation" || identity.type === "remote") && identity.pluginId
      ? resolveLinkedDirectPeerId({
          identityLinks: cfg.session?.identityLinks,
          channel: identity.pluginId,
          peerId: identity.id,
        })
      : null;
  return {
    userId: resolveCanonicalMemoryUserId(
      linkedId
        ? JSON.stringify(["identity-link", linkedId])
        : JSON.stringify(
            readParticipantIdentity(participantIdentityNamespace(identity), identity.id),
          ),
    ),
    userName: participant.label?.trim() || identity.id,
  };
}

export function resolveMemoryContext(
  entry: SessionEntry,
  sessionKey: string,
  cfg: OpenClawConfig,
  resolvePolicy: ChannelGroupAdapter["resolveMemoryPolicy"],
  prepared?: ReadonlyMap<string, MemoryContextParticipant>,
): MemoryContextReadContext {
  const origin = sessionDeliveryOrigin(entry);
  const nativeChannelId = origin?.nativeChannelId?.trim();
  const threadId =
    typeof origin?.threadId === "number"
      ? String(origin.threadId)
      : origin?.threadId?.trim() || undefined;
  // Native threads may use their own id as nativeChannelId (Discord), or keep
  // their parent there (Slack and Discord auto-thread ingress). Only admitted
  // native facts establish that parent; a delivery alias cannot substitute.
  const parentChannelId = origin?.nativeParentChannelId?.trim() || nativeChannelId;
  if (threadId && (!parentChannelId || parentChannelId === threadId)) {
    throw new Error(
      "memory parent channel is unavailable; retry after a new inbound message supplies the thread's parent channel",
    );
  }
  const channelId = resolveCanonicalMemoryChannelId({
    provider: origin?.provider ?? origin?.surface,
    accountId: origin?.accountId,
    channelId: (threadId ? parentChannelId : nativeChannelId) || origin?.to?.trim() || sessionKey,
  });
  const participants = (entry.participants ?? []).flatMap((participant) => {
    const resolved = resolveMemoryParticipant(participant, cfg, prepared);
    return resolved ? [resolved] : [];
  });
  const policy = origin ? resolvePolicy?.({ cfg, origin }) : undefined;
  const members = (policy?.group?.members ?? []).flatMap((participant) => {
    const resolved = resolveMemoryParticipant(participant, cfg, prepared);
    return resolved ? [resolved] : [];
  });
  // Only Thread observations extend a fixed Channel roster; observed labels
  // enrich matching configured IDs without establishing a new identity.
  const observedById = new Map(
    participants.map((participant) => [participant.userId, participant]),
  );
  const configured = members.map((member) => observedById.get(member.userId) ?? member);
  const selected = policy?.group
    ? threadId
      ? [...configured, ...participants]
      : configured
    : participants;
  return resolveMemoryContextReadContext({
    conversation: threadId
      ? {
          kind: "thread",
          channelId,
          threadId: resolveCanonicalMemoryThreadId(threadId),
        }
      : {
          kind: "channel",
          channelId,
        },
    participants: selected,
    channelMemory: policy?.channelMemory,
    ...(policy?.group
      ? {
          group: {
            key: policy.group.key,
            userIds: configured.map((member) => member.userId),
            workspaceShared: policy.group.workspaceShared,
            consolidationAllowed: policy.group.consolidationAllowed,
          },
        }
      : {}),
    // Thread observations supplement the configured group but cannot prove a complete roster.
    participantCoverage: policy?.group && !threadId ? "complete" : "partial",
  });
}

/** Resolve verified person links once; every later effect consumes the identity owner's fence. */
export async function prepareMemoryContext(
  entry: SessionEntry,
  sessionKey: string,
  getConfig: () => OpenClawConfig,
  resolvePolicy: ChannelGroupAdapter["resolveMemoryPolicy"],
) {
  const cfg = getConfig();
  const origin = sessionDeliveryOrigin(entry);
  const policy = origin ? resolvePolicy?.({ cfg, origin }) : undefined;
  const identities = new Map(
    [...(entry.participants ?? []), ...(policy?.group?.members ?? [])].map((participant) => [
      JSON.stringify(
        readParticipantIdentity(
          participantIdentityNamespace(participant.identity),
          participant.identity.id,
        ),
      ),
      participant,
    ]),
  );
  const prepared = new Map<string, MemoryContextParticipant>();
  const guards: Array<() => boolean> = [];
  const revision = readUserProfileAliasRevision();
  for (const [key, participant] of identities) {
    const identity = participant.identity;
    if (
      !(
        (identity.type === "remote" && identity.idKind === "user") ||
        (identity.type === "observation" && identity.senderKind === "human")
      ) ||
      !identity.pluginId
    ) {
      continue;
    }
    const authority = await prepareUserChannelIdentityAuthority({
      channelId: identity.pluginId,
      accountId:
        identity.type === "observation"
          ? (identity.accountId ?? origin?.accountId ?? "default")
          : (origin?.accountId ?? "default"),
      senderId: identity.id,
    });
    if (authority) {
      guards.push(authority.isCurrent);
      prepared.set(key, {
        userId: resolveCanonicalMemoryUserId(
          JSON.stringify({ type: "profile", id: authority.linked.profileId }),
        ),
        userName: authority.linked.displayName || participant.label || identity.id,
      });
    }
  }
  const context = resolveMemoryContext(entry, sessionKey, cfg, resolvePolicy, prepared);
  const fingerprint = JSON.stringify(context);
  let revoked = false;
  const assertCurrent = () => {
    if (
      revoked ||
      readUserProfileAliasRevision() !== revision ||
      guards.some((isCurrent) => !isCurrent()) ||
      JSON.stringify(
        resolveMemoryContext(entry, sessionKey, getConfig(), resolvePolicy, prepared),
      ) !== fingerprint
    ) {
      revoked = true;
      throw new Error("memory context membership or publication authority changed");
    }
  };
  assertCurrent();
  return { context, assertCurrent };
}

/**
 * Address a framework observation using the departing entry captured by its
 * lifecycle owner. This projection grants no read or Dream publication authority.
 */
export function resolveMemoryEventScopeFromEntry(
  entry: SessionEntry | undefined,
  sessionKey: string,
  cfg: OpenClawConfig,
): MemoryScope | undefined {
  const origin = entry && sessionDeliveryOrigin(entry);
  if (!entry || !origin) {
    if (entry?.chatType === "group" || entry?.chatType === "channel") {
      throw new Error("memory Event requires the departing conversation's delivery origin");
    }
    return { kind: "workspace" };
  }
  const provider = origin.provider ?? origin.surface;
  const resolvePolicy = provider
    ? getLoadedChannelPluginById(provider)?.groups?.resolveMemoryPolicy
    : undefined;
  return resolveMemoryContext(entry, sessionKey, cfg, resolvePolicy).fragment?.scope;
}
