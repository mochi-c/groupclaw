---
summary: "How OpenClaw remembers things across sessions"
title: "Memory overview"
read_when:
  - You want to understand how memory works
  - You want to know what memory files to write
---

OpenClaw remembers things by writing plain Markdown files in your agent's
workspace (default `~/.openclaw/workspace`). The model only remembers what gets
saved to disk; there is no hidden state.

## How it works

Your agent uses these memory artifacts:

- **`USER.md`** (optional) — stable preferences, communication style,
  relationships, and active-project context written as directives. Loaded at
  the start of a session with a separate small budget.
- **`memory/MEMORY.md`** — curated Workspace knowledge. Channel, Thread, and User
  scopes have their own `MEMORY.md` files; the runtime admits the layers readable
  by the current conversation. Doctor migrates legacy root `MEMORY.md`.
- **Scoped `Fragment/YYYY-MM-DD.md`** — timestamped notes appended through
  `memory_fragment_append`. Dream selects useful evidence for curated memory;
  temporary plans can remain available to authorized recall.
- **Legacy daily notes** — `memory/YYYY-MM-DD.md` and slugged variants remain
  operator artifacts. Conversation recording uses scoped Fragments.
- **Scoped `Event/*.md`** — framework lifecycle evidence. The bundled
  session-memory hook records resets, rollovers, successful embedded compactions,
  and committed Discord Thread closures under the source Channel/Thread, or
  Workspace for local sessions. Closure Events retain transcript archive
  references. These artifacts are available
  to authorized recall and are never automatically loaded as daily notes.
- **`DREAMS.md`** (optional) — Dream Diary and dreaming sweep summaries for
  human review, including grounded historical backfill entries.

<Tip>
If you want your agent to remember something, just ask it: "Remember that I
prefer TypeScript." It appends a Fragment and reports that the note was recorded.
Dream later decides how to update curated memory.
</Tip>

## What goes where

`USER.md` can supply operator-maintained startup directives. Conversation
preferences and corrections are recorded as Fragments with the subject and
source; Dream reconciles the participating User's curated memory.
See [User model](/concepts/user-model).

Scoped `MEMORY.md` is the compact, curated layer for durable facts,
standing decisions, and short summaries that should be available at the start
of a session. It is not a raw transcript, daily log, or exhaustive archive.

Scoped Fragments are the working layer: observations and context that may still
be useful later. They are available to authorized memory search and reads, and
are excluded from bootstrap.

The [dreaming](/concepts/dreaming) sweep owns curated updates and formal Archives.
A publication can cite part of a Fragment while retaining the original note.
Cleanup requires explicit full coverage or discard; unfinished evidence remains
available. Ordinary file tools reject direct memory edits and filter reads to the
current audience. Full shell and desktop authority require separate execution
isolation and are outside this file-tool guarantee.

If `MEMORY.md` grows past the bootstrap file budget, OpenClaw keeps the file on
disk intact but truncates the copy injected into context. Treat that as a
signal to move detailed material into `memory/*.md`, keep only a durable
summary in `MEMORY.md`, or raise the bootstrap limits if you want to spend more
prompt budget. Use `/context list`, `/context detail`, or `openclaw doctor` to
see raw vs. injected sizes and truncation status.

For an admitted conversation, bootstrap also loads the current Channel, optional
Thread, and participating Users' curated `MEMORY.md` summaries. These refresh
each turn and use a separate 12,000-character pool: up to 2,000 characters for
each conversation scope and 1,000 for each User. Truncated summaries identify
the full source to read. Scope authorization and provenance checks still apply;
Fragments, Events, and Archives remain explicit recall sources.

## Import from coding assistants

The Control UI can import existing local memory from Codex, Claude Code, and
Hermes.
Open **Settings** → **Import Memory**, choose the destination agent, review the
detected files, and confirm the import. For the existing default agent, you can
instead open **Settings → Ask OpenClaw** and say `import memory`; this narrower
chat wizard requires completed onboarding, copies only new detected memory, and
reports per-source failures or possible partial copies. OpenClaw copies only
Markdown memory:

- Codex: the consolidated `MEMORY.md` and `memory_summary.md` files under
  `~/.codex/memories` (or `CODEX_HOME/memories`). Raw rollout and transcript
  files are not imported.
