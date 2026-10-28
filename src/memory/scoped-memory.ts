import path from "node:path";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";

type ConversationMemoryScope =
  | { kind: "channel"; channelId: string }
  | { kind: "thread"; channelId: string; threadId: string };

export type MemoryScope =
  | { kind: "workspace" }
  | ConversationMemoryScope
  | { kind: "user"; userId: string };

export type MemoryContextParticipant = {
  userId: string;
  userName: string;
};

export type MemoryTurnIdentity = {
  conversation: ConversationMemoryScope;
  senderUserId?: string;
  participants?: readonly MemoryContextParticipant[];
  participantCoverage?: "complete" | "partial";
  channelMemory?: "include" | "exclude";
  group?: {
    key: string;
    userIds: readonly string[];
    workspaceShared: boolean;
    consolidationAllowed: boolean;
  };
};

type MemoryContextLayer = "workspace" | "channel" | "thread" | "users";

type MemoryContextReadArtifact = {
  layer: MemoryContextLayer;
  relativePath: string;
  scope: MemoryScope;
  userName?: string;
};

type MemoryFragmentWriteContext = {
  /** Admitted conversation a Fragment may be appended to; Workspace/User are never offered. */
  scope: ConversationMemoryScope;
  /**
   * Mint the dated day-file path (`Fragment/YYYY-MM-DD.md`): one file per
   * scope per day, with notes appended sequentially. The host owns all path
   * encoding; callers never supply a destination or entry filename.
   */
  resolveRelativePath(params: { createdDate: string }): string;
};

export type MemoryContextReadContext = {
  artifacts: readonly MemoryContextReadArtifact[];
  participantCoverage: "complete" | "partial";
  /** Absent at a launch Channel; only its admitted Thread accepts temporary notes. */
  fragment?: MemoryFragmentWriteContext;
  group?: MemoryTurnIdentity["group"];
};

type MemoryArtifactKind = "memory" | "fragment" | "event" | "archive";

export const WORKSPACE_MEMORY_RELATIVE_PATH = "memory/MEMORY.md";

/** Recognize curated addresses; this supplies no audience or enumeration grant. */
export function isCuratedMemoryRelativePath(relativePath: string): boolean {
  return /^memory\/(?:(?:Channel\/id-[a-f0-9]{64}(?:\/Thread\/id-[a-f0-9]{64})?|User\/id-[a-f0-9]{64})\/)?MEMORY\.md$/u.test(
    relativePath,
  );
}

/** Current-context file visibility; searchable history has its own audience admission. */
export function resolveConversationScopeMemoryPathFilter(context: MemoryContextReadContext): {
  exactPaths: string[];
  directoryPrefixes: string[];
  includeOutsideMemory: true;
} {
  const prefixes = new Set<string>();
  for (const artifact of context.artifacts) {
    const directory = path.posix.dirname(artifact.relativePath);
    if (artifact.layer === "channel") {
      for (const kind of ["Fragment", "Event", "Archive"]) {
        prefixes.add(`${directory}/${kind}/`);
      }
    } else if (artifact.layer === "thread" || artifact.layer === "users") {
      prefixes.add(`${directory}/`);
    }
  }
  return {
    exactPaths: context.artifacts.map((artifact) => artifact.relativePath),
    directoryPrefixes: [...prefixes],
    includeOutsideMemory: true,
  };
}

export function prepareConversationScopedMemoryPathMatcher(context: MemoryContextReadContext) {
  const filter = resolveConversationScopeMemoryPathFilter(context);
  const exact = new Set(filter.exactPaths);
  return (relativePath: string): boolean => {
    const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//u, "");
    if (
      !normalized ||
      normalized.startsWith("/") ||
      normalized.includes("\0") ||
      normalized.split("/").some((segment) => segment === "." || segment === "..") ||
      path.posix.normalize(normalized) !== normalized
    ) {
      return false;
    }
    return (
      (!normalized.startsWith("memory/") && normalized !== "memory") ||
      exact.has(normalized) ||
      filter.directoryPrefixes.some((prefix) => normalized.startsWith(prefix))
    );
  };
}

const CANONICAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MEMORY_ID_PATTERN = /^[^/\\\0]+$/u;

