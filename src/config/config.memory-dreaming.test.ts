import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function validateDreaming(dreaming: Record<string, unknown>) {
  const home = tempDirs.make("openclaw-dreaming-config-");
  return validateConfigObjectWithPlugins(
    {
      agents: { entries: { main: {} } },
      plugins: { entries: { "memory-core": { enabled: true, config: { dreaming } } } },
    },
    {
      env: {
        HOME: home,
        OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "extensions"),
        VITEST: "true",
      },
    },
  );
}

it("accepts Dream execution settings through the bundled plugin manifest", () => {
  const execution = {
    model: "openai/dream-config-fixture",
    speed: "fast",
    thinking: "high",
    budget: "cheap",
    maxOutputTokens: 2048,
    temperature: 0,
    timeoutMs: 60000,
  };
  const dreaming = {
    enabled: true,
    execution: { defaults: execution },
    phases: {
      light: { execution },
      rem: { execution },
      deep: { execution },
    },
  };
  const result = validateDreaming(dreaming);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.config.plugins?.entries?.["memory-core"]).toMatchObject({
      enabled: true,
      config: { dreaming },
    });
  }
});

it.each([
  ["defaults", "speed", "instant"],
  ["light", "thinking", "off"],
  ["rem", "budget", "unlimited"],
  ["deep", "maxOutputTokens", 0],
  ["defaults", "maxOutputTokens", 1.5],
  ["light", "timeoutMs", -1],
  ["rem", "timeoutMs", 1.5],
  ["deep", "temperature", -0.1],
  ["defaults", "temperature", 2.1],
  ["deep", "unknownExecutionOption", true],
] as const)("rejects invalid %s execution %s=%j", (scope, field, value) => {
  const execution = { [field]: value };
  const dreaming =
    scope === "defaults"
      ? { execution: { defaults: execution } }
      : { phases: { [scope]: { execution } } };
  const result = validateDreaming(dreaming);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: expect.stringContaining("plugins.entries.memory-core.config.dreaming"),
      }),
    );
  }
});
