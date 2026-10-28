---
name: session-memory
description: "Save scoped session lifecycle evidence on reset, compaction, or Thread closure"
homepage: https://docs.openclaw.ai/automation/hooks#session-memory
metadata:
  {
    "openclaw":
      {
        "emoji": "💾",
        "events":
          [
            "command:new",
            "command:reset",
            "session:auto-reset",
            "session:compacted",
            "session:memory-flush",
            "session:closed",
          ],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Session Memory Hook

Automatically saves scoped lifecycle evidence on `/new`, `/reset`, daily reset,
idle expiry, successful embedded compaction, a settled memory flush, or Discord Thread closure.

Incognito sessions are excluded and never create these memory files.

## What It Does

When a manual or automatic reset starts a fresh session:

1. **Finds the previous session** - Uses the pre-reset session entry to locate the correct transcript
2. **Extracts conversation** - Reads the last N user/assistant messages from the session (default: 15, configurable)
3. **Resolves the Event scope** - Uses the departing session's canonical Channel/Thread identity, or Workspace for a local session without a delivery origin
4. **Saves the Event** - Creates `Event/YYYY-MM-DD_session-reset-<event-id>_timestamp.md` under that scope in the background

## Output Format

Events include framework metadata and a bounded, separately classified transcript excerpt:

```markdown
---
schema: 1
artifactType: event
eventType: session.reset
status: completed
scope: { "kind": "workspace" }
sessionId: "abc123def456"
provenance:
  framework: system
  payloadTrust: untrusted
captureStatus: available
---

# Session: 2026-01-16 14:30:00 America/New_York

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram
```

Automatic reset Events use `eventType: session.rollover` and `Reason: daily` or
`Reason: idle` instead of a command source. Each Event also records its unique
identity, creation time, and source session key. Transcript failure is recorded
as `captureStatus: unavailable`.

Successful embedded compactions use `eventType: session.compacted`, with message
and token metrics when available. Standalone compaction includes a bounded
pre-compaction excerpt; automatic compaction captures the remaining conversation.
Events are written in the source agent Workspace even when standalone compaction
executes in a sandbox with read-only or no Workspace access.
Failed, skipped, and aborted compactions do not create completion Events.
Native harness compaction does not yet emit these memory Events.

Tools-arm memory flushes emit `session:memory-flush` after the detached run
settles. Its `memory.pre-compaction-flush` Event records the host-granted
Channel/Thread scope, original session references, `flushId`, run ID, compaction
count, and `outcome` (`completed`, `failed`, `skipped`, or `exhausted`).
Each settled run gets its own Event identity; fallback and retry correlation uses
the existing `flushId`. The Event contains framework metadata only. Candidate
notes stay in the memory provider's storage; Memory Core appends Fragments.
Disabled flushes, invalid audiences, launch Channels, and source revocation create
no flush Event. Capture failure is logged and does not change the flush outcome.

Discord Thread archive/delete uses `eventType: thread.closed` only after the
guarded session deletion commits. The Event identifies the actual deleted
session and its retained transcript archive generations. Its excerpt is marked
unavailable because closure preserves source archives instead of rereading the
deleted session. A rejected deletion creates no closure Event.

Thread Events remain under the departing Thread even when its successor routes
elsewhere. A group/channel session without canonical delivery identity produces
a logged failure rather than a Workspace artifact. Launch Channel policy can
exclude its Events. Events are recallable evidence and are never automatically
injected as current memory. Only Dream creates semantic Archives.

## Filename Examples

The host assigns the event type, unique identity, and immutable creation timestamp:

- `2026-01-16_session-reset-<event-id>_1768591800000.md`

With `llmSlug: true`, the configured model can append a descriptive slug:

- `2026-01-16_session-reset-<event-id>-vendor-pitch_1768591800000.md`

Independent identities and exclusive publication preserve concurrent captures
that share the same millisecond.

## Requirements

- A resolved agent workspace. Configure it with `agents.defaults.workspace` or
  `agents.entries.<id>.workspace` when the default is unsuitable. The descriptor's
  `workspace.dir` requirement is an internal eligibility marker, not an
  `openclaw.json` key to add.

When `llmSlug` is enabled, the hook uses your configured LLM provider to generate slugs, so it works with any provider (Anthropic, OpenAI, etc.).

## Configuration

The hook supports optional configuration:

| Option     | Type    | Default       | Description                                                                                 |
| ---------- | ------- | ------------- | ------------------------------------------------------------------------------------------- |
| `messages` | number  | 15            | Number of user/assistant messages to include in the memory file                             |
| `llmSlug`  | boolean | false         | Use your configured model to generate descriptive filename slugs instead of timestamp slugs |
| `model`    | string  | agent default | Configured alias, bare model ID on the default provider, or `provider/model` override       |

Example configuration:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": {
          "enabled": true,
          "messages": 25,
          "llmSlug": true,
          "model": "sonnet"
        }
      }
    }
  }
}
```

The hook automatically:

- Uses your workspace directory (`~/.openclaw/workspace` by default)
- Uses host-assigned Event identities by default so reset handling stays fast
- Uses `agents.defaults.userTimezone` for artifact dates and timestamps, with the host timezone as fallback
- Runs memory capture in the background so replacement sessions are not delayed
- Uses your configured LLM for slug generation only when `llmSlug` is `true`
- Resolves configured aliases such as `sonnet`; bare model IDs use the agent's default provider, while `provider/model` selects another provider
- Uses the event type and identity if LLM slug generation is unavailable

## Disabling

To disable this hook:

```bash
openclaw hooks disable session-memory
```

Or explicitly disable its config entry, then restart the Gateway:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": { "enabled": false }
      }
    }
  }
}
```
