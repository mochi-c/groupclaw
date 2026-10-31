---
doc-schema-version: 1
title: "Scoped memory design"
summary: "Proposed Workspace, Channel, Thread, User, Event, and Archive memory architecture with a source-backed implementation plan"
read_when:
  - Designing memory for assistants that participate in shared channels and threads
  - Changing memory bootstrap, flush, recall, indexing, or dreaming behavior
  - Migrating root MEMORY.md and date-based daily notes to scoped memory
---

# Scoped memory design

**Implementation in progress.** This document defines the target memory
architecture for GroupClaw and maps it to the current OpenClaw implementation.
It is based on source revision `031013a60bc41764bd4b4e8ba7043234f11551f0`
reviewed on October 6, 2026, with Phase 0 and the Workspace portion of Phase 1
started on October 7, 2026. The current-context read design was added on October
8, 2026. Discord current-context routing was strengthened on October 24, 2026,
against the latest available remote `main` (`646b87dccb7`).

Implemented through the current code slice:

- canonical `MemoryScope`, `ConversationMemoryScope`, and `MemoryTurnIdentity` contracts;
- one host-owned resolver for Memory, Event, Archive, and Fragment append paths;
- collision-resistant one-segment scope ID encoding;
- Workspace Memory reads and writes at `memory/MEMORY.md`;
- read compatibility plus Doctor migration for legacy root `MEMORY.md` and `memory.md`;
- Workspace Memory bootstrap in direct, Channel, and Thread conversations;
- memory indexing, watching, provenance, recall metadata, and public artifact discovery updated
  for the canonical Workspace Memory path.
- host-minted current Context metadata derived from the durable Session delivery origin and
  retained participant projection;
- `memory_context_read` with default all-layer reads, explicit `layers` and `userNames`
  narrowing, `summary` and `full` detail, bounded pagination, and audience revalidation after
  every file read;
- Event and Archive exclusion from current-context reads by construction, with Fragments
  recall-only and likewise excluded;
- `memory_fragment_append` as the only conversation-time memory write: one host-pathed
  append-only day file per admitted Channel or Thread (`Fragment/YYYY-MM-DD.md`), with each
  note appended sequentially as a timestamped entry through an atomic compare-and-swap
  replace; existing entries are never edited or deleted, and audience currency is
  rechecked before and after the write;
- ordinary file tools share the host's current-context path predicate and audience
  checks. Reads pin their actual source, listings hide other conversation scopes,
  and direct memory writes, patch creates, moves, and deletes are refused.
  Conversation execution uses the independent project boundary described below.
- conversation-scoped discovery has a separate authorized corpus from current Context.
  `memory_search`, `memory_get`, and `memory_read` admit public sibling Channels and
  Threads from the same configured group using current policy and durable source facts.
  Ended/reset sources are re-admitted from their recorded origin and participants.
  Private or unverified Threads, other groups, launch Channels, and legacy loose files
  stay excluded. Source grants remain held through provider work, deadline fallback,
  exact reading, and result publication; unscoped callers keep their operator view.
- `memory_read` expands versioned, bounded memory-file references returned by
  `memory_search`, using the same exact reader and scoped path policy as
  `memory_get`. References bind Agent ownership and excerpt range, never grant
  access, and read the current file. `nextRef` continues bounded reads; current
  audience authority is rechecked before reading and before returning content.
  Session and wiki search hits do not receive memory-file references.
- scoped search applies the admitted path predicate before keyword, filename, and
  vector candidate limits, so excluded Channels cannot consume the 200-candidate
  budget. The sqlite-vec path widens its nearest-neighbor window and falls back to
  a complete filtered scan when its 4096-neighbor limit would hide matches.
  Final results and partial keyword snapshots still pass audience authorization.
- Discord parent Channel persistence for native Threads, forum posts, and automatic Threads;
- ordinary-message and native-command conversation links through one Discord resolver;
- stable User IDs through the Session participant identity owner, with observed participant
  coverage explicitly reported as partial.
- explicit `session.identityLinks` shared by conversation admission and Dream for
  platform participant identities; linked aliases share one User memory identity,
  display names never establish links, and background authority is revoked when
  the configured links change. Links do not rewrite Session participant records
  or implicitly merge local profile identities.
- Workspace-wide incremental Fragment Dream for configured Discord groups, using one
  SQLite-backed notebook and serialized job per Workspace;
- scoped Memory and Archive publication, exact covered-entry cleanup, pending-publication
  recovery, and source-dependent forget, with current Session and config authority rechecked
  before effects;
- citations and full Fragment coverage are separate plan fields. Pending plans
  retain `coveredSourceIds` and explicit discard receipts; cleanup requires these
  receipts and no unfinished topic dependency. Older destructive plans without
  coverage are deferred with their sources intact.
- a Workspace with Fragment notebook state uses only the Fragment Dream lane.
  Shared group/channel transcripts are excluded from legacy ingestion even before
  the first Fragment. Legacy direct-session processing keeps its existing owner.
- session forget deletes unchanged Event artifacts using host-held path/hash
  receipts and purges their index entries. A changed Event defers deletion before
  file mutations; its receipts remain available for an authorized retry.
- Dream exclusion of launch Channel and private or unverified Thread evidence, with
  compatible group boundaries enforced during analysis and publication.
- independent audience batches continue after inference or plan-validation failure;
  deferred sources remain intact for a later pass, while durable pending publication
  and service revocation stop further batches.
- Discord-owned configured member resolution shared by conversation admission and Dream;
  silent configured members remain readable, observed Thread contributors supplement the
  roster, and private or unverified Threads never inherit the parent member set.
- launch Channel exclusion from current-context reads, scoped Markdown search/get, and
  Fragment append; public Threads retain their structural parent and their own memory.
- launch Channels and their ordinary Thread routes stay separate even with `groupScope: main`;
  native and automatically created Threads omit parent transcript inheritance while retaining
  parent model/configuration inheritance. Explicit focused session bindings remain operator-owned.
- session-memory reset and rollover output now uses scoped Event files with
  host-assigned identity, immutable timestamp, source session references, and
  separately classified transcript trust; automatic reset dispatch preserves
  the departing entry's delivery identity. Concurrent captures publish
  exclusively, and a missing group/channel origin cannot fall back to Workspace.
- successful standalone and automatic embedded compactions create scoped
  `session.compacted` Events with bounded excerpts and available metrics;
  standalone compaction retains the source Workspace for Event publication
  while sandbox execution and plugin hooks keep their prepared execution directory.
  Discord Thread closures create `thread.closed` Events only after guarded
  deletion commits, using the actual deleted entry and retained archive
  generation references. Failed or rejected operations create no completion Event.

Conversation-side prompt and tool guidance now asks focused questions for ambiguous
subjects, identity, scope, confidentiality, or claims, records clear corrections without
redundant confirmation, and preserves both sources plus any remaining uncertainty.
Confidential facts cannot be written into shared memory. This guidance leaves semantic
judgment with the agent and Dream; live model-quality validation remains pending.

The file-backed memory runtime now receives host-minted audiences through its explicit
runtime opt-in. Conversation tools require an audience, while sessionless and one-shot
CLI callers retain their operator path. Audience-aware tools-arm flushes can run in a
read-only sandbox; file-arm flushes still require a writable workspace.

## Conversation project execution

OpenClaw conversation audiences retain scripts and builds in an independent
Docker or Podman project. The sandbox owner binds its directory and runtime to
the exact session incarnation, overriding configured sandbox disablement,
shared scope, and writable access to the agent workspace. Missing admission
denies a scoped group/channel run. Host placements cannot supply this project.
Provisioning rechecks both run and audience authority after asynchronous work.

The project begins empty. It does not clone or mount the agent workspace,
Memory, bootstrap files, private skills, attachments, GitHub identity, host
environment, or configured extra mounts and setup commands. File tools use the
project bridge and permission root. Dedicated Memory tools retain the source
workspace and its audience; their data is never mounted for shell access.
Automatic source import and writeback are outside this slice.

The final tool policy caps all configured and additional grants. Client
functions, host MCP/LSP, desktop, browser, nodes, and session spawning cannot
enter the project execution surface. Explicit ordinary bridge networking is
retained; host or custom network namespaces are capped to no network.
Container resource limits, image, user, and working-directory choices remain
with the existing sandbox owner.

Session-generation publication and current membership changes revoke the
audience's execution signal, including delegated lineage. Restoring former
membership configuration does not revive a revoked audience; a new admission
must mint a new grant. Execution checks revocation before preparation and at the
final native spawn boundary, so revocation during preparation prevents launch.
Each admitted run owns its process scope and joins cancellation and backend finalization before
release. Normal script completion also starts the existing targeted descendant
cleanup. That cleanup relies on the inherited execution marker; processes that
deliberately remove it are outside the proven cleanup contract. Real container
execution, surviving-process inspection, and live Discord acceptance remain
required evidence. An unavailable container runtime reports a provisioning
failure and does not fall back to a host shell.

Local verification covers 11 isolation negative controls, session-generation and
membership revocation, cancellation before native spawn, and joined process
settlement. Search and Context consumers were reverified with the authority
repairs. Regression batches are bound to their recorded inputs and overlap;
they are not added into one total. The selected native checks and the full build,
including declarations, pass with independent compiler dependencies. This local
evidence does not establish real container behavior, live Discord delivery,
model recall semantics, published-driver recovery, or independent review.

Memory Core now supplies a tools-arm pre-compaction plan using the existing
Fragment writer and scoped lookup. Host timing replaces the plugin's duplicate
budget calculations. With the session-memory hook enabled, runs first record
`memory.pre-compaction-flush` Events under the source audience's Channel/Thread
scope, with original session references, flush/retry identity, and actual
processing state; settlement updates the same artifact with the actual outcome.
Events contain framework metadata, while Fragment candidates remain
separate Dream inputs. Capture requires the live source grant through publication
and never falls back to a Workspace daily file.

The internal Event owner now serves reset, rollover, compaction, Thread closure,
and pre-compaction flush writers. Updates are bounded to state and outcome,
retain immutable source metadata and payload trust, reject terminal or concurrent
updates, recheck source authority at publication, and preserve prior human edits.
Filesystem publication is atomic but does not offer a cross-process byte compare-and-swap.
Bootstrap now reads curated Channel, Thread, and participating User summaries
from the run's existing host audience. Scoped records refresh each turn outside
the shared bootstrap cache, retain provenance filtering, reject filesystem
aliases and hook substitutions, and recheck the audience after hooks. Their
12,000-character pool is independent of project instructions: Thread and Channel
summaries each receive up to 2,000 characters, and each User up to 1,000.
Native harnesses use the existing memory-reference carrier for these files.

Native harness compaction Events remain pending. Dream now consumes settled
lifecycle Events using exact, provenance-bound source receipts retained in the
existing notebook. Ended-session admission uses canonical origin and participant
facts captured by the lifecycle owner. The permission-scoped `session_end`
consumer also marks existing Fragments ended and captures a bounded native tail
when no ended Event receipt exists. It does not synthesize an empty Event when
the reader is unavailable. A Fragment path or source ID never grants publication
authority.
`memory_get` retains its exact path-based excerpt contract, and `memory_read`
adapts artifact references to that same authorized reader. `threadMode` now controls
Thread creation as well as memory participation: `never` suppresses creation,
`auto` uses a bounded semantic suitability decision, and `always` creates or
reuses the initiating message's Thread. Failed required creation stops before
agent ingress and explains how to retry. Native commands in an `always` parent
require an existing Thread because Slash interactions have no initiating-message
anchor. When `threadMode` is omitted, legacy `autoThread` behavior remains.
`replyMode` and reuse of unrelated existing topic Threads remain proposed.

Memory admission resolves verified platform links through the Profile identity
owner. Unlinking a person or changing the configured group invalidates retained
memory grants; reverting the configuration does not revive them. Public Thread
contributors admitted by the host are also eligible User publication subjects.
Existing User files are not automatically merged or migrated after identity
changes.

Fragment Dream uses the current Deep phase's model, thinking level, output-token
budget, temperature, and timeout, including numeric execution defaults inherited
by the phase. Speed defaults map to 60/120/240-second timeouts, and budget
defaults map to 4,000/8,000/16,000 output tokens. Each resulting publication is
capped at 48,000 characters after covered-entry removals. Exceeding that bound
defers the plan and preserves its sources and prior target; existing oversized
targets remain deferred.
Configured-group admission is currently Discord-specific;
other channel integrations
defer Fragment processing and block Workspace publication. Scope columns in the memory index are deferred until path-prefix
filtering shows measured need. The existing `owner-private` provider audience remains
temporarily in place for legacy transcript search behavior. Direct messages already receive
Channel-shaped current Context; Markdown recall uses the admitted scoped path policy.

