import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  resolveMemoryArtifactRelativePath,
  withMemoryDreamSource,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import type { DreamFragmentSource } from "./dreaming-fragment-state.js";

type DreamSourceFacts = Parameters<Parameters<typeof withMemoryDreamSource>[1]>[0];

export type DreamFragmentAdmissionParams = {
  workspaceDir: string;
  cfg: OpenClawConfig;
  getConfig: () => OpenClawConfig;
  assertCurrent(): void;
};

type AdmittedDreamFragmentSource = {
  source: DreamFragmentSource;
  policy: ReturnType<typeof resolveDreamFragmentPolicy>;
  assertCurrent(): void;
};

export async function withAdmittedDreamSources<T>(
  params: DreamFragmentAdmissionParams,
  sources: DreamFragmentSource[],
  consume: (admitted: AdmittedDreamFragmentSource[]) => Promise<T>,
): Promise<T> {
  const admitted: AdmittedDreamFragmentSource[] = [];
  const visit = async (index: number): Promise<T> => {
    const source = sources[index];
    if (!source) {
      return consume(admitted);
    }
    return withMemoryDreamSource(
      {
        agentId: source.agentId,
        sessionKey: source.sessionKey,
        sessionId: source.sessionId,
        storePath: resolveStorePath(params.cfg.session?.store, { agentId: source.agentId }),
        assertCurrent: () => params.assertCurrent(),
        getConfig: params.getConfig,
        ...(source.endedSession && source.session ? { endedSession: source.session } : {}),
      },
      async (facts) => {
        const policy = resolveDreamFragmentPolicy(params.getConfig(), source, facts);
        if (policy.workspaceDir !== path.resolve(params.workspaceDir)) {
          throw new Error("Dream source no longer belongs to this Workspace");
        }
        admitted.push({
          source,
          policy,
          assertCurrent: () => {
            facts.assertCurrent();
            const current = resolveDreamFragmentPolicy(params.getConfig(), source, facts);
            if (
              JSON.stringify(current.targets.map((target) => target.path)) !==
                JSON.stringify(policy.targets.map((target) => target.path)) ||
              current.partition !== policy.partition ||
              current.workspaceDir !== policy.workspaceDir
            ) {
              throw new Error("Dream source membership or publication authority changed");
            }
          },
        });
        return visit(index + 1);
      },
    );
  };
  return visit(0);
}

/** Configured group membership is independent from sender ACLs and observed speakers. */
function resolveDreamFragmentPolicy(
  cfg: OpenClawConfig,
  source: DreamFragmentSource,
  facts: DreamSourceFacts,
) {
  facts.assertCurrent();
  const { context } = facts;
  const group = context.group;
  if (!group?.consolidationAllowed) {
    throw new Error("Dream deferred: fixed group membership or Thread policy is missing");
  }
  if (!context.fragment) {
    throw new Error("Dream deferred: launch Channel memory is excluded");
  }
  const expected =
    source.kind === "fragment"
      ? context.fragment.resolveRelativePath({
          createdDate: source.relativePath.slice(-13, -3),
        })
      : resolveMemoryArtifactRelativePath({
          scope: context.fragment.scope,
          artifactKind: "event",
          artifactName: `${source.eventType.slice(0, 28)}-${source.id}`,
          createdDate: source.relativePath.split("/").at(-1)!.slice(0, 10),
          createdAtMs: source.createdAtMs,
        });
  if (
    source.kind === "fragment"
      ? expected !== source.relativePath
      : path.posix.dirname(expected) !== path.posix.dirname(source.relativePath) ||
        JSON.stringify(source.scope) !== JSON.stringify(context.fragment.scope)
  ) {
    throw new Error("Dream Fragment no longer matches its canonical session scope");
  }
  const targets = context.artifacts
    .filter(
      (artifact) =>
        (artifact.layer !== "workspace" || group.workspaceShared) &&
        (artifact.scope.kind !== "user" || group.userIds.includes(artifact.scope.userId)),
    )
    .map((artifact) => ({
      path: artifact.relativePath,
      kind: artifact.scope.kind,
      label: artifact.userName ?? artifact.scope.kind,
      archive:
        artifact.scope.kind !== "user"
          ? (createdAtMs: number) =>
              resolveMemoryArtifactRelativePath({
                scope: artifact.scope,
                artifactKind: "archive",
                artifactName: "dream",
                createdDate: new Date(createdAtMs).toISOString().slice(0, 10),
                createdAtMs,
              })
          : undefined,
    }));
  const workspaceDir = path.resolve(resolveAgentWorkspaceDir(cfg, source.agentId));
  return { partition: group.key, targets, workspaceDir };
}
