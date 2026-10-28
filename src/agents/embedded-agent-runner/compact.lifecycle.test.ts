import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createSandboxTestContext } from "../sandbox/test-fixtures.js";
import { useCompactHooksSessionFixture } from "./compact.hooks.fixture.test-support.js";
import {
  hookRunner,
  loadCompactHooksHarness,
  resolveSandboxContextMock,
} from "./compact.hooks.harness.js";

const sessionKey = "agent:main:discord:channel:101";
const fixture = useCompactHooksSessionFixture(sessionKey);
let compact: typeof import("./compact.js").compactEmbeddedAgentSessionDirect;
let hooks: typeof import("../../hooks/internal-hooks.js");
let memory: typeof import("../../hooks/bundled/session-memory/handler.js");
let dateTime: typeof import("../date-time.js");
let storePath: string;
let source: Awaited<ReturnType<typeof fixture.prepareSession>>;

beforeAll(async () => {
  compact = (await loadCompactHooksHarness()).compactEmbeddedAgentSessionDirect;
  hooks = await import("../../hooks/internal-hooks.js");
  memory = await import("../../hooks/bundled/session-memory/handler.js");
  dateTime = await import("../date-time.js");
  storePath = await fixture.prepare();
});

beforeEach(async () => {
  source = await fixture.prepareSession();
  vi.mocked(dateTime.resolveUserTimezone).mockReturnValue("UTC");
  const actual = await vi.importActual<typeof hooks>("../../hooks/internal-hooks.js");
  vi.mocked(hooks.triggerInternalHook).mockImplementation(actual.triggerInternalHook);
  hooks.registerInternalHook("session:compacted", memory.default);
});

afterEach(() => {
  hooks.unregisterInternalHook("session:compacted", memory.default);
});

describe("direct compaction lifecycle memory", () => {
  it.each(["ro", "none", "rw"] as const)(
    "retains Thread evidence in the source Workspace with %s sandbox access",
    async (workspaceAccess) => {
      const sandboxDir = fixture.makeTempDir("openclaw-compaction-sandbox-");
      resolveSandboxContextMock.mockResolvedValue(
        createSandboxTestContext({
          overrides: {
            sessionKey,
            workspaceAccess,
            workspaceDir: sandboxDir,
            agentWorkspaceDir: source.workspaceDir,
          },
        }),
      );
      hookRunner.hasHooks.mockReturnValue(true);
      const sessionEntry: SessionEntry = {
        sessionId: source.sessionId,
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
      const sessionTarget = { agentId: "main", sessionId: source.sessionId, sessionKey, storePath };
      await upsertSessionEntryCore(sessionTarget, sessionEntry);
      const result = await compact({
        agentId: "main",
        sessionId: source.sessionId,
        sessionKey,
        sessionEntry,
        sessionFile: sessionKey,
        sessionTarget,
        workspaceDir: source.workspaceDir,
      });
      expect(result).toMatchObject({ ok: true, compacted: true });
      const files = (
        await readdir(join(source.workspaceDir, "memory"), { recursive: true })
      ).filter((file) => file.endsWith(".md"));
      expect(files).toHaveLength(1);
      const file = expectDefined(files[0], "compaction Event");
      expect(file).toMatch(/^Channel\/[^/]+\/Thread\/[^/]+\/Event\//);
      const content = await readFile(join(source.workspaceDir, "memory", file), "utf8");
      expect(content).toContain("eventType: session.compacted");
      expect(content).toContain(`sessionId: ${JSON.stringify(source.sessionId)}`);
      expect(content).toContain('user: "hello"');
      await expect(access(join(sandboxDir, "memory"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(hookRunner.runAfterCompaction).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          workspaceDir: workspaceAccess === "rw" ? source.workspaceDir : sandboxDir,
        }),
      );
    },
  );
});