The target model has one global Workspace memory, conversation memory organized
as Channel then Thread, and User memory bound to an authenticated person. It
does not define Organization, Tenant, PlatformSpace, or special private-chat
memory classes. Direct messages are Channels. A Thread always belongs to a
Channel.

The design separates four artifact kinds:

- **Fragment** is a dated, temporary note the agent appends during a
  conversation to the current Channel or Thread; it records the situation as
  observed and is the raw material for Dream.
- **Memory** is compact, curated knowledge loaded or recalled as context; only
  Dream writes it, consolidating Fragments and other evidence by scope.
- **Event** records one framework-generated trigger and its processing result.
- **Archive** preserves a Dream-produced summary of a completed or bounded
  event or activity with clear evidence that it has ended.

Recent unprocessed Fragments are Dream's primary input. Existing Memory, Events,
Archives, and source transcripts are read when needed to interpret that input.
Archives are primarily retrieval artifacts, not a corpus Dream routinely
reprocesses. Fragment, Event, Archive, and Dream working notes are never
automatically injected as long-term conversation context.

## Confirmed product behavior

The October 24 questionnaire supersedes earlier proposals about participation,
confidential User facts, conflicts, Channel launch behavior, and Archive
producers. These are confirmed requirements, not implementation claims.

GroupClaw is a collaboration partner in a fixed small group. Conversation is
the primary interface for remembering, inspecting, correcting, and undoing
knowledge. The first complete journey is shared planning: a discussion
establishes preferences and Thread decisions, a later discussion recalls them
with their origin, and a participant corrects them through conversation.

The October 29 clarification confirms one family with a fixed membership set.
Multiple chat groups and Channels organize topics and conversation context;
they are not separate audiences requiring separate personal memory. One shared
Workspace Memory and one User Memory per person are intentional. Channel and
Thread memory keep the current discussion focused, while explicit retrieval and
Dream can connect authorized knowledge across the family's discussions.
No per-chat-group User partition, separate-Workspace deployment, or group-based
migration is required for this product scope. The configured `members` on these
Channels should describe the same fixed family roster.

### Reply and Thread configuration

Each Discord Channel independently selects a Thread mode. `threadMode` is
implemented; `replyMode` remains a proposed setting.

| Proposed field | Value       | Observable behavior                                                                                                |
| -------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `replyMode`    | `mention`   | Respond when explicitly addressed.                                                                                 |
| `replyMode`    | `always`    | Respond to admitted messages without requiring a mention.                                                          |
| `replyMode`    | `selective` | Consider unmentioned discussions and respond when a contribution helps.                                            |
| `threadMode`   | `never`     | Do not create a Thread for a reply; continue within existing Threads.                                              |
| `threadMode`   | `auto`      | Semantically select creation when a separate ongoing topic helps; reuse an initiating message's associated Thread. |
| `threadMode`   | `always`    | Put each Channel reply in a Thread associated with its initiating message.                                         |

**Assumption to verify in use:** explicit addressing means mentioning the bot
or replying to its message, rather than requiring both. Selective participation
is useful when it answers a question, supplies relevant authorized knowledge,
identifies a decision conflict, or advances planning. Social acknowledgments
and unrelated conversations do not require a reply. Thread suitability is a
semantic decision, not a text-length or keyword threshold.

One initiating Discord message has at most one associated Thread. Follow-ups
stay there; streamed chunks do not create separate Threads. Unsupported
destinations and permission failures have a visible outcome. In `always`,
failed Thread creation must not silently publish a normal Channel answer or
store Channel memory.

The `always` Channel is a launch entry only. Its identifier still owns routing,
access policy, member bindings, and the structural Thread parent relationship,
but contributes no Channel memory. Bootstrap, context reads, writes, search
selection, and Dream consolidation all exclude that Channel's memory:

```text
launch Channel → current Thread
context = Workspace + Thread + participating Users
```

This restriction does not erase earlier Channel artifacts or move Thread
directories. A requested Channel-memory write explains the Thread-only behavior
and offers the current Thread. Model and configuration inheritance may still
consult the parent; transcript and memory inheritance may not.

### Participants and personal knowledge

Participants include every member bound to the Channel plus additional Thread
participants. Observed speakers alone are not a complete roster. Missing
membership facts produce explicit partial coverage and do not prevent an
otherwise possible reply.

The existing Profile and platform-account identity owner supplies stable people
and verified links. Labels and nicknames are lookup aliases, never merge
authority. Equal nicknames require clarification. Account links retain the
identity owner's verification and revocation rules; memory does not introduce a
competing person registry.

Personal profiles are shared within the authorized fixed group. Facts
explicitly marked confidential are excluded from shared profiles, summaries,
and cross-discussion recall. A confidentiality change requires confirmation
before visibility changes. Until an authorized private destination exists,
confidential persistence must be declined with an explanation.

### Remembering, correction, and recall

During a conversation the agent's only memory write is appending a Fragment
entry to the current Thread's dated day file, or to the current Channel's when
there is no Thread. A Fragment is a simple, timestamped note of the situation
as observed: what was said or decided, who said it, source message links, and
optional subject hints. Notes from the same day append in sequence to one
`Fragment/YYYY-MM-DD.md` file. The agent decides what is worth recording and
announces what it noted. Ambiguous subject or scope is clarified in
conversation; the latest sender is never an automatic subject. The agent never
writes curated Memory, never edits or deletes a Fragment entry, and never
writes outside the current conversation scope.

Persistent knowledge in every dimension is Dream's responsibility. Dream
summarizes, organizes, promotes, discards, and archives evidence. An explicit
fact or decision is not automatically durable knowledge: ordinary availability,
one-off plans, and discussion details normally remain in Fragment or current
conversation context. Dream autonomously selects knowledge with continuing
value, normally promoting through Thread, parent Channel, then Workspace.
Strong evidence of wider applicability permits a direct broader target. User
knowledge follows the authenticated subject identity rather than this ladder.

Dream manages memory, not the group's business decisions. It may represent a
correction or an unresolved conflict faithfully, but does not choose a new plan,
contact participants, or initiate a confirmation workflow. The conversation
agent handles questions when the discussion needs them and records answers as
new Fragments. Confidentiality changes still require authorized confirmation;
autonomous promotion never grants wider access to restricted evidence.

Correction is new evidence rather than undo of a stored revision: when a
participant says a fact is wrong, the agent appends a correction Fragment and
Dream updates curated Memory, citing both sources. Exact revision-level undo is
deliberately unsupported. The transcript remains the raw chronological record;
Dream may clean covered Fragment entries after their replacement is durable.
Removing a fact uses the existing forget owner.

Cross-discussion recall searches only currently authorized knowledge, cites its
origin, and explains partial or stale results. Recalled memory is not new
evidence of the recalled fact. Group members jointly maintain authorized shared
memory; participation grants no access to confidential facts or unbound groups.

### Dream and Archive

Only background Dream publishes a formal Archive. A request such as "summarize
this discussion" produces a transient answer. It may become evidence for a
later Dream pass, but never directly creates an Archive. Reset, compaction, and
Thread closure produce Events.

Dream has a Workspace-wide working view of authorized recent, unprocessed
Fragments and one independent working notebook for that Workspace. Source
scopes remain attached to every item; broad analysis does not imply broad
publication authority. Launch Channels are never consolidation or intermediate
promotion targets.

Archive collects substantial, coherent accounts of clearly ended matters.
Dream decides whether the evidence establishes completion; inactivity alone
does not. Published Archives are primarily searched and recalled. Genuine
later additions may be appended, but routine rereading, rewriting, and merging
Archives are not part of the Dream sweep. Promoted Memory may reference an
Archive for the detailed case behind a compact claim.

After successful summary, promotion, or archival publication, Dream removes
covered duplicates from lower-level Memory and Fragments. Unique context,
exceptions, and unresolved matters remain unless also preserved in the result.
Publishing a Memory entry does not require inventing an Archive.

### First complete planning journey

1. An admitted planning message starts a Thread when required. The reply
   explains unavailable roster or memory facts.
2. A participant states a preference and the group agrees on a plan. The agent
   appends dated Fragments to the planning Thread, distinguishing subject from
   contributor and linking the source messages.
3. Dream retains the one-off plan as working evidence and may promote a
   durable personal preference to User Memory. A later Thread recalls the
   authorized evidence with its origin.
4. A conflicting correction stays unresolved unless the conversation supplies
   enough evidence to resolve it. Dream does not decide the activity's new plan.
5. Answers are appended as new dated Fragments; a later Dream pass reconciles
   the memory representation. There is no revision-level undo.
6. Once the activity clearly ends, Dream may publish its coherent Archive,
   link reusable Memory to it, and clean covered lower-level material.

The current routing, context-read, Fragment-append, and Discord Dream slices
support identity, temporary notes, scoped publication, recovery, and cleanup.
Complete conversation membership, authorized automatic recall,
and conversation Channel modes remain
implementation work. Local background-flow tests cover the Dream slice;
live Discord and model-quality validation remain separate proof.

### Storage implementation decision for review

The October 24 discussion approves autonomous, normally gradual promotion,
cleanup of covered lower-level material, completed-matter Archives, incremental
Fragment input, and independent Dream working notes. The concrete persistence
proposal below records the wider target design. The incremental Dream subset
was accepted on October 25 and is implemented as described in the next section;
The Event and ended-session source persistence extension was accepted on
October 27. Conversation-policy changes remain proposed.
It supersedes the earlier confirmation-only promotion and immutable-Fragment
lifecycle proposals.

The conversation agent only appends dated Fragment files. Dream owns curated
publication and subsequent cleanup. `dreaming-state.ts` remains the coordination
owner; working notes and processing progress use its SQLite-backed plugin state,
not new Markdown, JSON, or JSONL sidecars. Namespace, value-contract, cleanup,
and recovery changes beyond the accepted incremental Dream subset require
material-storage acceptance before implementation. The October 27 acceptance
extends this same store with producer-captured Event identities, exact content
hashes, canonical departing-session delivery and participant facts, and complete
model-input receipts for pending publication. These facts describe evidence;
the current channel policy and the existing session-generation owner grant
publication authority anew on every pass and recovery. No roster table, competing identity database,
revision lineage, or separate recovery database is proposed.

| Responsibility                             | Existing owner to extend                                            | Proposed change                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Person and linked platform accounts        | `src/state/user-channel-identity-operations.ts` and Profile storage | Resolve verified links and aliases through this owner; no new person table.                                                                               |
| Bound Channel group and per-Channel policy | Channel config owner                                                | Declare the fixed bound member set (stable platform user IDs), `replyMode`, `threadMode`, and launch-only policy in config; no roster table.              |
| Observed conversation participants         | channel ingress and Session delivery/participant owners             | Additional Thread participants stay observed facts in the existing Session participant table with explicit coverage; never a roster.                      |
| Agent temporary memory                     | `src/memory/scoped-memory.ts` path owner and atomic file writer     | Add a Fragment artifact kind: the agent appends timestamped entries to one dated Markdown day file under the current Channel or Thread, and nothing else. |
| Persistent memory by dimension             | memory-core Dream scheduler, promotion writer, decay/forget owners  | Dream consolidates Fragments and Events into Workspace/Channel/Thread/User `MEMORY.md`; existing decay and forget owners own Fragment aging.              |
| Search and recall                          | memory-host SDK index and memory-core index publication             | Filter by canonical scoped path prefixes with no schema change; add derived scope columns only if measured need is demonstrated.                          |
| Consolidation and Archive                  | memory-core Dream scheduler and promotion writer                    | Group by authorized target scope, exclude launch Channels, and publish Archives only from background passes.                                              |

The fixed small group is operator-authored config, not a synchronized database
table. A Channel binding declares its complete bound member set by stable
platform user ID, along with its reply/Thread modes and launch-only policy;
config revision is the authority revalidated at admission and before write
effects. The Session participant table remains the owner of observed
contributors: additional Thread participants observed through delivery extend
the bound set for that Thread only, are marked partial coverage, and never
rewrite the configured roster. Private-thread membership restrictions remain
authoritative even when a Channel has a larger bound group. Identity-link or
config membership changes take effect on the next admission; they do not
migrate or revoke already published Memory, which is re-authorized at read
time instead.

