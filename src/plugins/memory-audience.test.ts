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
import { sessionChanges } from "../sessions/session-row-changes.js";
import { bindMemoryProvider } from "./memory-provider-adapter.js";
import type { MemoryProviderHandle } from "./memory-provider-types.js";

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
  assertMemoryAudienceCurrent,
  assertMemoryAudienceSession,
  delegateMemoryAudience,
  isHostMemoryAudience,
  readMemoryAudienceExecutionSignal,
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

function resolveAt(sessionKey: string, entry: FakeSessionRow, senderIsOwner?: boolean) {
  fakeSessionOwner.rows.set(sessionKey, entry);
  return resolveMemoryAudienceFromEntry(
    {
      agentId: AGENT_ID,
      sessionKey,
      sessionId: entry.sessionId,
      senderIsOwner,
      storePath: STORE_PATH,
    },
    entry,
  );
}

async function grantAt(sessionKey: string, entry: FakeSessionRow, senderIsOwner?: boolean) {
  const resolution = await resolveAt(sessionKey, entry, senderIsOwner);
  if (resolution.status !== "granted") {
    throw new Error(`expected a memory audience: ${resolution.reason}`);
  }
  return resolution;
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
      assertMemoryAudienceCurrent(result.audience);
      cfg = { session: { identityLinks: { alice: ["slack:U123"] } } };
      expect(() => assertMemoryAudienceCurrent(result.audience)).toThrow(
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
      assertMemoryAudienceCurrent(result.audience);
      groupKey = "changed";
      sessionChanges.emit({ all: true, scope: "config" });
      expect(executionSignal.aborted).toBe(true);
      expect(() => assertMemoryAudienceCurrent(result.audience)).toThrow(
        "membership or publication authority changed",
      );
      groupKey = "initial";
      sessionChanges.emit({ all: true, scope: "config" });
      expect(() => assertMemoryAudienceCurrent(result.audience)).toThrow(
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

  it("reuses an admitted root entry without a session read", async () => {
    await grantAt(ROOT_KEY, rootEntry(), true);
    expect(fakeSessionOwner.workerReads).toEqual([]);
  });

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

  it("denies a missing parent, missing chat type, missing session id, or mismatched session id", async () => {
    const root = rootEntry();
    const child = childEntry(root);
    fakeSessionOwner.rows.set(CHILD_KEY, child);
    await expect(
      resolveMemoryAudienceFromEntry(
        {
          agentId: AGENT_ID,
          sessionKey: CHILD_KEY,
          sessionId: child.sessionId,
          senderIsOwner: true,
          storePath: STORE_PATH,
        },
        child,
      ),
    ).resolves.toMatchObject({ status: "denied" });
    await expect(
      resolveAt(ROOT_KEY, { ...root, chatType: undefined }, true),
    ).resolves.toMatchObject({ status: "denied" });
    for (const sessionId of [undefined, randomUUID()]) {
      await expect(
        resolveMemoryAudienceFromEntry(
          {
            agentId: AGENT_ID,
            sessionKey: ROOT_KEY,
            sessionId,
            senderIsOwner: true,
            storePath: STORE_PATH,
          },
          root,
        ),
      ).resolves.toMatchObject({ status: "denied" });
    }
    expect(fakeSessionOwner.activeLeases).toBe(0);
  });

  it.each([
    ["private", "direct", true, "owner-private"],
    ["non-owner conversation", "direct", false, "conversation"],
    ["group conversation", "group", true, "conversation"],
  ] as const)(
    "inherits the root %s audience through nested children",
    async (_name, chatType, owner, kind) => {
      const root = rootEntry(chatType);
      const child = { ...childEntry(root), spawnedBySenderIsOwner: owner };
      const nestedKey = "agent:main:subagent:nested";
      fakeSessionOwner.rows.set(ROOT_KEY, root);
      fakeSessionOwner.rows.set(CHILD_KEY, child);
      const { audience } = await grantAt(nestedKey, childEntry(child, CHILD_KEY), !owner);
      expect(audience.kind).toBe(kind);
      if (audience.kind === "conversation") {
        expect(audience).toMatchObject({ sessionKey: ROOT_KEY, sessionId: root.sessionId });
      }
    },
  );

  it("denies malformed, stale, cyclic, and cross-agent lineage", async () => {
    const mutations: Array<(parent: FakeSessionRow, child: FakeSessionRow) => void> = [
      (_parent, child) => {
        child.spawnedBySessionId = undefined;
      },
      (_parent, child) => {
        child.spawnedBySessionId = randomUUID();
      },
      (parent) => {
        parent.lifecycleRevision = randomUUID();
      },
      (_parent, child) => {
        child.parentSessionLifecycleRevision = undefined;
      },
      (_parent, child) => {
        child.parentSessionKey = "agent:main:other";
      },
      (_parent, child) => {
        child.spawnedBy = child.parentSessionKey = "agent:foreign:root";
      },
      (_parent, child) => {
        child.spawnedBy = child.parentSessionKey = CHILD_KEY;
        child.spawnedBySessionId = child.sessionId;
        child.parentSessionLifecycleRevision = child.lifecycleRevision;
      },
    ];
    for (const mutate of mutations) {
      const parent = rootEntry();
      const child = childEntry(parent);
      mutate(parent, child);
      await expect(resolveChild(parent, child)).resolves.toMatchObject({ status: "denied" });
    }
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

  it.each([
    [
      "missing both receipts",
      { spawnedBySenderIsOwner: undefined, parentSessionLifecycleRevision: undefined },
    ],
    ["missing the owner receipt", { spawnedBySenderIsOwner: undefined }],
  ] as const)(
    "fails closed with a respawn instruction for a pre-existing spawned row %s",
    async (_name, legacy) => {
      const parent = rootEntry();
      const resolution = await resolveChild(parent, { ...childEntry(parent), ...legacy });
      expect(resolution).toEqual({
        status: "denied",
        legacyLineage: true,
        reason: expect.stringContaining(
          `spawned session ${CHILD_KEY} predates memory lineage receipts`,
        ),
      });
      expect(resolution.status === "denied" && resolution.reason).toContain(
        "Respawn it from its parent session to restore memory access.",
      );
      expect(fakeSessionOwner.workerReads).toEqual([]);
      expect(fakeSessionOwner.activeLeases).toBe(0);
    },
  );

  it("grants a conversation audience to a new child of a group row without a lifecycle revision", async () => {
    // Channel-created group rows carry no lifecycle revision; the child records that absence.
    const { lifecycleRevision: _revision, ...group } = rootEntry("group");
    const child = { ...childEntry(group), parentSessionLifecycleRevision: undefined };
    fakeSessionOwner.rows.set(ROOT_KEY, group);
    const resolution = await resolveAt(CHILD_KEY, child, false);
    if (resolution.status !== "granted") {
      throw new Error(resolution.reason);
    }
    expect(resolution.audience).toMatchObject({
      kind: "conversation",
      agentId: AGENT_ID,
      sessionKey: ROOT_KEY,
      sessionId: group.sessionId,
    });
    assertMemoryAudienceSession(resolution.audience, CHILD_KEY);
    // A reset that gives the parent a lifecycle revision ends the child's grant.
    fakeSessionOwner.rows.set(ROOT_KEY, { ...group, lifecycleRevision: randomUUID() });
    expect(() => assertMemoryAudienceCurrent(resolution.audience)).toThrow("no longer current");
  });
});

describe("memory audience currency", () => {
  it.each(["reset", "removal"] as const)("revokes a child after parent %s", async (change) => {
    const parent = rootEntry();
    const resolution = await resolveChild(parent, childEntry(parent));
    if (resolution.status !== "granted") {
      throw new Error(resolution.reason);
    }
    if (change === "reset") {
      fakeSessionOwner.rows.set(ROOT_KEY, { ...parent, lifecycleRevision: randomUUID() });
    } else {
      fakeSessionOwner.rows.delete(ROOT_KEY);
    }
    expect(() => assertMemoryAudienceCurrent(resolution.audience)).toThrow("no longer current");
    // A later write that restores the old incarnation cannot revive the grant.
    fakeSessionOwner.rows.set(ROOT_KEY, parent);
    expect(() => assertMemoryAudienceCurrent(resolution.audience)).toThrow("no longer current");
  });

  it("checks currency synchronously without session reads and fails closed while a write is pending", async () => {
    const { audience } = await grantAt(ROOT_KEY, rootEntry(), true);
    assertMemoryAudienceCurrent(audience);
    assertMemoryAudienceCurrent(audience);
    fakeSessionOwner.pendingKeys.add(ROOT_KEY);
    expect(() => assertMemoryAudienceCurrent(audience)).toThrow("currency is unavailable");
    fakeSessionOwner.pendingKeys.delete(ROOT_KEY);
    assertMemoryAudienceCurrent(audience);
    expect(fakeSessionOwner.workerReads).toEqual([]);
  });

  it("rejects a retained audience after its owner releases it", async () => {
    const { audience, release } = await grantAt(ROOT_KEY, rootEntry(), true);
    release();
    expect(() => assertMemoryAudienceCurrent(audience)).toThrow("released by its owner");
    expect(fakeSessionOwner.activeLeases).toBe(0);
  });
});

describe("memory audience delegation", () => {
  it("binds the delegate to its child session and folds parent revocation into provider calls", async () => {
    const root = rootEntry();
    const { audience } = await grantAt(ROOT_KEY, root, true);
    fakeSessionOwner.rows.set(CHILD_KEY, { sessionId: "recall-session", updatedAt: 1 });
    const delegated = await delegateMemoryAudience(audience, {
      sessionKey: CHILD_KEY,
      storePath: STORE_PATH,
    });
    expect(delegated.audience).toEqual(audience);
    expect(delegated.audience).not.toBe(audience);
    expect(Object.isFrozen(delegated.audience)).toBe(true);
    expect(isHostMemoryAudience(delegated.audience)).toBe(true);
    expect(() => assertMemoryAudienceSession(audience, ROOT_KEY)).not.toThrow();
    expect(() => assertMemoryAudienceSession(delegated.audience, ROOT_KEY)).toThrow(
      "different session",
    );
    const raw = provider();
    const bound = bindMemoryProvider(raw, "test", {
      authority: {
        kind: "session",
        sessionKey: CHILD_KEY,
        sandboxed: false,
        audience: delegated.audience,
      },
      assertCurrent() {},
    });
    await expect(bound.health()).resolves.toMatchObject({ status: "ready" });
    fakeSessionOwner.rows.set(ROOT_KEY, { ...root, lifecycleRevision: randomUUID() });
    await expect(bound.health()).rejects.toThrow("no longer current");
    expect(() => assertMemoryAudienceCurrent(audience)).toThrow("no longer current");
    await expect(
      delegateMemoryAudience(audience, { sessionKey: "agent:main:other", storePath: STORE_PATH }),
    ).rejects.toThrow("no longer current");
    expect(raw.health).toHaveBeenCalledTimes(1);
  });

  it("requires an existing child session for the same agent", async () => {
    const { audience } = await grantAt(ROOT_KEY, rootEntry(), true);
    await expect(
      delegateMemoryAudience(audience, { sessionKey: CHILD_KEY, storePath: STORE_PATH }),
    ).rejects.toThrow("requires an existing child session");
    await expect(
      delegateMemoryAudience(audience, { sessionKey: "agent:other:child", storePath: STORE_PATH }),
    ).rejects.toThrow("requires a session for the same agent");
  });
});
