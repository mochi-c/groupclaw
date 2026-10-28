import { readFile, rm, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendAgentMemoryFragmentFile,
  MEMORY_FRAGMENT_MAX_CHARS,
} from "./fragment-memory-write.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

createMemoryCoreTestHarness();

function visibleContent(content: string): string {
  return content.replace(/^<!-- openclaw-memory-(?:promotion|end):[^\n]+ -->\n/gmu, "");
}

const tempDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fragment-write-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function workspaceConfig(workspaceDir: string): OpenClawConfig {
  return {
    agents: { entries: { main: { workspace: workspaceDir } } },
  } as unknown as OpenClawConfig;
}

describe("appendAgentMemoryFragmentFile", () => {
  it.each([
    { title: "planning time", heading: "## 14:05 — planning time" },
    { title: undefined, heading: "## 14:05" },
    { title: "  # Plan\n\ndetails\tline  ", heading: "## 14:05 — Plan details line" },
    { title: "Plan\u0000?\u007f", heading: "## 14:05 — Plan?" },
  ])("writes a heading-safe entry and nested directories: $heading", async ({ title, heading }) => {
    const workspaceDir = await createWorkspace();
    const relPath = "memory/Channel/id-channel/Thread/id-thread/Fragment/2026-10-24.md";

    const result = await appendAgentMemoryFragmentFile({
      cfg: workspaceConfig(workspaceDir),
      agentId: "main",
      relPath,
      timeLabel: "14:05",
      title,
      content: "  Alice confirmed Friday.  ",
    });

    expect(result.relativePath).toBe(relPath);
    const written = await readFile(path.join(workspaceDir, relPath), "utf8");
    expect(visibleContent(written)).toBe(`${heading}\n\nAlice confirmed Friday.\n`);
  });

  it("appends repeated notes to the same day file in order without overwriting", async () => {
    const workspaceDir = await createWorkspace();
    const relPath = "memory/Channel/id-channel/Fragment/2026-10-24.md";
    const cfg = workspaceConfig(workspaceDir);

    await appendAgentMemoryFragmentFile({
      cfg,
      agentId: "main",
      relPath,
      timeLabel: "09:00",
      content: "first",
    });
    await appendAgentMemoryFragmentFile({
      cfg,
      agentId: "main",
      relPath,
      timeLabel: "09:30",
      title: "stand-up",
      content: "second",
    });

    const written = await readFile(path.join(workspaceDir, relPath), "utf8");
    expect(visibleContent(written)).toBe("## 09:00\n\nfirst\n\n## 09:30 — stand-up\n\nsecond\n");
  });

  it("keeps distinct dates and scopes in distinct files", async () => {
    const workspaceDir = await createWorkspace();
    const cfg = workspaceConfig(workspaceDir);
    const dayOne = "memory/Channel/id-channel/Fragment/2026-10-24.md";
    const dayTwo = "memory/Channel/id-channel/Fragment/2026-10-25.md";

    await appendAgentMemoryFragmentFile({
      cfg,
      agentId: "main",
      relPath: dayOne,
      timeLabel: "23:59",
      content: "today",
    });
    await appendAgentMemoryFragmentFile({
      cfg,
      agentId: "main",
      relPath: dayTwo,
      timeLabel: "00:01",
      content: "tomorrow",
    });

    expect(visibleContent(await readFile(path.join(workspaceDir, dayOne), "utf8"))).toBe(
      "## 23:59\n\ntoday\n",
    );
    expect(visibleContent(await readFile(path.join(workspaceDir, dayTwo), "utf8"))).toBe(
      "## 00:01\n\ntomorrow\n",
    );
  });

  it("preserves every simultaneous append and gives repeated identical entries distinct identities", async () => {
    const workspaceDir = await createWorkspace();
    const relPath = "memory/Channel/id-channel/Fragment/2026-10-24.md";
    await Promise.all(
      Array.from({ length: 12 }, () =>
        appendAgentMemoryFragmentFile({
          cfg: workspaceConfig(workspaceDir),
          agentId: "main",
          relPath,
          timeLabel: "09:00",
          content: "same note",
        }),
      ),
    );
    const written = await readFile(path.join(workspaceDir, relPath), "utf8");
    const ids = [...written.matchAll(/openclaw-memory-promotion:([^ ]+)/gu)].map(
      (match) => match[1],
    );
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect(written.match(/same note/gu)).toHaveLength(12);
  });

  it.each([
    ["workspace memory", "memory/MEMORY.md"],
    ["user scope", "memory/User/id-alice/Fragment/2026-10-24.md"],
    ["non-fragment channel dir", "memory/Channel/id-channel/Event/2026-10-24.md"],
    ["legacy per-note name", "memory/Channel/id-channel/Fragment/2026-10-24_note_1.md"],
    ["path traversal", "memory/Channel/id-channel/Fragment/../../MEMORY.md"],
  ])("rejects non-fragment day paths: %s", async (_label, relPath) => {
    const workspaceDir = await createWorkspace();
    await expect(
      appendAgentMemoryFragmentFile({
        cfg: workspaceConfig(workspaceDir),
        agentId: "main",
        relPath,
        timeLabel: "10:00",
        content: "note",
      }),
    ).rejects.toThrow(/fragment/i);
  });

  it("rejects empty or oversized content and invalid time labels", async () => {
    const workspaceDir = await createWorkspace();
    const relPath = "memory/Channel/id-channel/Fragment/2026-10-24.md";
    const base = { cfg: workspaceConfig(workspaceDir), agentId: "main", relPath };

    await expect(
      appendAgentMemoryFragmentFile({ ...base, timeLabel: "10:00", content: "  " }),
    ).rejects.toThrow("non-empty");
    await expect(
      appendAgentMemoryFragmentFile({
        ...base,
        timeLabel: "10:00",
        content: "x".repeat(MEMORY_FRAGMENT_MAX_CHARS + 1),
      }),
    ).rejects.toThrow(`at most ${MEMORY_FRAGMENT_MAX_CHARS} characters`);
    await expect(
      appendAgentMemoryFragmentFile({ ...base, timeLabel: "25:00", content: "note" }),
    ).rejects.toThrow("HH:MM");
  });
});