A Fragment is one timestamped entry inside a single append-only day file under
the current conversation scope: `Fragment/YYYY-MM-DD.md` in the configured
timezone, for example
`memory/Channel/<id>/Thread/<id>/Fragment/2026-10-24.md`. Every note from one
day appends sequentially to that file as a `## HH:MM — Optional Title` entry
followed by the note body; the model never chooses a filename, title slug, or
destination. The entry body is a plain situation note: observation or
decision, contributor, source message links, and optional subject hints.
The model does not author processing IDs, status fields, hashes, or lineage.
The host adds entry markers and stores source receipts in plugin SQLite so
recovery and cleanup can distinguish identical concurrent notes. Appending
an entry is the only conversation-agent write: that agent never edits,
overwrites, or deletes existing entries. Dream may later remove or summarize
entries through its separately authorized cleanup owner. Each append
publishes through an atomic compare-and-swap file replace (read current bytes
plus hash, temp-file write, hash-checked rename) with bounded retries, so a
crash leaves either the previous complete file or the new complete file;
concurrent appenders re-read and retry rather than dropping an entry.

Fragments are temporary working material, not curated context: they are not
bootstrap-injected, they are recallable within their own scope while retained,
and they are Dream's incremental input. Successful processing permits cleanup
of fully covered entries; unprocessed or uniquely useful evidence is not
discarded merely because it leaves a recent-input window. This cleanup-contract
change is part of the incremental Dream acceptance recorded below. No fixed time-based
expiry or permanent Fragment retention guarantee is proposed.
Only Dream writes scoped `MEMORY.md`, using the validated publication owner,
and only background Dream publishes Archives. Unfinished organization work
persists in Dream's independent notebook; unresolved business decisions remain
unresolved in the evidence. Confidentiality changes keep their existing
conversation-confirmation boundary.

Correction is a newer Fragment, never an in-place undo. Dream reconciles
curated Memory from the dated evidence and cites sources; removing an accepted
fact uses the existing forget owner. There is deliberately no revision-level
undo and no guarantee of reconstructing an arbitrary earlier Memory state.

Scope-based authorization uses the canonical path hierarchy
(`memory/Channel/<id>/Thread/<id>/...`): the index filters artifacts by the
admitted scope prefixes before returning snippets, using existing hashes and
paths as artifact identity, never as access grants. This adds no schema,
migration, or index-table storage in the first version. Unclassified legacy
data remains `legacy-unscoped`; migration does not guess its person, Channel,
or Thread, and shared automatic recall excludes it until an explicit migration
establishes its scope. Existing evidence deletion removes its Fragment or
Memory file through the existing deletion owner and drops it from filtered
results.

Upgrade does not bulk rewrite existing curated bytes or identity links.
Background passes introduce scoped publication and covered-source cleanup only
after the new state contract is admitted. Disabling Dream stops these effects
and leaves published Markdown readable. Rolling back code does not reconstruct
cleaned Fragments; existing backups and transcripts are recovery inputs, not a
promise of exact revision-level restoration.

Validation must exercise the real planning flow, launch-only read/write/search
exclusion, ambiguous names, same-subject conflicts confirmed entirely through
conversation, authority revocation before a Fragment append, concurrent
Fragment appends landing as sequenced entries in the same day file without a
lost note, crash during an append's atomic replace, correction through a newer
entry, source deletion and forgetting, and legacy unscoped reads. Discord API and live-channel proof require separate
isolated credentials and per-task authorization; local mocks establish only
the channel boundary.

## Workspace-wide incremental Dream proposal

**Accepted for implementation, October 25, 2026.** The maintainer approved this
proposal with “继续推进吧。” after reviewing the broad Dream design. The existing
plugin SQLite state owns a versioned notebook, source receipts, and pending
publications; no database schema version changes. State capacity rejects new
records rather than evicting progress. Missing source or audience facts defer
processing without deleting files. Disabling Dream preserves this state and
Fragments; explicit forget removes dependent state and published content.
Rollback preserves both source files and pending publication receipts. A host
without this Dream lane continues to read Markdown; a version 1 notebook reader
refuses version 2 rather than replaying incomplete recovery evidence.

Dream works across a
Workspace so it can discover reusable knowledge between discussions. Thread,
Channel, User, and Workspace are destinations and evidence boundaries, not
separate isolated Dream notebooks.

### One broad working view, explicit publication targets

The scheduler admits one Dream job per physical Workspace at a time, using the
existing coordination owner. Agents sharing that Workspace do not independently
rewrite the same working notes or artifacts. Work continues across bounded
passes; a large analysis scope does not require loading all history into one
model call.

```text
Recent unprocessed Fragments from admitted Threads and Channels
                      + independent Dream notebook
                      + relevant Memory / selected source detail
                                      |
                          Workspace-wide organization
                                      |
         retain / summarize / promote / discard / archive
                                      |
                   validate and publish exact targets
                                      |
              record results, then clean covered sources
```

The host admits readable evidence and writable targets from current owner-held
authority. Workspace breadth is not a new superuser grant. Private Threads,
confidential facts, and unrelated group boundaries remain enforced. Evidence
with incompatible audiences cannot be combined in a shared model context or
published to a broader destination. Where required, a Workspace job uses
separate authorized analysis batches and notebook sections.

Launch Channel artifacts remain excluded. Its admitted Threads can contribute
evidence and promote directly to an otherwise authorized Workspace target
because the parent Channel is not a memory destination. Existing artifacts
under a launch Channel are not automatically deleted. Missing launch-policy or
membership facts produce a deferred operation with a reason, not a fabricated
permissive policy.

### Incremental inputs and continuity

Primary inputs are complete, recent Fragment entries not yet processed by Dream,
selected across the Workspace. Existing Memory is loaded by relevance to those
entries. Events and transcript excerpts supply missing context when needed;
Archives are selected by reference or retrieval. Memory reads, notebook reuse,
and Archive retrieval are never counted as fresh independent evidence.

The current Fragment lane reads admitted scoped Memory and its own referenced
Archives and settled lifecycle Events with host-held source receipts. On-demand
transcript expansion and retrieval-selected Archives remain proposed extensions.

Current Fragment lane budgets use character and byte bounds:

| Budget                       | Current bound                                       | Behavior at the boundary                                          |
| ---------------------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| Preferred recent window      | 14 days                                             | Prioritize recent input; keep older unprocessed backlog eligible. |
| Selected fresh input         | Up to 80 entries per Workspace selection            | Reserve capacity for unfinished work and rotate remaining scopes. |
| Fragment text per model call | 64,000 characters                                   | Omit whole entries without marking them processed.                |
| Persistent working notes     | 16,000 characters of topic text                     | Reject oversized state and preserve sources.                      |
| Serialized notebook          | 900,000 bytes                                       | Reject oversized state and preserve pending work.                 |
| Publications per plan        | 8 files, 300,000 characters of preimages and output | Reject an oversized plan before publication.                      |

These are engineering defaults, not minimum evidence thresholds or expiry rules.
Reserve part of each pass for the oldest pending work and rotate source scopes
so a busy Channel cannot indefinitely displace quieter ones. Budgeting never
marks omitted input as processed. No new model call is needed when there is no
new input, unfinished work, or pending publication recovery.

A day file is a container, not a processing unit. Each admitted snapshot records
complete entry boundaries and host-held source references. A file hash or mtime
alone cannot identify processed entries after cleanup or a concurrent append.
Processing progress records exact selected entries, including occurrence
identity for repeated identical notes. Host references remain outside the
Markdown contract and are not permission grants. A changed or unresolvable
entry is reread or deferred; guessed line offsets are never deletion targets.

An item retained for an ongoing matter can be processed without being promoted.
It stays available for recall, with an unfinished-work reference when further
organization is useful. New evidence can reopen that matter. The notebook must
not copy every retained Fragment just to avoid selecting it again.

### Independent working notebook

Dream owns one logical notebook per Workspace, maintained through Dream-only
tools. It is a continuity aid, not curated user memory, an Archive, or a diary
of every run. The conversation agent cannot read or write it.

The notebook contains concise unfinished topics, relationships between evidence,
summary or Archive drafts, promotion candidates, unresolved representations,
and references needed to continue. Related topics may span several Threads
and Channels. Each topic retains its evidence audience so that subsequent
reads and writes can be reauthorized. Finished topics are removed.

Store its Markdown-formatted text and versioned processing metadata in the
SQLite-backed plugin state owned by `dreaming-state.ts`. Do not create
`Dream.md`, JSON checkpoints, per-scope notebook files, or a second database.
Use a plugin-owned logical namespace if needed, with its admission and lifecycle
contract reviewed before implementation. Keep it excluded from memory indexing,
ordinary tools, bootstrap, Active Memory, exported public artifacts, and public
Dream reports. Forgetting source evidence also clears dependent working notes.

Working notes can be compressed, but references to unfinished sources and
outstanding writes must not silently disappear at the token or store-capacity
boundary. Notebook eviction cannot be the processing checkpoint. If durable
state cannot be saved, leave source material untouched and record the failure.

### Content decisions and promotion

Dream chooses among these outcomes; a pass can produce none of them:

| Outcome                | Use                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| Retain                 | Useful temporary material or an ongoing matter that needs no durable promotion.             |
| Summarize and organize | Combine related working material while retaining its unique information and open questions. |
| Promote                | Extract knowledge expected to remain useful in its target scope.                            |
| Discard                | Remove redundant, valueless, or fully covered material within the admitted cleanup scope.   |
| Archive                | Preserve a substantial coherent matter whose completion is evidenced.                       |

Clear wording, repeated mentions, or a resolved one-off decision do not by
themselves justify promotion. Dream evaluates continuing utility and applicable
scope. Default conversation promotion is Thread to its parent Channel, then
Workspace. A local plan does not become a Channel rule simply because it was
agreed upon.

Strong signals can justify skipping levels: an explicit Workspace convention,
an unequivocally global constraint, or independently supported cross-Channel
knowledge. Dream selects from host-admitted targets and states why the broader
scope applies. A direct broader target does not require writing duplicate
intermediate entries. Personal knowledge goes to the authenticated subject's
User Memory; it is not a Channel rule and is not assigned to the latest sender
by default.

The broad working view allows related observations in different Threads to
support Channel knowledge, and observations in different Channels to support
Workspace knowledge. A wider target still requires appropriate visibility and
provenance. Frequency is supporting evidence, not authorization or an automatic
promotion quota.

Dream may faithfully summarize changed facts and explicit corrections.
When the evidence still conflicts, it retains the uncertainty rather than
choosing what participants should do. It does not send questions, schedule
actions, or convert a personal constraint into an agreed group decision.

### Archive and covered-source cleanup

Archive publication needs a coherent, substantial matter and evidence that it
ended. Dream can infer completion from a delivered outcome, resolution,
explicit cancellation, or a completed stage. Silence or Thread closure alone
does not establish that the underlying work finished. Open matters stay in
working evidence or the notebook.

Archive holds the fuller account; Memory holds reusable knowledge. A promoted
entry can cite one or several authorized Archives for its examples and origin.
An Archive may be created without promotion, and promotion without an Archive.
Later new evidence can append a dated addition to a selected Archive. Published
Archives are not periodically scanned for reorganization.

After a summary, promotion, or Archive covers source content, clean that content
from Fragments and lower-level Memory. Do not leave repeated copies at every
level. Retain specific exceptions and unfinished matters not covered by the
result. Direct discard needs no replacement artifact when the material has no
remaining value; it is still an explicit, host-validated cleanup operation.

Routine Dream cleanup is different from forgetting. Removing a processed
Fragment must not invalidate the Memory or Archive that successfully replaced
it. Before cleanup, results must retain resolvable Archive, transcript, or
message references sufficient for their source and forget contract. If their
only usable citation still points to the Fragment being removed, defer cleanup.
Explicit forget continues through the existing deletion owner, clearing
dependent Memory, Archives, notebook topics, checkpoints, and pending writes
within its authorized selector.

### Publication, concurrency, and recovery

The model returns structured content and operations against host-provided
artifact and entry references. Host tools own paths, identity, authorization,
source matching, output size, atomic writes, and cleanup. The conversation
agent never receives these publication or cleanup tools.

1. Admit a bounded source snapshot and existing target versions.
2. Build and validate the organization plan; persist only the unfinished work
   and outstanding operation facts needed to resume through the existing state
   owner.
3. Revalidate current authority immediately before each effect and atomically
   publish each target through the publication owner.
4. Record verified publication outcomes. If one source feeds several required
   outputs, wait for all those outputs before cleaning that source.
5. Reread cleanup targets and compare exact covered entries. Preserve concurrent
   additions, unrelated edits, and entries not present in the admitted snapshot.
6. Apply validated cleanup and save processing progress and remaining notes.

Several Markdown files and SQLite state do not form one atomic transaction.
The recovery contract therefore favors temporary duplication over source loss.
A crash after publication but before cleanup leaves both copies. Resume verifies
the original target's recorded outcome before retrying; it must not append a
duplicate Archive, blindly replay a write, or overwrite a later operator edit.
A source changed during analysis is reread before destructive cleanup.

