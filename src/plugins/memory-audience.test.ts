import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildChannelInboundEventContext } from "../channels/inbound-event/context.js";
import type { ChannelGroupAdapter } from "../channels/plugins/types.adapters.js";
import { deriveSessionMetaPatch } from "../config/sessions/metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveCanonicalMemoryChannelId,
  resolveCanonicalMemoryThreadId,
} from "../memory/scoped-memory.js";
import { createPluginRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { changeCanonicalUserChannelIdentity } from "../state/user-channel-identity-operations.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { bindMemoryProvider } from "./memory-provider-adapter.js";
import type { MemoryAudience, MemoryProviderHandle } from "./memory-provider-types.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRecord } from "./status.test-helpers.js";
import { createPluginToolFactoryContext } from "./tool-factory-context.js";
import { bindPluginToolCallbacks } from "./tool-factory-runtime.js";

const channelPolicy = vi.hoisted(() => ({
  resolve: undefined as ChannelGroupAdapter["resolveMemoryPolicy"],
}));
// mock-isolation: exercise the admitted audience without importing channel runtimes or starting transports.
vi.mock("../channels/plugins/registry-loaded.js", () => ({
  listLoadedChannelPlugins: () => [],
  getLoadedChannelPluginById: () => ({
    groups: {
      resolveMemoryPolicy: (
        params: Parameters<NonNullable<ChannelGroupAdapter["resolveMemoryPolicy"]>>[0],
      ) => channelPolicy.resolve?.(params),
    },
  }),
}));

vi.mock("../config/sessions/session-delivery-generation.js", async () => {
  const { fakeSessionGenerationModule } = await import("./memory-audience.test-support.js");
  return fakeSessionGenerationModule;
});
vi.mock("../config/sessions/session-entry-read-runtime.js", async () => {
  const { fakeSessionEntryReadModule } = await import("./memory-audience.test-support.js");
  return fakeSessionEntryReadModule;
});

import {
  assertMemoryAudienceCurrent as assertCurrent,
  assertMemoryAudienceSession as assertSession,
  delegateMemoryAudience,
  isHostMemoryAudience,
  readMemoryAudienceExecutionSignal,
  type MemoryAudienceResolution,
  prepareMemoryAudienceRead,
  resolveMemoryAudienceFromEntry,
} from "./memory-audience.js";
import { fakeSessionOwner, type FakeSessionRow } from "./memory-audience.test-support.js";

const AGENT_ID = "main";
const ROOT_KEY = "agent:main:root";
const CHILD_KEY = "agent:main:subagent:child";
const STORE_PATH = "/tmp/openclaw-memory-audience/main.sqlite";

function rootEntry(chatType: FakeSessionRow["chatType"] = "direct"): FakeSessionRow {
  return { sessionId: randomUUID(), lifecycleRevision: randomUUID(), chatType, updatedAt: 1 };
}

function childEntry(parent: FakeSessionRow, parentKey = ROOT_KEY): FakeSessionRow {
  return {
    sessionId: randomUUID(),
    updatedAt: 1,
    lifecycleRevision: randomUUID(),
    spawnedBy: parentKey,
    parentSessionKey: parentKey,
    spawnedBySessionId: parent.sessionId,
    parentSessionLifecycleRevision: parent.lifecycleRevision,
    spawnedBySenderIsOwner: true,
  };
}

function resolveAt(
  sessionKey: string,
  entry: FakeSessionRow,
  senderIsOwner?: boolean,
  overrides: Partial<Parameters<typeof resolveMemoryAudienceFromEntry>[0]> = {},
) {
  fakeSessionOwner.rows.set(sessionKey, entry);
  return resolveMemoryAudienceFromEntry(
    {
      agentId: AGENT_ID,
      sessionKey,
      sessionId: entry.sessionId,
      senderIsOwner,
      storePath: STORE_PATH,
      ...overrides,
    },
    entry,
  );
}

function delegate(audience: MemoryAudience, sessionKey = CHILD_KEY) {
  return delegateMemoryAudience(audience, { sessionKey, storePath: STORE_PATH });
}

async function delegatedChild() {
  const root = rootEntry();
  const rootGrant = await grantAt(ROOT_KEY, root, true);
  fakeSessionOwner.rows.set(CHILD_KEY, childEntry(root));
  return { rootGrant, grant: await delegate(rootGrant.audience) };
}

function bindProvider(raw: MemoryProviderHandle, audience: MemoryAudience, signal?: AbortSignal) {
  return bindMemoryProvider(raw, "test", {
    authority: { kind: "session", sessionKey: CHILD_KEY, sandboxed: false, audience },
    assertCurrent() {},
    signal,
  });
}

async function grantAt(sessionKey: string, entry: FakeSessionRow, senderIsOwner?: boolean) {
  return requireGrant(await resolveAt(sessionKey, entry, senderIsOwner));
}

function resolveChild(parent: FakeSessionRow, child: FakeSessionRow) {
  fakeSessionOwner.rows.set(ROOT_KEY, parent);
  return resolveAt(CHILD_KEY, child, false);
}

function provider(): MemoryProviderHandle & { health: ReturnType<typeof vi.fn> } {
  return {
    capabilities: { sources: ["memory"], pagination: false, candidates: [], projectFilter: false },
    search: vi.fn(async () => ({ hits: [] })),
    get: vi.fn(async () => ({ status: "not_found" as const })),
    health: vi.fn(async () => ({ status: "ready" as const })),
    close: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  fakeSessionOwner.reset();
  channelPolicy.resolve = undefined;
});

describe("memory audience resolution", () => {
  it("shares verified Profile memory across providers and retires the audience after unlink", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const alice = ensureProfileForEmail("memory-alice@example.test");
      const discord = { channelId: "discord", accountId: "default", senderId: "123" };
      const slack = { channelId: "slack", accountId: "default", senderId: "U123" };
      await changeCanonicalUserChannelIdentity("link", alice.id, discord);
      await changeCanonicalUserChannelIdentity("link", alice.id, slack);
      const participant = (pluginId: string, id: string) => ({
        identity: {
          type: "observation" as const,
          pluginId,
          accountId: "default",
          senderKind: "human" as const,
          id,
        },
        label: "Alice",
      });
      channelPolicy.resolve = () => ({
        channelMemory: "include",
        group: {
          key: "family",
          members: [participant("discord", "123"), participant("slack", "U123")],
          workspaceShared: true,
          consolidationAllowed: true,
        },
      });
      const entry = {
        ...rootEntry("channel"),
        delivery: {
          kind: "external" as const,
          route: { channel: "discord", target: { to: "channel:100" } },
          context: { channel: "discord", to: "channel:100" },
          origin: { provider: "discord", accountId: "default", nativeChannelId: "100" },
        },
      };
      const grant = requireGrant(await resolveAt(ROOT_KEY, entry));
      try {
        const executionSignal = readMemoryAudienceExecutionSignal(grant.audience);
        expect(
          grant.audience.context?.artifacts.filter((item) => item.layer === "users"),
        ).toHaveLength(1);
        assertCurrent(grant.audience);
        await changeCanonicalUserChannelIdentity("unlink", alice.id, discord);
        expect(() => assertCurrent(grant.audience)).toThrow("publication authority changed");
        expect(executionSignal.aborted).toBe(true);
      } finally {
        grant.release();
      }
    });
  });

  it("shares declared participant identities across channels and revokes changed links", async () => {
    const human = (pluginId: string, id: string) => ({
      type: "observation" as const,
      pluginId,
      accountId: "default",
      senderKind: "human" as const,
      id,
    });
    const discordAlice = { identity: human("discord", "123"), label: "Alice" };
    const slackAlice = { identity: human("slack", "U123"), label: "Alice on Slack" };
    const visitor = { identity: human("discord", "456"), label: "Alice" };
    let cfg: OpenClawConfig = {
      session: { identityLinks: { alice: ["discord:123", "slack:U123"] } },
    };
    channelPolicy.resolve = () => ({
      channelMemory: "include",
      group: {
        key: "family",
        members: [discordAlice, slackAlice, visitor],
        workspaceShared: true,
        consolidationAllowed: true,
      },
    });
    const entry = {
      ...rootEntry("channel"),
      participants: [discordAlice],
      delivery: {
        kind: "external" as const,
        route: { channel: "discord", target: { to: "channel:100" } },
        context: { channel: "discord", to: "channel:100" },
        origin: { provider: "discord", nativeChannelId: "100" },
      },
    };
    fakeSessionOwner.rows.set(ROOT_KEY, entry);
    const result = await resolveMemoryAudienceFromEntry(
      {
        agentId: AGENT_ID,
        sessionKey: ROOT_KEY,
        sessionId: entry.sessionId,
        storePath: STORE_PATH,
        senderIsOwner: false,
        getConfig: () => cfg,
      },
      entry,
    );
    if (result.status !== "granted") {
      throw new Error(result.reason);
    }
    try {
      const users = result.audience.context?.artifacts.filter((item) => item.layer === "users");
      expect(users).toHaveLength(2);
      expect(new Set(users?.map((item) => item.relativePath)).size).toBe(2);
      expect(users?.map((item) => item.userName)).toEqual(["Alice", "Alice"]);
      assertCurrent(result.audience);
      cfg = { session: { identityLinks: { alice: ["slack:U123"] } } };
      expect(() => assertCurrent(result.audience)).toThrow(
        "membership or publication authority changed",
      );
    } finally {
      result.release();
    }
    expect(fakeSessionOwner.activeLeases).toBe(0);
  });

  it.each([false, true])(
    "includes silent configured members and scopes extra speakers to Threads (%s)",
    async (thread) => {
      const identity = (id: string) => ({ type: "profile" as const, id });
      channelPolicy.resolve = () => ({
        channelMemory: "exclude",
        group: {
          members: [
            { identity: identity("alice"), label: "Configured Alice" },
            { identity: identity("bob"), label: "Bob" },
          ],
          key: "family",
          workspaceShared: true,
          consolidationAllowed: true,
        },
      });
      const ctx = buildChannelInboundEventContext({
        channel: "discord",
        from: "discord:alice",
        sender: { id: "alice", name: "Alice" },
        conversation: {
          kind: "channel",
          id: thread ? "101" : "100",
          nativeChannelId: thread ? "101" : "100",
          ...(thread ? { parentId: "100", threadId: "101" } : {}),
        },
        route: { agentId: AGENT_ID, routeSessionKey: ROOT_KEY },
        reply: { to: `channel:${thread ? "101" : "100"}` },
        message: { rawBody: "remember our plans" },
      });
      const root = rootEntry("channel");
      const entry = {
        ...root,
        ...deriveSessionMetaPatch({ ctx, sessionKey: ROOT_KEY, existing: root }),
        participants: [
          { identity: identity("alice"), label: "Alice" },
          { identity: identity("visitor"), label: "Visitor" },
        ],
      };
      const { audience, release } = await grantAt(ROOT_KEY, entry);
      try {
        expect(
          audience.context?.artifacts
            .filter((item) => item.layer === "users")
            .map((item) => item.userName),
        ).toEqual(thread ? ["Alice", "Bob", "Visitor"] : ["Alice", "Bob"]);
        expect(audience.context?.participantCoverage).toBe(thread ? "partial" : "complete");
        expect(audience.context?.artifacts.some((item) => item.layer === "channel")).toBe(false);
        expect(audience.context?.fragment?.scope.kind).toBe(thread ? "thread" : undefined);
      } finally {
        release();
      }
    },
  );

  it("rejects background authority when configured membership changes after admission", async () => {
    let groupKey = "initial";
    channelPolicy.resolve = () => ({
      channelMemory: "include",
      group: { key: groupKey, members: [], workspaceShared: true, consolidationAllowed: true },
    });
    const entry = {
      ...rootEntry("channel"),
      delivery: {
        kind: "external" as const,
        route: { channel: "discord", target: { to: "channel:100" } },
        context: { channel: "discord", to: "channel:100" },
        origin: { provider: "discord", nativeChannelId: "100" },
      },
    };
    fakeSessionOwner.rows.set(ROOT_KEY, entry);
    const result = await resolveMemoryAudienceFromEntry(
      {
        agentId: AGENT_ID,
        sessionKey: ROOT_KEY,
        sessionId: entry.sessionId,
        senderIsOwner: false,
        storePath: STORE_PATH,
        getConfig: () => ({}),
      },
      entry,
    );
    if (result.status !== "granted") {
      throw new Error(result.reason);
    }
    try {
      const executionSignal = readMemoryAudienceExecutionSignal(result.audience);
      assertCurrent(result.audience);
      groupKey = "changed";
      sessionChanges.emit({ all: true, scope: "config" });
      expect(executionSignal.aborted).toBe(true);
      expect(() => assertCurrent(result.audience)).toThrow(
        "membership or publication authority changed",
      );
      groupKey = "initial";
      sessionChanges.emit({ all: true, scope: "config" });
      expect(() => assertCurrent(result.audience)).toThrow(
        "membership or publication authority changed",
      );
    } finally {
      result.release();
    }
  });

  it.each([
    ["owner direct", "direct", true, "owner-private"],
    ["non-owner direct", "direct", false, "conversation"],
    ["group", "group", true, "conversation"],
    ["channel", "channel", true, "conversation"],
  ] as const)("maps a %s root", async (_name, chatType, owner, expectedKind) => {
    const root = rootEntry(chatType);
    const { audience } = await grantAt(ROOT_KEY, root, owner);
    expect(audience).toMatchObject(
      expectedKind === "owner-private"
        ? { kind: "owner-private", agentId: AGENT_ID }
        : {
            kind: "conversation",
            agentId: AGENT_ID,
            sessionKey: ROOT_KEY,
            sessionId: root.sessionId,
          },
    );
    expect(isHostMemoryAudience(audience)).toBe(true);
    expect(Object.isFrozen(audience)).toBe(true);
  });

  it("uses durable chat type for threaded sessions", async () => {
    const root = {
      ...rootEntry("group"),
      delivery: {
        kind: "external" as const,
        route: {
          channel: "discord",
          accountId: "family-bot",
          target: { to: "room-1", chatType: "group" as const },
          thread: { id: "thread-1" },
        },
        context: {
          channel: "discord",
          accountId: "family-bot",
          to: "room-1",
          threadId: "thread-1",
        },
        origin: {
          provider: "discord",
          accountId: "family-bot",
          nativeChannelId: "room-1",
          threadId: "thread-1",
        },
      },
      participants: [
        { identity: { type: "profile" as const, id: "alice" }, label: "Alice" },
        { identity: { type: "agent" as const, id: "main" }, label: "OpenClaw" },
        {
          identity: {
            type: "observation" as const,
            pluginId: "discord",
            accountId: "family-bot",
            senderKind: "human" as const,
            id: "bob",
          },
          label: "Bob",
        },
      ],
      participantCount: 4,
    };
    const threadKey = "agent:main:discord:group:room:thread:reply";
    const { audience } = await grantAt(threadKey, root, true);
    expect(audience).toMatchObject({
      kind: "conversation",
      agentId: AGENT_ID,
      sessionKey: threadKey,
      sessionId: root.sessionId,
      context: {
        participantCoverage: "partial",
        artifacts: [
          { layer: "workspace", scope: { kind: "workspace" } },
          { layer: "channel", scope: { kind: "channel" } },
          {
            layer: "thread",
            scope: { kind: "thread", threadId: expect.stringMatching(/^thread-v1-/u) },
          },
          { layer: "users", scope: { kind: "user" }, userName: "Alice" },
          { layer: "users", scope: { kind: "user" }, userName: "Bob" },
        ],
      },
    });
  });
});
function pendingPublication(sessionKey: string) {
  const publication = createDeferredCore();
  fakeSessionOwner.publications.set(sessionKey, publication.promise);
  fakeSessionOwner.pendingKeys.add(sessionKey);
  return () => {
    fakeSessionOwner.pendingKeys.delete(sessionKey);
    fakeSessionOwner.publications.delete(sessionKey);
    publication.resolve();
  };
}

