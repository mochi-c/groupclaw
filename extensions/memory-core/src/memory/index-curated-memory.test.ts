import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  INVALID_PROJECT_ANNOTATION_KEY,
  MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("curated memory index", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { createConfig: createCfg, getFreshManager } = fixture;
  const writeMemory = (filename: string, content: string) =>
    fs.writeFile(path.join(fixture.paths.memory, filename), content);

  it("round-trips mixed-case project keys through indexed recall consumers", async () => {
    const projectKey = "github.com/OpenClaw/OpenClaw";
    await writeMemory(
      "MEMORY.md",
      `- Follow the kraken deploy ritual. <!-- trigger: kraken deploy ritual --> <!-- importance: 8 --> <!-- project: ${projectKey} -->\n`,
    );

    const manager = await getFreshManager(createCfg({}));
    await manager.sync({ reason: "test", force: true });
    const db = Reflect.get(manager, "db") as DatabaseSync;
    expect(
      db
        .prepare(
          `SELECT metadata.project_key AS projectKey
           FROM memory_index_chunks AS chunk
           JOIN memory_index_chunk_recall_metadata AS metadata
             ON metadata.chunk_id = chunk.id
           WHERE chunk.path = 'memory/MEMORY.md'
             AND metadata.triggers = 'kraken deploy ritual'`,
        )
        .get(),
    ).toEqual({ projectKey });

    const activeProjectKeys = [projectKey];
    const curated = await manager.listCuratedProjectCandidates({ activeProjectKeys });
    const triggers = await manager.listTriggerCandidates({ activeProjectKeys });
    const expectedCandidates = [
      {
        projectKey,
        triggers: "kraken deploy ritual",
        provenance: { originClass: "agent" },
      },
    ];
    expect(curated).toMatchObject(expectedCandidates);
    expect(triggers).toMatchObject(expectedCandidates);

    const neutral = await manager.search("kraken deploy", {
      minScore: 0,
      maxResults: 10,
      activeProjectKeys: [],
    });
    const active = await manager.search("kraken deploy", {
      minScore: 0,
      maxResults: 10,
      activeProjectKeys,
    });
    const neutralHit = neutral.find((entry) => entry.projectKey === projectKey);
    const activeHit = active.find((entry) => entry.projectKey === projectKey);
    assert.ok(neutralHit && activeHit, "expected neutral and active project hits");
    expect(activeHit.score).toBeGreaterThan(neutralHit.score);
  });

  it("keeps quarantined curated memory searchable but out of automatic candidates", async () => {
    const projectKey = "github.com/openclaw/openclaw";
    await writeMemory(
      "MEMORY.md",
      `- Quarantined release instruction. <!-- trigger: release instruction --> <!-- project: ${projectKey} -->\n`,
    );
    const manager = await getFreshManager(createCfg({ provider: "none" }));
    await manager.sync({ reason: "test", force: true });
    const db = memoryIndexFixtureWriter(manager);
    db.prepare(
      `UPDATE ${MEMORY_INDEX_CHUNK_PROVENANCE_TABLE}
       SET origin_class = 'untrusted'
       WHERE chunk_id IN (
         SELECT id FROM memory_index_chunks WHERE path = 'memory/MEMORY.md' AND source = 'memory'
       )`,
    ).run();
    await expect(
      manager.listCuratedProjectCandidates({ activeProjectKeys: [projectKey] }),
    ).resolves.toEqual([]);
    await expect(
      manager.listTriggerCandidates({ activeProjectKeys: [projectKey] }),
    ).resolves.toEqual([]);

    const explicit = await manager.search("Quarantined release instruction", {
      lexicalOnly: true,
      minScore: 0,
      maxResults: 10,
      sources: ["memory"],
    });
    expect(explicit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provenance: expect.objectContaining({ originClass: "untrusted" }),
        }),
      ]),
    );
  });

  it("keeps invalid project annotations scoped but unsatisfiable", async () => {
    await writeMemory(
      "MEMORY.md",
      [
        "- Invalid fact. <!-- trigger: invalid fact --> <!-- project: bad< -->",
        "- Mixed fact. <!-- trigger: mixed fact --> <!-- project: alpha-key; bad< -->",
        "- Unterminated fact. <!-- trigger: unterminated fact --> <!-- project: alpha-key",
        "- Global fact. <!-- trigger: global fact -->",
      ].join("\n"),
    );
    const manager = await getFreshManager(createCfg({ provider: "none" }));
    await manager.sync({ reason: "test", force: true });
    const db = Reflect.get(manager, "db") as DatabaseSync;
    expect(
      db
        .prepare(
          `SELECT metadata.triggers, metadata.project_key AS projectKey
           FROM memory_index_chunks AS chunk
           LEFT JOIN memory_index_chunk_recall_metadata AS metadata
             ON metadata.chunk_id = chunk.id
           WHERE chunk.path = 'memory/MEMORY.md'
           ORDER BY chunk.start_line`,
        )
        .all(),
    ).toEqual([
      { triggers: "invalid fact", projectKey: INVALID_PROJECT_ANNOTATION_KEY },
      { triggers: "mixed fact", projectKey: INVALID_PROJECT_ANNOTATION_KEY },
      { triggers: null, projectKey: INVALID_PROJECT_ANNOTATION_KEY },
      { triggers: "global fact", projectKey: null },
    ]);
    const activeProjectKeys = ["alpha-key"];
    const triggerCandidates = await manager.listTriggerCandidates({ activeProjectKeys });
    expect(triggerCandidates).toMatchObject([{ triggers: "global fact" }]);
    const results = await manager.search("fact", {
      minScore: 0,
      maxResults: 10,
      activeProjectKeys,
    });
    expect(
      results.every((entry) => !/Invalid fact|Mixed fact|Unterminated fact/u.test(entry.snippet)),
    ).toBe(true);
  });

  it("keeps indexed memory searchable when source discovery fails", async () => {
    const memoryPath = path.join(fixture.paths.memory, "MEMORY.md");
    const query = "harbor seal migration ritual";
    await fs.writeFile(memoryPath, `Remember the ${query}.\n`);
    const manager = await getFreshManager(createCfg({}));
    await manager.sync({ reason: "test", force: true });
    await expect(manager.search(query)).resolves.toEqual([
      expect.objectContaining({ path: "memory/MEMORY.md" }),
    ]);

    const scanError = Object.assign(new Error("workspace scan failed"), { code: "EIO" });
    const realReaddir = fs.readdir;
    const readdirSpy = vi
      .spyOn(fs, "readdir")
      .mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
        const scannedDir = path.resolve(String(args[0]));
        if (scannedDir === fixture.paths.workspace || scannedDir === fixture.paths.memory) {
          throw scanError;
        }
        return await realReaddir(...args);
      });
    try {
      await expect(manager.sync({ reason: "cli", force: true })).rejects.toThrow(
        "memory source scan failed",
      );
    } finally {
      readdirSpy.mockRestore();
    }

    await expect(manager.search(query)).resolves.toEqual([
      expect.objectContaining({ path: "memory/MEMORY.md" }),
    ]);
  });
});
