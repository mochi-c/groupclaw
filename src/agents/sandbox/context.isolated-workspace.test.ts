import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveMemoryAudienceFromEntry } from "../../plugins/memory-audience.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveAttemptWorkspaceSandbox } from "../workspace-sandbox.js";

const mocks = vi.hoisted(() => ({
  createSandboxBackend: vi.fn(),
  syncWorkspaceSkills: vi.fn(async () => []),
  prepareLocalSandboxWorkspace: vi.fn(),
}));
// mock-isolation: prove SQLite admission without starting containers on the host.
vi.mock("./backend.js", () => ({
  createSandboxBackend: mocks.createSandboxBackend,
}));
// mock-isolation: do not read the operator's registered runtimes during project admission.
vi.mock("./registry.js", () => ({ readRegisteredSandboxRuntimeIds: async () => [] }));
// mock-isolation: observe bootstrap copying without importing or copying private host files.
vi.mock("./local-workspace.js", () => ({
  prepareLocalSandboxWorkspace: mocks.prepareLocalSandboxWorkspace,
}));
// mock-isolation: observe skill synchronization without importing or reading private host skills.
vi.mock("../../skills/loading/workspace-skill-sync.runtime.js", () => ({
  syncWorkspaceSkills: mocks.syncWorkspaceSkills,
}));

it("provisions an independent project without host bootstrap, skills, identity, or mounts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ root }) => {
    const workspaceDir = path.join(root, "private-agent");
    await fs.mkdir(workspaceDir);
    for (const name of ["USER.md", "AGENTS.md", ".env", "MEMORY.md"]) {
      await fs.writeFile(path.join(workspaceDir, name), "PRIVATE_HOST_BYTES");
    }
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "off",
            scope: "shared",
            workspaceAccess: "rw",
            workspaceRoot: path.join(root, "projects"),
            docker: {
              env: { HOST_SECRET: "PRIVATE_HOST_BYTES" },
              binds: [`${workspaceDir}:/host`],
              network: "host",
              readOnlyRoot: false,
              capDrop: [],
              dangerouslyAllowExternalBindSources: true,
            },
            browser: { enabled: true, allowHostControl: true },
            prune: { idleHours: 0, maxAgeDays: 0 },
          },
        },
        entries: {
          main: {
            tools: { github: { profileId: "isolated-fixture", allowInSandbox: true } },
          },
        },
      },
      tools: { sandbox: { tools: { allow: ["*"] } } },
    };
    const sessionKey = "agent:main:discord:channel:101";
    mocks.createSandboxBackend.mockResolvedValue({
      id: "docker",
      runtimeId: "isolated-fixture",
      runtimeLabel: "isolated-fixture",
      workdir: "/workspace",
      buildExecSpec: vi.fn(),
      runShellCommand: vi.fn(),
      createFsBridge: () => ({}),
    });
    const scope = {
      agentId: "main",
      sessionKey,
      storePath: openOpenClawAgentDatabase({ agentId: "main" }).path,
    };
    const entry = {
      sessionId: "00000000-0000-4000-8000-000000000101",
      updatedAt: 1,
      chatType: "channel" as const,
    };
    await replaceSessionEntry(scope, entry);
    const audience = await resolveMemoryAudienceFromEntry(
      { ...scope, sessionId: entry.sessionId, senderIsOwner: false, cfg: config },
      entry,
    );
    if (audience.status !== "granted") {
      throw new Error(audience.reason);
    }
    try {
      const prepared = await resolveAttemptWorkspaceSandbox({
        config,
        sessionKey,
        sessionId: entry.sessionId,
        agentId: "main",
        chatType: "channel",
        workspaceDir,
        memoryAudience: audience.audience,
      });
      const { sandbox } = prepared;
      expect(sandbox).toMatchObject({
        required: true,
        isolatedWorkspace: true,
        workspaceAccess: "none",
        browserAllowHostControl: false,
      });
      expect(sandbox?.workspaceDir).not.toBe(workspaceDir);
      expect(prepared.sessionPermissionRoot).toBe(sandbox?.workspaceDir);
      expect(prepared.effectiveWorkspace).toBe(sandbox?.workspaceDir);
      expect(prepared.effectiveFsWorkspaceOnly).toBe(true);
      expect(await fs.readdir(sandbox!.workspaceDir)).toEqual([]);
      expect(mocks.syncWorkspaceSkills).not.toHaveBeenCalled();
      expect(mocks.prepareLocalSandboxWorkspace).not.toHaveBeenCalled();
      expect(mocks.createSandboxBackend).toHaveBeenCalledWith(
        expect.objectContaining({
          readOnlyResourceMounts: undefined,
          cfg: expect.objectContaining({
            scope: "agent",
            workspaceAccess: "none",
            docker: expect.objectContaining({
              env: {},
              binds: undefined,
              network: "none",
              readOnlyRoot: true,
              capDrop: ["ALL"],
              dangerouslyAllowExternalBindSources: false,
            }),
            browser: expect.objectContaining({ enabled: false, allowHostControl: false }),
          }),
        }),
        undefined,
        undefined,
        expect.anything(),
      );
      expect(sandbox?.executionSignal?.aborted).toBe(false);
      await replaceSessionEntry(scope, {
        ...entry,
        sessionId: "00000000-0000-4000-8000-000000000102",
      });
      expect(sandbox?.executionSignal?.aborted).toBe(true);
    } finally {
      audience.release();
    }
  });
});