function conversation(root: FakeSessionRow) {
  return {
    kind: "conversation",
    agentId: AGENT_ID,
    sessionKey: ROOT_KEY,
    sessionId: root.sessionId,
    context: expect.any(Object),
  };
}

function requireGrant(resolution: MemoryAudienceResolution) {
  if (resolution.status !== "granted") {
    throw new Error(resolution.reason);
  }
  return resolution;
}

async function expectDenied(
  result: Promise<MemoryAudienceResolution>,
  kind: "ineligible" | "stale-lineage" | "unverified",
) {
  await expect(result).resolves.toMatchObject({ status: "denied", kind });
  expect(fakeSessionOwner.activeLeases).toBe(0);
}

it.each([
  { name: "channel", nativeId: "room-1", kind: "channel" as const },
  { name: "native thread", nativeId: "thread-1", parentId: "room-1", threadId: "thread-1" },
  { name: "auto thread", nativeId: "room-1", parentId: "room-1", threadId: "thread-1" },
  { name: "forum post", nativeId: "post-1", parentId: "room-1", threadId: "post-1" },
  { name: "direct message", nativeId: "dm-1", kind: "direct" as const },
  { name: "group DM", nativeId: "group-dm-1", kind: "group" as const },
])("resolves Discord $name memory from persisted inbound facts", async (input) => {
  const ctx = buildChannelInboundEventContext({
    channel: "discord",
    accountId: "family-bot",
    from: "discord:user-1",
    sender: { id: "user-1", name: "Alice" },
    conversation: {
      kind: input.kind ?? "channel",
      id: input.nativeId,
      nativeChannelId: input.nativeId,
      parentId: input.parentId,
      threadId: input.threadId,
    },
    route: { agentId: AGENT_ID, routeSessionKey: ROOT_KEY },
    reply: { to: `channel:${input.threadId ?? input.nativeId}` },
    message: { rawBody: "remember our plans" },
  });
  const root = rootEntry(input.kind ?? "channel");
  const entry = {
    ...root,
    ...deriveSessionMetaPatch({ ctx, sessionKey: ROOT_KEY, existing: root }),
  };
  const { audience, release } = await grantAt(ROOT_KEY, entry, true);
  try {
    const channelId = resolveCanonicalMemoryChannelId({
      provider: "discord",
      accountId: "family-bot",
      channelId: input.parentId ?? input.nativeId,
    });
    expect(audience.context?.artifacts.find((item) => item.layer === "channel")?.scope).toEqual({
      kind: "channel",
      channelId,
    });
    const thread = audience.context?.artifacts.find((item) => item.layer === "thread");
    expect(thread?.scope).toEqual(
      input.threadId
        ? { kind: "thread", channelId, threadId: resolveCanonicalMemoryThreadId(input.threadId) }
        : undefined,
    );
    expect(fakeSessionOwner.workerReads).toEqual([]);
  } finally {
    release();
  }
});