function requireMemoryId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized === "." || normalized === ".." || !MEMORY_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a non-empty canonical id without path separators`);
  }
  return normalized;
}

function encodeMemoryScopeId(value: string): string {
  return `id-${sha256Hex(requireMemoryId(value, "memory scope id"))}`;
}

export function resolveCanonicalMemoryChannelId(params: {
  provider?: string;
  accountId?: string;
  channelId: string;
}): string {
  const channelId = params.channelId.trim();
  if (!channelId) {
    throw new Error("memory channel id must be non-empty");
  }
  return `channel-v1-${sha256Hex(
    JSON.stringify([
      params.provider?.trim() || "unknown",
      params.accountId?.trim() || "default",
      channelId,
    ]),
  )}`;
}

export function resolveCanonicalMemoryUserId(identityKey: string): string {
  const normalized = identityKey.trim();
  if (!normalized) {
    throw new Error("memory user identity must be non-empty");
  }
  return `user-v1-${sha256Hex(normalized)}`;
}

export function resolveCanonicalMemoryThreadId(threadId: string): string {
  const normalized = threadId.trim();
  if (!normalized) {
    throw new Error("memory thread id must be non-empty");
  }
  return `thread-v1-${sha256Hex(normalized)}`;
}

function resolveMemoryScopeRelativeDirectory(scope: MemoryScope): string {
  if (scope.kind === "workspace") {
    return "memory";
  }
  if (scope.kind === "channel") {
    return path.posix.join("memory", "Channel", encodeMemoryScopeId(scope.channelId));
  }
  if (scope.kind === "thread") {
    return path.posix.join(
      "memory",
      "Channel",
      encodeMemoryScopeId(scope.channelId),
      "Thread",
      encodeMemoryScopeId(scope.threadId),
    );
  }
  return path.posix.join("memory", "User", encodeMemoryScopeId(scope.userId));
}

function slugMemoryArtifactName(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80)
    .replace(/-+$/u, "");
  return slug || "artifact";
}

export function resolveMemoryArtifactRelativePath(params: {
  scope: MemoryScope;
  artifactKind: MemoryArtifactKind;
  artifactName?: string;
  createdDate?: string;
  createdAtMs?: number;
}): string {
  const scopeDir = resolveMemoryScopeRelativeDirectory(params.scope);
  if (params.artifactKind === "memory") {
    return path.posix.join(scopeDir, "MEMORY.md");
  }
  if (
    params.artifactKind === "fragment" &&
    params.scope.kind !== "channel" &&
    params.scope.kind !== "thread"
  ) {
    throw new Error("memory fragments are supported only for channel and thread scopes");
  }
  if (params.artifactKind === "archive" && params.scope.kind === "user") {
    throw new Error("user-scoped archives are not supported");
  }
  if (!params.createdDate || !CANONICAL_DATE_PATTERN.test(params.createdDate)) {
    throw new Error("memory artifact createdDate must use YYYY-MM-DD");
  }
  // Fragments use one append-only day file per scope; each call adds an entry,
  // so the filename carries no slug or millisecond discriminator.
  if (params.artifactKind === "fragment") {
    return path.posix.join(scopeDir, "Fragment", `${params.createdDate}.md`);
  }
  if (!Number.isSafeInteger(params.createdAtMs) || (params.createdAtMs ?? -1) < 0) {
    throw new Error("memory artifact createdAtMs must be a non-negative safe integer");
  }
  const directory = params.artifactKind === "event" ? "Event" : "Archive";
  const name = slugMemoryArtifactName(params.artifactName ?? params.artifactKind);
  return path.posix.join(
    scopeDir,
    directory,
    `${params.createdDate}_${name}_${params.createdAtMs}.md`,
  );
}

export function resolveMemoryContextReadContext(
  identity: MemoryTurnIdentity,
): MemoryContextReadContext {
  const artifacts: MemoryContextReadArtifact[] = [
    {
      layer: "workspace",
      scope: { kind: "workspace" },
      relativePath: WORKSPACE_MEMORY_RELATIVE_PATH,
    },
  ];
  if (identity.channelMemory !== "exclude") {
    artifacts.push({
      layer: "channel",
      scope: { kind: "channel", channelId: identity.conversation.channelId },
      relativePath: resolveMemoryArtifactRelativePath({
        scope: { kind: "channel", channelId: identity.conversation.channelId },
        artifactKind: "memory",
      }),
    });
  }
  if (identity.conversation.kind === "thread") {
    const scope = {
      kind: "thread" as const,
      channelId: identity.conversation.channelId,
      threadId: identity.conversation.threadId,
    };
    artifacts.push({
      layer: "thread",
      scope,
      relativePath: resolveMemoryArtifactRelativePath({ scope, artifactKind: "memory" }),
    });
  }
  const participants = [...(identity.participants ?? [])]
    .map((participant) => ({
      userId: requireMemoryId(participant.userId, "memory user id"),
      userName: participant.userName.trim(),
    }))
    .filter((participant) => participant.userName.length > 0)
    .toSorted(
      (left, right) =>
        left.userName.localeCompare(right.userName) || left.userId.localeCompare(right.userId),
    );
  const seenUserIds = new Set<string>();
  for (const participant of participants) {
    if (seenUserIds.has(participant.userId)) {
      continue;
    }
    seenUserIds.add(participant.userId);
    const scope = { kind: "user" as const, userId: participant.userId };
    artifacts.push({
      layer: "users",
      scope,
      userName: participant.userName,
      relativePath: resolveMemoryArtifactRelativePath({ scope, artifactKind: "memory" }),
    });
  }
  const fragmentScope: ConversationMemoryScope =
    identity.conversation.kind === "thread"
      ? {
          kind: "thread",
          channelId: identity.conversation.channelId,
          threadId: identity.conversation.threadId,
        }
      : { kind: "channel", channelId: identity.conversation.channelId };
  const fragment: MemoryFragmentWriteContext | undefined =
    identity.channelMemory === "exclude" && identity.conversation.kind === "channel"
      ? undefined
      : Object.freeze({
          scope: Object.freeze({ ...fragmentScope }),
          resolveRelativePath: (params) =>
            resolveMemoryArtifactRelativePath({
              scope: fragmentScope,
              artifactKind: "fragment",
              createdDate: params.createdDate,
            }),
        });
  return Object.freeze({
    artifacts: Object.freeze(
      artifacts.map((artifact) =>
        Object.freeze({ ...artifact, scope: Object.freeze({ ...artifact.scope }) }),
      ),
    ),
    participantCoverage: identity.participantCoverage ?? "partial",
    fragment,
    ...(identity.group
      ? {
          group: Object.freeze({
            ...identity.group,
            userIds: Object.freeze([...identity.group.userIds]),
          }),
        }
      : {}),
  });
}
