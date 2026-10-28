import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, it as baseIt, vi } from "vitest";
import {
  applyShortTermPromotions,
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
} from "./short-term-promotion.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "./test-helpers.js";

type RecordRecallParams = Parameters<typeof recordShortTermRecalls>[0];
type RecallResult = RecordRecallParams["results"][number];
type RecallResultExtras = Partial<
  Omit<RecallResult, "path" | "startLine" | "endLine" | "score" | "snippet" | "source">
>;
type RankAllOptions = Omit<
  Parameters<typeof rankShortTermPromotionCandidates>[0],
  "workspaceDir" | "minScore" | "minRecallCount" | "minUniqueQueries"
>;
type ApplyAllOptions = Omit<
  Parameters<typeof applyShortTermPromotions>[0],
  "workspaceDir" | "candidates" | "minScore" | "minRecallCount" | "minUniqueQueries"
>;

export const allPromotionThresholds = {
  minScore: 0,
  minRecallCount: 0,
  minUniqueQueries: 0,
} as const;

export function memoryRecallResult(
  memoryPath: string,
  startLine: number,
  endLine: number,
  score: number,
  snippet: string,
  extras: RecallResultExtras = {},
): RecallResult {
  return { ...extras, path: memoryPath, startLine, endLine, score, snippet, source: "memory" };
}

export function recordMemoryRecalls(
  workspaceDir: string,
  query: string,
  results: RecallResult[],
  options: Omit<RecordRecallParams, "workspaceDir" | "query" | "results"> = {},
): Promise<void> {
  return recordShortTermRecalls({ ...options, workspaceDir, query, results });
}

export function rankAllCandidates(workspaceDir: string, options: RankAllOptions = {}) {
  return rankShortTermPromotionCandidates({ ...options, workspaceDir, ...allPromotionThresholds });
}

export function applyAllCandidates(
  workspaceDir: string,
  candidates: Parameters<typeof applyShortTermPromotions>[0]["candidates"],
  options: ApplyAllOptions = {},
) {
  return applyShortTermPromotions({
    ...options,
    workspaceDir,
    candidates,
    ...allPromotionThresholds,
  });
}

export async function writeDailyMemoryNote(
  workspaceDir: string,
  date: string,
  lines: string[],
): Promise<string> {
  const notePath = path.join(workspaceDir, "memory", `${date}.md`);
  await fs.writeFile(notePath, `${lines.join("\n")}\n`, "utf-8");
  return notePath;
}

export function recordRotateCredentialsRecall(workspaceDir: string): Promise<void> {
  return recordMemoryRecalls(
    workspaceDir,
    "rotate creds",
    [
      memoryRecallResult(
        "memory/2026-04-29.md",
        3,
        3,
        0.96,
        "Rotate the staging Postgres credentials before next deploy.",
      ),
    ],
    { nowMs: Date.parse("2026-04-29T10:00:00.000Z") },
  );
}

export function createShortTermPromotionFixture() {
  let root = "";
  let caseId = 0;

  beforeAll(async () => {
    await configureMemoryCoreDreamingStateForTests();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-promote-"));
  });

  afterAll(async () => {
    if (!root) {
      return;
    }
    await fs.rm(root, { recursive: true, force: true });
    resetMemoryCoreDreamingStateForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function withTempWorkspace(run: (workspaceDir: string) => Promise<void>) {
    const workspaceDir = path.join(root, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
    await run(workspaceDir);
  }

  return {
    get root() {
      return root;
    },
    withTempWorkspace,
    it: (title: string, run: (workspaceDir: string) => Promise<void>) =>
      baseIt(title, async () => {
        await withTempWorkspace(run);
      }),
  };
}