Publication `sourceIds` establish provenance; `coveredSourceIds` certify full
preservation of a Fragment's useful content. Explicit discard supplies a separate
cleanup basis. A retained topic or partial publication keeps its original Fragment
readable for later organization and complete Archive coverage. Recovery validates
these same receipts before publication or cleanup. Older pending plans that
request cleanup without full coverage remain deferred; operators must resolve the
recorded plan using its preserved evidence before further Workspace processing.

An inference, admission, or plan-validation failure before a pending plan is
durable defers only that audience batch. Preserve its Fragments and processing
state, record the reason and next-pass retry, and continue other admitted batches.
The single Workspace notebook remains the recovery owner: if it contains a
pending plan after any failed batch, stop the Workspace pass and recover that
plan before starting another batch. A service generation change or disabled
Dream stops the pass even when no pending plan exists.

Append and cleanup share one file-mutation concurrency contract. A concurrent
conversation append must survive Dream's cleanup replacement, including same-day
files with repeated headings or identical bodies. No async work runs inside a
SQLite write transaction. Use the existing worker-backed state and publication
facilities; extend a narrow plugin contract only where the owner is missing a
required operation.

### Implementation ownership and proof

The existing scheduler owns Workspace admission and settlement.
`dreaming-state.ts` owns working notes, entry processing progress, and unfinished
publication state through plugin SQLite. `src/memory/scoped-memory.ts` remains
the host's canonical scope/path owner, consumed through documented SDK surfaces.
The consolidation and promotion owners validate scoped Memory publication;
the artifact writer owns Archive append and source cleanup. The existing forget
owner handles explicit deletion and source-dependent state removal.

Do not feed scoped Fragments unchanged into the Workspace-only promotion writer.
First establish typed destinations, current authority, incremental processing,
and source-aware cleanup. Existing recall scoring may support analysis, but
manufacturing recall counts must not become the admission rule for Fragments.
Light, REM, and Deep remain internal phases of one job and notebook, not
competing Workspace processors or mandatory model calls on every pass.

Prove the real background flow with: cross-Thread and cross-Channel synthesis;
one-off plans retained without promotion; normal and strong-signal promotion;
launch-target exclusion; subject-based User output; no business decisions;
completed-matter Archive creation and dated additions; lower-level cleanup;
unchanged processed input skipped; old backlog serviced; concurrent append
preserved; partial publication and crash recovery; forget and authority
revocation; and notebook exclusion from ordinary recall.

The accepted Fragment lane reuses the existing plugin SQLite state namespace
without a database schema bump. Its versioned notebook and pending receipts
coordinate recovery; Markdown publication and SQLite progress are separate
durable operations. Changes beyond this accepted state and cleanup contract
still require material-storage review. The accepted October 27 extension retains
Event Markdown as the canonical operation record and stores its processing
progress in the same namespace. Only settled, provenance-matched bytes are
eligible. Ended-session facts preserve the original conversation scope after
reset or deletion without reviving a retired turn's authority. Notebook version
2 records every admitted source identity, actual input hash, target version,
curated entry version, and working-notebook fingerprint. Recovery validates the
whole input set, including uncited evidence, before publishing.

Fragment cleanup reserves each file's exact preimage and replacement in the
same pending plan before deleting covered entries. Recovery recognizes an
already published cleanup outcome even when the following progress write
failed, including an explicit discard with no replacement publication. An
unrecorded missing entry or a later edit defers recovery.

Event files are retained when Dream marks them processed; only fully covered
Fragment entries use the existing cleanup path. Explicit forget discards a
pending plan when any input source depends on the forgotten session and removes
its receipts. Failed reservations cannot admit absent or changed files.
The database schema and namespace stay unchanged. The notebook retains its
900,000-byte bound and the source store retains its 50,000-entry admission cap.
Rollback preserves source Markdown; an older notebook reader refuses version 2
rather than replaying a plan with incomplete evidence. Existing version 1
notebooks are unshipped development state and are not silently reinterpreted.

## Goals

The implementation should:

1. Make Channel and Thread the primary conversation-memory boundaries.
2. Keep `memory/MEMORY.md` as the single Workspace-global curated memory.
3. Maintain User memory independently of the Channel where evidence appeared.
4. Preserve one canonical copy of raw conversation history in the session
   transcript instead of duplicating it into every derived memory artifact.
5. Store framework-triggered events in independently addressable Event files.
6. Store only background Dream-produced conversation summaries in
   independently addressable Archive files.
7. Make an explicit memory search broad by default across the Workspace memory
   corpus, with current Channel and Thread context used as ranking signals.
8. Keep automatic bootstrap injection bounded to the current conversation
   hierarchy and Workspace memory.
9. Provide one simple current-context read operation for the current Workspace,
   Channel, optional Thread, and participant set.
10. Let Dreaming extract several scoped facts from the same source evidence.
11. Preserve source references, contributor identity, and trust metadata
    through every consolidation step, without maintaining revision lineage.
12. Keep memory failures non-blocking for ordinary replies.
13. Retain Markdown as the human-inspectable source of truth while using SQLite
    only for indexes, metadata, and existing Dream coordination state.
14. Limit the agent's conversation-time writes to appending dated Fragment
    files under the current Channel or Thread; Dream alone publishes Memory.

## Non-goals

This design does not introduce:

- multi-tenant Organization or Tenant memory;
- PlatformSpace as a memory scope;
- a separate private-chat memory model;
- unrestricted automatic prompt injection of unrelated Channels;
- a requirement that one Thread represent exactly one real-world activity;
- raw transcript duplication under User directories;
- model-selected unrestricted filesystem paths;
- automatic promotion of every User fact into Workspace memory;
- an implicit single-user target derived from the latest message sender.

Provider, account, guild, server, and workspace identifiers may remain useful
as routing and diagnostic metadata. They do not form additional memory scopes.
When needed to avoid collisions, the host incorporates them into the canonical
Channel identifier.

## Scope model

Memory has four scopes.

```ts
export type MemoryScope =
  | { kind: "workspace" }
  | { kind: "channel"; channelId: string }
  | { kind: "thread"; channelId: string; threadId: string }
  | { kind: "user"; userId: string };
```

The structural relationships are:

```text
Workspace Memory

Channel Memory
└── Thread Memory

User Memory
```

Workspace is global. Channel and Thread form the conversation hierarchy. User
is an orthogonal identity scope: User evidence can originate in any Channel or
Thread, but its curated result belongs to that User.

### Workspace

Workspace memory contains facts and rules that should be available throughout
the complete GroupClaw instance. It replaces the current root `MEMORY.md` role
and lives at `memory/MEMORY.md`.

Examples include:

- shared household or team conventions;
- global resource and device names;
- common scheduling policies;
- durable decisions that apply in every Channel;
- knowledge promoted from multiple Channels after validation.

Workspace is a global memory scope, not a parent directory around the other
scopes and not a tenant abstraction.

### Channel

A Channel is the required root for every conversation. A direct message is also
a Channel. The host constructs a collision-safe canonical `channelId` from the
trusted delivery context.

Recommended logical examples are:

```text
discord:default:123456789012345678
slack:T012345:C012345
web:default:conversation-123
```

The representation is intentionally opaque to memory consumers. Downstream
memory code must compare canonical IDs and must not parse provider-specific
segments out of them.

### Thread

A Thread always belongs to exactly one Channel. Its identity is the tuple
`(channelId, threadId)`; `threadId` is never globally authoritative by itself.

```ts
export type ThreadScope = {
  kind: "thread";
  channelId: string;
  threadId: string;
};
```

This contract normalizes platform differences. Slack typically identifies a
thread with a thread timestamp appended to a Channel route. Discord exposes a
native thread as a Channel-like object. Channel adapters supply native routing
facts; the host memory audience owner resolves them into the same memory scope.

### User

User memory is bound to a stable authenticated person identity. A platform user
ID may initially serve as the user key, but the design permits several platform
identities to resolve to one person later.

```ts
export type UserIdentity = {
  userId: string;
  sourceIdentities: Array<{
    provider: string;
    accountId?: string;
    nativeUserId: string;
  }>;
};
```

The memory system must distinguish the person described by a fact from the
person who supplied it:

```ts
export type UserMemoryEvidence = {
  subjectUserId: string;
  contributorUserId: string;
  evidenceType: "self-declared" | "third-party" | "observed" | "agent-inferred";
};
```

## Context composition

Bootstrap context and explicit search have different breadth. Bootstrap remains
small and deterministic; invoking memory search means the caller wants broader
discovery.

For a Channel turn:

```text
Workspace Memory
+ current Channel Memory
+ all participating User Memory summaries
```

For a Thread turn:

```text
Workspace Memory
+ parent Channel Memory
+ current Thread Memory
+ all participating User Memory summaries
```

For a Thread launched from a `threadMode: always` Channel, omit parent Channel
Memory as required by the confirmed launch behavior above.

The default set excludes:

- other Channels;
- sibling Threads;
- historical Events and Archives that were not selected by recall.

The current Context treats the whole family or group as participating. It does
not privilege the latest message sender. The participant set contains every
User bound to the current Channel, plus any additional User explicitly attached
to the Thread. Compose may inject bounded summaries for all participants, with
independent per-User budgets so that one large profile cannot displace the
conversation scopes.

An exact operation on one User supplies a `userName`. The host resolves that
name to a stable User identity, rejects ambiguity, and returns no User memory
when the name cannot be resolved safely.

An explicit `memory_search` is broad by default across indexed Workspace,
Channel, Thread, User, Event, and Archive artifacts available to the agent.
Current Channel and Thread are relevance boosts, not hard filters. Optional
filters can narrow a search when the caller already knows the desired scope or
artifact kind.

Context budgeting should allocate independent budgets to each scope. A useful
default order for resolving conflicts and trimming context is:

```text
Thread → Channel → participating Users → Workspace
```

This order expresses locality, not trust. Provenance and authorization remain
separate inputs.

## Storage layout

The canonical human-readable layout is:

```text
memory/
  MEMORY.md

  Event/
    YYYY-MM-DD_EventName_timestamp.md

  Channel/
    <encoded-channel-id>/
      MEMORY.md

      Event/
        YYYY-MM-DD_EventName_timestamp.md

      Archive/
        YYYY-MM-DD_ArchiveName_timestamp.md

      Fragment/
        YYYY-MM-DD.md

      Thread/
        <encoded-thread-id>/
          MEMORY.md

          Event/
            YYYY-MM-DD_EventName_timestamp.md

          Archive/
            YYYY-MM-DD_ArchiveName_timestamp.md

          Fragment/
            YYYY-MM-DD.md

  User/
    <encoded-user-id>/
      MEMORY.md

      Event/
        YYYY-MM-DD_EventName_timestamp.md
```

The roles are:

| Path                                                     | Meaning                              |
| -------------------------------------------------------- | ------------------------------------ |
| `memory/MEMORY.md`                                       | Workspace-global curated memory      |
| `memory/Event/*`                                         | Workspace-scoped framework events    |
| `memory/Channel/<id>/MEMORY.md`                          | Channel-curated memory               |
| `memory/Channel/<id>/Event/*`                            | Channel-scoped framework events      |
| `memory/Channel/<id>/Archive/*`                          | Channel conversation archives        |
| `memory/Channel/<id>/Fragment/YYYY-MM-DD.md`             | Channel agent notes, appended by day |
| `memory/Channel/<id>/Thread/<id>/MEMORY.md`              | Thread-curated memory                |
| `memory/Channel/<id>/Thread/<id>/Event/*`                | Thread-scoped framework events       |
| `memory/Channel/<id>/Thread/<id>/Archive/*`              | Thread conversation archives         |
| `memory/Channel/<id>/Thread/<id>/Fragment/YYYY-MM-DD.md` | Thread agent notes, appended by day  |
| `memory/User/<id>/MEMORY.md`                             | User-curated memory                  |
| `memory/User/<id>/Event/*`                               | User-targeted framework events       |

User directories do not contain copies of ordinary conversation transcripts or
Archives. User memory is derived from Channel and Thread evidence and points
back to that evidence.

### Safe path encoding

Canonical IDs may contain characters that are unsafe or ambiguous in paths.
The filesystem adapter must encode each ID as one path segment and must retain
the canonical value in metadata. It must reject traversal, separators, NUL
bytes, empty IDs, reserved path names, and case-folding collisions.

Display names never determine identity. Renaming a Channel, Thread, User, Event,
or Archive must not silently move or fork its memory.

## Artifact model

Fragment, Memory, Event, and Archive have distinct lifecycle rules.

