import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-plugin-common";
import type { OpenClawPluginApi, OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildSessionEndHookPayload } from "../auto-reply/reply/session-hooks.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createClosedSessionTranscriptSource } from "../gateway/session-end-transcript-reader.js";
import { listDirectoryTreeStrict } from "../infra/directory-walk.js";
import { MEMORY_DREAMING_SYSTEM_EVENT_TEXT } from "../memory-host-sdk/dreaming.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createHookRunner } from "./hooks.js";
import { addTestHook } from "./hooks.test-helpers.js";
import { registerMemoryCapability } from "./memory-state.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import type { PluginHookHandlerMap } from "./types.js";

let fixture: OpenClawTestState & { cfg: OpenClawConfig };
let stop: (() => Promise<void>) | undefined;

beforeEach(async () => {
  const state = await createOpenClawTestState({
    prefix: "openclaw-ended-memory-",
    layout: "state-only",
  });
  fixture = {
    ...state,
    cfg: {
      agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
    },
  };
  await fs.mkdir(path.join(fixture.workspaceDir, "memory"), { recursive: true });
});

afterEach(async () => {
  await stop?.();
  stop = undefined;
  clearRuntimeConfigSnapshot();
  await fixture.restoreEnv();
  resetPluginStateStoreForTests();
  await fixture.cleanup();
  resetPluginRuntimeStateForTest();
});