- Claude Code: Markdown files from each project auto-memory directory under
  `~/.claude/projects/*/memory`, plus a user-configured
  `autoMemoryDirectory` when present. Project instructions, sessions, settings,
  and credentials are not part of this memory-only action.
- Hermes: `MEMORY.md` and `USER.md` from the detected Hermes home. Config,
  credentials, and skills are not part of this memory-only action.

Imported files stay separate under `memory/imports/codex/` and
`memory/imports/claude-code/`, or `memory/imports/hermes/` in the selected agent
workspace. They are indexed for `memory_search` and available through
`memory_get`; they are not merged into the agent's bootstrap `MEMORY.md`. The
source files are left unchanged.

The preview marks destination conflicts. Enable **Replace existing imports** to
replace those files; apply creates a verified pre-import backup and preserves
item-level copies of overwritten files in the migration report.

## Action-sensitive memories

Most memories are ordinary Markdown notes. Some affect what the agent should
do later; for those, capture when it is safe to act on the note, not just the
fact itself.

Capture that action boundary when a note involves:

- approval or permission requirements,
- temporary constraints,
- handoffs to another session, thread, or person,
- expiry conditions,
- safe-to-act timing,
- source or owner authority,
- instructions to avoid a tempting action.

A useful action-sensitive memory makes clear:

- what changes future behavior,
- when or under what condition it applies,
- when it expires, or what unlocks action,
- what the agent should avoid doing,
- who is the source or owner, if that affects trust or authority.

Memory can preserve approval context, but it does not enforce policy. Use
OpenClaw approval settings, sandboxing, and scheduled tasks for hard
operational controls.

Example:

```md
The API migration is being designed in another session. Future turns should
not edit the API implementation from this thread; use findings here only as
design input until the migration plan lands.
```

Another example:

```md
A report from an untrusted source needs review before promotion. Future turns
should treat it as evidence only; do not store it as durable memory until a
trusted reviewer confirms the contents.
```

This is not a required schema for every memory; simple facts can stay concise.
Use action-sensitive boundaries when losing timing, authority, expiry, or
safe-to-act context could cause the agent to do the wrong thing later.

Use [scheduled tasks](/automation/cron-jobs) for exact reminders, timed checks,
and recurring work. Memory can still summarize the durable context around that
work.

## Memory tools

The active memory plugin (default: `memory-core`) supplies these tools when
their required context and permissions are available:

- **`memory_search`** — finds relevant notes using semantic search, even when
  the wording differs from the original.
- **`memory_get`** — reads a specific memory file or line range.
- **`memory_read`** — expands a memory-file `ref` returned by search. It defaults
  to the referenced excerpt; `from` and `lines` can select another bounded range
  in that file. Follow `nextRef` to continue reading. Each request checks the
  current Agent and conversation access; a reference is neither an access grant
  nor a frozen snapshot. Deleted files return `status=not_found`.
- **`memory_context_read`** — reads the current Workspace, Channel, optional
  Thread, and participant curated memories, with bounded pagination.
- **`memory_fragment_append`** — appends a dated note in the admitted Channel
  or Thread for later Dream consolidation.
- **`intent`** — creates, lists, or explicitly cancels event-conditioned
  standing intents. Time-based reminders continue to use scheduled tasks.

When session indexing is enabled, `memory_search` can also return session
transcript hits. Their `sessions/...jsonl` paths are search references, not files
that `memory_get` or `memory_read` can read, and they have no memory-file `ref`.
Use `sessions_search` with distinctive text from the
snippet (optionally scope `sessionKey` to the transcript ID), then pass its returned
`sessionKey`, `messageId`, and `sessionId` to `sessions_history` for a bounded,
sanitized excerpt. These tools enforce session visibility independently on each
request. Memory-search line numbers are not session-history offsets.

The recall prompt recommends only enabled tools. Without session-history tools,
report the excerpt limitation instead of reading raw transcript files.
`memory_get` reports unsupported paths as read errors, not missing arguments or a
globally disabled memory service. Memory-file reads and optional wiki reads keep
their existing range, continuation, and partial-corpus semantics.

## Memory search

When an embedding provider is configured, `memory_search` uses hybrid search:
vector similarity (semantic meaning) combined with keyword matching (exact
terms like IDs and code symbols). This works out of the box with an API key
for any supported provider.

