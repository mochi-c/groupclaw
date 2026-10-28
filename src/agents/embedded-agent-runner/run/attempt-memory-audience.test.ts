import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../../../plugins/runtime.js";

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

// mock-isolation: The fixture's committed rows own generations; real SQLite leases would use unrelated state.
vi.mock("../../../config/sessions/session-delivery-generation.js", async () => {
  const { fakeSessionGenerationModule } =
    await import("../../../plugins/memory-audience.test-support.js");
  return fakeSessionGenerationModule;
});
// mock-isolation: Read the same fixture-owned rows as the generation owner, without starting SQLite workers.
vi.mock("../../../config/sessions/session-entry-read-runtime.js", async () => {
  const { fakeSessionEntryReadModule } =
    await import("../../../plugins/memory-audience.test-support.js");
  return fakeSessionEntryReadModule;
});
vi.mock("../logger.js", () => ({ log: { warn: mocks.warn, debug: vi.fn() } }));

import {
  assertMemoryAudienceCurrent,
  assertMemoryAudienceSession,
} from "../../../plugins/memory-audience.js";
import { fakeSessionOwner } from "../../../plugins/memory-audience.test-support.js";
import { resolveEmbeddedAttemptMemoryAudience } from "./attempt-memory-audience.js";

const attempt = {
  agentId: "main",
  sessionKey: "agent:main:channel:planning",
  sessionId: randomUUID(),
  senderIsOwner: false,
};
const entry = {
  sessionId: attempt.sessionId,
  updatedAt: 1,
  chatType: "channel" as const,
  origin: { provider: "discord", to: "channel:planning", nativeChannelId: "planning" },
};
const admission = { entry, storePath: "/tmp/main.sqlite" };

describe("embedded attempt memory audience", () => {
  beforeEach(() => {
    fakeSessionOwner.reset();
    mocks.warn.mockReset();
    fakeSessionOwner.rows.set(attempt.sessionKey, entry);
  });

  afterEach(async () => {
    await clearActivePluginRegistry();
  });

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

  it("admits current conversation memory for an opted-in file-backed runtime", async () => {
    selectMemoryRuntime(true);
    const resolved = await resolveEmbeddedAttemptMemoryAudience({ ...attempt, admission });
    try {
      expect(resolved.memoryAudience?.context?.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ layer: "workspace", relativePath: "memory/MEMORY.md" }),
          expect.objectContaining({ layer: "channel" }),
        ]),
      );
      expect(resolved.memoryAudience?.context?.fragment?.scope.kind).toBe("channel");
      assertMemoryAudienceSession(resolved.memoryAudience!, attempt.sessionKey);
      assertMemoryAudienceCurrent(resolved.memoryAudience!);
    } finally {
      resolved.release();
    }
    expect(() => assertMemoryAudienceCurrent(resolved.memoryAudience!)).toThrow("released");
  });

  it("resolves no audience, lineage, or leases for a legacy memory owner", async () => {
    selectMemoryRuntime();
    const resolved = await resolveEmbeddedAttemptMemoryAudience({ ...attempt, admission });

    expect(resolved.memoryAudience).toBeUndefined();
    expect(fakeSessionOwner.activeLeases).toBe(0);
    expect(fakeSessionOwner.workerReads).toHaveLength(0);
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