it.each([true, false])(
  "captures an ended native tail and admits Dream only with conversation access (%s)",
  async (conversationAccessAllowed) => {
    const member = (id: string) => ({
      identity: {
        type: "remote" as const,
        pluginId: "discord",
        domain: "discord",
        idKind: "user",
        id,
      },
      label: id,
    });
    const channel: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "discord" }),
      groups: {
        resolveMemoryPolicy: () => ({
          channelMemory: "include",
          group: {
            members: [member("1"), member("2")],
            key: "family",
            workspaceShared: true,
            consolidationAllowed: true,
          },
        }),
      },
    };
    const registry = createTestRegistry([{ pluginId: "discord", source: "test", plugin: channel }]);
    setActivePluginRegistry(registry);
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
    setRuntimeConfigSnapshot(fixture.cfg);
    const complete = vi.fn<OpenClawPluginApi["runtime"]["subagent"]["complete"]>(
      async ({ message }) => {
        const input = JSON.parse(message) as {
          fragments: Array<{ id: string; kind: string; text: string }>;
          targets: Array<{ id: string; scope: string }>;
        };
        expect(input.fragments).toHaveLength(1);
        expect(input.fragments[0]).toMatchObject({
          kind: "event",
          text: expect.stringContaining("Use UTC for shared schedules."),
        });
        return {
          text: JSON.stringify({
            topics: [],
            processed: [],
            discard: [],
            publications: [
              {
                targetId: input.targets.find((target) => target.scope === "workspace")!.id,
                kind: "memory",
                sourceIds: [input.fragments[0]!.id],
                content: "Use UTC for shared schedules.",
                reason: "Explicit shared convention.",
                completed: false,
              },
            ],
          }),
        };
      },
    );
    const on = vi.fn();
    const registerCli = vi.fn<OpenClawPluginApi["registerCli"]>();
    let service:
      | Parameters<ReturnType<typeof createTestPluginApi>["registerService"]>[0]
      | undefined;
    const api = createTestPluginApi({
      id: "memory-core",
      config: fixture.cfg,
      on,
      registerCli,
      registerService: (registered) => {
        if (registered.id === "memory-core-dreaming") {
          service = registered;
        }
      },
      registerMemoryCapability: (capability) => registerMemoryCapability("memory-core", capability),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    Object.assign(api.runtime, {
      agent: createPluginRuntimeMock().agent,
      config: { current: () => fixture.cfg },
      subagent: { complete },
      state: {
        openKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
          createPluginStateKeyedStoreForTests<T>("memory-core", options),
      },
    });
    const { default: memoryPlugin } = await loadBundledPluginFacade<{
      default: OpenClawPluginDefinition;
    }>({ pluginId: "memory-core", artifactBasename: "index.js" });
    memoryPlugin.register?.(api);
    const scheduler = createTestPluginServiceScheduler();
    const serviceContext = {
      config: fixture.cfg,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      logger: api.logger,
      scheduler,
      getCron: () => undefined,
    };
    await service?.start(serviceContext);
    stop = async () => {
      await service?.stop?.(serviceContext);
      await scheduler.stop();
    };
    const endedHandler = on.mock.calls.find(
      ([name]) => name === "session_end",
    )?.[1] as PluginHookHandlerMap["session_end"];
    addTestHook({
      registry,
      hookName: "session_end",
      pluginId: "memory-core",
      handler: endedHandler,
      ...(conversationAccessAllowed ? { conversationAccessAllowed: true } : {}),
    });
    const sessionId = randomUUID();
    const sessionKey = "agent:main:discord:channel:101";
    const storePath = resolveSessionStorePathCore(fixture.cfg.session?.store, { agentId: "main" });
    const entry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      chatType: "channel",
      participants: [member("1")],
      delivery: {
        kind: "external",
        route: { channel: "discord", target: { to: "channel:101" }, thread: { id: "101" } },
        context: { channel: "discord", to: "channel:101", threadId: "101" },
        origin: {
          provider: "discord",
          nativeChannelId: "101",
          nativeParentChannelId: "100",
          threadId: "101",
          nativeThreadVisibility: "public",
        },
      },
    };
    const scope = { agentId: "main", sessionKey, sessionId, storePath };
    await patchSessionEntryCore(scope, () => entry, {
      fallbackEntry: entry,
      replaceEntry: true,
      skipMaintenance: true,
    });
    await replaceTranscriptEvents(scope, [
      {
        type: "message",
        id: "utc",
        parentId: null,
        message: {
          role: "user",
          content: "Use UTC for shared schedules.",
        },
      },
    ]);
    const payload = buildSessionEndHookPayload({
      agentId: "main",
      sessionKey,
      sessionId,
      sessionEntry: entry,
      reason: "reset",
      endedTranscript: createClosedSessionTranscriptSource(scope),
    });
    await patchSessionEntryCore(scope, () => ({ ...entry, sessionId: randomUUID() }), {
      skipMaintenance: true,
    });
    await createHookRunner(registry).runSessionEnd(payload.event, payload.context);
    expect(api.logger.warn).not.toHaveBeenCalled();
    const memoryDir = path.join(fixture.workspaceDir, "memory");
    const eventFiles = (await listDirectoryTreeStrict(memoryDir))
      .filter(
        ({ dirent, relativePath }) =>
          dirent.isFile() &&
          relativePath.split(path.sep).includes("Event") &&
          relativePath.endsWith(".md"),
      )
      .map(({ relativePath }) => relativePath);
    expect(eventFiles).toHaveLength(conversationAccessAllowed ? 1 : 0);
    if (!conversationAccessAllowed) {
      expect(complete).not.toHaveBeenCalled();
      return;
    }
    const eventPath = path.join(memoryDir, eventFiles[0]!);
    const eventContent = await fs.readFile(eventPath, "utf8");
    expect(eventContent).toContain(sessionId);
    const program = new Command();
    for (const [register] of registerCli.mock.calls) {
      await register({
        program,
        parentPath: [],
        config: fixture.cfg,
        workspaceDir: fixture.workspaceDir,
        logger: api.logger,
      });
    }
    const forget = () =>
      program.parseAsync(
        ["memory", "forget", "--session", sessionId, "--agent", "main", "--json"],
        { from: "user" },
      );
    const dream = on.mock.calls.find(
      ([name]) => name === "before_agent_reply",
    )?.[1] as PluginHookHandlerMap["before_agent_reply"];
    await fs.writeFile(eventPath, eventContent.replace("Use UTC", "Use local time"));
    await dream(
      { cleanedBody: MEMORY_DREAMING_SYSTEM_EVENT_TEXT },
      { trigger: "cron", agentId: "main", workspaceDir: fixture.workspaceDir },
    );
    expect(complete).not.toHaveBeenCalled();
    await expect(forget()).rejects.toThrow("changed after capture");
    expect(await fs.readFile(eventPath, "utf8")).toContain("Use local time");
    await fs.writeFile(eventPath, eventContent);
    await dream(
      { cleanedBody: MEMORY_DREAMING_SYSTEM_EVENT_TEXT },
      { trigger: "cron", agentId: "main", workspaceDir: fixture.workspaceDir },
    );
    expect(api.logger.error).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    expect(
      await fs.readFile(path.join(fixture.workspaceDir, "memory/MEMORY.md"), "utf8"),
    ).toContain("Use UTC for shared schedules.");
    expect(await fs.readFile(eventPath, "utf8")).toBe(eventContent);
    await forget();
    expect(
      await fs.readFile(path.join(fixture.workspaceDir, "memory/MEMORY.md"), "utf8"),
    ).not.toContain("Use UTC for shared schedules.");
    await expect(fs.readFile(eventPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    complete.mockClear();
    await createHookRunner(registry).runSessionEnd(payload.event, payload.context);
    await dream(
      { cleanedBody: MEMORY_DREAMING_SYSTEM_EVENT_TEXT },
      { trigger: "cron", agentId: "main", workspaceDir: fixture.workspaceDir },
    );
    expect(complete).not.toHaveBeenCalled();
  },
);