<Info>
OpenClaw uses OpenAI embeddings by default. Set
`memory.search.provider` explicitly to use Gemini, Voyage,
Mistral, Bedrock, DeepInfra, local GGUF, Ollama, LM Studio, GitHub Copilot, or
a generic OpenAI-compatible endpoint.
</Info>

See [Memory search](/concepts/memory-search) for how search works, tuning
options, and provider setup.

## Memory engines

<CardGroup cols={3}>
<Card title="Builtin (default)" icon="database" href="/concepts/memory-builtin">
SQLite-based. Works out of the box with keyword search, vector similarity, and
hybrid search. No extra dependencies.
</Card>
<Card title="Honcho" icon="brain" href="/concepts/memory-honcho">
AI-native cross-session memory with user modeling, semantic search, and
multi-agent awareness. Plugin install.
</Card>
<Card title="LanceDB" icon="layers" href="/plugins/memory-lancedb">
LanceDB-backed memory with OpenAI-compatible embeddings, auto-recall,
auto-capture, and local Ollama embedding support. Plugin install.
</Card>
</CardGroup>

## Knowledge wiki layer

If you want durable memory to behave more like a maintained knowledge base
than raw notes, use the bundled `memory-wiki` plugin. It compiles durable
knowledge into a wiki vault with deterministic page structure, structured
claims and evidence, contradiction and freshness tracking, generated
dashboards, compiled digests, and wiki-native tools (`wiki_status`,
`wiki_search`, `wiki_get`, `wiki_apply`, `wiki_lint`).

