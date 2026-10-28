import path from "node:path";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { withMemoryDreamSource } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import { readDreamFragmentSources } from "./dreaming-fragment-state.js";
import type { MemoryToolOptions } from "./memory-tool-contract.js";
import type { ScopedMemoryContext } from "./scoped-memory-visibility.js";

/** Source receipts locate discussions; current channel policy grants their search audience. */
export async function withMemorySearchContext<T>(
  params: {
    options: MemoryToolOptions;
    cfg: OpenClawConfig;
    agentId: string;
    context: ScopedMemoryContext;
    signal?: AbortSignal;
  },
  consume: (scope: {
    memorySearchContext: ScopedMemoryContext;
    assertMemorySearchCurrent(): void;
  }) => Promise<T>,
): Promise<T> {
  const { options, agentId, signal, context } = params;
  const audience = options.memoryAudience;
  if (audience?.kind !== "conversation") {
    throw new Error("Shared memory search requires a conversation audience");
  }
  const getConfig = () => options.getConfig?.() ?? params.cfg;
  const workspaceDir = path.resolve(resolveAgentWorkspaceDir(params.cfg, agentId));
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const checks: Array<() => void> = [];
  const assertCallerCurrent = () => {
    signal?.throwIfAborted();
    options.assertMemoryAudienceCurrent?.();
    const currentConfig = getConfig();
    if (path.resolve(resolveAgentWorkspaceDir(currentConfig, agentId)) !== workspaceDir) {
      throw new Error("Memory search Workspace changed during admission");
    }
    if (resolveStorePath(currentConfig.session?.store, { agentId }) !== storePath) {
      throw new Error("Memory search session catalog changed during admission");
    }
  };
  const assertCurrent = () => {
    assertCallerCurrent();
    for (const check of checks) {
      check();
    }
  };
  assertCurrent();
  // Many notes share a session. Hold one live source admission per incarnation,
  // retaining ended facts so reset/archival does not erase authorized discovery.
  const sources = [
    ...new Map(
      (await readDreamFragmentSources(workspaceDir))
        .filter(
          (source) =>
            source.agentId === agentId &&
            (source.sessionKey !== audience.sessionKey || source.sessionId !== audience.sessionId),
        )
        .map((source) => [
          JSON.stringify([source.sessionKey, source.sessionId, source.endedSession === true]),
          source,
        ]),
    ).values(),
  ];
  assertCurrent();
  const artifacts = new Map(context.artifacts.map((artifact) => [artifact.relativePath, artifact]));
  const visit = async (index: number): Promise<T> => {
    const source = sources[index];
    if (!source) {
      assertCurrent();
      const result = await consume({
        memorySearchContext: { ...context, artifacts: [...artifacts.values()] },
        assertMemorySearchCurrent: assertCurrent,
      });
      assertCurrent();
      return result;
    }
    let admitted = false;
    try {
      const result = await withMemoryDreamSource(
        {
          agentId,
          sessionKey: source.sessionKey,
          sessionId: source.sessionId,
          storePath,
          getConfig,
          assertCurrent: assertCallerCurrent,
          ...(source.endedSession && source.session ? { endedSession: source.session } : {}),
        },
        async (facts) => {
          const candidate = facts.context;
          const fragment = candidate.fragment;
          if (
            !fragment ||
            !candidate.group?.consolidationAllowed ||
            candidate.group.key !== context.group?.key ||
            (facts.session.chatType !== "group" && facts.session.chatType !== "channel") ||
            path.posix.dirname(source.relativePath) !==
              path.posix.join(
                path.posix.dirname(fragment.resolveRelativePath({ createdDate: "2000-01-01" })),
                source.kind === "fragment" ? "." : "../Event",
              )
          ) {
            return undefined;
          }
          facts.assertCurrent();
          admitted = true;
          checks.push(facts.assertCurrent);
          try {
            for (const artifact of candidate.artifacts) {
              if (artifact.layer === "channel" || artifact.layer === "thread") {
                artifacts.set(artifact.relativePath, artifact);
              }
            }
            return { value: await visit(index + 1) };
          } finally {
            checks.pop();
          }
        },
      );
      if (result) {
        return result.value;
      }
    } catch (error) {
      // A denied historical source is absent from the corpus. A failed search
      // or revoked admitted source must propagate, never retry the operation.
      assertCurrent();
      if (admitted) {
        throw error;
      }
    }
    return await visit(index + 1);
  };
  return await withMemoryDreamSource(
    {
      agentId,
      sessionKey: audience.sessionKey,
      sessionId: audience.sessionId,
      storePath,
      getConfig,
      assertCurrent: assertCallerCurrent,
    },
    async (facts) => {
      if (JSON.stringify(facts.context) !== JSON.stringify(context)) {
        throw new Error("Memory search audience changed during admission");
      }
      checks.push(facts.assertCurrent);
      try {
        return await visit(0);
      } finally {
        checks.pop();
      }
    },
  );
}
