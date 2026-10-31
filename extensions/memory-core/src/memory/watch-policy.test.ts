import fs from "node:fs/promises";
import path from "node:path";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryWatchPolicy } from "./watch-policy.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "memory-watch-policy" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await state.cleanup();
});
const p = (...parts: string[]) => state.path(...parts);
const observe = (owner: MemoryWatchPolicy) => owner.observations(new AbortController().signal);
type ExtraPaths = ConstructorParameters<typeof MemoryWatchPolicy>[1]["extraPaths"];
function policy(extraPaths: ExtraPaths = [], media = false, workspace = state.workspaceDir) {
  const modalities: ("image" | "audio")[] = media ? ["image", "audio"] : [];
  return new MemoryWatchPolicy(workspace, {
    extraPaths,
    multimodal: { enabled: media, modalities, maxFileBytes: 10485760 },
    sync: { watchDebounceMs: 0 },
  });
}

it("observes root-entry links without following sources the indexer rejects", async () => {
  await fs.mkdir(state.path("target"));
  await fs.writeFile(state.path("target", "note.md"), "trusted");
  await fs.symlink(state.path("target"), path.join(state.workspaceDir, "memory"), "junction");
  // USER.md remains a workspace-root entry; curated MEMORY.md lives inside the
  // observed memory tree and must not get a second, nested entry target.
  await fs.symlink(state.path("target", "note.md"), path.join(state.workspaceDir, "USER.md"));
  await fs.symlink(state.path("target"), state.path("extra-link"), "junction");
  const owner = policy([state.path("extra-link")]);
  const groups = await observe(owner);
  const selected = groups.flatMap((group) =>
    group.selections.map((selection) => ({
      path: path.resolve(group.root.rootDir, selection.scope.path),
      ...selection,
    })),
  );
  expect(selected).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: path.join(state.workspaceDir, "memory"),
        alias: true,
        scope: expect.objectContaining({ kind: "entry" }),
      }),
      expect.objectContaining({
        path: path.join(state.workspaceDir, "USER.md"),
        alias: true,
        scope: expect.objectContaining({ kind: "entry" }),
      }),
      expect.objectContaining({ path: state.path("extra-link"), alias: true, core: false }),
    ]),
  );
  // The canonical curated entry is covered by the memory tree, which is selected once.
  expect(
    selected.filter((selection) => selection.path === path.join(state.workspaceDir, "memory")),
  ).toHaveLength(1);
  expect(selected.every((selection) => !selection.path.startsWith(state.path("target")))).toBe(
    true,
  );
});

it("observes the first intermediate alias separately and retains configured parent-alias behavior", async () => {
  await fs.mkdir(p("real/workspace"), { recursive: true });
  await fs.mkdir(p("real/extra"));
  await fs.symlink(p("real"), p("alias"), "junction");
  const owner = policy([p("alias/extra")], false, p("alias/workspace"));
  const scopes = (await observe(owner)).flatMap((group) =>
    owner.scopes(group).map((scope) => path.resolve(group.root.rootDir, scope.path)),
  );
  expect(scopes).toEqual(expect.arrayContaining([p("alias"), p("real/extra")]));
  expect(scopes).not.toContain(p("alias/extra"));
});

it.each([false, true])("retains pinned roots when later admission fails: %s", async (failLater) => {
  await Promise.all(["first", "second"].map((name) => fs.mkdir(p(name))));
  const owner = policy([p("first/missing/notes"), p("second/notes")]);
  if (failLater) {
    const original = fs.lstat.bind(fs);
    const failure = new Error("admission denied");
    const stat = vi
      .spyOn(fs, "lstat")
      .mockImplementation((...args) =>
        String(args[0]) === p("second") ? Promise.reject(failure) : original(...args),
      );
    await expect(observe(owner)).rejects.toBe(failure);
    stat.mockRestore();
  } else {
    const first = await observe(owner);
    await fs.mkdir(p("first/missing/notes"), { recursive: true });
    const next = await observe(owner);
    expect(next.map((group) => group.root)).toEqual(first.map((group) => group.root));
  }
  await fs.rename(p("first"), p("first-old"));
  await fs.mkdir(p("first/missing/notes"), { recursive: true });
  await expect(observe(owner)).rejects.toBeDefined();
});

it("selects configured patterns and multimodal files while pruning unrelated descendants", async () => {
  const extra = p("extra");
  const owner = policy([{ path: extra, pattern: "..notes/**/*" }, p("other")], true);
  const group = (await observe(owner)).find((entry) =>
    entry.selections.some((selection) => selection.lexical === extra),
  )!;
  const relative = (name: string) => path.relative(group.root.rootDir, path.join(extra, name));
  for (const file of ["..notes/note.md", "..notes/PHOTO.PNG", "..notes/voice.WAV"]) {
    expect(owner.select(group, relative(file), false)).toMatchObject({ relative: relative(file) });
  }
  for (const file of ["drafts/skip.md", "..notes/metadata.json", "node_modules/pkg/note.md"]) {
    expect(owner.select(group, relative(file), false)).toBeUndefined();
  }
  for (const directory of ["node_modules", ".venv"]) {
    expect(owner.exclude(group, { path: relative(directory), kind: "directory" })).toBe(true);
  }
  expect(owner.exclude(group, { path: relative("..notes"), kind: "directory" })).toBe(false);
  expect(owner.exclude(group, { path: relative("nested-link"), kind: "symlink" })).toBe(true);
});