it("denies a native thread whose durable parent is unavailable", async () => {
  const root = {
    ...rootEntry("channel"),
    delivery: {
      kind: "external" as const,
      route: { channel: "discord", target: { to: "channel:thread-1" } },
      context: { channel: "discord", to: "channel:thread-1", threadId: "thread-1" },
      origin: { provider: "discord", nativeChannelId: "thread-1", threadId: "thread-1" },
    },
  };
  await expect(resolveAt(ROOT_KEY, root, true)).resolves.toMatchObject({
    status: "denied",
    reason: expect.stringContaining("parent channel"),
  });
  expect(fakeSessionOwner.activeLeases).toBe(0);
});

it("keeps participant memory IDs stable across property order and reports roster coverage honestly", async () => {
  const identity = {
    type: "observation" as const,
    pluginId: "discord",
    accountId: "family-bot",
    senderKind: "human" as const,
    id: "alice",
  };
  const first = await grantAt(ROOT_KEY, {
    ...rootEntry("channel"),
    participants: [{ identity, label: "Alice" }],
    participantCount: 1,
  });
  const reordered = {
    id: identity.id,
    senderKind: identity.senderKind,
    accountId: identity.accountId,
    pluginId: identity.pluginId,
    type: identity.type,
  };
  const second = await grantAt(ROOT_KEY, {
    ...rootEntry("channel"),
    participants: [{ identity: reordered, label: "Renamed Alice" }],
    participantCount: 1,
  });
  try {
    const userScope = (audience: typeof first.audience) =>
      audience.context?.artifacts.find((item) => item.layer === "users")?.scope;
    expect(userScope(first.audience)).toEqual(userScope(second.audience));
    // Session participants are observed contributors, not a complete platform membership list.
    expect(first.audience.context?.participantCoverage).toBe("partial");
    expect(second.audience.context?.participantCoverage).toBe("partial");
  } finally {
    first.release();
    second.release();
  }
});

