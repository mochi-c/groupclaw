import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withMemoryDreamSource } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import { patchSessionEntry, type SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markDreamSessionEnded } from "./dreaming-fragment-state.js";
import { appendAgentMemoryFragmentFile } from "./fragment-memory-write.js";
import { runInMemoryTestBackgroundContext } from "./memory/background-context.test-support.js";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./memory/index.js";
import { createManagerIndexFixture } from "./memory/manager-index.test-support.js";
import { createMemoryContextReadTool } from "./tools.context-read.js";
import { createMemoryReadTool, createMemorySearchTool, testing } from "./tools.js";

describe("authorized cross-discussion memory search", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  afterEach(() => {
    testing.resetMemorySearchToolCooldowns();
    resetPluginRuntimeStateForTest();
  });

  it("finds public same-group history, expands refs, and revokes access without widening Context", async () => {
    const cfg = fixture.createConfig({ vectorEnabled: false });
    cfg.channels = {
      discord: {
        guilds: {
          "900": {
            channels: {
              "100": { members: ["1", "2"], threadMode: "auto" },
              "200": { members: ["1", "2"], threadMode: "auto" },
              "300": { members: ["1", "2"], threadMode: "always" },
              "400": { members: ["3"], threadMode: "auto" },
            },
          },
        },
      },
    };
    // The channel contract supplies configured membership and native visibility;
    // the search flow must obtain those facts through the real host admission.
    const resolveMemoryPolicy: NonNullable<
      NonNullable<ChannelPlugin["groups"]>["resolveMemoryPolicy"]
    > = ({ cfg: current, origin }) => {
      const channel =
        current.channels?.discord?.guilds?.["900"]?.channels?.[
          origin.nativeParentChannelId ?? origin.nativeChannelId ?? ""
        ];
      const members = [...(channel?.members ?? [])].toSorted();
      return {
        channelMemory: channel?.threadMode === "always" ? "exclude" : "include",
        ...(members.length && (!origin.threadId || origin.nativeThreadVisibility === "public")
          ? {
              group: {
                key: JSON.stringify(members),
                members: members.map((id) => ({
                  identity: {
                    type: "remote" as const,
                    pluginId: "discord",
                    domain: "discord",
                    idKind: "user",
                    id,
                  },
                })),
                workspaceShared: false,
                consolidationAllowed: Boolean(channel?.threadMode),
              },
            }
          : {}),
      };
    };
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: {
            id: "discord",
            meta: { id: "discord", label: "Discord" },
            groups: { resolveMemoryPolicy },
          },
        },
      ]),
    );
    const append = async (
      channel: string,
      thread: string | undefined,
      visibility: "public" | "private" | "unknown" = "public",
    ) => {
      const sessionId = randomUUID();
      const sessionKey = `agent:main:discord:channel:${thread ?? channel}`;
      const entry: SessionEntry = {
        sessionId,
        updatedAt: Date.now(),
        chatType: "channel",
        delivery: {
          kind: "external",
          route: {
            channel: "discord",
            accountId: "default",
            target: { to: `channel:${thread ?? channel}`, chatType: "channel" },
            ...(thread ? { thread: { id: thread } } : {}),
          },
          context: {
            channel: "discord",
            accountId: "default",
            to: `channel:${thread ?? channel}`,
            ...(thread ? { threadId: thread } : {}),
          },
          origin: {
            provider: "discord",
            accountId: "default",
            nativeChannelId: thread ?? channel,
            ...(thread
              ? {
                  threadId: thread,
                  nativeParentChannelId: channel,
                  ...(visibility === "unknown" ? {} : { nativeThreadVisibility: visibility }),
                }
              : {}),
          },
        },
      };
      await patchSessionEntry({
        agentId: "main",
        sessionKey,
        fallbackEntry: entry,
        update: () => entry,
        replaceEntry: true,
        skipMaintenance: true,
      });
      return withMemoryDreamSource(
        {
          cfg,
          agentId: "main",
          sessionKey,
          sessionId,
          storePath: resolveStorePath(cfg.session?.store, { agentId: "main" }),
          assertCurrent: () => {},
        },
        async (facts) => {
          const relativePath = facts.context.fragment!.resolveRelativePath({
            createdDate: "2026-10-27",
          });
          await appendAgentMemoryFragmentFile({
            cfg,
            agentId: "main",
            relPath: relativePath,
            timeLabel: "09:00",
            content: `Orchid decision from ${thread ?? channel}.`,
            source: { sessionKey, sessionId, createdAtMs: Date.now() },
            assertCurrent: facts.assertCurrent,
          });
          return {
            relativePath,
            sessionKey,
            sessionId,
            context: facts.context,
            session: facts.session,
          };
        },
      );
    };
    const current = await append("100", "101");
    const sibling = await append("100", "102");
    const otherChannel = await append("200", "201");
    const privateThread = await append("100", "103", "private");
    const unknownThread = await append("100", "104", "unknown");
    const otherGroup = await append("400", "401");
    const launch = await append("300", "301");
    const launchPath = launch.relativePath.replace(/\/Thread\/[^/]+/u, "");
    const legacyPath = "memory/2026-10-26.md";
    for (const relativePath of [launchPath, legacyPath]) {
      await fs.mkdir(path.dirname(path.join(fixture.paths.workspace, relativePath)), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(fixture.paths.workspace, relativePath),
        "Orchid hidden decision.",
      );
    }
    await markDreamSessionEnded({
      workspaceDir: fixture.paths.workspace,
      agentId: "main",
      ...otherChannel,
      assertCurrent: () => {},
    });
    await patchSessionEntry({
      agentId: "main",
      sessionKey: otherChannel.sessionKey,
      update: (entry) => ({ ...entry!, sessionId: randomUUID() }),
      skipMaintenance: true,
    });
    const manager = await fixture.getFreshManager(cfg);
    await manager.sync({ force: true, reason: "test" });
    const options = {
      config: cfg,
      getConfig: () => cfg,
      runInBackgroundContext: runInMemoryTestBackgroundContext,
      agentId: "main",
      agentSessionKey: current.sessionKey,
      memoryAudience: {
        kind: "conversation" as const,
        agentId: "main",
        sessionKey: current.sessionKey,
        sessionId: current.sessionId,
        context: current.context,
      },
      assertMemoryAudienceCurrent: () => {},
    };
    const search = createMemorySearchTool(options)!;
    const read = createMemoryReadTool(options)!;
    const result = await search.execute("cross-thread", {
      query: "Orchid",
      corpus: "memory",
      maxResults: 20,
    });
    expect(result.details).not.toMatchObject({ unavailable: true });
    const hits = (result.details as { results: Array<{ path: string; ref: string }> }).results;
    expect(hits.map((hit) => hit.path).toSorted()).toEqual(
      [current, sibling, otherChannel, launch].map((source) => source.relativePath).toSorted(),
    );
    for (const source of [privateThread, unknownThread, otherGroup]) {
      const ref =
        "memory:v1:" +
        Buffer.from(JSON.stringify(["main", source.relativePath, 1, 20])).toString("base64url");
      await expect(read.execute("excluded-ref", { ref })).resolves.toMatchObject({
        details: { status: "not_found", text: "" },
      });
    }
    const siblingHit = hits.find((hit) => hit.path === sibling.relativePath)!;
    await expect(read.execute("sibling-ref", { ref: siblingHit.ref })).resolves.toMatchObject({
      details: { status: "ok", text: expect.stringContaining("Orchid decision from 102") },
    });
    const aliasPath = path.posix.join(path.posix.dirname(sibling.relativePath), "alias.md");
    await fs.link(
      path.join(fixture.paths.workspace, privateThread.relativePath),
      path.join(fixture.paths.workspace, aliasPath),
    );
    const aliasRef =
      "memory:v1:" + Buffer.from(JSON.stringify(["main", aliasPath, 1, 20])).toString("base64url");
    await expect(read.execute("aliased-ref", { ref: aliasRef })).resolves.toMatchObject({
      details: { status: "error", text: "", code: "hardlink" },
    });
    await fs.unlink(path.join(fixture.paths.workspace, aliasPath));
    const context = await createMemoryContextReadTool(options)!.execute("local-context", {});
    expect(JSON.stringify(context.details)).not.toContain(sibling.relativePath);
    const threadMemory = current.context.artifacts.find((artifact) => artifact.layer === "thread")!;
    const threadMemoryPath = path.join(fixture.paths.workspace, threadMemory.relativePath);
    await fs.link(path.join(fixture.paths.workspace, privateThread.relativePath), threadMemoryPath);
    await expect(
      createMemoryContextReadTool(options)!.execute("aliased-context", { layers: ["thread"] }),
    ).rejects.toMatchObject({ code: "hardlink" });
    await fs.unlink(threadMemoryPath);
    cfg.channels.discord!.guilds!["900"]!.channels!["200"]!.members = ["9"];
    const endedRef = hits.find((hit) => hit.path === otherChannel.relativePath)!.ref;
    await expect(read.execute("revoked-ended-ref", { ref: endedRef })).resolves.toMatchObject({
      details: { status: "not_found", text: "" },
    });
    const after = await search.execute("revoked-search", {
      query: "Orchid",
      corpus: "memory",
      maxResults: 20,
    });
    expect(
      (after.details as { results: Array<{ path: string }> }).results.map((hit) => hit.path),
    ).not.toContain(otherChannel.relativePath);

    for (const phase of ["retrieval", "deadline"] as const) {
      // Each revocation phase starts a fresh call; the previous denial can put
      // the tool in its ordinary one-minute failure cooldown.
      testing.resetMemorySearchToolCooldowns();
      cfg.channels.discord!.guilds!["900"]!.channels!["300"]!.members = ["1", "2"];
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      fixture.provider.beforeEmbedQuery = async () => {
        entered.resolve();
        await release.promise;
      };
      // Advance admission timers while waiting for the real session/database
      // workers; the deadline is still advanced explicitly after provider entry.
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "Date"],
        shouldAdvanceTime: true,
      });
      const execution = search.execute(`revoked-${phase}`, {
        query: "Orchid",
        corpus: "memory",
        maxResults: 20,
      });
      void execution.catch(() => {});
      try {
        await Promise.race([
          entered.promise,
          execution.then(() => {
            throw new Error("Search completed before the held embedding operation");
          }),
        ]);
        cfg.channels.discord!.guilds!["900"]!.channels!["300"]!.members = ["9"];
        if (phase === "deadline") {
          await vi.advanceTimersByTimeAsync(30_000);
        } else {
          release.resolve();
        }
        await expect(execution).rejects.toThrow(
          "memory context membership or publication authority changed",
        );
      } finally {
        release.resolve();
        await execution.catch(() => {});
        fixture.provider.beforeEmbedQuery = null;
        vi.useRealTimers();
      }
    }
    cfg.channels.discord!.guilds!["900"]!.channels!["100"]!.members = ["9"];
    const currentRef = hits.find((hit) => hit.path === current.relativePath)!.ref;
    await expect(read.execute("revoked-current-ref", { ref: currentRef })).rejects.toThrow(
      "Memory search audience changed during admission",
    );
  });
});