| Artifact | Primary producer                             | Purpose                                            | Automatically injected   | Dreaming source |
| -------- | -------------------------------------------- | -------------------------------------------------- | ------------------------ | --------------- |
| Fragment | agent, during a conversation                 | Dated temporary note appended to the current scope | No                       | Yes             |
| Memory   | background Dream consolidation               | Compact durable knowledge for exactly one scope    | Yes, by scope and budget | Yes             |
| Event    | framework, plugin, hook, cron, or automation | Record a triggered operation and outcome           | No                       | Yes             |
| Archive  | background Dreaming                          | Preserve a substantial ended matter                | No                       | On demand       |

### Fragment

A Fragment is the agent's only conversation-time write. It is one timestamped
entry appended to the current Channel or Thread day file, recording the
situation as observed: the observation or decision, contributor, source message
links, and optional subject hints. The host derives the file path from the
admitted scope and current date; a model supplies only the note text and an
optional title, and must never select a destination path, edit or delete an
existing entry, or write outside the current conversation.

All notes from one day share one file:

```text
Fragment/YYYY-MM-DD.md
```

Each entry is a chronological Markdown block appended in sequence:

```markdown
## 14:05 — Optional Title

the self-contained note body
```

The date and `HH:MM` time label use the configured user timezone; the title
lives in the heading, never in a filename. Appends publish through an atomic
compare-and-swap replace with bounded conflict retries, so concurrent writers
never lose an entry.

Fragments carry no model-authored revision id, status, hash, or lineage. They
are temporary working material, recallable within their authorized scope while
retained. Dream owns summary, promotion, archival publication, and covered-entry
cleanup; the conversation agent retains append-only access. Explicit forgetting
remains with the existing forget owner.

### Memory

Each `MEMORY.md` contains compact claims valid for exactly one scope, written
only by Dream consolidation from Fragments, Events, and prior Memory. Entries
preserve source references and lifecycle metadata such as observation time,
importance, and trigger phrases; they do not maintain revision lineage.

The model may propose or confirm a change in conversation, but only the host
Dream path constructs and validates the Memory write. A model must never select
an arbitrary destination path or edit `MEMORY.md` directly.

### Event

An Event records one framework-generated trigger. Examples include:

- a cron job firing;
- a reminder becoming due;
- a calendar item changing;
- a webhook arriving;
- a device state changing;
- a background agent task completing;
- a Channel or Thread lifecycle notification;
- a pre-compaction memory flush;
- a session reset or rollover;
- an automation succeeding, failing, or retrying.

The filename contract is:

```text
YYYY-MM-DD_EventName_timestamp.md
```

For example:

```text
2026-10-06_calendar-reminder-triggered_1791279148201.md
```

The date uses the configured user timezone. The timestamp is the immutable
creation time in Unix milliseconds. `EventName` is a bounded, path-safe slug.
The filename remains stable if the display title later changes.

An Event may be updated while the framework operation progresses through states
such as `created`, `processing`, `completed`, or `failed`. The host owns these
state transitions.

Suggested Event frontmatter:

```yaml
---
schema: 1
artifactType: event
eventId: evt_1791279148201
eventType: calendar.reminder.triggered
name: Calendar Reminder Triggered
status: completed
createdAt: 2026-10-06T12:12:28.201Z
updatedAt: 2026-10-06T12:12:31.040Z
scope:
  kind: channel
  channelId: discord:default:123456789
trigger:
  kind: cron
  sourceId: family-dinner-reminder
provenance:
  originClass: system
  payloadTrust: untrusted
---
```

Framework provenance and payload trust are separate. The fact that OpenClaw
received a webhook can be trusted as a system observation while the webhook
payload remains untrusted. Writing external content into an Event must not
launder that content into trusted memory.

### Archive

An Archive is a semantic summary deliberately produced by background Dreaming.
An explicit summarization request returns a transient answer. Framework lifecycle behavior never
creates an Archive directly. Session reset, rollover, compaction, inactivity,
and Thread closure are Events; Dreaming may later use those Events and their
source transcripts to create an Archive.

An Archive is appropriate for a substantial activity, resolved issue, completed
project stage, or canceled plan whose end is supported by evidence. An ended
episode inside a still-active Thread may be archived independently. An idle
Thread or an unresolved discussion is not automatically a completed matter.

The filename contract is:

```text
YYYY-MM-DD_ArchiveName_timestamp.md
```

For example:

```text
2026-10-06_family-dinner-planning_1791279148201.md
```

Suggested Archive sections are:

```text
Summary
Decisions
Open Items
Participants
User Memory Candidates
Channel Memory Candidates
Workspace Memory Candidates
Source Sessions and Messages
```

An Archive is stable after publication and primarily used for search and recall.
Genuine new information or a correction may be appended as a dated addition
without silently rewriting the historical account. Dream does not routinely
scan, merge, or reorganize existing Archives. A selected Archive is read when
new Fragments refer to it or a recall needs its detail.

Memory entries may retain an authorized Archive reference for the underlying
case. References do not grant read access. Cleanup of lower-level duplicates
preserves that link and any retained transcript references.

One Thread may produce several Archives, and one Archive may cover only a
bounded portion of a long-running Thread. Therefore Thread and Archive are not
equivalent concepts.

## Canonical evidence and candidate extraction

The session transcript remains the canonical raw conversation record. Fragment,
Event, and Archive files contain bounded derived evidence, not independent
copies of all messages.

One source message may generate several memory candidates:

```text
"I avoid peanuts, so this trip's restaurant must have peanut-free options."

→ User candidate for the speaker
→ Thread decision candidate for the trip
```

Candidates need a target scope independent of their source scope:

```ts
export type ScopedMemoryCandidate = {
  candidateId: string;
  targetScope: MemoryScope;
  claim: string;
  category:
    | "fact"
    | "decision"
    | "preference"
    | "constraint"
    | "routine"
    | "relationship"
    | "goal"
    | "action-item";
  confidence: number;
  contributorUserId?: string;
  subjectUserId?: string;
  source: {
    channelId: string;
    threadId?: string;
    sessionId?: string;
    messageIds?: string[];
    fragmentId?: string;
    eventId?: string;
    archiveId?: string;
    observedAt: string;
  };
  provenance: MemoryEntryProvenance;
};
```

The host validates `targetScope`. The model may classify and summarize evidence,
but it cannot invent a Channel, Thread, or User destination outside the
authorized candidate set. Candidates carry source citations, not a stored
supersession chain. Dream faithfully represents unresolved conflicts in its
working notes or retained evidence and never initiates a conversation to settle
them. Explicit newer corrections may update the representation without
inventing a new business decision.

## Write behavior

### Ordinary conversation

Ordinary messages remain in the transcript. During the conversation the agent
may append timestamped entries to the current Thread's dated Fragment day
file, or the current Channel's when there is no Thread, recording observations
and decisions worth keeping; the agent decides what is worth a Fragment and
announces what it noted. It never writes curated Memory directly. Raw messages
are not copied wholesale into Fragment entries, and Fragments are never
appended to the Workspace scope or to other conversations.

Before compaction, the framework records a scoped Event describing the flush.
The flush is framework behavior, so it does not create or append to an Archive.
Recent Fragments are the bounded evidence Dream ingests for that scope.

### Explicit remember requests

An explicit request is captured like any other observation: the agent appends a
Fragment with the requested target intent. Dream performs the persistent write
on a later pass; no conversation-time path writes curated Memory directly.
Examples of the target intent the Fragment carries:

| User statement                            | Proposed target    |
| ----------------------------------------- | ------------------ |
| "Remember that Alice avoids peanuts."     | named User `Alice` |
| "Remember this decision for this thread." | current Thread     |
| "Remember this rule for this channel."    | current Channel    |
| "Use this rule everywhere."               | Workspace          |

The narrowest supported scope is the default target. An ambiguous subject or
scope requires clarification before the Fragment is appended. Dream may choose
a broader authorized scope when strong evidence warrants it; Workspace
promotion does not require an additional conversational confirmation.
Confidentiality changes retain their confirmation requirement.

User-targeted facts are never inferred from the latest message sender. The
model supplies `userName`, and the host resolves it against authenticated
identity records and the visible participant directory. Ambiguous names require
clarification.

### Framework events

The framework creates the Event path and metadata before exposing a bounded
append/update capability to plugins or agents. Event writes must preserve the
source trigger identity and current processing state.

## Recall behavior

All recall paths must apply the same scope authorization to both Markdown and
session transcript hits.

### Current-context read

The simplest explicit read operation is `memory_context_read`. It is callable
with defaults, but it is not parameterless. The host derives the current
Workspace, Channel, optional Thread, and participant set from the authenticated
turn contract, while a small set of optional parameters controls how much of
that Context is returned.

```ts
memory_context_read({
  layers?: Array<"workspace" | "channel" | "thread" | "users">,
  userNames?: string[],
  detail?: "summary" | "full",
  cursor?: string,
});
```

The controls have deliberately narrow semantics:

| Parameter   | Default                    | Meaning                                                                                                   |
| ----------- | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `layers`    | all current Context layers | Select Workspace, Channel, Thread, or User Memory without supplying scope IDs.                            |
| `userNames` | every participating User   | Narrow the User layer to explicitly named participants; names resolve to stable IDs or fail as ambiguous. |
| `detail`    | `full`                     | Return full curated `MEMORY.md` content within the host budget, or choose `summary`.                      |
| `cursor`    | first page                 | Continue a previously truncated Context read.                                                             |

A zero-configuration call reads the effective current Context:

```text
Workspace MEMORY.md
+ current Channel MEMORY.md
+ current Thread MEMORY.md, when present
+ MEMORY.md for every participating User
```

The default participant set is the whole family or group bound to the Channel,
plus any additional Thread-bound participants. It is not inferred from the
latest message sender. Discord configured Channel members establish a complete
bound group; Thread reads add the durable Session participant projection and
report partial coverage because observed contributors do not establish a complete
Thread roster. Channels without configured membership retain observed-only reads
with partial coverage. Reading one specific User outside this
aggregate view requires an explicit, resolvable `userName`.

`memory_context_read` reads curated `MEMORY.md` artifacts only. It does not
implicitly enumerate Event or Archive files. It returns each item with its
scope, revision, source metadata, and truncation state. When the aggregate
exceeds the response budget, it preserves independent scope and per-User
boundaries, reports omitted items, and returns a cursor instead of silently
dropping a participant.

This operation complements automatic Compose injection. Compose supplies a
small deterministic snapshot at turn start; `memory_context_read` refreshes or
expands that same Context without requiring a broad search.

### Broad search

An explicit `memory_search` searches broadly across the available Workspace
memory corpus by default:

```text
Workspace Memory
+ all Channel and Thread Memory
+ User Memory
+ Event evidence
+ Archive evidence
```

The current Channel and Thread are ranking signals, not default exclusion
boundaries. Search results must return scope and artifact metadata so the Agent
can distinguish local context from information found elsewhere.

For scoped conversations, “available” means currently authorized sources from
the same configured group, plus their admitted Workspace and User artifacts.
Current Context stays local. Historical references never restore former
authority; both the requester and each discovered source must pass current
admission before results or exact excerpts are returned.

Callers can optionally narrow by Channel, Thread, artifact kind, time range, or
`userName`. User filters are resolved to stable User IDs by the host. The search
contract does not expose an implicit per-turn User target.

The model-facing shape should be similar to:

```ts
memory_search({
  query: string,
  userName?: string,
  channelId?: string,
  threadId?: string,
  artifactKinds?: Array<"memory" | "event" | "archive">,
  from?: string,
  to?: string,
});
```

Omitting filters means broad search. Supplying filters narrows the corpus; it
does not widen authorization.

Ranking should prefer local context:

| Scope relation          | Suggested base multiplier |
| ----------------------- | ------------------------: |
| Current Thread          |                      1.00 |
| Parent Channel          |                      0.85 |
| Participating User      |                      0.80 |
| Workspace               |                      0.65 |
| Other Channel or Thread |                      0.55 |
| Explicitly named User   |                      0.80 |
| Other User              |                      0.50 |

These values are initial calibration targets, not compatibility guarantees.

`memory_read` must reauthorize the referenced artifact. A reference returned by
an earlier search is not a durable access grant.

Authorization still applies before ranking, but scope locality does not prevent
broad search. Automatic bootstrap injection and `memory_context_read` remain
local; `memory_search` is the deliberate transition to broad discovery.

## Dreaming

Dreaming uses the Workspace-wide incremental proposal above: one admitted
working view and independent notebook, with several scoped publication targets.

```text
Recent unprocessed Fragments + Dream notebook
                     |
        cross-conversation organization
                     |
       retain / summarize / discard
       scoped Memory / ended-matter Archive
```

### Extraction

Extraction determines:

- what claim the evidence supports;
- which scope owns the claim;
- which user is the subject, when applicable;
- who contributed the evidence;
- whether the claim is self-declared, third-party, observed, or inferred;
- confidence, importance, trigger terms, and source citations;
- whether the content is eligible for automatic promotion.

