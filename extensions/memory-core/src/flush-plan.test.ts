// Memory Core tests cover flush plan plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMemoryFlushPlan } from "./flush-plan.js";

describe("buildMemoryFlushPlan", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back when the injected timestamp is outside Date range", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 30, 12, 0, 0));

    const plan = buildMemoryFlushPlan({
      nowMs: 8_640_000_000_000_001,
    });

    expect(plan?.prompt).toContain("Reference UTC: 2026-05-30 12:00 UTC");
  });

  it("includes the user timezone and one current-time reference", () => {
    const plan = buildMemoryFlushPlan({
      cfg: { agents: { defaults: { userTimezone: "America/New_York" } } },
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });
    expect(plan?.prompt).toMatch(
      /Current time: Monday, February 16th, 2026 - 10:00(?: AM)? \(America\/New_York\)/,
    );
    expect(plan?.prompt).toContain("Reference UTC: 2026-02-16 15:00 UTC");
    expect(plan?.prompt.match(/Current time:/g)).toHaveLength(1);
  });

  it("keeps consolidation and destinations outside the flush model's authority", () => {
    const plan = buildMemoryFlushPlan();
    for (const prompt of [plan?.prompt, plan?.systemPrompt]) {
      expect(prompt).toContain("memory_fragment_append");
      expect(prompt).toContain("do not supply a path");
      expect(prompt).toContain("Do not write curated Memory, Events, or Archives");
    }
  });

  it("respects explicit disablement", () => {
    expect(
      buildMemoryFlushPlan({
        cfg: { agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } } },
      }),
    ).toBeNull();
  });
});
