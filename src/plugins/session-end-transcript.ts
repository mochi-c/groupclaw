import type { MemorySourceSession } from "../memory/session-memory-context.js";

type PluginHookEndedTranscriptUnavailableReason =
  | "conversation-access-required"
  | "no-stable-cutoff"
  | "incognito-deleted"
  | "archive-unavailable"
  | "unsupported-source";

export type PluginHookEndedTranscriptReadOptions = {
  maxMessages: number;
  maxBytes: number;
};

export type PluginHookEndedTranscriptReadResult = {
  messages: readonly unknown[];
  totalMessages: number;
  truncated: boolean;
};

type EndedSessionFacts = {
  /** Departing conversation facts; these do not grant publication authority. */
  session?: MemorySourceSession;
  /** Current hosts bind persistence to the admitted handler's lifetime. */
  assertActive?: () => void;
};

type PluginHookEndedTranscript = EndedSessionFacts &
  (
    | {
        available: false;
        reason: PluginHookEndedTranscriptUnavailableReason;
      }
    | {
        available: true;
        readTail(
          options: PluginHookEndedTranscriptReadOptions,
        ): Promise<PluginHookEndedTranscriptReadResult>;
      }
  );

export type PluginHookSessionContext = {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  /** Undefined on older hosts. Current hosts publish a reader or an explicit reason. */
  endedTranscript?: PluginHookEndedTranscript;
};

type SessionEndTranscriptAvailableSource = Extract<PluginHookEndedTranscript, { available: true }>;

export type SessionEndTranscriptSource = EndedSessionFacts &
  (
    | SessionEndTranscriptAvailableSource
    | {
        available: false;
        reason: Exclude<PluginHookEndedTranscriptUnavailableReason, "conversation-access-required">;
      }
  );

const sessionEndTranscriptSource = Symbol("openclaw.sessionEndTranscriptSource");

type SessionEndContextWithSource = PluginHookSessionContext & {
  [sessionEndTranscriptSource]?: SessionEndTranscriptSource;
};

export function attachSessionEndTranscriptSource(
  context: PluginHookSessionContext,
  source: SessionEndTranscriptSource,
): void {
  Object.defineProperty(context, sessionEndTranscriptSource, {
    configurable: false,
    enumerable: false,
    value: source,
    writable: false,
  });
}

function createScopedEndedTranscript(
  source: SessionEndTranscriptSource,
  lifecycleSignal?: AbortSignal,
): {
  capability: SessionEndTranscriptSource;
  revoke(): void;
} {
  let active = true;
  const assertActive = () => {
    if (!active || lifecycleSignal?.aborted) {
      throw new Error("session_end transcript reader is no longer active");
    }
    source.assertActive?.();
  };
  return {
    capability: Object.freeze(
      source.available
        ? {
            ...source,
            assertActive,
            async readTail(options: PluginHookEndedTranscriptReadOptions) {
              assertActive();
              const result = await source.readTail(options);
              await Promise.resolve();
              assertActive();
              return result;
            },
          }
        : { ...source, assertActive },
    ),
    revoke() {
      active = false;
    },
  };
}

export function createSessionEndTranscriptSourceLease(source: SessionEndTranscriptSource): {
  source: SessionEndTranscriptSource;
  revoke(): void;
} {
  const scoped = createScopedEndedTranscript(source);
  return { source: scoped.capability, revoke: () => scoped.revoke() };
}

export function projectSessionEndTranscriptContext(
  hook: { conversationAccessAllowed?: true },
  context: PluginHookSessionContext,
  lifecycleSignal?: AbortSignal,
): { context: PluginHookSessionContext; dispose(): void } {
  if (hook.conversationAccessAllowed !== true) {
    return {
      context: {
        ...context,
        endedTranscript: Object.freeze({
          available: false as const,
          reason: "conversation-access-required" as const,
        }),
      },
      dispose() {},
    };
  }
  const source: SessionEndTranscriptSource =
    // SAFETY: attachSessionEndTranscriptSource is the sole writer for this private symbol.
    (context as SessionEndContextWithSource)[sessionEndTranscriptSource] ?? {
      available: false,
      reason: "unsupported-source",
    };
  const scoped = createScopedEndedTranscript(source, lifecycleSignal);
  return {
    context: { ...context, endedTranscript: scoped.capability },
    dispose: () => scoped.revoke(),
  };
}
