import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withinTest } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { replaceTranscriptEvents } from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { registerInternalHook, unregisterInternalHook } from "../../internal-hooks.js";
import { emitSessionAutoResetHook } from "../../session-auto-reset.js";
import handler, { flushSessionMemoryWritesForTest } from "./handler.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session-memory automatic reset", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-session-memory-auto-");
  });

  afterEach(async () => {
    await flushSessionMemoryWritesForTest();
  });

  it.for(["daily", "idle"] as const)(
    "preserves the departing Thread identity through automatic %s reset dispatch",
    async (reason, { signal }) => {
      const sessionKey = "agent:main:discord:channel:101";
      const sessionId = `${reason}-session`;
      const storePath = path.join(tempDir, "sessions.json");
      const cfg = {
        agents: { defaults: { workspace: tempDir } },
        session: { store: storePath },
      } satisfies OpenClawConfig;
      await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
        {
          type: "message",
          id: `${reason}-user`,
          parentId: null,
          message: {
            role: "user",
            content: `Remember the ${reason} rollover`,
            __openclaw: { senderIsOwner: true },
          },
        },
        {
          type: "message",
          id: `${reason}-assistant`,
          parentId: `${reason}-user`,
          message: { role: "assistant", content: "Captured automatically" },
        },
      ]);
      const sessionEntry: SessionEntry = {
        sessionId,
        updatedAt: 1,
        chatType: "channel",
        delivery: {
          kind: "external",
          route: { channel: "discord", target: { to: "channel:101" } },
          context: { channel: "discord", to: "channel:101" },
          origin: {
            provider: "discord",
            nativeChannelId: "101",
            nativeParentChannelId: "100",
            threadId: "101",
          },
        },
      };
      const finished = createDeferredCore();
      const listener: typeof handler = async (event) => {
        try {
          await handler(event);
        } finally {
          finished.resolve();
        }
      };
      registerInternalHook("session:auto-reset", listener);
      try {
        emitSessionAutoResetHook({
          cfg,
          agentId: "main",
          workspaceDir: tempDir,
          storePath,
          sessionKey,
          sessionEntry,
          reason,
        });
        await withinTest(finished.promise, signal);
      } finally {
        unregisterInternalHook("session:auto-reset", listener);
      }

      const memoryDir = path.join(tempDir, "memory");
      const files = (await fs.readdir(memoryDir, { recursive: true }))
        .filter((file) => file.endsWith(".md"))
        .map((file) => file.replaceAll(path.sep, "/"));
      const memoryContent = await fs.readFile(
        path.join(memoryDir, expectDefined(files[0], "files[0] test invariant")),
        "utf8",
      );
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(
        /^Channel\/id-[a-f0-9]{64}\/Thread\/id-[a-f0-9]{64}\/Event\/.*\.md$/,
      );
      expect(memoryContent).toContain("eventType: session.rollover");
      expect(memoryContent).toContain(`- **Reason**: ${reason}`);
      expect(memoryContent).toContain(`user: ${JSON.stringify(`Remember the ${reason} rollover`)}`);
      expect(memoryContent).toContain(`assistant: ${JSON.stringify("Captured automatically")}`);
    },
  );
});