it("reads a child's durable parent on the session read worker", async () => {
  const root = rootEntry();
  const resolution = await resolveChild(root, childEntry(root));
  expect(resolution).toMatchObject({
    status: "granted",
    audience: { kind: "owner-private", agentId: AGENT_ID },
  });
  expect(fakeSessionOwner.workerReads).toEqual([ROOT_KEY]);
});

it.each([
  ["owner direct", "direct", true, false, "owner-private"],
  ["non-owner direct", "direct", false, false, "conversation"],
  ["group", "group", true, false, "conversation"],
  ["channel", "channel", true, false, "conversation"],
  ["nested private", "direct", true, true, "owner-private"],
  ["nested non-owner", "direct", false, true, "conversation"],
  ["nested group", "group", true, true, "conversation"],
] as const)("maps a %s audience", async (_name, chatType, owner, nested, expectedKind) => {
  const root = rootEntry(chatType);
  let sessionKey = ROOT_KEY;
  let entry = root;
  if (nested) {
    const child = { ...childEntry(root), spawnedBySenderIsOwner: owner };
    fakeSessionOwner.rows.set(ROOT_KEY, root);
    fakeSessionOwner.rows.set(CHILD_KEY, child);
    sessionKey = "agent:main:subagent:nested";
    entry = childEntry(child, CHILD_KEY);
  }
  const { audience } = await grantAt(sessionKey, entry, nested ? !owner : owner);
  expect(audience).toEqual(
    expectedKind === "owner-private"
      ? { kind: "owner-private", agentId: AGENT_ID, context: expect.any(Object) }
      : conversation(root),
  );
});

