import fs from "node:fs/promises";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";

export async function seedTranscript(params: {
  messages: Array<{
    role: "assistant" | "user";
    content: unknown;
    owner?: boolean;
    provenance?: { kind: "internal_system"; sourceTool: "heartbeat" };
    timestamp: number | string;
  }>;
  sessionId: string;
  sessionKey?: string;
  chatType?: "direct" | "group" | "channel";
  hookExternalContentSource?: "gmail" | "webhook";
}): Promise<void> {
  const agentId = "main";
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  const storePath = path.join(sessionsDir, "sessions.json");
  const sessionKey = params.sessionKey ?? `agent:${agentId}:chat:${params.sessionId}`;
  const timestamps = params.messages
    .map((message) =>
      typeof message.timestamp === "number" ? message.timestamp : Date.parse(message.timestamp),
    )
    .filter((timestamp) => Number.isFinite(timestamp));
  // Accessor writes run normal maintenance; keep fixture entries fresh while
  // retaining per-message timestamps as the dreaming corpus clock.
  const updatedAt = Math.max(Date.now(), ...timestamps);
  await fs.mkdir(sessionsDir, { recursive: true });
  const registration = {
    agentId,
    sessionKey,
    storePath,
    entry: {
      sessionId: params.sessionId,
      updatedAt,
      ...(params.chatType ? { chatType: params.chatType } : {}),
      ...(params.hookExternalContentSource
        ? { hookExternalContentSource: params.hookExternalContentSource }
        : {}),
    },
  };
  await upsertSessionEntry(registration);
  for (const message of params.messages) {
    await appendSessionTranscriptMessageByIdentity({
      agentId,
      sessionId: params.sessionId,
      sessionKey,
      storePath,
      message: {
        role: message.role,
        content: message.content,
        ...(message.owner ? { __openclaw: { senderIsOwner: true } } : {}),
        ...(message.provenance ? { provenance: message.provenance } : {}),
        timestamp: message.timestamp,
      },
    });
  }
  await upsertSessionEntry(registration);
}
