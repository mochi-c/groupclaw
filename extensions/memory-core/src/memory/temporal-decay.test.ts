import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryCoreTestHarness } from "../test-helpers.js";
import { mergeHybridResults } from "./hybrid.js";
import { applyTemporalDecayToHybridResults } from "./temporal-decay.js";

const DAY_MS = 86_400_000;
const NOW_MS = Date.UTC(2026, 1, 10);
const { createTempWorkspace } = createMemoryCoreTestHarness();
const selective = { path: "notes", pattern: "stable/**/*.md", evergreen: true };
const notePaths = ["notes/stable/topic.md", "notes/dated/topic.md"];
const dated = ["memory/2026-01-11.md"];
const memoryPolicy = { path: "memory", evergreen: true };
const sessions = ["sessions/main/note.jsonl"];
const sessionPolicy = { path: "sessions", evergreen: true };

it.each([
  [notePaths, 30, [1, 0.5], selective, "memory", undefined, false],
  [notePaths, 0, [1, 0.5], selective, "memory", 30, false],
  [["memory/MEMORY.md"], 90, [1], undefined, "memory", 90, false],
  [dated, 90, [0.5], memoryPolicy, "memory", 90, false],
  [dated, 90, [0.5], memoryPolicy, "memory", 90, true],
  [sessions, 90, [1], sessionPolicy, "sessions", undefined, false],
  [sessions, 90, [0.5], sessionPolicy, "sessions", 30, false],
] as const)(
  "ranks %j with filesystem age %s and expected scores %j",
  async (files, age, expected, extraPath, source, indexedAge, absolute) => {
    const workspaceDir = await createTempWorkspace("openclaw-temporal-decay-");
    for (const file of files) {
      const filename = path.join(workspaceDir, file);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, "memory\n");
      const mtime = new Date(NOW_MS - age * DAY_MS);
      await fs.utimes(filename, mtime, mtime);
    }
    const results = files.map((file) => ({
      path: absolute ? path.join(workspaceDir, file) : file,
      score: 1,
      source,
    }));
    const mtimes = new Map(
      results.map((entry) => [
        entry.path,
        indexedAge === undefined ? undefined : NOW_MS - indexedAge * DAY_MS,
      ]),
    );
    const ranked = await applyTemporalDecayToHybridResults({
      results,
      workspaceDir,
      extraPaths: extraPath ? [extraPath] : undefined,
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      nowMs: NOW_MS,
      memorySourceMtimes: source === "memory" && indexedAge !== undefined ? mtimes : undefined,
      sessionSourceMtimes: source === "sessions" ? mtimes : undefined,
    });
    for (const [index, score] of expected.entries()) {
      expect(ranked[index]?.score).toBeCloseTo(score, 2);
    }
  },
);

function createVectorMemoryEntry(memoryPath: string, vectorScore: number) {
  return {
    id: memoryPath,
    path: memoryPath,
    startLine: 1,
    endLine: 1,
    source: "memory" as const,
    snippet: "memory",
    vectorScore,
  };
}

async function mergeVectorResultsWithTemporalDecay(
  vector: Parameters<typeof mergeHybridResults>[0]["vector"],
) {
  return mergeHybridResults({
    vectorWeight: 1,
    textWeight: 0,
    temporalDecay: { enabled: true, halfLifeDays: 30 },
    mmr: { enabled: false, lambda: 0.7 },
    nowMs: NOW_MS,
    vector,
    keyword: [],
  });
}

describe("temporal decay", () => {
  it("uses indexed remote mtimes in hybrid ranking while retaining evergreen and dated paths", async () => {
    const paths = ["imports/note.md", "memory/MEMORY.md", "memory/2026-02-09.md"];
    const results = await mergeHybridResults({
      vector: paths.map((filePath) => ({
        ...createVectorMemoryEntry(filePath, 1),
        snippet: "host content",
      })),
      keyword: [],
      vectorWeight: 1,
      textWeight: 0,
      mmr: { enabled: false, lambda: 0.7 },
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      nowMs: NOW_MS,
      memorySourceMtimes: new Map(paths.map((filePath) => [filePath, NOW_MS - 30 * DAY_MS])),
    });
    expect(results.find((entry) => entry.path === "imports/note.md")?.score).toBeCloseTo(0.5);
    expect(results.find((entry) => entry.path === "memory/MEMORY.md")?.score).toBe(1);
    expect(results.find((entry) => entry.path === "memory/2026-02-09.md")?.score).toBeGreaterThan(
      0.9,
    );
  });

  it("does not decay evergreen memory files", async () => {
    const dir = await createTempWorkspace("openclaw-temporal-decay-");

    const veryOld = new Date(Date.UTC(2010, 0, 1));
    for (const relativePath of ["memory/MEMORY.md", "USER.md", "memory/projects.md"]) {
      const filePath = path.join(dir, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "evergreen");
      await fs.utimes(filePath, veryOld, veryOld);
    }

    const decayed = await applyTemporalDecayToHybridResults({
      results: [
        { path: "memory/MEMORY.md", score: 1, source: "memory" },
        { path: "USER.md", score: 0.9, source: "memory" },
        { path: "memory/projects.md", score: 0.75, source: "memory" },
      ],
      workspaceDir: dir,
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      nowMs: NOW_MS,
    });

    expect(decayed[0]?.score).toBeCloseTo(1);
    expect(decayed[1]?.score).toBeCloseTo(0.9);
    expect(decayed[2]?.score).toBeCloseTo(0.75);
  });

  it("applies decay in hybrid merging before ranking", async () => {
    const merged = await mergeVectorResultsWithTemporalDecay([
      createVectorMemoryEntry("memory/2025-01-01.md", 0.95),
      createVectorMemoryEntry("memory/2026-02-10.md", 0.8),
    ]);

    expect(merged[0]?.path).toBe("memory/2026-02-10.md");
    expect(merged[0]?.score ?? 0).toBeGreaterThan(merged[1]?.score ?? 0);
  });

  it("decays dated and slugged memory files at any depth by their embedded date", async () => {
    const merged = await mergeVectorResultsWithTemporalDecay([
      createVectorMemoryEntry("memory/dreaming/light/2025-01-01.md", 0.95),
      createVectorMemoryEntry("memory/2025-01-01.md", 0.95),
      createVectorMemoryEntry("memory/2025-01-01-1430.md", 0.95),
      createVectorMemoryEntry("memory/2025-01-01-1430-2.md", 0.95),
      createVectorMemoryEntry("memory/dreaming/light/2025-01-01-vendor-pitch.md", 0.95),
      createVectorMemoryEntry("memory/dreaming/light/report.md", 0.7),
    ]);

    const byPath = new Map(merged.map((entry) => [entry.path, entry]));
    const nestedOld = byPath.get("memory/dreaming/light/2025-01-01.md");
    const rootOld = byPath.get("memory/2025-01-01.md");
    expect(nestedOld?.score).toBeCloseTo(rootOld?.score ?? 0);
    expect(nestedOld?.score ?? 1).toBeLessThan(0.5);
    expect(byPath.get("memory/2025-01-01-1430.md")?.score).toBeCloseTo(rootOld?.score ?? 0);
    expect(byPath.get("memory/2025-01-01-1430-2.md")?.score).toBeCloseTo(rootOld?.score ?? 0);
    expect(byPath.get("memory/dreaming/light/2025-01-01-vendor-pitch.md")?.score).toBeCloseTo(
      rootOld?.score ?? 0,
    );
    expect(byPath.get("memory/dreaming/light/report.md")?.score).toBeCloseTo(0.7);
  });
});