it.each([
  ["missing parent", "stale-lineage"],
  ["missing chat type", "ineligible"],
  ["missing session id", "ineligible"],
  ["mismatched session id", "unverified"],
] as const)("denies %s", async (missing, kind) => {
  const root = rootEntry();
  const result =
    missing === "missing parent"
      ? resolveAt(CHILD_KEY, childEntry(root), true)
      : missing === "missing chat type"
        ? resolveAt(ROOT_KEY, { ...root, chatType: undefined }, true)
        : resolveAt(ROOT_KEY, root, true, {
            sessionId: missing === "missing session id" ? undefined : randomUUID(),
          });
  await expectDenied(result, kind);
});

it("denies malformed, stale, cyclic, and cross-agent lineage", async () => {
  const mutations = [
    ["child", "spawnedBySessionId", undefined, "ineligible"],
    ["child", "spawnedBySessionId", randomUUID(), "stale-lineage"],
    ["parent", "lifecycleRevision", randomUUID(), "stale-lineage"],
    ["child", "parentSessionLifecycleRevision", undefined, "stale-lineage"],
    ["child", "parentSessionKey", "agent:main:other", "ineligible"],
    ["lineage", "spawnedBy", "agent:foreign:root", "ineligible"],
    ["cycle", "spawnedBy", CHILD_KEY, "ineligible"],
  ] as const;
  for (const [target, field, value, kind] of mutations) {
    const parent = rootEntry();
    const child = childEntry(parent);
    Reflect.set(target === "parent" ? parent : child, field, value);
    if (target === "lineage" || target === "cycle") {
      child.parentSessionKey = child.spawnedBy;
    }
    if (target === "cycle") {
      child.spawnedBySessionId = child.sessionId;
      child.parentSessionLifecycleRevision = child.lifecycleRevision;
    }
    await expectDenied(resolveChild(parent, child), kind);
  }
  expect(fakeSessionOwner.activeLeases).toBe(0);
});

