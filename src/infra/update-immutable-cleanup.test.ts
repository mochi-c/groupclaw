import fs from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  immutableInstallReadOperations,
  updateImmutableInstallRecord,
} from "./package-update-activation-immutable.js";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-paths.js";
import {
  createImmutableActivationLayout,
  identity,
} from "./update-immutable-activation.test-support.js";
import { cleanupImmutableGenerations } from "./update-immutable-cleanup.js";
import {
  IMMUTABLE_GENERATION_MANIFEST,
  writeImmutableGenerationManifest,
} from "./update-immutable-generation-manifest.js";
import type { ImmutableInstallDescriptor } from "./update-immutable-install-schema.js";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  verify: vi.fn(),
  census: vi.fn(),
  owner: vi.fn(),
  runtimeRoot: vi.fn(),
}));
// mock-isolation: Read the synthetic journal without admitting host installation state.
vi.mock("./update-immutable-install-record.js", () => ({ readImmutableInstallRecord: mocks.read }));
// mock-isolation: Keep root updater leases outside this filesystem cleanup boundary test.
vi.mock("./update-immutable-owner.js", () => ({ withImmutableUpdateOwner: mocks.owner }));
// mock-isolation: Supply process custody without inspecting unrelated host processes.
vi.mock("./openclaw-process-census.js", () => ({ inspectOtherOpenClawProcesses: mocks.census }));
vi.mock("./openclaw-root.js", async (original) => ({
  ...(await original<typeof import("./openclaw-root.js")>()),
  resolveOpenClawPackageRoot: mocks.runtimeRoot,
}));
vi.mock("./update-immutable-generation.js", async (original) => ({
  ...(await original<typeof import("./update-immutable-generation.js")>()),
  verifyImmutableGeneration: mocks.verify,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const obsoleteSha = "c".repeat(40);
const digest = "4".repeat(64);
let root: string;
let descriptor: ImmutableInstallDescriptor;
let layout: ReturnType<typeof createImmutableActivationLayout>;
let obsolete: string;
const read = () =>
  immutableInstallReadOperations["immutableInstall.read"](
    { root },
    {
      path: resolvePackageActivationJournalPath(resolvePackageActivationAnchor(root)),
      env: process.env,
    },
  );

beforeEach(() => {
  vi.resetAllMocks();
  const parent = fs.realpathSync(dirs.make("immutable-generation-cleanup-"));
  layout = createImmutableActivationLayout(parent);
  ({ root, descriptor } = layout);
  const fstat = fs.fstatSync;
  vi.spyOn(fs, "fstatSync").mockImplementation((...args) => {
    const stat = fstat(...args);
    Object.defineProperty(stat, "uid", { value: typeof stat.uid === "bigint" ? 0n : 0 });
    return stat;
  });
  const lstat = fsAsync.lstat;
  vi.spyOn(fsAsync, "lstat").mockImplementation(async (...args) => {
    const stat = await lstat(...args);
    if (String(args[0]).startsWith(`${parent}/`)) {
      Object.defineProperty(stat, "uid", { value: typeof stat.uid === "bigint" ? 0n : 0 });
    }
    return stat;
  });
  obsolete = path.join(root, "releases", obsoleteSha);
  fs.mkdirSync(path.join(obsolete, ".git"), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(obsolete, "dist"), { mode: 0o755 });
  fs.writeFileSync(path.join(obsolete, "dist", "index.js"), "obsolete fixture code");
  writeImmutableGenerationManifest(obsolete, { ...descriptor, sha: obsoleteSha }, digest);
  mocks.read.mockImplementation(async () => read());
  mocks.verify.mockImplementation(async (generation: string) => ({
    identity: identity(generation),
    buildDigest: generation === descriptor.current.path ? descriptor.current.buildDigest : digest,
  }));
  mocks.census.mockReturnValue({ matchingPids: [], unverifiedPids: [] });
  mocks.owner.mockImplementation(async (_root, run) => run(() => {}));
  mocks.runtimeRoot.mockResolvedValue(parent);
});
afterEach(() => vi.restoreAllMocks());

it("previews then removes only obsolete owned generations, preserving current, prepared, rollback and unknown material", async () => {
  const previous = path.join(root, "releases", "d".repeat(40));
  fs.mkdirSync(previous, { mode: 0o755 });
  const record = read();
  updateImmutableInstallRecord(
    record,
    {
      ...record,
      activation: {
        previous: {
          sha: path.basename(previous),
          path: previous,
          identity: identity(previous),
          buildDigest: digest,
        },
      },
    },
    () => {},
  );
  const unknown = path.join(root, "releases", "e".repeat(40));
  fs.mkdirSync(unknown, { mode: 0o755 });
  fs.writeFileSync(path.join(unknown, "operator-backup"), "preserve");
  const before = fs.readdirSync(path.join(root, "releases"));
  const preview = await cleanupImmutableGenerations({ root, dryRun: true });
  expect(preview.eligible).toEqual([obsolete]);
  expect(fs.readdirSync(path.join(root, "releases"))).toEqual(before);
  expect(mocks.owner).not.toHaveBeenCalled();

  mockProcessPlatform("linux");
  const result = await cleanupImmutableGenerations({ root });
  expect(result.removed).toEqual([obsolete]);
  expect(fs.readdirSync(path.join(root, "releases"))).toEqual(
    before.filter((name) => name !== obsoleteSha),
  );
  expect(fs.readFileSync(path.join(unknown, "operator-backup"), "utf8")).toBe("preserve");
  expect(read().revision).toBe(2);
  expect(result.warnings).toEqual([expect.stringContaining(unknown)]);
});

it.each(["live", "opaque", "failed"] as const)(
  "retains release bytes when process custody is %s",
  async (kind) => {
    mocks.census.mockReturnValue({
      matchingPids: kind === "live" ? [42] : [],
      unverifiedPids: kind === "opaque" ? [43] : [],
      ...(kind === "failed" ? { error: "host census incomplete" } : {}),
    });
    const result = await cleanupImmutableGenerations({ root, dryRun: true });
    expect(result.eligible).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(fs.readFileSync(path.join(obsolete, "dist", "index.js"), "utf8")).toBe(
      "obsolete fixture code",
    );
  },
);

it.each(["manifest", "build", "copied-manifest"] as const)(
  "preserves an owned-looking generation with a changed %s",
  async (kind) => {
    if (kind === "manifest") {
      const file = path.join(obsolete, IMMUTABLE_GENERATION_MANIFEST);
      fs.chmodSync(file, 0o644);
    } else if (kind === "build") {
      mocks.verify.mockImplementation(async (generation: string) => ({
        identity: identity(generation),
        buildDigest: descriptor.current.buildDigest,
      }));
    } else {
      const replacement = path.join(root, "releases", "f".repeat(40));
      fs.renameSync(obsolete, replacement);
      fs.mkdirSync(path.join(obsolete, ".git"), { recursive: true, mode: 0o755 });
      fs.copyFileSync(
        path.join(replacement, IMMUTABLE_GENERATION_MANIFEST),
        path.join(obsolete, IMMUTABLE_GENERATION_MANIFEST),
      );
      fs.chmodSync(path.join(obsolete, IMMUTABLE_GENERATION_MANIFEST), 0o444);
      // The replaced original stays outside discovery; the copied inode receipt must not authorize it.
      fs.renameSync(replacement, path.join(path.dirname(root), "operator-copy"));
    }
    const result = await cleanupImmutableGenerations({ root, dryRun: true });
    expect(result.eligible).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(fs.existsSync(obsolete)).toBe(true);
  },
);

it("retains the cleanup runtime even when process.title has erased its original arguments", async () => {
  mocks.runtimeRoot.mockResolvedValue(obsolete);
  const result = await cleanupImmutableGenerations({ root, dryRun: true });
  expect(result.eligible).toEqual([]);
  expect(result.warnings).toEqual([]);
  expect(fs.existsSync(obsolete)).toBe(true);
});

it("retains all generations during pending publication, even when the pointer effect is not reconciled", async () => {
  const record = read();
  const journal = resolvePackageActivationJournalPath(resolvePackageActivationAnchor(root));
  const control = path.dirname(journal);
  updateImmutableInstallRecord(
    record,
    {
      ...record,
      activation: {
        operation: {
          version: 1,
          operationId: "00000000-0000-4000-8000-000000000001",
          phase: "publishing",
          authority: {
            databasePath: journal,
            databaseIdentity: identity(journal),
            parentIdentity: identity(control),
            installKey: root,
            owner: "synthetic-executor",
          },
          previous: descriptor.current,
          candidate: layout.candidate,
          serviceDigest: digest,
          protection: layout.protection,
          recovery: {
            root,
            path: path.join(control, `recovery-${layout.candidate.sha}`),
            sha: layout.candidate.sha,
            identity: layout.candidate.identity,
            buildDigest: digest,
            helperPath: path.join(control, "recovery.mjs"),
            helperIdentity: identity(control),
            helperDigest: digest,
          },
          startedAtMs: 1,
        },
      },
    },
    () => {},
  );
  fs.unlinkSync(path.join(root, "current"));
  fs.symlinkSync(`releases/${layout.candidate.sha}`, path.join(root, "current"));
  const result = await cleanupImmutableGenerations({ root, dryRun: true });
  expect(result.eligible).toEqual([]);
  expect(result.warnings).toEqual([expect.stringContaining("Activation recovery is pending")]);
  expect(fs.existsSync(obsolete)).toBe(true);
  expect(mocks.verify).not.toHaveBeenCalled();
  expect(mocks.census).not.toHaveBeenCalled();
});

it("stops before filesystem mutation when the durable installation record changes during verification", async () => {
  mocks.verify.mockImplementationOnce(async (generation: string) => {
    const record = read();
    updateImmutableInstallRecord(record, record, () => {});
    return { identity: identity(generation), buildDigest: descriptor.current.buildDigest };
  });
  await expect(cleanupImmutableGenerations({ root, dryRun: true })).rejects.toThrow(
    "no longer current",
  );
  expect(fs.existsSync(obsolete)).toBe(true);
  expect(mocks.census).not.toHaveBeenCalled();
});

it("retains a partially removed retirement tree and resumes from its sealed ownership artifact", async () => {
  mockProcessPlatform("linux");
  fs.writeFileSync(path.join(obsolete, ".git", "HEAD"), "synthetic HEAD");
  fs.symlinkSync("../dist/index.js", path.join(obsolete, ".git", "remaining-link"));
  const unlink = fsAsync.unlink;
  let fail = true;
  vi.spyOn(fsAsync, "unlink").mockImplementation(async (...args) => {
    if (fail && String(args[0]).endsWith("/HEAD")) {
      fail = false;
      throw Object.assign(new Error("synthetic disk busy"), { code: "EBUSY" });
    }
    return unlink(...args);
  });
  const first = await cleanupImmutableGenerations({ root });
  expect(first.removed).toEqual([]);
  expect(first.warnings).toHaveLength(1);
  const retiredName = fs
    .readdirSync(path.join(root, "releases"))
    .find((name) => name.startsWith(".openclaw-retired-"))!;
  const retired = path.join(root, "releases", retiredName);
  expect(fs.existsSync(path.join(retired, IMMUTABLE_GENERATION_MANIFEST))).toBe(true);
  expect(fs.existsSync(path.join(retired, "dist"))).toBe(false);
  expect(fs.lstatSync(path.join(retired, ".git", "remaining-link")).isSymbolicLink()).toBe(true);
  const second = await cleanupImmutableGenerations({ root });
  expect(second.removed).toEqual([retired]);
  expect(second.warnings).toEqual([]);
  expect(fs.existsSync(retired)).toBe(false);
});