Extraction does not modify a curated `MEMORY.md`.

### Consolidation

Evidence may be analyzed across authorized source scopes. Validated publication
operations are grouped by exact target:

```ts
export type PromotionGroupKey = {
  scope: MemoryScope;
  projectKey?: string;
};
```

One atomic file publication modifies one target `MEMORY.md`; a Workspace pass
may publish several such targets. Existing
optimistic concurrency, source validation, maximum-file-size checks, and
prior-entry-loss limits remain mandatory.

### Conversation promotion

Conversation knowledge normally moves upward through this chain:

```text
Thread → parent Channel → Workspace
```

Strong signals permit a direct broader authorized target, including Workspace,
without another confirmation step. Cross-Thread and cross-Channel evidence may
support a broader claim; promotion does not copy local claims into unrelated
sibling memories. A launch Channel is excluded as an intermediate memory
target, while its Thread evidence can support an authorized Workspace result.

### User consolidation

User candidates are collected from ordinary Channel and Thread conversations,
Events, and Archives. The extraction output names the subject with `userName`;
the host resolves that name to `subjectUserId` before candidate persistence.
Candidates are consolidated by the resolved subject identity regardless of
which Channel supplied the evidence.

Recommended evidence priority is:

```text
self-declared
→ repeated behavior observed across conversations
→ explicitly confirmed third-party statement
→ unconfirmed third-party statement
→ agent inference
```

User Dreaming updates only `memory/User/<user-id>/MEMORY.md`. It does not
automatically promote personal facts into Workspace memory. A new explicitly
shared rule may be created from the same evidence, but it is a separate
Workspace candidate with its own wording and provenance.

### Fragment, Event, and Archive processing

Fragments, Events, and Archives are indexed as evidence. They are not loaded
wholesale into every prompt. Dreaming may extract scoped candidates from them
and records the source `fragmentId`, `eventId`, or `archiveId` on each
candidate. Agent conversations append Fragments; framework transitions always
produce Events; only background Dreaming produces an Archive.

Event processing must preserve the distinction between trusted framework
metadata and potentially untrusted payload content. Fragment and Archive
processing must preserve source session and message references so deletion and
forgetting can trace derived claims back to their conversation evidence.
Fragments are plain notes, not framework-trusted events; Dream preserves their
provenance and uncertainty. It does not initiate confirmation workflows.

## Current implementation

The baseline at the source revision named above was optimized for a personal
assistant with an agent-wide Workspace and a privileged main conversation.
The following baseline analysis identifies the owners being migrated; the
implemented slices listed at the start of this page supersede those portions.

### Current file model

The generated workspace instructions define:

- root `MEMORY.md` as durable non-profile memory;
- root `USER.md` as the stable user model;
- `memory/YYYY-MM-DD.md` as daily working memory;
- `memory/YYYY-MM-DD-<slug>.md` as session summaries;
- `DREAMS.md` and optional `memory/dreaming/**` as review output.

See `docs/reference/templates/AGENTS.md` and
`docs/concepts/memory-architecture.md`.

This model has no path-level Channel, Thread, or User partition for ordinary
memory files.

### Bootstrap injection

`src/agents/bootstrap-files.ts` loads the fixed bootstrap file set and filters
root `MEMORY.md` out of group, channel, cron, and subagent sessions.
`src/agents/system-prompt-context-files.ts` then renders eligible files into the
Project Context section.

The current behavior protects private root memory from automatic group prompt
injection, but it also means a shared Channel has no automatically composed
curated Channel memory. Root `USER.md` remains a shared bootstrap concept, while
the target design requires explicit User lookup by name and stable identity.

`src/auto-reply/reply/startup-context.ts` loads recent daily files by calendar
date for bare `/new` and `/reset`. Selection is based on date and file budget,
not Channel or Thread identity. The files are framed as untrusted notes, which
protects instruction priority but does not establish semantic scope.

### Channel and Thread routing

The ingress layer already exposes most required identity facts through
`ConversationFacts` in `src/channels/turn/types.ts`: conversation ID, space ID,
parent ID, thread ID, and native Channel ID.

Slack generally derives a thread-suffixed session key in
`extensions/slack/src/monitor/message-handler/prepare-routing.ts`. Discord
native Threads are already Channel-shaped, so
`extensions/discord/src/monitor/message-handler.context.ts` calls the thread
helper with `useSuffix: false` and separately records a parent session key.

This provider difference must be normalized at ingress. Memory code cannot
derive Thread identity by parsing session keys.

### Implemented Discord current-context routing

The existing ordinary-message and native-command adapters supply
`nativeChannelId`, `parentId`, and `threadId`. The inbound context builder carries
these facts as `NativeChannelId`, `ThreadParentId`, and `MessageThreadId`.
`src/config/sessions/metadata.ts` persists the parent as
`delivery.origin.nativeParentChannelId` alongside the native conversation and
thread IDs. The existing Session entry payload owns this metadata; no additional
store or transcript schema is introduced by this slice.

`src/plugins/memory-audience.ts` resolves canonical scopes from those durable
facts when it mints the generation-bound grant:

| Discord conversation            | Channel scope source       | Thread scope source   |
| ------------------------------- | -------------------------- | --------------------- |
| Guild channel                   | native Channel ID          | none                  |
| Native public or private Thread | native parent Channel ID   | native Thread ID      |
| Forum or media post             | native parent Channel ID   | native post Thread ID |
| Automatically created Thread    | original Channel ID        | created Thread ID     |
| Direct message                  | native DM Channel ID       | none                  |
| Group DM                        | native group DM Channel ID | none                  |

Channel IDs include provider and account identity. Thread paths are nested
under their parent Channel, so sibling Threads share Channel memory while
retaining distinct Thread memory. Display names and session-key shapes do not
determine this relationship. Adapters do not provide a separate canonical
memory identity that can disagree with Session routing.

Provider, surface, account, native conversation, and explicit thread changes
retire stale routing facts. A repeated turn in the same Thread can retain an
already known parent when lookup temporarily omits it. Internal turns preserve
the bound external conversation. User IDs use the canonical Session participant
namespace and ID, independent of object property order or display-name changes.
Session participants remain observed contributors, with partial coverage.

Ordinary messages and native commands use one resolver for Discord conversation
links. Thread links point to the actual native or created Thread; DM links use
the native conversation ID under `@me`. Guild links require a numeric guild ID;
configured slugs never substitute for one.

**Update behavior:** existing entries remain readable. The next authenticated
inbound turn with a known parent populates the additive origin field. A Thread
without enough native facts to establish its parent receives a memory denial
with a retry instruction; ordinary replies continue. Historical parent
relationships are not guessed or bulk reassigned. Existing memory artifacts
under an incorrect legacy Thread-as-Channel path require explicit migration.

This routing slice establishes current-context identity and link consistency.
Later slices add scoped search, Fragment writes, and configured-group Discord
Dream consolidation, as listed at the start of this document. Complete
conversation membership, participant display-name enrichment, Channel/Thread
native harness compaction Event producers remain pending.

### Memory audience

The baseline `src/plugins/memory-provider-types.ts` defined:

```ts
{
  kind: "owner-private";
  agentId: string;
}
{
  kind: "conversation";
  agentId: string;
  sessionKey: string;
  sessionId: string;
}
```

`src/plugins/memory-audience.ts` intentionally gives thread-shaped session keys
no special interpretation. The current slice adds optional `context` metadata
to both audience kinds, containing host-resolved Workspace, Channel, optional
Thread, and observed User artifacts. Scoped Markdown recall uses these admitted
artifacts through `scoped-memory-visibility.ts`; legacy audience kinds retain
their transcript-search behavior. Callers without scoped Context retain the
existing Workspace-wide Markdown view.

The generation-bound grant, revocation checks, child-session delegation, and
fail-closed behavior should be retained. The payload of the grant must be
extended rather than replaced with model-provided identifiers.

### Pre-compaction flush

`extensions/memory-core/src/flush-plan.ts` always targets
`memory/YYYY-MM-DD.md`. Its prompt requires append-only writes, treats curated
bootstrap files as read-only, and prevents timestamped variants.

The surrounding flush implementation preserves useful properties:

- it runs as private maintenance context rather than polluting the transcript;
- failure does not block compaction or the reply;
- the file writer is restricted to one host-selected path;
- provider-native persistence tools can replace the file writer;
- the source turn's memory audience and sandbox state are retained;
- successful flush state is recorded on the session entry.

Only target resolution and candidate persistence need conceptual replacement.
The append-only writer and authority propagation should remain.

### Session-memory hook

`src/hooks/bundled/session-memory/handler.ts` writes one
scoped `session.reset` or `session.rollover` Event during `/new`, `/reset`, or
automatic rollover. The filename contains the event type, a unique Event ID,
and immutable creation timestamp; optional LLM naming only appends a description.
Dates follow the configured user timezone.

The canonical memory-context resolver addresses the Event using the departing
entry captured by the lifecycle owner. A Thread's successor cannot redirect its
evidence. Local sessions without delivery origin use Workspace; group/channel
sessions require canonical delivery origin, and launch Channel exclusion remains
enforced. Scope projection records an observation and grants no Dream authority.

The existing bounded capture and provenance reservation precede exclusive
publication. Metadata records framework provenance separately from payload
trust. Events never create Archives directly. Dream consumes settled,
provenance-matched Event bytes and retains the source artifact after processing.
The version 2 notebook carries exact input receipts and lifecycle-captured
conversation facts for ended-source admission.

Embedded compaction emits `session:compacted` after successful persistence.
Standalone compaction supplies its pre-compaction messages; automatic compaction
supplies the remaining conversation and resolves the exact source entry on the
read-only worker. Both paths share one Event emitter and the bundled writer.
Discord closure supplies the deletion owner's committed entry and archive
identities through the `deleteSessionEntry` lifecycle option. No closure Event
is emitted when its guarded deletion is rejected or finds no entry. Native
harness compaction remains pending.

### Index schema

`extensions/memory-core/src/memory/manager-chunk-writer.ts` stores chunk path,
source, line range, hash, model, text, embedding, importance, triggers,
`project_key`, origin class, session kind, observation time, and supersession
key.

It does not store:

- memory scope kind;
- canonical Channel ID;
- parent Channel ID for a Thread;
- Thread ID;
- subject User ID;
- contributor User ID;
- artifact kind;
- Event or Archive identity;
- visibility or scope-policy revision.

Project metadata currently influences matching and promotion grouping, but it
does not establish an authorization partition.

### Search visibility and Active Memory

`extensions/memory-core/src/session-search-visibility.ts` applies detailed
visibility checks to session transcript hits. Cross-conversation recall is
currently restricted to trusted same-agent private conversations and excludes
group and channel transcripts.

The legacy memory-provider adapter authorizes session hits through this
filter, but ordinary Markdown memory hits remain Workspace-wide. Consequently,
group bootstrap can omit root `MEMORY.md` while `memory_search` can still return
Workspace memory files. Bootstrap isolation, transcript isolation, and file
search isolation do not share one policy owner.

`extensions/active-memory/index.ts` also gates deterministic and model-based
automatic recall on a private destination. The target design removes that
special class. When Active Memory decides a search is warranted, it should use
the broad search contract while supplying current Channel and Thread as ranking
context.

### Dreaming ingestion

`extensions/memory-core/src/session-ingestion.ts` enumerates interactive session
transcripts and stages selected lines under
`memory/.dreams/session-corpus/YYYY-MM-DD.txt`. A rendered line includes the
agent and session path, and staged entries may retain agent ID, session ID, and
session key.

`src/config/sessions/session-accessor.sqlite-contract.ts` persists only coarse
source metadata for transcript instances: creation time, channel plugin,
account ID, chat type, and hook source. It does not preserve canonical Channel,
Thread, message, or User identities required by the target model.

The day-based shared session corpus mixes evidence from every eligible session
in the same Workspace before promotion scoring.

### Dreaming consolidation

Light Dreaming collects recent daily, session, and recall evidence. REM prefers
Light-staged entries and finds recurring patterns. Deep Dreaming ranks durable
candidates using frequency, relevance, query diversity, recency,
consolidation, and conceptual signals.

The current defaults include a minimum score of `0.75`, three recalls, three
unique queries, a fourteen-day recency half-life, and ten selected candidates
per sweep. Deep consolidation accepts only owner- or agent-derived interactive
evidence, asks a tool-free model to choose add, merge, or supersede operations,
and lets the host construct the final entry text.

`extensions/memory-core/src/short-term-promotion-metadata.ts` groups candidates
only by `projectKey`. `extensions/memory-core/src/short-term-promotion-apply.ts`
then writes all accepted results into root `MEMORY.md`.

