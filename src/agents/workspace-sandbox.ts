import fs from "node:fs/promises";
import {
  assertMemoryAudienceCurrent,
  assertMemoryAudienceSession,
  readMemoryAudienceExecutionSignal,
} from "../plugins/memory-audience.js";
import { usesLoadedMemoryAudience } from "../plugins/memory-state.js";
import { resolveUserPath } from "../utils.js";
import { resolveAdmittedRunActiveAssertion } from "./admitted-run-context.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import type { EmbeddedRunAttemptParams } from "./embedded-agent-runner/run/types.js";
import { resolveSandboxContext } from "./sandbox.js";
import {
  type resolveSandboxRuntimeStatus,
  withSandboxRuntimeStatusInWorker,
} from "./sandbox/runtime-status.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "./tool-fs-policy.js";

export type WorkspaceSandboxParams = Pick<
  EmbeddedRunAttemptParams,
  | "abortSignal"
  | "agentId"
  | "config"
  | "chatType"
  | "cwd"
  | "execOverrides"
  | "permissionMode"
  | "sandboxSessionKey"
  | "sandboxAgentId"
  | "sessionId"
  | "sessionKey"
  | "sessionRoot"
  | "skillsSnapshot"
  | "requireWritableSandbox"
  | "requireWorkspaceOnly"
  | "workspaceDir"
  | "memoryAudience"
> & {
  admittedRunContext?: EmbeddedRunAttemptParams["admittedRunContext"];
  /** Placement execution policy never supplies Gateway-side filesystem or media roots. */
  placementSandbox?: Awaited<ReturnType<typeof resolveSandboxContext>>;
};

function assertSandboxCwd(requestedCwd: string | undefined, workspaceDir: string) {
  if (requestedCwd && requestedCwd !== workspaceDir) {
    throw new Error(
      "cwd override is not supported for sandboxed embedded agent runs; omit cwd or use the agent workspace as cwd",
    );
  }
}

/** Preserve prepared local projection roots without overriding a remote placement owner. */
export function resolveHarnessWorkspace(
  workspaceDir: string,
  params: Pick<WorkspaceSandboxParams, "cwd" | "sessionRoot">,
  prepared: Awaited<ReturnType<typeof resolveAttemptWorkspaceSandbox>> | undefined,
  sandbox: Awaited<ReturnType<typeof resolveSandboxContext>> | undefined,
) {
  const projected =
    prepared?.sandbox?.workspaceSource === "managed-worktree" && prepared.sandbox === sandbox;
  if (projected) {
    assertSandboxCwd(
      params.cwd ? resolveUserPath(params.cwd) : undefined,
      prepared.resolvedWorkspace,
    );
  }
  return {
    workspaceDir: projected ? prepared.effectiveWorkspace : workspaceDir,
    cwd: projected ? prepared.effectiveCwd : params.cwd,
    sessionRoot: projected ? prepared.sessionPermissionRoot : params.sessionRoot,
  };
}

