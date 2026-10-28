import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { MemoryEventHandle } from "../memory/memory-events.js";
import { assertMemoryAudienceCurrent } from "../plugins/memory-audience.js";
import type { MemoryAudience } from "../plugins/memory-provider-types.js";
import type { MemoryFlushObservation } from "./internal-hook-types.js";
import {
  createInternalHookEvent,
  hasInternalHookListeners,
  triggerInternalHook,
} from "./internal-hooks.js";

const log = createSubsystemLogger("hooks/session-memory-flush");

/** Start an attempt under its held source audience before running detached inference. */
export async function startSessionMemoryFlushEvent(params: {
  cfg: OpenClawConfig;
  workspaceDir: string;
  audience: MemoryAudience;
  sessionKey: string;
  sessionEntry: SessionEntry;
  observation: Omit<MemoryFlushObservation, "outcome">;
  assertCurrent: () => void;
}): Promise<MemoryEventHandle | undefined> {
  const scope = params.audience.context?.fragment?.scope;
  if (!scope || !hasInternalHookListeners("session", "memory-flush")) {
    return undefined;
  }
  const assertCurrent = () => {
    params.assertCurrent();
    assertMemoryAudienceCurrent(params.audience);
  };
  try {
    assertCurrent();
    const source = params.audience.kind === "conversation" ? params.audience : params;
    let handle: MemoryEventHandle | undefined;
    await triggerInternalHook(
      createInternalHookEvent("session", "memory-flush", source.sessionKey, {
        cfg: params.cfg,
        agentId: params.audience.agentId,
        workspaceDir: params.workspaceDir,
        sessionEntry: {
          sessionId:
            params.audience.kind === "conversation"
              ? params.audience.sessionId
              : params.sessionEntry.sessionId,
          updatedAt: params.sessionEntry.updatedAt,
        },
        memoryEventScope: scope,
        memoryFlush: params.observation,
        onMemoryEventCreated: (created) => {
          handle = created;
        },
        assertCurrent,
        previousSessionMemory: { status: "available", content: null, originClass: "agent" },
      }),
    );
    return handle;
  } catch (error) {
    log.warn(`memory flush Event capture failed: ${String(error)}`);
    return undefined;
  }
}
