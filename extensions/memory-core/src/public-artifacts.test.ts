import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { appendMemoryHostEvent } from "openclaw/plugin-sdk/memory-host-events";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
afterEach(() => {
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
});
const registerMemoryCapability = vi.fn<OpenClawPluginApi["registerMemoryCapability"]>();
plugin.register(createTestPluginApi({ registerMemoryCapability }));
const publicArtifacts = registerMemoryCapability.mock.calls[0]?.[0].publicArtifacts;
assert(publicArtifacts, "expected memory-core to register public artifacts");

describe("memory-core public artifacts", () => {
  let fixtureRoot = "";

  beforeAll(() => {
    fixtureRoot = tempDirs.make("memory-core-public-artifacts-");
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("lists public workspace artifacts with stable kinds", async () => {
    const workspaceDir = path.join(fixtureRoot, "workspace-stable-kinds");
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtureRoot);
    await fs.mkdir(path.join(workspaceDir, "memory", "dreaming"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "memory", "MEMORY.md"),
      "# Durable Memory\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-06.md"),
      "# Daily Note\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "memory", "dreaming", "2026-04-06.md"),
      "# Dream Report\n",
      "utf8",
    );
    const eventStoredAt = Date.parse("2026-04-07T09:30:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(eventStoredAt);
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.recall.recorded",
      timestamp: "2026-04-06T12:00:00.000Z",
      query: "alpha",
      resultCount: 0,
      results: [],
    });

    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: { workspace: workspaceDir } },
      },
    };

    const artifacts = await publicArtifacts.listArtifacts({ cfg });
    const eventArtifact = artifacts.find((artifact) => artifact.kind === "event-log");
    if (!eventArtifact) {
      throw new Error("expected memory event export");
    }
    expect(artifacts.filter((artifact) => artifact.kind !== "event-log")).toEqual([
      {
        kind: "daily-note",
        workspaceDir,
        relativePath: "memory/2026-04-06.md",
        absolutePath: path.join(workspaceDir, "memory", "2026-04-06.md"),
        agentIds: ["main"],
        contentType: "markdown",
      },
      {
        kind: "dream-report",
        workspaceDir,
        relativePath: "memory/dreaming/2026-04-06.md",
        absolutePath: path.join(workspaceDir, "memory", "dreaming", "2026-04-06.md"),
        agentIds: ["main"],
        contentType: "markdown",
      },
      {
        kind: "memory-root",
        workspaceDir,
        relativePath: "memory/MEMORY.md",
        absolutePath: path.join(workspaceDir, "memory", "MEMORY.md"),
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);
    expect(eventArtifact.relativePath).toMatch(
      /^memory\/events\/[a-f0-9]{32}\/memory-host-events\.jsonl$/u,
    );
    await expect(fs.readFile(eventArtifact.absolutePath, "utf8")).resolves.toBe(
      `${JSON.stringify({
        type: "memory.recall.recorded",
        timestamp: "2026-04-06T12:00:00.000Z",
        query: "alpha",
        resultCount: 0,
        results: [],
      })}\n`,
    );
  });

  it("ignores lowercase memory root when only the legacy filename exists", async () => {
    const workspaceDir = path.join(fixtureRoot, "workspace-lowercase-root");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "memory.md"), "# Legacy Durable Memory\n", "utf8");

    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: { workspace: workspaceDir } },
      },
    };

    await expect(publicArtifacts.listArtifacts({ cfg })).resolves.toStrictEqual([]);
  });
});
