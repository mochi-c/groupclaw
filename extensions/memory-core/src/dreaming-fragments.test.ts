import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { withMemoryDreamSource } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { MEMORY_DREAMING_SYSTEM_EVENT_TEXT } from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import { patchSessionEntry, type SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { readDreamFragmentNotebook, readDreamFragmentSources } from "./dreaming-fragment-state.js";
import * as fragmentState from "./dreaming-fragment-state.js";
import type { DreamingCompletion } from "./dreaming-narrative.js";
import { registerShortTermPromotionDreaming } from "./dreaming.js";
import { appendAgentMemoryFragmentFile } from "./fragment-memory-write.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import { createMemoryForgetFixture } from "./memory-forget.test-helpers.js";
import {
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
} from "./short-term-promotion.js";

// These tests exercise the real cron hook, canonical session admission,
// SQLite notebook, atomic publication, and cleanup. Only inference is stubbed.
describe("Fragment Dream background flow", () => {
  let fixture: Awaited<ReturnType<typeof createMemoryForgetFixture>>;
  let stop: (() => Promise<void>) | undefined;
  let run: () => Promise<unknown>;
  let complete: Mock<DreamingCompletion["complete"]>;
  let api: OpenClawPluginApi;

  beforeEach(async () => {
    fixture = await createMemoryForgetFixture("openclaw-fragment-dream-");
    fixture.cfg.channels = {
      discord: {
        guilds: {
          "900": {
            channels: {
              "100": { members: ["1", "2"], threadMode: "auto" },
              "200": { members: ["1", "2"], threadMode: "auto" },
              "300": { members: ["1", "2"], threadMode: "always" },
            },
          },
        },
      },
    };
    fixture.cfg.plugins = {
      entries: {
        "memory-core": {
          config: {
            dreaming: {
              enabled: true,
              phases: { light: { enabled: false }, rem: { enabled: false } },
            },
          },
        },
      },
    };
    // The host consumes the registered channel contract. Transport-specific
    // config behavior is proved by the Discord policy suite.
    const resolveMemoryPolicy: NonNullable<
      NonNullable<ChannelPlugin["groups"]>["resolveMemoryPolicy"]
    > = ({ cfg, origin }) => {
      const discord = cfg.channels?.discord;
      const account = discord?.accounts?.[origin.accountId ?? "default"];
      if (discord?.enabled === false || account?.enabled === false) {
        throw new Error("channel disabled");
      }
      const channel = (account?.guilds ?? discord?.guilds)?.["900"]?.channels?.[
        origin.nativeParentChannelId ?? origin.nativeChannelId ?? ""
      ];
      const members = [...(channel?.members ?? [])].toSorted();
      return {
        channelMemory: channel?.threadMode === "always" ? "exclude" : "include",
        ...(members.length && (!origin.threadId || origin.nativeThreadVisibility === "public")
          ? {
              group: {
                members: members.map((id) => ({
                  identity: {
                    type: "remote" as const,
                    pluginId: "discord",
                    domain: "discord",
                    idKind: "user",
                    id,
                  },
                  label: id === "1" ? "Alice" : `Discord user ${id}`,
                })),
                key: JSON.stringify(members),
                consolidationAllowed: Boolean(channel?.threadMode),
                workspaceShared: Object.values(discord?.guilds?.["900"]?.channels ?? {}).every(
                  (candidate) =>
                    JSON.stringify([...(candidate.members ?? [])].toSorted()) ===
                    JSON.stringify(members),
                ),
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
    complete = vi.fn<DreamingCompletion["complete"]>();
    const on = vi.fn();
    let service: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
    const scheduler = createTestPluginServiceScheduler();
    api = createTestPluginApi({
      config: fixture.cfg,
      on,
      registerService: (registered) => {
        service = registered;
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    Object.assign(api.runtime, { subagent: { complete }, config: { current: () => fixture.cfg } });
    registerShortTermPromotionDreaming(api);
    const context = {
      config: fixture.cfg,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      logger: api.logger,
      scheduler,
      getCron: () => undefined,
    };
    await service?.start(context);
    stop = async () => {
      await service?.stop?.(context);
      await scheduler.stop();
    };
    const handler = on.mock.calls.find(([name]) => name === "before_agent_reply")?.[1] as (
      event: { cleanedBody: string },
      ctx: { trigger: string; agentId: string; workspaceDir: string },
    ) => Promise<unknown>;
    run = () =>
      handler(
        { cleanedBody: MEMORY_DREAMING_SYSTEM_EVENT_TEXT },
        {
          trigger: "cron",
          agentId: "main",
          workspaceDir: fixture.workspaceDir,
        },
      );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await stop?.();
    stop = undefined;
    await fixture.cleanup();
    resetPluginRuntimeStateForTest();
  });

  async function append(
    channel: string,
    content: string,
    thread?: string,
    visibility: "public" | "private" = "public",
  ) {
    const sessionId = randomUUID();
    const sessionKey = `agent:main:discord:${thread ?? channel}:${sessionId}`;
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
          chatType: "channel",
          nativeChannelId: thread ?? channel,
          ...(thread
            ? {
                threadId: thread,
                nativeParentChannelId: channel,
                nativeThreadVisibility: visibility,
              }
            : {}),
        },
      },
      participants: [
        {
          identity: {
            type: "remote",
            pluginId: "discord",
            domain: "discord",
            idKind: "user",
            id: "1",
          },
          label: "Alice",
        },
      ],
    };
    await patchSessionEntry({
      agentId: "main",
      sessionKey,
      fallbackEntry: entry,
      update: () => entry,
      replaceEntry: true,
      skipMaintenance: true,
    });
    // Create upgrade evidence under an earlier, non-launch admission. Current
    // configuration stays authoritative when the background pass reads it.
    const admissionConfig = structuredClone(fixture.cfg);
    if (!thread) {
      admissionConfig.channels!.discord!.guilds!["900"]!.channels![channel]!.threadMode = "auto";
    }
    return withMemoryDreamSource(
      {
        agentId: "main",
        sessionKey,
        sessionId,
        storePath: resolveStorePath(fixture.cfg.session?.store, { agentId: "main" }),
        assertCurrent: () => {},
        cfg: admissionConfig,
      },
      async (facts) => {
        const relPath = facts.context.fragment!.resolveRelativePath({
          createdDate: new Date().toISOString().slice(0, 10),
        });
        await appendAgentMemoryFragmentFile({
          cfg: fixture.cfg,
          agentId: "main",
          relPath,
          timeLabel: "10:00",
          content,
          source: { sessionKey, sessionId, createdAtMs: Date.now() },
          assertCurrent: () => facts.assertCurrent(),
        });
        return { relPath, sessionId, sessionKey, entry };
      },
    );
  }

  function planFor(message: string, scope = "workspace", fullyCovered = true) {
    const input = JSON.parse(message) as {
      fragments: Array<{ id: string; text: string }>;
      notebook: Array<{ text: string; sourceIds: string[] }>;
      targets: Array<{ id: string; scope: string; content: string; archive: boolean }>;
      curated: Array<{ id: string; target: string; text: string; sourceIds: string[] }>;
    };
    const ids = input.fragments.map((fragment) => fragment.id);
    const target = input.targets.find((candidate) => candidate.scope === scope);
    if (!target) {
      throw new Error(`missing target ${scope}`);
    }
    return {
      input,
      plan: {
        topics: [],
        processed: ids,
        discard: [],
        publications: [
          {
            targetId: target.id,
            kind: "memory",
            sourceIds: ids,
            ...(fullyCovered ? { coveredSourceIds: ids } : {}),
            content: "Use UTC for shared schedules.",
            reason: "Explicit global convention supported across discussions.",
            completed: false,
          },
        ],
      },
    };
  }

  it("synthesizes cross-Channel sources once, cleans covered entries, and forgets the replacement", async () => {
    const first = await append("100", "Workspace convention: use UTC for all schedules.", "101");
    const second = await append("200", "Confirmed globally: use UTC for shared schedules.", "201");
    complete.mockImplementation(async ({ message }: { message: string }) => {
      const { input, plan } = planFor(message);
      expect(input.fragments).toHaveLength(2);
      return { text: JSON.stringify(plan) };
    });
    await Promise.all([run(), run()]);
    expect(api.logger.error).not.toHaveBeenCalled();
    const memoryPath = path.join(fixture.workspaceDir, "memory/MEMORY.md");
    expect(await fs.readFile(memoryPath, "utf8")).toContain("Use UTC for shared schedules.");
    for (const source of [first, second]) {
      expect(
        await fs.readFile(path.join(fixture.workspaceDir, source.relPath), "utf8"),
      ).not.toContain("use UTC");
    }
    expect(
      (await readDreamFragmentSources(fixture.workspaceDir)).every((source) => source.processed),
    ).toBe(true);
    await run();
    expect(complete).toHaveBeenCalledTimes(1);
    await forgetMemoryEntries({ cfg: fixture.cfg, agentId: "main", sessionIds: [first.sessionId] });
    expect(await fs.readFile(memoryPath, "utf8")).not.toContain("Use UTC");
    expect(await readDreamFragmentNotebook(fixture.workspaceDir)).toEqual({
      version: 2,
      topics: [],
    });
  });

  it("keeps an unfinished matter in the private notebook and preserves a concurrent identical append", async () => {
    const first = await append("100", "Choose the picnic venue later.", "101");
    complete.mockImplementationOnce(async ({ message }: { message: string }) => {
      const { input } = planFor(message);
      await append("100", "Choose the picnic venue later.", "101");
      return {
        text: JSON.stringify({
          topics: [{ text: "Venue remains undecided.", sourceIds: [input.fragments[0]!.id] }],
          processed: [input.fragments[0]!.id],
          discard: [],
          publications: [],
        }),
      };
    });
    await run();
    expect(api.logger.error).not.toHaveBeenCalled();
    expect((await readDreamFragmentNotebook(fixture.workspaceDir)).topics[0]?.text).toContain(
      "undecided",
    );
    expect(await fs.readFile(path.join(fixture.workspaceDir, first.relPath), "utf8")).toMatch(
      /Choose the picnic venue later\.[\s\S]*Choose the picnic venue later\./u,
    );
    await expect(
      fs.readFile(path.join(fixture.workspaceDir, "memory/MEMORY.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await forgetMemoryEntries({ cfg: fixture.cfg, agentId: "main", sessionIds: [first.sessionId] });
    expect((await readDreamFragmentNotebook(fixture.workspaceDir)).topics).toEqual([]);
  });

  it("preserves a partially cited Fragment until later organization fully covers it", async () => {
    const source = await append(
      "100",
      "Use UTC for schedules. The picnic venue remains undecided.",
      "101",
    );
    complete.mockImplementationOnce(async ({ message }) => {
      const { plan } = planFor(message, "thread");
      plan.publications[0]!.coveredSourceIds = undefined;
      return { text: JSON.stringify(plan) };
    });
    await run();
    expect(await fs.readFile(path.join(fixture.workspaceDir, source.relPath), "utf8")).toContain(
      "picnic venue remains undecided",
    );

    complete.mockImplementationOnce(async ({ message }) => {
      const { input } = planFor(message, "thread");
      expect(input.fragments[0]?.text).toContain("picnic venue remains undecided");
      return {
        text: JSON.stringify({
          topics: [{ text: "Venue remains undecided.", sourceIds: [input.fragments[0]!.id] }],
          processed: [input.fragments[0]!.id],
          discard: [],
          publications: [],
        }),
      };
    });
    await run();
    complete.mockImplementationOnce(async ({ message }) => {
      const { input, plan } = planFor(message, "thread");
      expect(input.fragments[0]?.text).toContain("picnic venue remains undecided");
      plan.publications[0] = {
        ...plan.publications[0]!,
        kind: "archive",
        completed: true,
        content: "The picnic was canceled; UTC remains the schedule convention.",
        reason: "The pending matter was explicitly canceled.",
      };
      return { text: JSON.stringify(plan) };
    });
    await run();
    expect(api.logger.error).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(3);
    expect(
      await fs.readFile(path.join(fixture.workspaceDir, source.relPath), "utf8"),
    ).not.toContain("picnic venue remains undecided");
    expect((await readDreamFragmentNotebook(fixture.workspaceDir)).topics).toEqual([]);
  });

  it("admits launch Threads, excludes launch Channel and private Thread evidence, and publishes subject Memory", async () => {
    const launch = await append("300", "Launch-only material.");
    const privateThread = await append("100", "Private project detail.", "102", "private");
    await append("300", "Alice prefers ISO dates.", "301");
    complete.mockImplementation(async ({ message }: { message: string }) => {
      const { input, plan } = planFor(message, "user");
      expect(input.fragments).toHaveLength(1);
      plan.publications[0]!.content = "Alice prefers ISO dates.";
      plan.publications[0]!.reason = "Alice's stated personal preference.";
      return { text: JSON.stringify(plan) };
    });
    await run();
    expect(api.logger.error).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    for (const source of [launch, privateThread]) {
      expect(await fs.readFile(path.join(fixture.workspaceDir, source.relPath), "utf8")).not.toBe(
        "",
      );
    }
    const users = await fs.readdir(path.join(fixture.workspaceDir, "memory/User"));
    expect(
      await fs.readFile(
        path.join(fixture.workspaceDir, "memory/User", users[0]!, "MEMORY.md"),
        "utf8",
      ),
    ).toContain("Alice prefers ISO dates.");
  });

  it("continues unfinished organization with original evidence until explicitly discarded", async () => {
    await append("100", "Keep this open topic for the next organization pass.", "101");
    complete.mockImplementationOnce(async ({ message }: { message: string }) => {
      const { input } = planFor(message);
      return {
        text: JSON.stringify({
          topics: [
            { text: "Organize the remaining evidence.", sourceIds: [input.fragments[0]!.id] },
          ],
          processed: [input.fragments[0]!.id],
          discard: [],
          publications: [],
        }),
      };
    });
    await run();
    complete.mockImplementationOnce(async ({ message }: { message: string }) => {
      const { input } = planFor(message);
      expect(input.fragments[0]?.text).toContain("Keep this open topic");
      expect(input.notebook).toHaveLength(1);
      return { text: JSON.stringify({ topics: [], processed: [], discard: [], publications: [] }) };
    });
    await run();
    expect(api.logger.error).not.toHaveBeenCalled();
    expect((await readDreamFragmentNotebook(fixture.workspaceDir)).topics).toEqual([]);
    complete.mockImplementationOnce(async ({ message }) => {
      const { input } = planFor(message);
      expect(input.fragments[0]?.text).toContain("Keep this open topic");
      return {
        text: JSON.stringify({
          topics: [],
          processed: [],
          discard: [input.fragments[0]!.id],
          publications: [],
        }),
      };
    });
    await run();
    await run();
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("archives a completed matter and appends a later dated addition without duplicating history", async () => {
    await append(
      "100",
      "Picnic delivered: the team met at Riverside and the event is complete.",
      "101",
    );
    complete.mockImplementationOnce(async ({ message }: { message: string }) => {
      const { plan } = planFor(message, "thread");
      plan.publications[0] = {
        ...plan.publications[0]!,
        kind: "archive",
        completed: true,
        content: "The team picnic was completed at Riverside.",
        reason: "Delivered event.",
      };
      return { text: JSON.stringify(plan) };
    });
    await run();
    const notebook = await readDreamFragmentNotebook(fixture.workspaceDir);
    const archivePath = notebook.artifacts?.[0]?.target;
    expect(archivePath).toContain("/Archive/");
    const original = await fs.readFile(path.join(fixture.workspaceDir, archivePath!), "utf8");
    await append("100", "After the event: all reimbursements are now settled.", "101");
    complete.mockImplementationOnce(async ({ message }: { message: string }) => {
      const { input, plan } = planFor(message, "thread");
      const existing = input.targets.find((target) =>
        target.content.includes("picnic was completed"),
      );
      expect(existing).toBeDefined();
      plan.publications[0] = {
        ...plan.publications[0]!,
        targetId: existing!.id,
        kind: "archive",
        completed: true,
        content: "All reimbursements are settled.",
        reason: "Completed financial follow-up.",
      };
      return { text: JSON.stringify(plan) };
    });
    await run();
    expect(api.logger.error).not.toHaveBeenCalled();
    const updated = await fs.readFile(path.join(fixture.workspaceDir, archivePath!), "utf8");
    expect(updated.startsWith(original)).toBe(true);
    expect(updated).toContain("All reimbursements are settled.");
    expect(
      new Set(
        (await readDreamFragmentNotebook(fixture.workspaceDir)).artifacts?.map(
          (artifact) => artifact.target,
        ),
      ).size,
    ).toBe(1);
    expect((await readDreamFragmentNotebook(fixture.workspaceDir)).artifacts).toHaveLength(2);
  });

  it("promotes across Threads and removes exact covered Channel Memory after Workspace publication", async () => {
    await append("100", "The team uses UTC for schedules.", "101");
    complete.mockImplementationOnce(async ({ message }: { message: string }) => {
      const { plan } = planFor(message, "channel");
      return { text: JSON.stringify(plan) };
    });
    await run();
    const channelPath = (await readDreamFragmentNotebook(fixture.workspaceDir)).artifacts![0]!
      .target;
    await append("100", "Confirmed in a second discussion: globally use UTC.", "102");
    complete.mockImplementationOnce(async ({ message }: { message: string }) => {
      const { input, plan } = planFor(message);
      expect(input.curated).toHaveLength(1);
      Object.assign(plan.publications[0]!, {
        sourceIds: [...plan.publications[0]!.sourceIds, ...input.curated[0]!.sourceIds],
        coveredEntries: [input.curated[0]!.id],
      });
      return { text: JSON.stringify(plan) };
    });
    await run();
    expect(api.logger.error).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(fixture.workspaceDir, channelPath), "utf8")).not.toContain(
      "Use UTC",
    );
    expect(
      await fs.readFile(path.join(fixture.workspaceDir, "memory/MEMORY.md"), "utf8"),
    ).toContain("Use UTC");
  });

  it("preserves an operator edit and pending plan before processing another group", async () => {
    fixture.cfg.channels!.discord!.guilds!["900"]!.channels!["200"]!.members = ["1", "3"];
    const source = await append("100", "Workspace convention: use UTC.", "101");
    const later = await append("200", "Group two uses ISO dates.", "201");
    const memoryPath = path.join(
      fixture.workspaceDir,
      path.dirname(source.relPath),
      "../MEMORY.md",
    );
    await fs.mkdir(path.dirname(memoryPath), { recursive: true });
    complete.mockImplementationOnce(async ({ message }: { message: string }) => {
      const { plan } = planFor(message, "thread");
      await fs.writeFile(memoryPath, "Operator-owned text.\n");
      return { text: JSON.stringify(plan) };
    });
    complete.mockImplementation(async ({ message }) => {
      const { plan } = planFor(message, "thread");
      plan.publications[0]!.content = "Group two uses ISO dates.";
      return { text: JSON.stringify(plan) };
    });
    await run();
    expect(await fs.readFile(memoryPath, "utf8")).toBe("Operator-owned text.\n");
    expect(await fs.readFile(path.join(fixture.workspaceDir, source.relPath), "utf8")).toContain(
      "use UTC",
    );
    const pending = (await readDreamFragmentNotebook(fixture.workspaceDir)).pending;
    expect(pending).toBeDefined();
    expect(await fs.readFile(path.join(fixture.workspaceDir, later.relPath), "utf8")).toContain(
      "ISO dates",
    );
    await run();
    expect((await readDreamFragmentNotebook(fixture.workspaceDir)).pending).toEqual(pending);
    expect(complete).toHaveBeenCalledTimes(1);
    await fs.writeFile(memoryPath, "");
    await run();
    expect(await fs.readFile(memoryPath, "utf8")).toContain("Use UTC");
    expect((await readDreamFragmentNotebook(fixture.workspaceDir)).pending).toBeUndefined();
    expect(
      (await readDreamFragmentSources(fixture.workspaceDir)).every((entry) => entry.processed),
    ).toBe(true);
    await run();
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("defers recovery when an uncited model input changed after planning", async () => {
    const first = await append("100", "Use UTC for schedules.", "101");
    const second = await append("200", "An exception needs further discussion.", "201");
    const memoryPath = path.join(fixture.workspaceDir, path.dirname(first.relPath), "../MEMORY.md");
    await fs.mkdir(path.dirname(memoryPath), { recursive: true });
    complete.mockImplementationOnce(async ({ message }) => {
      const { input, plan } = planFor(message, "thread");
      expect(input.fragments).toHaveLength(2);
      const id = input.fragments.find((item) => item.text.includes("Use UTC"))!.id;
      plan.processed = [id];
      plan.publications[0]!.sourceIds = [id];
      plan.publications[0]!.coveredSourceIds = [id];
      await fs.writeFile(memoryPath, "Operator-owned text.\n");
      return { text: JSON.stringify(plan) };
    });
    await run();
    const pending = (await readDreamFragmentNotebook(fixture.workspaceDir)).pending;
    expect(pending).toBeDefined();
    await fs.writeFile(
      path.join(fixture.workspaceDir, second.relPath),
      "The uncited exception changed.\n",
    );
    await fs.writeFile(memoryPath, "");
    await run();
    expect(await fs.readFile(memoryPath, "utf8")).toBe("");
    expect((await readDreamFragmentNotebook(fixture.workspaceDir)).pending).toEqual(pending);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("preserves sources when an older pending plan has citations but no cleanup coverage", async () => {
    const source = await append("100", "Use UTC; the travel plan is still unresolved.", "101");
    const memoryPath = path.join(
      fixture.workspaceDir,
      path.dirname(source.relPath),
      "../MEMORY.md",
    );
    await fs.mkdir(path.dirname(memoryPath), { recursive: true });
    complete.mockImplementationOnce(async ({ message }) => {
      const { plan } = planFor(message, "thread");
      await fs.writeFile(memoryPath, "Operator-owned text.\n");
      return { text: JSON.stringify(plan) };
    });
    await run();
    const notebook = await readDreamFragmentNotebook(fixture.workspaceDir);
    expect(notebook.pending).toBeDefined();
    delete notebook.pending!.discard;
    for (const publication of notebook.pending!.publications) {
      delete publication.coveredSourceIds;
    }
    await fragmentState.writeDreamFragmentNotebook(fixture.workspaceDir, notebook);
    await fs.writeFile(memoryPath, "");
    await run();
    expect(api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("lacks complete source coverage"),
    );
    expect(await fs.readFile(memoryPath, "utf8")).toBe("");
    expect(await fs.readFile(path.join(fixture.workspaceDir, source.relPath), "utf8")).toContain(
      "travel plan is still unresolved",
    );
    expect((await readDreamFragmentSources(fixture.workspaceDir))[0]!.processed).not.toBe(true);
    expect((await readDreamFragmentNotebook(fixture.workspaceDir)).pending).toEqual(
      notebook.pending,
    );
    expect(complete).toHaveBeenCalledOnce();
  });

  it("resumes discarded Fragment cleanup after the progress write fails", async () => {
    const source = await append("100", "Discard this temporary reminder.", "101");
    const writeSource = fragmentState.writeDreamFragmentSource;
    complete.mockImplementationOnce(async ({ message }) => {
      const { input } = planFor(message);
      vi.spyOn(fragmentState, "writeDreamFragmentSource").mockImplementationOnce(async () => {
        throw new Error("Progress store unavailable after cleanup");
      });
      return {
        text: JSON.stringify({
          topics: [],
          processed: [],
          discard: [input.fragments[0]!.id],
          publications: [],
        }),
      };
    });
    await run();
    expect(api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Progress store unavailable after cleanup"),
    );
    expect(
      await fs.readFile(path.join(fixture.workspaceDir, source.relPath), "utf8"),
    ).not.toContain("Discard this temporary reminder.");
    expect((await readDreamFragmentNotebook(fixture.workspaceDir)).pending).toBeDefined();
    vi.mocked(fragmentState.writeDreamFragmentSource).mockImplementation(writeSource);
    await run();
    expect((await readDreamFragmentNotebook(fixture.workspaceDir)).pending).toBeUndefined();
    expect((await readDreamFragmentSources(fixture.workspaceDir))[0]?.processed).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it.each(["publication", "cleanup"])(
    "preserves the preimage when Dream stops during %s staging",
    async (operation) => {
      const source = await append("100", "Use UTC for shared schedules.", "101");
      const sourcePath = path.join(fixture.workspaceDir, source.relPath);
      const original = await fs.readFile(sourcePath, "utf8");
      const memoryPath = path.join(fixture.workspaceDir, "memory/MEMORY.md");
      const open = fs.open.bind(fs);
      let revoked = false;
      complete.mockImplementationOnce(async ({ message }) => {
        const { plan } = planFor(message);
        vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
          const handle = await open(target, flags, mode);
          const prefix =
            operation === "publication" ? ".openclaw-dream-." : ".openclaw-dream-clean-.";
          if (typeof target === "string" && path.basename(target).startsWith(prefix)) {
            revoked = true;
            fixture.cfg.plugins!.entries!["memory-core"]!.config = {
              dreaming: { enabled: false },
            };
          }
          return handle;
        });
        return { text: JSON.stringify(plan) };
      });
      await run();
      expect(revoked).toBe(true);
      expect(await fs.readFile(sourcePath, "utf8")).toBe(original);
      expect((await readDreamFragmentNotebook(fixture.workspaceDir)).pending).toBeDefined();
      if (operation === "publication") {
        await expect(fs.readFile(memoryPath)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await fs.readFile(memoryPath, "utf8")).toContain("Use UTC");
      }
      expect(complete).toHaveBeenCalledOnce();
    },
  );

  it.each(["invalid plan", "inference rejection"])(
    "processes an independent group after %s and retries only the deferred group",
    async (failure) => {
      fixture.cfg.channels!.discord!.guilds!["900"]!.channels!["200"]!.members = ["1", "3"];
      const deferred = await append("100", "Group one uses UTC.", "101");
      const healthy = await append("200", "Group two uses ISO dates.", "201");
      const deferredPath = path.join(fixture.workspaceDir, deferred.relPath);
      const original = await fs.readFile(deferredPath, "utf8");
      complete.mockImplementationOnce(async ({ message }) => {
        const { input, plan } = planFor(message, "thread");
        expect(input.fragments[0]?.text).toContain("Group one");
        if (failure === "inference rejection") {
          throw new Error("Inference temporarily unavailable");
        }
        plan.processed = ["outside-admitted-evidence"];
        return { text: JSON.stringify(plan) };
      });
      complete.mockImplementation(async ({ message }) => {
        const { input, plan } = planFor(message, "thread");
        plan.publications[0]!.content = input.fragments[0]!.text;
        return { text: JSON.stringify(plan) };
      });
      await run();
      expect(complete).toHaveBeenCalledTimes(2);
      expect(api.logger.error).not.toHaveBeenCalled();
      expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("retry next pass"));
      expect(await fs.readFile(deferredPath, "utf8")).toBe(original);
      const sources = await readDreamFragmentSources(fixture.workspaceDir);
      expect(sources.find((entry) => entry.sessionId === deferred.sessionId)?.processed).not.toBe(
        true,
      );
      expect(sources.find((entry) => entry.sessionId === healthy.sessionId)?.processed).toBe(true);
      const healthyMemoryPath = path.join(
        fixture.workspaceDir,
        path.dirname(healthy.relPath),
        "../MEMORY.md",
      );
      const healthyMemory = await fs.readFile(healthyMemoryPath, "utf8");
      expect(healthyMemory).toContain("Group two uses ISO dates.");
      await run();
      expect(complete).toHaveBeenCalledTimes(3);
      expect(
        (await readDreamFragmentSources(fixture.workspaceDir)).every((entry) => entry.processed),
      ).toBe(true);
      expect(
        await fs.readFile(
          path.join(fixture.workspaceDir, path.dirname(deferred.relPath), "../MEMORY.md"),
          "utf8",
        ),
      ).toContain("Group one uses UTC.");
      expect(await fs.readFile(healthyMemoryPath, "utf8")).toBe(healthyMemory);
    },
  );

  it.each([
    "membership changes",
    "Discord is disabled",
    "account is disabled",
    "source workspace changes",
    "session store changes",
    "Dream is disabled",
  ])("defers publication after %s during analysis", async (change) => {
    const discord = fixture.cfg.channels!.discord!;
    discord.guilds!["900"]!.channels!["200"]!.members = ["1", "3"];
    const source = await append("100", "Group convention: use UTC.", "101");
    if (change === "Dream is disabled") {
      await append("200", "Another group must not run after Dream stops.", "201");
    }
    complete.mockImplementationOnce(async ({ message }: { message: string }) => {
      const { plan } = planFor(message, "thread");
      if (change === "membership changes") {
        discord.guilds!["900"]!.channels!["100"]!.members = ["1", "3"];
      } else if (change === "Discord is disabled") {
        discord.enabled = false;
      } else if (change === "account is disabled") {
        discord.accounts = { default: { enabled: false } };
      } else if (change === "source workspace changes") {
        fixture.cfg.agents!.defaults!.workspace = path.join(fixture.workspaceDir, "moved");
      } else if (change === "Dream is disabled") {
        fixture.cfg.plugins!.entries!["memory-core"]!.config = { dreaming: { enabled: false } };
      } else {
        fixture.cfg.session = { store: path.join(fixture.stateDir, "other-sessions.json") };
      }
      return { text: JSON.stringify(plan) };
    });
    await run();
    if (change === "Dream is disabled") {
      expect(api.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Dream was disabled during the sweep"),
      );
    } else if (change === "session store changes") {
      expect(api.logger.error).toHaveBeenCalled();
    } else {
      expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("retry next pass"));
      expect(api.logger.error).not.toHaveBeenCalled();
    }
    expect(complete).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(fixture.workspaceDir, source.relPath), "utf8")).toContain(
      "use UTC",
    );
    await expect(
      fs.readFile(path.join(fixture.workspaceDir, path.dirname(source.relPath), "../MEMORY.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps separate group notebooks and never routes scoped recall through Workspace promotion", async () => {
    fixture.cfg.channels!.discord!.guilds!["900"]!.channels!["200"]!.members = ["1", "3"];
    const first = await append("100", "Group one has an unfinished venue decision.", "101");
    await append("200", "Group two has an unfinished budget decision.", "201");
    complete.mockImplementation(async ({ message }: { message: string }) => {
      const { input } = planFor(message, "thread");
      expect(input.fragments).toHaveLength(1);
      expect(input.targets.some((target) => target.scope === "workspace")).toBe(false);
      const id = input.fragments[0]!.id;
      return {
        text: JSON.stringify({
          topics: [{ text: input.fragments[0]!.text, sourceIds: [id] }],
          processed: [id],
          discard: [],
          publications: [],
        }),
      };
    });
    await run();
    expect(api.logger.error).not.toHaveBeenCalled();
    expect((await readDreamFragmentNotebook(fixture.workspaceDir)).topics).toHaveLength(2);
    for (let index = 0; index < 4; index++) {
      await recordShortTermRecalls({
        workspaceDir: fixture.workspaceDir,
        query: `venue ${index}`,
        results: [first.relPath, path.join(fixture.workspaceDir, first.relPath)].map(
          (filePath) => ({
            path: filePath,
            startLine: 1,
            endLine: 4,
            score: 1,
            snippet: "Group one has an unfinished venue decision.",
            source: "memory" as const,
          }),
        ),
      });
    }
    expect(
      await rankShortTermPromotionCandidates({
        workspaceDir: fixture.workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      }),
    ).toEqual([]);
  });

  it("does not run legacy Dream reports after scoped Dream admission", async () => {
    const source = await append("100", "Keep the picnic venue decision open.", "101");
    fixture.cfg.plugins!.entries!["memory-core"]!.config = {
      dreaming: {
        enabled: true,
        phases: {
          light: { enabled: false },
          rem: { enabled: false },
          deep: { minScore: 0, minRecallCount: 1, minUniqueQueries: 1 },
        },
      },
    };
    const relativePath = "memory/2026-10-26.md";
    const snippet = "Legacy transcript rule: every venue decision is globally final.";
    await fs.writeFile(path.join(fixture.workspaceDir, relativePath), snippet);
    await recordShortTermRecalls({
      workspaceDir: fixture.workspaceDir,
      query: "venue decisions",
      results: [
        {
          path: relativePath,
          startLine: 1,
          endLine: 1,
          score: 1,
          snippet,
          source: "memory",
          provenance: { originClass: "owner", sessionKind: "interactive", observedAt: 0 },
        },
      ],
    });
    expect(
      await rankShortTermPromotionCandidates({
        workspaceDir: fixture.workspaceDir,
        minScore: 0,
        minRecallCount: 1,
        minUniqueQueries: 1,
      }),
    ).toHaveLength(1);
    complete.mockImplementation(async ({ message }) => {
      const { input } = planFor(message, "thread");
      return {
        text: JSON.stringify({
          topics: [{ text: "Venue undecided.", sourceIds: [input.fragments[0]!.id] }],
          processed: [input.fragments[0]!.id],
          discard: [],
          publications: [],
        }),
      };
    });
    await run();
    expect(complete).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(fixture.workspaceDir, source.relPath), "utf8")).toContain(
      "Keep the picnic venue decision open.",
    );
    await expect(
      fs.readFile(path.join(fixture.workspaceDir, "memory/MEMORY.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(fixture.workspaceDir, "DREAMS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