`memory-wiki` does not replace the active memory plugin; the active memory
plugin still owns recall, promotion, and dreaming. `memory-wiki` adds a
provenance-rich knowledge layer beside it. You can browse the compiled wiki
in the Control UI under Memory → Dreams → Diary → **Memory Wiki**
([details](/plugins/memory-wiki#browsing-the-wiki-in-the-control-ui)).

<CardGroup cols={1}>
<Card title="Memory Wiki" icon="book" href="/plugins/memory-wiki">
Compiles durable memory into a provenance-rich wiki vault with claims,
dashboards, bridge mode, and Obsidian-friendly workflows.
</Card>
</CardGroup>

## Automatic memory flush

Before [compaction](/concepts/compaction) summarizes your conversation,
OpenClaw runs a silent turn that reminds the agent to save important context
to durable memory. Memory Core appends candidates to the current Channel or
Thread Fragment for later Dream consolidation. A selected
memory plugin can supply its own persistence tools. This is on by default; set
`agents.defaults.compaction.memoryFlush.enabled: false` to turn it off.
OpenClaw resolves when the flush runs from that host config and the active
context window. The selected memory provider supplies the prompts and
persistence target or tools. It inherits host timing unless it deliberately
overrides an optional timing field.

The flush uses a private copy of the conversation, so its housekeeping messages
never appear in later user turns, even if interrupted. Its writes to memory
are still saved normally.

Memory Core and native providers can use a tools-based flush without writable
workspace access in the inference sandbox;
other flush plans are not resolved for sessions that cannot write it. It exposes
`read`, the provider's declared persistence tools, and optional read-only lookup
tools, subject to normal tool policies. Those tools receive the source turn's
memory audience and sandbox state. Missing lookup tools produce a warning but do
not block a flush that can still persist. The flush is skipped if no valid
audience or permitted persistence tool is available. It succeeds when a
persistence tool completes without error or the agent returns `NO_REPLY`; lookup
success alone does not complete the flush. Skipping or failing this optional step
does not prevent compaction. Plugin authors can find the contract and retry
identity in [Pre-compaction memory flush](/plugins/sdk-overview/memory-and-context#pre-compaction-memory-flush).

With the session-memory hook enabled, a settled tools-based flush records a
`memory.pre-compaction-flush` Event in its granted Channel/Thread scope. It
records the source session, retry identity, and actual outcome without copying
the conversation. Source revocation and launch Channel exclusion prevent capture;
Event capture failure is logged without blocking compaction.

To keep that housekeeping turn on a local model, set an exact override that
applies only to the memory-flush turn (it does not inherit the active
session's model fallback chain):

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "memoryFlush": {
          "model": "ollama/qwen3:8b"
        }
      }
    }
  }
}
```

<Tip>
The memory flush gives the agent a chance to save important facts before
compaction summarizes the conversation. Check your memory plugin's saved notes
or records when you need to confirm that a fact was retained.
</Tip>

## Dreaming

Dreaming is the default background consolidation path for memory. It collects
short-term recall signals, scores candidates, and promotes only qualified
owner or agent-derived items into long-term memory (`MEMORY.md`):

- **Default on**: disable it with
  `plugins.entries.memory-core.config.dreaming.enabled: false`.
- **Scheduled**: when enabled, `memory-core` auto-manages one recurring cron
  job for a full dreaming sweep.
- **Thresholded**: promotions must pass score, recall-frequency, and
  query-diversity gates.
- **Consolidated**: a tool-free completion selects merges and supersessions
  after the deterministic gate. The memory writer composes the result from
  validated source evidence; invalid or unavailable decisions use append-only fallback.
- **Taint gated**: untrusted and system-derived candidates never enter the
  consolidation prompt or durable promotion path.
- **Reviewable**: phase summaries and diary entries are written to
  `DREAMS.md` for human review, including rewrite counts and highlights.

This background pattern follows the motivation behind sleep-time compute
(arXiv:2504.13171). Provenance-aware reflection also follows the durable
memory lessons of the Generative Agents research.

See [Dreaming](/concepts/dreaming) for phase behavior, scoring signals, and
Dream Diary details.

## Grounded backfill and live promotion

The dreaming system has two related review lanes:

- **Live dreaming** works from short-term dreaming state in SQLite plugin
  storage and is what the normal deep phase uses to decide what graduates into
  `MEMORY.md`.
- **Grounded backfill** reads historical `memory/YYYY-MM-DD.md` notes as
  standalone day files and writes structured review output into `DREAMS.md`.

Dreaming JSON journals from before July 2026 are no longer imported. The
migration check leaves `memory/.dreams/daily-ingestion.json`, `session-ingestion.json`,
`short-term-recall.json`, and `phase-signals.json` untouched. Existing SQLite
state remains authoritative. If Doctor cannot establish canonical state,
restore a backup from a July 2026 or newer release. An empty ingestion store
without a previous migration acknowledgement is indistinguishable from
unmigrated state; after verifying its SQLite state, back up and move the retired
JSON file aside, then rerun `openclaw doctor --fix`.

Grounded backfill is useful for replaying older notes and inspecting what the
system considers durable, without manually editing `MEMORY.md`.

```bash
openclaw memory rem-backfill --path ./memory --stage-short-term
```

The `--stage-short-term` flag stages grounded durable candidates into the same
short-term dreaming store the normal deep phase already uses; it does not
promote them directly. So:

- `DREAMS.md` stays the human review surface.
- The short-term store stays the machine-facing ranking surface.
- `MEMORY.md` is still only written by deep promotion.

To undo a replay without touching ordinary diary entries or normal recall
state:

```bash
openclaw memory rem-backfill --rollback
openclaw memory rem-backfill --rollback-short-term
```

## CLI

```bash
openclaw memory status          # Check index status and provider
openclaw memory search "query"  # Search from the command line
openclaw memory index --force   # Rebuild the index
```

## Further reading

- [Memory architecture](/concepts/memory-architecture): the storage, indexing, and retrieval layers behind every memory feature.
- [Memory search](/concepts/memory-search): search pipeline, providers, and tuning.
- [Builtin memory engine](/concepts/memory-builtin): default SQLite backend.
- [Honcho memory](/concepts/memory-honcho): AI-native cross-session memory.
- [Memory LanceDB](/plugins/memory-lancedb): LanceDB-backed plugin with OpenAI-compatible embeddings.
- [Memory Wiki](/plugins/memory-wiki): compiled knowledge vault and wiki-native tools.
- [Dreaming](/concepts/dreaming): background promotion from short-term recall to long-term memory.
- [Memory provenance and deletion](/concepts/memory-provenance): session lineage, admission policy, and `memory forget`.
- [Memory configuration reference](/reference/memory-config): all config knobs.
- [Compaction](/concepts/compaction): how compaction interacts with memory.
- [Active memory](/concepts/active-memory): sub-agent memory for interactive chat sessions.
- [User model](/concepts/user-model): directive-based durable preferences and profile facts.
- [Standing intents](/concepts/standing-intents): event-conditioned prospective memory.

## Related

- [`openclaw memory`](/cli/memory) — command reference for inspecting and editing memory