it("grants owner-private memory across agents only for an owner spawn from an owner direct root", async () => {
  const FOREIGN_CHILD_KEY = "agent:fm-know:subagent:child";
  const resolveForeignChild = (parent: FakeSessionRow, child: FakeSessionRow) => {
    const resolveAgentStorePath = vi.fn((agentId: string) => `/tmp/stores/${agentId}.sqlite`);
    fakeSessionOwner.rows.set(ROOT_KEY, parent);
    const resolution = resolveAt(FOREIGN_CHILD_KEY, child, false, {
      agentId: "fm-know",
      storePath: "/tmp/stores/fm-know.sqlite",
      resolveAgentStorePath,
    });
    return { resolution, resolveAgentStorePath };
  };

  const owner = rootEntry();
  const granted = resolveForeignChild(owner, childEntry(owner));
  const grant = requireGrant(await granted.resolution);
  expect(grant.audience).toEqual({
    kind: "owner-private",
    agentId: "fm-know",
    context: expect.any(Object),
  });
  expect(granted.resolveAgentStorePath).toHaveBeenCalledWith("main");
  grant.release();

  const group = rootEntry("group");
  await expectDenied(resolveForeignChild(group, childEntry(group)).resolution, "ineligible");
  const nonOwnerSpawn = { ...childEntry(owner), spawnedBySenderIsOwner: false };
  await expectDenied(resolveForeignChild(owner, nonOwnerSpawn).resolution, "ineligible");
  const reset = { ...owner, lifecycleRevision: randomUUID() };
  await expectDenied(resolveForeignChild(reset, childEntry(owner)).resolution, "stale-lineage");
  expect(fakeSessionOwner.activeLeases).toBe(0);
});

it("denies lineage beyond 64 hops", async () => {
  let parentKey = ROOT_KEY;
  let parent = rootEntry();
  fakeSessionOwner.rows.set(ROOT_KEY, parent);
  for (let index = 0; index < 64; index += 1) {
    const key = `agent:main:subagent:${index}`;
    const child = childEntry(parent, parentKey);
    fakeSessionOwner.rows.set(key, child);
    parentKey = key;
    parent = child;
  }
  await expect(resolveAt(parentKey, parent, true)).resolves.toMatchObject({
    status: "denied",
    reason: "session lineage exceeds 64 hops",
  });
  expect(fakeSessionOwner.activeLeases).toBe(0);
});

it("fails closed with a respawn instruction for a spawned row missing its owner receipt", async () => {
  const parent = rootEntry();
  const resolution = await resolveChild(parent, {
    ...childEntry(parent),
    spawnedBySenderIsOwner: undefined,
  });
  expect(resolution).toEqual({
    status: "denied",
    kind: "stale-lineage",
    reason: expect.stringContaining(
      `spawned session ${CHILD_KEY} predates memory lineage receipts`,
    ),
  });
  expect(resolution.status === "denied" && resolution.reason).toContain(
    "Respawn it from its parent session to restore memory access.",
  );
  expect(fakeSessionOwner.workerReads).toEqual([]);
  expect(fakeSessionOwner.activeLeases).toBe(0);
});

it("grants a conversation audience to a new child of a group row without a lifecycle revision", async () => {
  // Channel-created group rows carry no lifecycle revision; the child records that absence.
  const { lifecycleRevision: _revision, ...group } = rootEntry("group");
  const child = { ...childEntry(group), parentSessionLifecycleRevision: undefined };
  fakeSessionOwner.rows.set(ROOT_KEY, group);
  const resolution = requireGrant(await resolveAt(CHILD_KEY, child, false));
  expect(resolution.audience).toEqual(conversation(group));
  assertSession(resolution.audience, CHILD_KEY);
  // A reset that gives the parent a lifecycle revision ends the child's grant.
  fakeSessionOwner.rows.set(ROOT_KEY, { ...group, lifecycleRevision: randomUUID() });
  expect(() => assertCurrent(resolution.audience)).toThrow("no longer current");
});
it.each(["reset", "removal"] as const)("revokes a child after parent %s", async (change) => {
  const parent = rootEntry();
  const resolution = requireGrant(await resolveChild(parent, childEntry(parent)));
  if (change === "reset") {
    fakeSessionOwner.rows.set(ROOT_KEY, { ...parent, lifecycleRevision: randomUUID() });
  } else {
    fakeSessionOwner.rows.delete(ROOT_KEY);
  }
  expect(() => assertCurrent(resolution.audience)).toThrow("no longer current");
  // A later write that restores the old incarnation cannot revive the grant.
  fakeSessionOwner.rows.set(ROOT_KEY, parent);
  expect(() => assertCurrent(resolution.audience)).toThrow("no longer current");
});

it("checks currency synchronously without session reads and fails closed while a write is pending", async () => {
  const { audience } = await grantAt(ROOT_KEY, rootEntry(), true);
  assertCurrent(audience);
  assertCurrent(audience);
  fakeSessionOwner.pendingKeys.add(ROOT_KEY);
  expect(() => assertCurrent(audience)).toThrow("currency is unavailable");
  fakeSessionOwner.pendingKeys.delete(ROOT_KEY);
  assertCurrent(audience);
  expect(fakeSessionOwner.workerReads).toEqual([]);
});

