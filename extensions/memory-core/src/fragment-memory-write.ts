import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  resolveAgentWorkspaceDir,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { withMemoryDreamSource } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import { writeDreamFragmentSource } from "./dreaming-fragment-state.js";
import { recordMemoryEntryOrigins } from "./memory-entry-origins.js";
import { makeWorkspaceDirectory } from "./memory-workspace-files.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import {
  buildPromotionMarker,
  commitMemoryContent,
  hashMemoryContent,
  MemoryWriteConflictError,
  readMemoryContent,
  resolveMemoryWritePath,
} from "./short-term-promotion-memory-write.js";

// Fragments are short situation notes; this bound protects the file writer
// and downstream Dream ingestion, not model judgment.
export const MEMORY_FRAGMENT_MAX_CHARS = 8_000;
export const MEMORY_FRAGMENT_TITLE_MAX_CHARS = 120;

// One append-only day file per admitted Channel/Thread scope.
const FRAGMENT_RELATIVE_PATH_PATTERN =
  /^memory\/Channel\/[^/]+(?:\/Thread\/[^/]+)?\/Fragment\/\d{4}-\d{2}-\d{2}\.md$/u;
const FRAGMENT_TIME_LABEL_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

// Whitespace (including tab/newline) is collapsed first; this drops the
// remaining C0 controls and DEL/C1 bytes so headings stay single-line.
function stripControlCharacters(text: string): string {
  let stripped = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      continue;
    }
    stripped += char;
  }
  return stripped;
}

// Compare-and-swap retries cover concurrent appends (e.g. a scheduled turn
// racing an interactive turn) without ever dropping either entry.
const FRAGMENT_APPEND_MAX_ATTEMPTS = 5;

function normalizeFragmentBody(content: string): string {
  const trimmed = content.trim();
  if (/<!--\s*openclaw-memory-/iu.test(trimmed)) {
    throw new Error("fragment content cannot contain reserved memory entry markers");
  }
  if (!trimmed) {
    throw new Error("fragment content must be a non-empty string");
  }
  if (trimmed.length > MEMORY_FRAGMENT_MAX_CHARS) {
    throw new Error(`fragment content must be at most ${MEMORY_FRAGMENT_MAX_CHARS} characters`);
  }
  return trimmed;
}

function normalizeFragmentTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  if (/<!--\s*openclaw-memory-/iu.test(title)) {
    throw new Error("fragment title cannot contain reserved memory entry markers");
  }
  const singleLine = stripControlCharacters(title.replace(/\s+/gu, " ").trim().replace(/^#+/u, ""))
    .trim()
    .slice(0, MEMORY_FRAGMENT_TITLE_MAX_CHARS);
  return singleLine || undefined;
}

/** Render one chronological Markdown entry inside the day file. */
function renderFragmentEntry(params: { timeLabel: string; title?: string; body: string }): string {
  if (!FRAGMENT_TIME_LABEL_PATTERN.test(params.timeLabel)) {
    throw new Error("fragment time label must use HH:MM");
  }
  const body = normalizeFragmentBody(params.body);
  const title = normalizeFragmentTitle(params.title);
  const heading = `## ${params.timeLabel}${title ? ` — ${title}` : ""}`;
  return `${heading}\n\n${body}\n`;
}

/** Append one entry after the existing bytes, separated by a blank line. */
function joinFragmentFile(existing: string, entry: string): string {
  if (existing === "") {
    return entry;
  }
  return `${existing}${existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n"}${entry}`;
}

/**
 * Append one situation note to the admitted scope's dated Fragment day file.
 * The relative path is host-minted; this writer only appends sequenced
 * entries, never editing or deleting existing bytes. Publication is an atomic
 * compare-and-swap replace that retries when another writer appended between
 * the read and the rename.
 */
export async function appendAgentMemoryFragmentFile(params: {
  cfg: OpenClawConfig;
  agentId: string;
  relPath: string;
  content: string;
  timeLabel: string;
  title?: string;
  source?: { sessionKey: string; sessionId: string; createdAtMs: number };
  assertCurrent?: () => void;
}): Promise<{ relativePath: string }> {
  const relativePath = params.relPath.replace(/\\/g, "/");
  if (!FRAGMENT_RELATIVE_PATH_PATTERN.test(relativePath)) {
    throw new Error(
      "refusing fragment write outside the admitted Channel/Thread Fragment day file",
    );
  }
  const id = `fragment-${randomUUID()}`;
  const rendered = renderFragmentEntry({
    timeLabel: params.timeLabel,
    ...(params.title ? { title: params.title } : {}),
    body: params.content,
  });
  const entry = `${buildPromotionMarker(id)}\n${rendered}<!-- openclaw-memory-end:${id} -->\n`;
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const session = params.source
    ? await withMemoryDreamSource(
        {
          agentId: params.agentId,
          ...params.source,
          storePath: resolveStorePath(params.cfg.session?.store, { agentId: params.agentId }),
          cfg: params.cfg,
          assertCurrent: () => params.assertCurrent?.(),
        },
        async (facts) => facts.session,
      )
    : undefined;
  return withMemoryWorkspaceLock(workspaceDir, async () => {
    params.assertCurrent?.();
    const filePath = path.join(workspaceDir, ...relativePath.split("/"));
    await makeWorkspaceDirectory(workspaceDir, path.dirname(filePath));
    const writePath = await resolveMemoryWritePath(filePath, workspaceDir);
    if (params.source) {
      // Persist provenance before publishing bytes. A failed append leaves a
      // harmless unmatched receipt; Dream never treats it as a published source.
      await recordMemoryEntryOrigins({
        agentId: params.agentId,
        entryKey: id,
        origins: [
          {
            entryKey: id,
            agentId: params.agentId,
            sessionKey: params.source.sessionKey,
            sessionId: params.source.sessionId,
            observedAt: params.source.createdAtMs,
            originClass: "agent",
          },
        ],
      });
      await writeDreamFragmentSource(workspaceDir, {
        kind: "fragment",
        id,
        agentId: params.agentId,
        ...params.source,
        relativePath,
        hash: hashMemoryContent(entry),
        session,
      });
    }

    for (let attempt = 1; ; attempt += 1) {
      const existing = await readMemoryContent(writePath, workspaceDir);
      params.assertCurrent?.();
      try {
        await commitMemoryContent({
          filePath: writePath,
          content: joinFragmentFile(existing, entry),
          expectedHash: hashMemoryContent(existing),
          tempPrefix: ".openclaw-fragment-",
          workspaceDir,
          assertCurrent: params.assertCurrent,
        });
        return { relativePath };
      } catch (error) {
        if (
          !(error instanceof MemoryWriteConflictError) ||
          attempt >= FRAGMENT_APPEND_MAX_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
  });
}
