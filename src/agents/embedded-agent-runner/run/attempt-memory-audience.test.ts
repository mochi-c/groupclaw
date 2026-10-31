import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../../../plugins/runtime.js";

const { fakeSessionOwner, fakeSessionGenerationModule, fakeSessionEntryReadModule } =
  await vi.hoisted(() => import("../../../plugins/memory-audience.test-support.js"));

const mocks = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));

// mock-isolation: the fake session owner replaces SQLite generation facts.
vi.mock(
  "../../../config/sessions/session-delivery-generation.js",
  () => fakeSessionGenerationModule,
);
// mock-isolation: the fake session owner replaces worker-thread session reads.
vi.mock("../../../config/sessions/session-entry-read-runtime.js", () => fakeSessionEntryReadModule);
// mock-isolation: captures the attempt's log levels without emitting them.
vi.mock("../logger.js", () => ({ log: { warn: mocks.warn, info: mocks.info, debug: vi.fn() } }));

import {
  assertMemoryAudienceCurrent,
  assertMemoryAudienceSession,
} from "../../../plugins/memory-audience.js";
import { resolveEmbeddedAttemptMemoryAudience } from "./attempt-memory-audience.js";

const ROOT_KEY = "agent:main:root";
const CHILD_KEY = "agent:main:subagent:child";
const STORE_PATH = "/tmp/openclaw-attempt-memory-audience/main.sqlite";
const entry = () => ({ sessionId: randomUUID(), lifecycleRevision: randomUUID(), updatedAt: 1 });

const attempt = {
  agentId: "main",
  sessionKey: CHILD_KEY,
  sessionId: "child-session",
  run: { senderIsOwner: false },
  admission: { entry: { sessionId: "child-session", updatedAt: 1 }, storePath: STORE_PATH },
};

function selectMemoryRuntime(supportsMemoryAudience?: true) {
  const registry = createEmptyPluginRegistry();
  registry.memoryCapabilities.push({
    pluginId: "memory",
    memorySlotSelected: true,
    capability: {
      runtime: {
        getMemorySearchManager: async () => ({ manager: null }),
        resolveMemoryBackendConfig: () => ({ backend: "builtin" }),
        ...(supportsMemoryAudience ? { supportsMemoryAudience } : {}),
      },
    },
  });
  setActivePluginRegistry(registry);
}

// A spawned child whose receipt names its parent's incarnation at spawn time.
function spawnedChildAttempt(kind: "stale" | "unverified") {
  selectMemoryRuntime(true);
  const parent = { ...entry(), chatType: "direct" as const };
  const child = {
    ...entry(),
    spawnedBy: ROOT_KEY,
    parentSessionKey: ROOT_KEY,
    spawnedBySessionId: parent.sessionId,
    parentSessionLifecycleRevision: parent.lifecycleRevision,
    spawnedBySenderIsOwner: true,
  };
  fakeSessionOwner.rows.set(ROOT_KEY, parent);
  fakeSessionOwner.rows.set(CHILD_KEY, child);
  if (kind === "stale") {
    fakeSessionOwner.rows.set(ROOT_KEY, { ...parent, lifecycleRevision: randomUUID() });
  } else {
    fakeSessionOwner.pendingKeys.add(ROOT_KEY);
  }
  return {
    ...attempt,
    sessionId: child.sessionId,
    admission: { entry: child, storePath: STORE_PATH },
  };
}

beforeEach(() => {
  selectMemoryRuntime();
  mocks.warn.mockReset();
  mocks.info.mockReset();
  fakeSessionOwner.reset();
});

afterEach(async () => {
  await clearActivePluginRegistry();
});

it("admits current conversation memory for an opted-in file-backed runtime", async () => {
  selectMemoryRuntime(true);
  const sessionKey = "agent:main:channel:planning";
  const currentEntry = {
    ...entry(),
    chatType: "channel" as const,
    origin: { provider: "discord", to: "channel:planning", nativeChannelId: "planning" },
  };
  fakeSessionOwner.rows.set(sessionKey, currentEntry);
  const resolved = await resolveEmbeddedAttemptMemoryAudience({
    agentId: "main",
    sessionKey,
    sessionId: currentEntry.sessionId,
    run: { senderIsOwner: false },
    admission: { entry: currentEntry, storePath: STORE_PATH },
  });
  try {
    expect(resolved.memoryAudience?.context?.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layer: "workspace", relativePath: "memory/MEMORY.md" }),
        expect.objectContaining({ layer: "channel" }),
      ]),
    );
    expect(resolved.memoryAudience?.context?.fragment?.scope.kind).toBe("channel");
    assertMemoryAudienceSession(resolved.memoryAudience!, sessionKey);
    assertMemoryAudienceCurrent(resolved.memoryAudience!);
  } finally {
    resolved.release();
  }
  expect(() => assertMemoryAudienceCurrent(resolved.memoryAudience!)).toThrow("released");
});

it.each(["legacy", "stale", "unverified"] as const)(
  "denies %s lineage with the appropriate repair log",
  async (kind) => {
    const params = kind === "legacy" ? attempt : spawnedChildAttempt(kind);
    const resolved = await resolveEmbeddedAttemptMemoryAudience(params);
    expect(resolved.memoryAudience).toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledTimes(kind === "stale" ? 1 : 0);
    if (kind === "stale") {
      const [message] = mocks.warn.mock.calls[0] as [string];
      expect(message).toContain(`session ${CHILD_KEY} has stale lineage`);
      expect(message).toContain("Respawn or recreate it from a current session");
    }
    if (kind === "legacy") {
      expect(fakeSessionOwner.workerReads).toEqual([]);
    }
    if (kind !== "stale") {
      expect(fakeSessionOwner.activeLeases).toBe(0);
    }
    if (kind === "unverified") {
      expect(mocks.info).toHaveBeenCalledWith(
        expect.stringContaining("could not be verified"),
        expect.objectContaining({ kind: "unverified", sessionKey: CHILD_KEY }),
      );
    }
  },
);