it("rejects a retained audience after its owner releases it", async () => {
  const { audience, release } = await grantAt(ROOT_KEY, rootEntry(), true);
  release();
  expect(() => assertCurrent(audience)).toThrow("released by its owner");
  expect(fakeSessionOwner.activeLeases).toBe(0);
});
it("binds the delegate to its child session and folds parent revocation into provider calls", async () => {
  const root = rootEntry();
  const { audience } = await grantAt(ROOT_KEY, root, true);
  fakeSessionOwner.rows.set(CHILD_KEY, { sessionId: "recall-session", updatedAt: 1 });
  const delegated = await delegate(audience);
  expect(delegated.audience).toEqual(audience);
  expect(delegated.audience).not.toBe(audience);
  expect(Object.isFrozen(delegated.audience)).toBe(true);
  expect(isHostMemoryAudience(delegated.audience)).toBe(true);
  expect(() => assertSession(audience, ROOT_KEY)).not.toThrow();
  expect(() => assertSession(delegated.audience, ROOT_KEY)).toThrow("different session");
  const raw = provider();
  const bound = bindProvider(raw, delegated.audience);
  await expect(bound.health()).resolves.toMatchObject({ status: "ready" });
  fakeSessionOwner.rows.set(ROOT_KEY, { ...root, lifecycleRevision: randomUUID() });
  await expect(bound.health()).rejects.toThrow("no longer current");
  expect(() => assertCurrent(audience)).toThrow("no longer current");
  await expect(delegate(audience, "agent:main:other")).rejects.toThrow("no longer current");
  expect(raw.health).toHaveBeenCalledTimes(1);
});

it("requires an existing child session for the same agent", async () => {
  const { audience } = await grantAt(ROOT_KEY, rootEntry(), true);
  await expect(delegate(audience)).rejects.toThrow("requires an existing child session");
  await expect(delegate(audience, "agent:other:child")).rejects.toThrow(
    "requires a session for the same agent",
  );
});
it("observes a child publication when its parent rejects preparation", async () => {
  const { rootGrant, grant } = await delegatedChild();
  const publication = createDeferredCore();
  fakeSessionOwner.publications.set(CHILD_KEY, publication.promise);
  rootGrant.release();
  try {
    expect(() => prepareMemoryAudienceRead(grant.audience)).toThrow("released by its owner");
    publication.reject(new Error("Synthetic rejected child publication"));
    // Drain the rejection turn: Vitest must see no unhandled publication failure.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  } finally {
    fakeSessionOwner.publications.delete(CHILD_KEY);
    grant.release();
  }
});

it.each(["metadata", "reset", "release", "abort"] as const)(
  "joins a parent publication and handles %s before provider I/O",
  async (change) => {
    const { rootGrant, grant } = await delegatedChild();
    const publish = pendingPublication(ROOT_KEY);
    const controller = new AbortController();
    const native = provider();
    const bound = bindProvider(native, grant.audience, controller.signal);
    const result = bound.health();
    const observed = result.catch((error: unknown) => error);
    try {
      expect(native.health).not.toHaveBeenCalled();
      expect(() => assertCurrent(grant.audience)).toThrow("currency is unavailable");
      if (change === "reset") {
        fakeSessionOwner.rows.set(ROOT_KEY, rootEntry());
      }
      if (change === "release") {
        grant.release();
      }
      if (change === "abort") {
        controller.abort();
        expect(await observed).toBeInstanceOf(Error);
      }
      publish();
      if (change === "metadata") {
        await expect(result).resolves.toMatchObject({ status: "ready" });
        expect(native.health).toHaveBeenCalledOnce();
        expect(prepareMemoryAudienceRead(grant.audience)).toBeUndefined();
      } else {
        expect(await observed).toBeInstanceOf(Error);
        expect(native.health).not.toHaveBeenCalled();
      }
    } finally {
      publish();
      await observed;
      await bound.close();
      grant.release();
      rootGrant.release();
    }
  },
);
it.each(["memory", "other", "reset", "abort"] as const)(
  "prepares %s tool execution at the host boundary",
  async (kind) => {
    const grant = await grantAt(ROOT_KEY, rootEntry(), true);
    const builder = createTestPluginRegistry(createPluginRuntimeMock());
    const record = createPluginRecord({ id: "probe", contracts: { tools: ["probe"] } });
    builder.registry.plugins.push(record);
    builder.registry.memoryCapabilities.push({
      pluginId: kind === "other" ? "other" : "probe",
      capability: {},
      memorySlotSelected: true,
    });
    builder
      .createApi(record, { config: {}, registrationMode: "full" })
      .registerTool(() => null, { name: "probe" });
    const entry = builder.registry.tools[0]!;
    const context = createPluginToolFactoryContext({
      entry,
      registry: builder.registry,
      context: {
        sessionKey: ROOT_KEY,
        memoryAudience: grant.audience,
        assertMemoryAudienceCurrent: () => assertCurrent(grant.audience),
      },
    });
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const tool = bindPluginToolCallbacks(
      entry,
      builder.registry,
      {
        name: "probe",
        label: "probe",
        description: "probe",
        parameters: { type: "object", properties: {} },
        execute,
      },
      context.assertInvocationCurrent,
      context.memoryAudience,
    );
    const publish = pendingPublication(ROOT_KEY);
    const controller = new AbortController();
    const result = tool.execute("call", {}, controller.signal);
    const observed = result.catch((error: unknown) => error);
    try {
      if (kind === "other") {
        await result;
        expect(execute).toHaveBeenCalledOnce();
      } else {
        expect(execute).not.toHaveBeenCalled();
      }
      if (kind === "reset") {
        fakeSessionOwner.rows.set(ROOT_KEY, rootEntry());
      }
      if (kind === "abort") {
        controller.abort();
        expect(await observed).toBeInstanceOf(Error);
      }
      publish();
      if (kind === "reset" || kind === "abort") {
        expect(await observed).toBeInstanceOf(Error);
        expect(execute).not.toHaveBeenCalled();
      } else {
        await result;
        expect(execute).toHaveBeenCalledOnce();
      }
    } finally {
      publish();
      await observed;
      grant.release();
    }
  },
);