/** Resolves the shared workspace and sandbox policy used by native and plugin harnesses. */
export async function resolveAttemptWorkspaceSandbox(params: WorkspaceSandboxParams) {
  const audience = params.memoryAudience;
  const requireIsolatedWorkspace = audience?.kind === "conversation";
  if (
    !audience &&
    (params.chatType === "group" || params.chatType === "channel") &&
    usesLoadedMemoryAudience(params.config ?? {})
  ) {
    throw new Error(
      "Conversation execution requires an admitted memory audience; reset the session after repairing its membership.",
    );
  }
  const assertRunCurrent = params.admittedRunContext
    ? resolveAdmittedRunActiveAssertion(params.admittedRunContext, params.abortSignal)
    : undefined;
  if (params.admittedRunContext && !assertRunCurrent) {
    throw new Error("Sandbox preparation requires an active admitted run");
  }
  const assertCurrent = () => {
    params.abortSignal?.throwIfAborted();
    assertRunCurrent?.();
    if (audience) {
      assertMemoryAudienceSession(audience, params.sessionKey);
      assertMemoryAudienceCurrent(audience);
    }
  };
  assertCurrent();
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  const sessionKey = params.sessionKey?.trim() || params.sessionId;
  const sandboxSessionKey = requireIsolatedWorkspace
    ? `${sessionKey}:project:${params.sessionId}`
    : params.sandboxSessionKey?.trim() || sessionKey;
  if (requireIsolatedWorkspace && params.placementSandbox) {
    throw new Error(
      "Conversation execution requires an isolated project sandbox; host placements cannot supply its workspace.",
    );
  }
  const prepareWorkspace = async (
    sandboxRuntimeStatus?: ReturnType<typeof resolveSandboxRuntimeStatus>,
  ) => {
    await fs.mkdir(resolvedWorkspace, { recursive: true });
    assertCurrent();
    const sandbox = sandboxRuntimeStatus
      ? await resolveSandboxContext({
          config: params.config,
          agentId: sandboxRuntimeStatus.agentId,
          execOverrides: params.execOverrides,
          sessionKey: sandboxSessionKey,
          skillsSnapshot: params.skillsSnapshot,
          workspaceDir: resolvedWorkspace,
          assertCurrent,
          admittedRunContext: params.admittedRunContext,
          preparedRuntimeStatus: sandboxRuntimeStatus,
        })
      : null;
    assertCurrent();
    if (sandbox?.isolatedWorkspace && audience) {
      sandbox.executionSignal = readMemoryAudienceExecutionSignal(audience);
    }
    const projectedWorkspace = sandbox?.enabled && sandbox.workspaceSource === "managed-worktree";
    const effectiveWorkspace =
      sandbox?.enabled && (sandbox.workspaceAccess !== "rw" || projectedWorkspace)
        ? (sandbox.workspaceCwd ?? sandbox.workspaceDir)
        : resolvedWorkspace;
    const executionSandbox = params.placementSandbox ?? sandbox;
    if (
      params.requireWritableSandbox &&
      executionSandbox?.enabled &&
      !executionSandbox.isolatedWorkspace &&
      executionSandbox.workspaceAccess !== "rw"
    ) {
      throw new Error("sandbox workspace is not read-write; collection review skipped");
    }
    const requestedCwd = params.cwd ? resolveUserPath(params.cwd) : undefined;
    // Recorded roots pin worktree/explicit-cwd boundaries; rootless sessions use
    // the agent's canonical workspace as their permission boundary.
    const sessionPermissionRoot =
      sandbox?.isolatedWorkspace || projectedWorkspace
        ? sandbox.workspaceDir
        : (params.sessionRoot ?? (await fs.realpath(resolvedWorkspace)));
    const sessionPermissionPolicy = params.permissionMode
      ? {
          root: sessionPermissionRoot,
          mode: params.permissionMode,
        }
      : undefined;
    if (sandbox?.enabled) {
      assertSandboxCwd(requestedCwd, resolvedWorkspace);
    }
    assertCurrent();
    if (effectiveWorkspace !== resolvedWorkspace) {
      await fs.mkdir(effectiveWorkspace, { recursive: true });
    }
    assertCurrent();
    return {
      effectiveCwd: sandbox?.enabled ? effectiveWorkspace : (requestedCwd ?? effectiveWorkspace),
      effectiveFsWorkspaceOnly:
        params.requireWorkspaceOnly === true ||
        requireIsolatedWorkspace ||
        resolveEffectiveToolFsWorkspaceOnly({
          cfg: params.config,
          agentId: sessionAgentId,
        }),
      effectiveWorkspace,
      resolvedWorkspace,
      sessionPermissionRoot,
      sessionPermissionPolicy,
      sandbox,
      sandboxReport: sandboxRuntimeStatus
        ? { mode: sandboxRuntimeStatus.mode, sandboxed: sandboxRuntimeStatus.sandboxed }
        : undefined,
      sandboxSessionKey,
      sessionAgentId,
    };
  };
  return params.placementSandbox
    ? prepareWorkspace()
    : withSandboxRuntimeStatusInWorker(
        {
          cfg: params.config,
          // Independent policy sessions keep their own owner.
          agentId:
            params.sandboxAgentId ??
            (sandboxSessionKey === sessionKey ? sessionAgentId : undefined),
          sessionKey: sandboxSessionKey,
          requireIsolatedWorkspace,
        },
        { env: process.env, cwd: process.cwd(), assertCurrent },
        prepareWorkspace,
      );
}
