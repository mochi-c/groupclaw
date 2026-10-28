import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it as baseIt, vi } from "vitest";
import {
  applyShortTermPromotions,
  rankShortTermPromotionCandidates,
} from "./short-term-promotion.js";
import {
  applyAllCandidates,
  createShortTermPromotionFixture,
  memoryRecallResult,
  rankAllCandidates,
  recordMemoryRecalls,
  recordRotateCredentialsRecall,
  writeDailyMemoryNote,
} from "./short-term-promotion.test-support.js";

vi.mock("openclaw/plugin-sdk/memory-host-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/memory-host-events")>()),
  appendMemoryHostEvent: vi.fn(async () => {}),
}));
vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-core", { spy: true });

describe("MEMORY.md atomic promotion write", () => {
  const fixture = createShortTermPromotionFixture();
  const { it, withTempWorkspace } = fixture;

  baseIt.runIf(process.platform !== "win32")(
    "preserves a dangling MEMORY.md symlink and its target directory mode",
    async () => {
      await withTempWorkspace(async (workspaceDir) => {
        await writeDailyMemoryNote(workspaceDir, "2026-04-29", [
          "Keep the shared memory target and directory permissions intact.",
        ]);

        const aliasParent = path.join(
          fixture.root,
          `${path.basename(workspaceDir)}-alias`,
          "nested",
        );
        const workspaceAlias = path.join(aliasParent, "workspace");
        const sharedDir = path.join(fixture.root, `${path.basename(workspaceDir)}-shared`);
        const linkedDir = path.join(workspaceDir, "linked");
        const intermediatePath = path.join(sharedDir, "memory-alias.md");
        const targetPath = path.join(sharedDir, `${"long".repeat(55)}\\`);
        const memoryPath = path.join(workspaceDir, "memory", "MEMORY.md");
        await fs.mkdir(aliasParent, { recursive: true });
        await fs.mkdir(path.join(sharedDir, "nested"), { recursive: true });
        await fs.chmod(sharedDir, 0o755);
        await fs.symlink(workspaceDir, workspaceAlias);
        await fs.symlink(path.join(sharedDir, "nested"), linkedDir);
        await fs.symlink(path.basename(targetPath), intermediatePath);
        await fs.symlink("invalid-target.md/", memoryPath);

        await recordMemoryRecalls(
          workspaceAlias,
          "shared memory",
          [
            memoryRecallResult(
              "memory/2026-04-29.md",
              1,
              1,
              0.96,
              "Keep the shared memory target and directory permissions intact.",
            ),
          ],
          { nowMs: Date.parse("2026-04-29T10:00:00.000Z") },
        );
        const ranked = await rankAllCandidates(workspaceAlias);

        await expect(
          applyShortTermPromotions({
            workspaceDir: workspaceAlias,
            candidates: ranked,
            minScore: 0,
            minRecallCount: 0,
            minUniqueQueries: 0,
          }),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          fs.lstat(path.join(workspaceDir, "memory", "invalid-target.md")),
        ).rejects.toHaveProperty("code", "ENOENT");
        await fs.unlink(memoryPath);
        await fs.symlink("../linked/../memory-alias.md", memoryPath);

        await applyAllCandidates(workspaceAlias, ranked);

        expect((await fs.lstat(memoryPath)).isSymbolicLink()).toBe(true);
        expect((await fs.lstat(intermediatePath)).isSymbolicLink()).toBe(true);
        expect(await fs.readFile(targetPath, "utf-8")).toContain(
          "Keep the shared memory target and directory permissions intact.",
        );
        expect((await fs.stat(sharedDir)).mode & 0o7777).toBe(0o755);

        const secondSnippet = "Keep writing through a shared read-only directory.";
        const lexicalCollisionPath = path.join(workspaceDir, "memory-alias.md");
        await fs.writeFile(lexicalCollisionPath, "Do not overwrite this lexical collision.");
        await writeDailyMemoryNote(workspaceDir, "2026-04-30", [secondSnippet]);
        await recordMemoryRecalls(
          workspaceAlias,
          "read-only parent",
          [memoryRecallResult("memory/2026-04-30.md", 1, 1, 0.96, secondSnippet)],
          { nowMs: Date.parse("2026-04-30T10:00:00.000Z") },
        );
        const secondRanked = await rankAllCandidates(workspaceAlias);

        await fs.chmod(targetPath, 0o600);
        await fs.chmod(sharedDir, 0o555);
        try {
          const applied = await applyAllCandidates(workspaceAlias, secondRanked, {
            memoryFileMaxChars: 400,
            maxPriorEntryLossFraction: 1,
          });
          expect(applied.applied).toBe(1);
          expect(await fs.readFile(targetPath, "utf-8")).toContain(secondSnippet);
          expect(await fs.readFile(lexicalCollisionPath, "utf-8")).toBe(
            "Do not overwrite this lexical collision.",
          );
          expect((await fs.stat(sharedDir)).mode & 0o7777).toBe(0o555);
        } finally {
          await fs.chmod(sharedDir, 0o755);
        }
      });
    },
  );

  it("preserves the existing MEMORY.md when the promotion write fails mid-flight", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-29", [
      "Notes",
      "",
      "Rotate the staging Postgres credentials before next deploy.",
    ]);

    const memoryPath = path.join(workspaceDir, "memory", "MEMORY.md");
    const sentinel = "FINAL-USER-MEMORY-SENTINEL-do-not-lose";
    const filler = "pad line filler content ".repeat(9_000);
    const seeded = `# Long-Term Memory\n\n${filler}\n- ${sentinel}\n`;
    await fs.writeFile(memoryPath, seeded, "utf-8");

    await recordRotateCredentialsRecall(workspaceDir);

    const ranked = await rankAllCandidates(workspaceDir);

    const truncateAt = 51_200;
    const originalOpen = fs.open.bind(fs);
    const originalWriteFile = fs.writeFile.bind(fs);
    const promotionTempHandles = new WeakSet<object>();
    vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
      const handle = await originalOpen(target, flags, mode);
      if (typeof target === "string" && path.basename(target).startsWith("MEMORY.md.promotion")) {
        promotionTempHandles.add(handle);
      }
      return handle;
    });
    vi.spyOn(fs, "writeFile").mockImplementation((async (
      target: Parameters<typeof fs.writeFile>[0],
      data: Parameters<typeof fs.writeFile>[1],
      options?: Parameters<typeof fs.writeFile>[2],
    ) => {
      const targetPath =
        typeof target === "string" ? target : target instanceof URL ? target.pathname : "";
      if (
        (targetPath && path.basename(targetPath).startsWith("MEMORY.md")) ||
        (typeof target === "object" && target !== null && promotionTempHandles.has(target))
      ) {
        const text = typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString();
        await originalWriteFile(target, text.slice(0, truncateAt), options);
        throw Object.assign(new Error("EFBIG: file too large, write"), {
          code: "EFBIG",
        });
      }
      return originalWriteFile(target, data, options);
    }) as typeof fs.writeFile);

    await expect(
      applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-29T10:00:00.000Z"),
        memoryFileMaxChars: 5_000_000,
      }),
    ).rejects.toMatchObject({ code: "EFBIG" });

    const after = await fs.readFile(memoryPath, "utf-8");
    expect(after).toBe(seeded);
    await expect(
      rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      }),
    ).resolves.toHaveLength(1);
    expect(
      (await fs.readdir(path.join(workspaceDir, "memory"))).filter((entry) =>
        entry.startsWith("MEMORY.md.promotion"),
      ),
    ).toEqual([]);
  });
});