const RUN_KEY = "agent:main:cron:job-1:run:run-session";

// A scheduled run row records no spawn receipt; its execution context names the parent.
function resolveScheduledRun(
  parent: FakeSessionRow,
  senderIsOwner: boolean,
  link: { lifecycleRevision?: string } = { lifecycleRevision: parent.lifecycleRevision },
  parentKey = ROOT_KEY,
  runKey = RUN_KEY,
  run: FakeSessionRow = { sessionId: randomUUID(), updatedAt: 1 },
) {
  fakeSessionOwner.rows.set(parentKey, parent);
  return resolveAt(runKey, run, undefined, {
    scheduledParent: {
      sessionKey: parentKey,
      sessionId: parent.sessionId,
      senderIsOwner,
      ...link,
    },
  });
}

it("grants a scheduled child its parent's audience, bound to the run session", async () => {
  const parent = rootEntry();
  const grant = requireGrant(await resolveScheduledRun(parent, true));
  expect(grant.audience).toEqual({
    kind: "owner-private",
    agentId: AGENT_ID,
    context: expect.any(Object),
  });
  assertSession(grant.audience, RUN_KEY);
  const shared = requireGrant(await resolveScheduledRun(rootEntry(), false));
  expect(shared.audience).toMatchObject({ kind: "conversation", sessionKey: ROOT_KEY });
  // A parent reset during the run revokes the grant before provider I/O.
  fakeSessionOwner.rows.set(ROOT_KEY, { ...parent, lifecycleRevision: randomUUID() });
  expect(() => assertCurrent(grant.audience)).toThrow("no longer current");
});

it("denies a scheduled child whose parent was reset after the link was recorded", async () => {
  const parent = rootEntry();
  const resolution = await resolveScheduledRun(parent, true, { lifecycleRevision: randomUUID() });
  expect(resolution).toMatchObject({ status: "denied", kind: "stale-lineage" });
  expect(fakeSessionOwner.activeLeases).toBe(0);
});

it("matches a scheduled parent link that recorded only the session id", async () => {
  const grant = requireGrant(await resolveScheduledRun(rootEntry("group"), false, {}));
  expect(grant.audience).toMatchObject({ kind: "conversation", sessionKey: ROOT_KEY });
});

it("grants an in-session scheduled run its own linked row's audience with the occurrence's owner bit", async () => {
  const root = rootEntry();
  const resolve = (lifecycleRevision = root.lifecycleRevision) =>
    resolveScheduledRun(root, true, { lifecycleRevision }, ROOT_KEY, ROOT_KEY, root);
  const grant = requireGrant(await resolve());
  expect(grant.audience).toEqual({
    kind: "owner-private",
    agentId: AGENT_ID,
    context: expect.any(Object),
  });
  grant.release();
  const reset = await resolve(randomUUID());
  expect(reset).toMatchObject({ status: "denied", kind: "stale-lineage" });
  expect(fakeSessionOwner.activeLeases).toBe(0);
});

it.each(["spawned-parent", "in-session", "other-parent"] as const)(
  "caps scheduled requester ownership on a %s link",
  async (mode) => {
    const root = rootEntry();
    fakeSessionOwner.rows.set(ROOT_KEY, root);
    const spawned = childEntry(root);
    const parent = mode === "other-parent" ? rootEntry() : spawned;
    const parentKey = mode === "other-parent" ? "agent:main:linked" : CHILD_KEY;
    const run = mode === "spawned-parent" ? { sessionId: randomUUID(), updatedAt: 1 } : spawned;
    const runKey = mode === "spawned-parent" ? RUN_KEY : CHILD_KEY;
    const resolve = (owner: boolean) =>
      resolveScheduledRun(parent, owner, undefined, parentKey, runKey, run);
    if (mode === "spawned-parent") {
      const owner = requireGrant(await resolve(true));
      expect(owner.audience).toEqual({
        kind: "owner-private",
        agentId: AGENT_ID,
        context: expect.any(Object),
      });
      owner.release();
    }
    const capped = requireGrant(await resolve(false));
    expect(capped.audience).toEqual(conversation(root));
    capped.release();
  },
);
