import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { withMemoryDreamSource } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { createMemorySessionEndEvent } from "openclaw/plugin-sdk/memory-host-events";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import { markDreamSessionEnded, readDreamFragmentSources } from "./dreaming-fragment-state.js";
import { listMemorySessionTombstones } from "./memory-entry-origins.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";

/** Capture while the host's bounded reader and handler lease are still admitted. */
export async function captureDreamEndedSession(
  api: OpenClawPluginApi,
  ...[event, ctx]: Parameters<Parameters<typeof api.on<"session_end">>[1]>
): Promise<void> {
  const transcript = ctx.endedTranscript;
  const session = transcript?.session;
  const assertActive = transcript?.assertActive;
  if (!transcript || !session || !assertActive || !ctx.agentId || !ctx.sessionKey) {
    return;
  }
  const agentId = ctx.agentId;
  const sessionKey = ctx.sessionKey;
  const getConfig = (): OpenClawConfig => {
    // SAFETY: Host-validated config is only read by Dream's admission resolvers.
    return (api.runtime.config?.current?.() ?? api.config) as OpenClawConfig;
  };
  const cfg = getConfig();
  const workspaceDir = path.resolve(resolveAgentWorkspaceDir(cfg, agentId));
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  await withMemoryDreamSource(
    {
      agentId,
      sessionKey,
      sessionId: ctx.sessionId,
      storePath,
      endedSession: session,
      getConfig,
      assertCurrent: assertActive,
    },
    async (facts) =>
      withMemoryWorkspaceLock(workspaceDir, async () => {
        const assertCurrent = () => {
          facts.assertCurrent();
          if (path.resolve(resolveAgentWorkspaceDir(getConfig(), agentId)) !== workspaceDir) {
            throw new Error("Ended session Workspace changed during capture");
          }
          if (resolveStorePath(getConfig().session?.store, { agentId }) !== storePath) {
            throw new Error("Ended session store changed during capture");
          }
        };
        const tombstones = await listMemorySessionTombstones({
          agentId,
          sessionIds: [ctx.sessionId],
        });
        assertCurrent();
        if (tombstones.length) {
          return;
        }
        await markDreamSessionEnded({
          workspaceDir,
          agentId,
          sessionKey,
          sessionId: ctx.sessionId,
          session: facts.session,
          assertCurrent,
        });
        const sources = await readDreamFragmentSources(workspaceDir);
        assertCurrent();
        if (
          !transcript.available ||
          !facts.context.fragment ||
          sources.some(
            (source) =>
              source.kind === "event" &&
              source.endedSession &&
              source.agentId === agentId &&
              source.sessionId === ctx.sessionId &&
              source.sessionKey === sessionKey,
          )
        ) {
          return;
        }
        const tail = await transcript.readTail({ maxMessages: 256, maxBytes: 64_000 });
        assertCurrent();
        await createMemorySessionEndEvent({
          workspaceDir,
          agentId,
          sessionKey,
          sessionId: ctx.sessionId,
          session: facts.session,
          scope: facts.context.fragment.scope,
          reason: event.reason,
          ...tail,
          assertCurrent,
        });
      }),
  );
}