The current consolidation safety properties should remain:

- deterministic eligibility and scoring;
- explicit provenance gates;
- no model-authored destination paths;
- validated structured model output;
- optimistic concurrency;
- atomic replacement;
- preimage recovery state in the existing promotion owner;
- maximum curated-file size;
- maximum prior-entry-loss fraction;
- source citations without revision lineage in curated Memory;
- reply-path failure isolation.

The grouping and destination model must change from Workspace-only to target
scope.

### Provenance

Current origin classes are `owner`, `agent`, `untrusted`, and `system`.
Untrusted and system-derived candidates cannot automatically promote into
`MEMORY.md`. Recall-loop prevention also stops previously injected memory from
being extracted again as new evidence.

These controls must not be weakened. The target model adds subject,
contributor, source scope, target scope, artifact identity, and payload trust.
It does not treat framework-generated Event files as proof that their embedded
payload is trusted.

## Required implementation changes

### 1. Add canonical memory identity contracts

Create a generic host-owned contract near the existing memory audience types:

```ts
export type ConversationMemoryScope =
  | { kind: "channel"; channelId: string }
  | { kind: "thread"; channelId: string; threadId: string };

export type MemoryTurnIdentity = {
  conversation: ConversationMemoryScope;
  senderUserId?: string;
};
```

Channel plugins supply trusted native conversation and participant facts through
the existing ingress contract. The Session owner persists them; the host memory
audience owner constructs canonical Channel and Thread IDs and current Context.
Memory consumers must not parse session keys or accept a competing adapter-owned
canonical identity.

Primary code owners:

- `src/channels/turn/types.ts`
- `src/channels/inbound-event/context.ts`
- `src/config/sessions/metadata.ts`
- `src/memory/scoped-memory.ts`
- `src/plugins/memory-audience.ts`
- `extensions/discord/src/monitor/message-handler.context.ts`
- `extensions/slack/src/monitor/message-handler/prepare.ts`

### 2. Persist identity with transcript generations

Extend the authoritative session transcript schema and archive metadata with:

```text
channel_id
thread_id
sender_user_id or message-level participant identity
identity_schema_version
```

The transcript generation must retain these values after reset, compaction, and
archive rotation. Migration must treat missing identity as legacy unscoped data
rather than guessing from display names.

Primary code owners:

- `src/config/sessions/types.ts`
- `src/config/sessions/session-accessor.sqlite-contract.ts`
- `src/config/sessions/session-accessor.sqlite-entry.ts`
- `src/config/sessions/session-accessor.sqlite-history.ts`
- session database migrations and archive inventory code

### 3. Extend MemoryAudience

Replace the private/conversation partition payload with a unified scoped grant:

```ts
export type MemoryAudience = {
  kind: "scoped";
  agentId: string;
  sessionKey: string;
  sessionId: string;
  turnIdentity: MemoryTurnIdentity;
  searchableScopes: readonly MemoryScope[];
  writableScopes: readonly MemoryScope[];
};
```

The host computes the searchable scope set for the whole Workspace and carries
the current Channel and Thread as ranking context. The default write grant
remains narrow: current Thread or Channel. User writes require an explicit
`userName` resolved to a stable User ID. Direct Workspace writes require an
explicit operation or controlled promotion path.

Retain current lease and generation checks in
`src/plugins/memory-audience.ts`.

### 4. Introduce a scoped storage resolver

Add one owner that maps typed scopes and artifact kinds to safe paths:

```ts
resolveMemoryArtifactPath({
  scope,
  artifactKind,
  artifactId,
  createdAt,
  displayName,
});
```

No caller should assemble `memory/Channel/...` strings independently. The
resolver owns path encoding, collision handling, legacy aliases, case behavior,
and root containment.

It should support:

- curated `MEMORY.md` paths;
- Fragment append paths under the admitted Channel or Thread;
- Event creation and update paths;
- Archive publication paths;
- artifact metadata lookup;
- path-to-scope classification for indexing;
- migration from legacy paths.

### 5. Move Workspace memory

Change the canonical Workspace path from root `MEMORY.md` to
`memory/MEMORY.md`.

During migration:

1. If only root `MEMORY.md` exists, move it to `memory/MEMORY.md` after a
   verified backup.
2. If only the new path exists, use it.
3. If both exist with identical content, retain the new path and retire the old
   path.
4. If both differ, do not merge automatically; report a Doctor conflict.
5. Never write both locations.

Update bootstrap loading, provenance classification, memory indexing, import,
backup, Doctor, documentation, and tests that currently special-case the root
filename.

### 6. Replace date-only flush targets

Change `MemoryFlushPlan` from one daily relative path to a typed Event and
candidate persistence target. The host should resolve the target from the
current scoped audience.

The first implementation may keep append-only Markdown writes but should create
or update a `memory.pre-compaction-flush` Event associated with the current
Channel or Thread and submit extracted candidates separately. It must not create
an Archive or merge unrelated conversations into one Workspace daily file.

Provider-native persistence should receive the same target scope and evidence
metadata.

Primary code owners:

- `extensions/memory-core/src/flush-plan.ts`
- `src/auto-reply/reply/memory-flush-plan.ts`
- `src/auto-reply/reply/memory-flush.ts`
- `src/auto-reply/reply/memory-flush-session.ts`
- `src/agents/agent-tools.memory-flush.ts`

### 7. Convert session-memory output to Events

Replace `memory/YYYY-MM-DD-<slug>.md` output with a scoped `session.reset` or
`session.rollover` Event path. The hook should receive the authoritative Channel
and Thread identity captured before reset and store source session/message
references in frontmatter.

The current bounded transcript capture, visibility filtering, source-origin
classification, and asynchronous non-blocking write behavior should remain.

Primary code owners:

- `src/hooks/bundled/session-memory/handler.ts`
- `src/hooks/bundled/session-memory/capture.ts`
- `src/config/sessions/session-memory-targets.ts`

### 8. Add Event APIs

Add a host API for creating and updating framework Event artifacts. It should
require:

- a stable event type;
- a host-resolved target scope;
- trigger identity;
- creation timestamp;
- framework provenance;
- payload trust;
- bounded state transitions;
- optional source message, job, hook, or automation references.

Cron, hook, channel lifecycle, reminder, and automation implementations should
use this API instead of writing ad hoc memory files. Event writes must remain
optional and non-blocking unless the triggering feature explicitly requires
durable recording.

Compaction, reset, rollover, inactivity, and Thread closure are included in this
framework Event rule. None of these paths creates an Archive directly.

### 9. Add Archive APIs

Add a separate Archive publication API used only by background Dreaming.
It should accept a host-bounded evidence set and publish a semantic
summary with source session, message, and Event references.

The publisher accepts a display name and a bounded source selection such as the
current Thread or session. It is not a direct conversational tool and does not
accept arbitrary destination paths. Framework lifecycle handlers use the Event
API; explicit summarization requests return transient replies.

### 10. Extend the memory index

Add normalized scope and artifact metadata to every indexed chunk:

```text
scope_kind
channel_id
thread_id
user_id
artifact_kind
artifact_id
contributor_user_id
subject_user_id
payload_trust
scope_policy_revision
```

Prefer normalized side tables when they make multi-source provenance or schema
migration safer than adding nullable columns to the main chunk table.

Search requests should accept a host-produced scope filter. Scope filtering must
occur before final ranking and before snippets leave the provider boundary.

### 11. Unify file and transcript authorization

Replace the current transcript-only visibility filter with one authorization
owner for all memory hits. It must evaluate:

- caller audience currency;
- exact scope membership;
- Thread-to-parent-Channel inheritance;
- explicitly resolved User identities;
- Workspace-wide search authority;
- source deletion and reset cutoffs;
- artifact visibility and policy revision.

`memory_search`, `memory_context_read`, and `memory_read` must call the same
owner. A path, citation, or opaque
reference must never grant access by itself.

### 12. Build scoped bootstrap and current-context reading

Replace the fixed root-file bootstrap logic with a scope-aware composer. It
should load bounded curated entries from:

```text
Thread, when present
Channel
all participating Users
Workspace
```

The composer should retain provenance eligibility checks and independent token
budgets. Fragment, Event, and Archive content remains recall-only, never
bootstrap-injected. Participant User summaries receive separate per-User
budgets and are not selected from the latest message sender.

Add `memory_context_read` on the same owner. Its defaults read the current
Workspace, Channel, optional Thread, and all participating User `MEMORY.md`
artifacts. Optional `layers`, `userNames`, `detail`, and `cursor` parameters may
narrow or continue that read without accepting raw scope IDs or filesystem
paths. It must support bounded pagination, explicit omission metadata, and
refresh after writes without requiring a broad search. Fragment, Event, and
Archive artifacts remain excluded from this operation.

Add `memory_read` for exact artifact expansion. User-scoped reads outside the
aggregate current Context require an explicit `userName`; search references are
reauthorized before reading.

Update the generated `AGENTS.md` template after the runtime behavior exists.
The template should describe scope intent but must not be the enforcement
boundary.

### 13. Make Dreaming scope-aware

Use the Workspace-wide incremental design below. Extend evidence and publication
operations with source and target scope metadata. Exact target grouping applies
at publication, after authorized cross-conversation analysis.

The Dreaming sweep should:

1. select recent unprocessed Fragments across admitted Workspace scopes;
2. load the independent Workspace working notebook and relevant prior Memory;
3. connect related evidence across authorized Threads and Channels;
4. summarize, organize, promote, discard, or archive according to content;
5. normally promote through Thread, parent Channel, then Workspace, allowing
   direct wider promotion for strong evidence and subject-based User targets;
6. validate each target and publish one file atomically at a time;
7. record successful outputs before cleaning covered lower-level entries;
8. retain unfinished notes and unprocessed backlog for later passes;
9. report affected artifacts and partial outcomes without publishing private
   working notes to ordinary conversation context.

Primary code owners:

- `extensions/memory-core/src/session-ingestion.ts`
- `extensions/memory-core/src/dreaming-phases.ts`
- `extensions/memory-core/src/short-term-promotion-types.ts`
- `extensions/memory-core/src/short-term-promotion-record.ts`
- `extensions/memory-core/src/short-term-promotion-metadata.ts`
- `extensions/memory-core/src/dreaming-consolidation.ts`
- `extensions/memory-core/src/short-term-promotion-apply.ts`
- `extensions/memory-core/src/dreaming-markdown.ts`
- `extensions/memory-core/src/dreaming-dreams-file.ts`

### 14. Replace private-only Active Memory policy

Active Memory should run for every eligible Channel or Thread turn. Once it
decides recall is useful, its deterministic lane and recall subagent use broad
Workspace search with the current Channel and Thread supplied as ranking
context. Optional filters may narrow a specific query, but locality must not be
an implicit hard boundary for `memory_search`.

Remove assumptions that automatic cross-conversation recall requires a direct
or explicit private destination. Preserve tool authority, deadlines, cache
invalidation, late-result rejection, and fail-closed publication checks.

Primary code owners:

- `extensions/active-memory/index.ts`
- `extensions/active-memory/session-policy.ts`
- `extensions/active-memory/recall.ts`
- `extensions/active-memory/trigger-recall.ts`

### 15. Update forget and deletion semantics

Deletion must support selectors for:

- Channel;
- Channel plus Thread;
- User subject;
- Event ID;
- Archive ID;
- source session;
- source participant;
- time range.

Deleting source evidence must remove or invalidate every derived candidate and
curated entry whose cited sources include that evidence. Multi-source claims
should retain the current fail-safe behavior: remove the full claim rather than
ask a model to subtract one contributor from merged prose.

## Delivery plan

### Phase 0: contracts and invariants

- Add `MemoryScope`, `MemoryTurnIdentity`, and canonical ID helpers.
- Persist Channel, Thread, participant-set, and User identity on transcript generations.
- Extend host-minted `MemoryAudience` without changing storage behavior.
- Add unit tests for Slack, Discord, direct-message, Channel, and Thread mapping.

This phase should not change recall results or file locations.

### Phase 1: storage resolver and Workspace migration

- Introduce the only authorized scope-to-path resolver.
- Make `memory/MEMORY.md` canonical.
- Add Doctor migration and conflict reporting for root `MEMORY.md`.
- Update indexing, backup, import, workspace bootstrap, and provenance path
  classification.
- Continue reading legacy daily files as unscoped evidence.

### Phase 2: Fragment appends and scoped lifecycle Events

- Add the Fragment artifact kind to the resolver and the append-only agent
  write surface, restricted to the admitted Channel or Thread.
- Convert the session-memory hook to scoped Event output.
- Record reset, rollover, compaction, inactivity, and Thread closure as Events.
- Keep pre-compaction flush a framework Event; conversation evidence already
  exists as dated Fragments.
- Preserve non-blocking behavior and make each Fragment append an atomic
  compare-and-swap entry addition to the scope's dated day file.
- Stop creating new Workspace-global date-only conversation notes.

### Phase 3: scoped index and recall

- Authorize and filter first via canonical scoped path prefixes; add SQLite
  scope/artifact columns only if measured need is demonstrated.
- Apply one authorization policy to file and transcript hits.
- Add scope filters to provider search and candidate enumeration.
- Compose Thread, Channel, User, and Workspace bootstrap memory.
- Add configurable `memory_context_read` with safe defaults and
  participant-aware pagination.
- Add exact `memory_read` with the same authorization owner as search.
- Enable Active Memory in shared Channels using the scoped audience.

### Phase 4: Event artifacts

- Add Event creation/update APIs and filename generation.
- Integrate cron, hooks, reminders, automation, and lifecycle producers.
- Index Event evidence without automatically injecting it.
- Preserve independent framework provenance and payload trust.

### Phase 5: scoped Dreaming and User extraction

- Admit one Workspace job with recent unprocessed Fragment input and one
  independent SQLite-backed working notebook.
- Connect related evidence across authorized scopes, reading existing Memory
  and source detail on demand.
- Write one scoped `MEMORY.md` per atomic publication operation.
- Let Dreaming publish Archives for substantial, clearly ended matters.
- Keep formal Archive publication exclusive to background Dream.
- Add User evidence weighting and faithful correction or unresolved-conflict
  representation through newer dated evidence.
- Implement normally gradual promotion with strong-signal broader targets.
- Clean fully covered lower-level Memory and Fragment entries after verified
  publication; preserve concurrent additions and useful uncovered content.
- Persist incremental progress and recover outstanding writes through the
  existing coordination and backup owners.

### Phase 6: legacy retirement

- Stop indexing or injecting root `MEMORY.md` after the migration window.
- Retire date-only flush and session-memory paths.
- Remove private/main-session memory branches.
- Remove session-key parsing from memory policy.
- Update public memory, dreaming, user-model, compaction, and channel docs.

## Migration strategy

Legacy data must remain readable without being silently assigned to the wrong
scope.

### Root MEMORY.md

Root `MEMORY.md` migrates to `memory/MEMORY.md` as Workspace memory using the
conflict rules defined above.

### Root USER.md and personal USER.md

Existing personal profiles under `users/<profile-id>/USER.md` can seed
`memory/User/<user-id>/MEMORY.md` after identity mapping. A shared root
`USER.md` must not be copied into every User automatically. It should be
reviewed as either Workspace guidance, a specific User profile, or obsolete
bootstrap content.

### Daily memory

Legacy `memory/YYYY-MM-DD.md` files have no reliable Channel or Thread scope.
Keep them in a `legacy-unscoped` classification and exclude them from automatic
Channel/Thread bootstrap. They remain available to explicit migration and
review tools.

### Session-memory summaries

Legacy `memory/YYYY-MM-DD-<slug>.md` files may contain Session Key and Session ID
headers. Migration may resolve those identifiers through authoritative retained
session metadata. If the metadata maps unambiguously to a Channel and optional
Thread, convert the file to a legacy session-capture Event. Dreaming may later
use that Event to produce an Archive. Otherwise leave it legacy-unscoped.

### Dreaming state

Existing short-term candidates without scope metadata must not enter scoped
automatic promotion. They may remain visible in diagnostics and explicit
migration previews. New scoped candidates should use a versioned store schema so
rollback does not reinterpret old entries.

## Test strategy

### Identity and routing

- Slack Channel and Thread map to stable Channel/Thread scopes.
- Discord native Thread maps to a Thread with the correct parent Channel.
- Direct messages map to Channels without a private-memory special case.
- Canonical Channel IDs do not collide across providers or accounts.
- Thread IDs are authorized only with their parent Channel ID.

### Storage

- Encoded IDs cannot escape their scope directories.
- Display-name changes do not change identity paths.
- Concurrent Event creation cannot collide.
- Event filenames follow `YYYY-MM-DD_EventName_timestamp.md`.
- Workspace migration handles missing, identical, and conflicting files.
- No operation writes both legacy and new Workspace paths.

### Bootstrap and recall

- Channel bootstrap context includes Workspace, current Channel, and bounded
  summaries for all Channel participants.
- Thread context additionally includes its current Thread and any additional
  Thread-bound participants.
- `memory_context_read()` defaults to current Workspace, Channel, optional
  Thread, and every participating User without requiring identifiers.
- `layers`, `userNames`, `detail`, and `cursor` narrow or continue the current
  Context read without accepting raw paths.
- Oversized context reads report omissions and a cursor instead of silently
  dropping a User.
- Explicit search can discover sibling Channels, Threads, Users, Events, and
  Archives across the Workspace.
- Current Channel and Thread rank above unrelated scopes.
- User filtering requires an explicit resolvable `userName`.
- Ambiguous User names fail closed instead of selecting a likely person.
- Search, context read, and exact read apply identical authorization.
- Legacy-unscoped daily files are not automatically injected.

### Flush and lifecycle Events

- Pre-compaction flush persists only to its authorized Channel or Thread target.
- Pre-compaction flush records an Event and submits candidates; it does not
  create an Archive.
- Reset and rollover produce Events under the correct scope.
- Flush failure does not block compaction or replies.
- Recalled memory is not re-extracted into a new Event candidate.

<a id="event-1" />
<a id="event-2" />

### Event trust and state

- Framework metadata and payload trust remain distinct.
- External payload text cannot become trusted because it was stored in an Event.
- Event state updates retain event identity and source references.
- Workspace-, Channel-, Thread-, and User-targeted Events resolve correctly.

<a id="dreaming-1" />
<a id="dreaming-2" />

### Dreaming behavior

- Related evidence across authorized Threads and Channels supports wider
  knowledge without collapsing source identity or visibility.
- One atomic publication writes exactly one target; a pass can serve several.
- Conversation promotion is normally Thread to parent Channel to Workspace,
  with strong-signal skips and launch Channel exclusion.
- One-off plans are processed without mandatory promotion.
- Incremental selection skips unchanged processed entries and services older
  unprocessed backlog without treating the recent window as expiry.
- One Workspace notebook supports continuation and is absent from ordinary
  reads, searches, public exports, and reports.
- User candidates from several Channels consolidate by subject User.
- Background Dreaming is the only Archive producer; direct summaries create no Archive.
- Third-party User claims rank below self-declared evidence.
- Source deletion invalidates derived scoped entries.
- Routine covered-source cleanup preserves successfully published replacements;
  explicit forget still clears dependent outputs and Dream state.
- Archives require ended matters, accept genuine dated additions, and are not
  routinely rescanned for organization.
- Memory-to-Archive references survive lower-level cleanup and are reauthorized.
- Concurrent Fragment append survives cleanup; failed or uncertain publication
  never advances cleanup or discards pending source work.
- Existing size, loss, concurrency, and provenance gates remain effective.

## Risks and open decisions

The discussion resolves shared-group behavior, confidential-fact exclusion,
autonomous normally gradual promotion, broad incremental Dream input,
independent working notes, covered-source cleanup, launch Channel exclusion,
and ended-matter Archives. Canonical IDs use the implemented opaque hash format. Remaining
implementation decisions are:

1. **Persistent changes.** The incremental Dream state and cleanup contract is
   accepted. Changes beyond that subset, including index or transcript schemas,
   require storage review.
2. **Archive evidence boundary.** Decide which transcript ranges and Events a
   background Dream pass may combine into one Archive.
3. **Event mutability.** Define which Event fields are append-only and which
   state fields may be atomically replaced.
4. **User identity lookup.** Integrate the existing Profile linking and
   revocation owner; never merge people from nickname similarity.
5. **User fact sensitivity.** Implement the confirmed confidential-fact
   exclusion and confirmation on visibility changes.
6. **Workspace promotion authority.** Validate autonomous promotion against
   current source and target audiences, source versions, and group authority.
7. **Thread closure.** Define which platform lifecycle signals create a
   `thread.closed` Event and when Dreaming should turn the closed discussion into
   an Archive.
8. **Working-state validation.** The accepted SQLite notebook, incremental entry
   identity, capacity, publication recovery, and cleanup receipts have local
   test coverage. Live Discord and model-quality validation remain outstanding.
   Keep review reports distinct from private working notes.
9. **Case and path portability.** Define one encoding compatible with macOS,
   Linux, and Windows filesystems before writing migration code.
10. **Legacy retention window.** Define how long compatibility reads remain
    available after migration.

## Recommended first implementation slice

The first slice should establish identity and storage without attempting the
complete Dreaming redesign:

1. Add canonical Channel, Thread, and User identity to inbound turns and
   transcript generations.
2. Extend `MemoryAudience` with typed readable and writable scopes.
3. Add the central scope-to-path resolver.
4. Move Workspace memory to `memory/MEMORY.md` with Doctor migration.
5. Convert session-memory output into scoped lifecycle Events.
6. Change pre-compaction flush to emit a scoped Event and candidates.
7. Add scope metadata to new index chunks while retaining compatibility reads.

This creates a complete source-to-storage identity chain. Scoped bootstrap,
Active Memory, Event producers, and hierarchical Dreaming can then build on one
authoritative contract instead of introducing temporary path conventions.

## Acceptance criteria

The design is complete when all of the following are true:

- every interactive turn has a host-authenticated Channel and optional Thread;
- named User references resolve to stable User identities or fail as ambiguous;
- every indexed memory chunk has an explicit scope or is marked legacy-unscoped;
- explicit memory search covers the Workspace corpus and ranks current scope
  higher;
- automatic bootstrap injection remains bounded to Workspace, Channel, current
  Thread, and the complete participant set;
- `memory_context_read()` retrieves those current Context memories without a
  search query or explicit scope identifiers;
- exact User reads outside the aggregate Context require an unambiguous
  `userName`;
- Workspace memory loads from `memory/MEMORY.md`;
- reset, rollover, and compaction records are scoped Events;
- framework triggers can create independently addressable Event files;
- only background Dreaming creates Archives;
- Dream connects authorized evidence across the Workspace and validates exact
  publication targets after analysis;
- Dream continues from recent unprocessed Fragments and its private notebook;
- promotion is normally gradual, with autonomous strong-signal broader targets;
- covered lower-level material is cleaned only after verified replacement;
- Archives capture substantial ended matters and primarily support retrieval;
- User memory can be extracted from ordinary Channel and Thread evidence;
- all promoted entries retain traceable source evidence;
- existing provenance, atomic-write, budget, and non-blocking reply guarantees
  continue to hold.

## Discord Dream configuration

Set `channels.discord.guilds.<guildId>.channels.<channelId>.members` to stable
Discord user IDs and set `threadMode` explicitly. `members` defines the shared
memory group; it does not grant send permission or replace `users`/`roles` ACLs.
Dream accepts exact channel IDs and verified public Thread origins. Missing
membership, ambiguous channel configuration, private Threads, and legacy
unmarked Fragment entries are preserved and deferred.

`threadMode: "always"` excludes the parent launch Channel from current-context
reads, scoped Markdown search/get, Fragment append, and Dream input/publication.
Its public Threads remain eligible; the launch Channel grants no Fragment
destination. Existing Channel artifacts remain on disk.
`"auto"` and `"never"` permit Channel evidence. This setting describes memory
participation; `autoThread` continues to own Discord's automatic Thread creation.
Workspace publication requires compatible fixed members across every enabled
configured Channel, including wildcard entries and account overrides. Other
enabled channel integrations defer Workspace publication until their audience
contract is supported. Discord owns these audience facts through
`groups.resolveMemoryPolicy`; the host carries them into a bounded immutable
memory context and Dream consumes the same facts. Background source admission
rechecks current configured membership and target authority before effects.
Compatible Discord groups can still publish scoped
Memory and Archives.

Dream loads admitted scoped Memory and its own referenced Archives, retains
unfinished notes in SQLite, appends dated Archive follow-ups, and removes exact
covered curated entries after replacement verification. It does not scan old
Archives or infer legacy Fragment ownership. A model plan can select a User
target only from the configured group; the source session and current membership
are rechecked before publication. Changing the source Agent's configured
Workspace during analysis revokes the batch's publication authority. Dream
preserves the original Fragments and defers publication; it does not redirect
an already admitted plan to the new Workspace.

## Related current documentation

- [Memory overview](/concepts/memory)
- [Memory architecture](/concepts/memory-architecture)
- [Memory provenance and deletion](/concepts/memory-provenance)
- [Dreaming](/concepts/dreaming)
- [Sessions](/concepts/session)
- [Compaction](/concepts/compaction)
- [User model](/concepts/user-model)
