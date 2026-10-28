import fs from "node:fs";
import path from "node:path";
import { requireDirectorySync, syncDirectorySync } from "./directory-durability.js";
import { removePathWithinRoot } from "./fs-safe-remove.js";
import { inspectOtherOpenClawProcesses } from "./openclaw-process-census.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import { assertImmutableInstallRecordCurrent } from "./package-update-activation-immutable.js";
import {
  IMMUTABLE_GENERATION_MANIFEST,
  readImmutableGenerationManifest,
} from "./update-immutable-generation-manifest.js";
import {
  inspectImmutableGenerationTree,
  verifyImmutableGeneration,
} from "./update-immutable-generation.js";
import { readImmutableInstallRecord } from "./update-immutable-install-record.js";
import { assertImmutableDescriptorCurrent, directoryIdentity } from "./update-immutable-layout.js";
import { withImmutableUpdateOwner } from "./update-immutable-owner.js";
import { UPDATE_CLEANUP_BUDGET_MS } from "./update-maintenance.js";

export type ImmutableCleanupResult = {
  status: "completed" | "dry-run" | "retained";
  removed: string[];
  eligible: string[];
  warnings: string[];
};

/** Retire generations through the installation owner, outside activation and state migration. */
export async function cleanupImmutableGenerations(params: {
  root: string;
  dryRun?: boolean;
}): Promise<ImmutableCleanupResult> {
  if (!params.dryRun && (process.platform !== "linux" || process.geteuid?.() !== 0)) {
    throw new Error("Immutable generation cleanup requires the root updater on the Linux host.");
  }
  const root = path.resolve(params.root);
  const result: ImmutableCleanupResult = {
    status: params.dryRun ? "dry-run" : "completed",
    removed: [],
    eligible: [],
    warnings: [],
  };
  const collect = async (assertOwner: () => void) => {
    const record = await readImmutableInstallRecord(root);
    if (!record) {
      throw new Error("Generation cleanup requires an adopted immutable installation.");
    }
    const descriptor = record.descriptor;
    const assertCurrent = () => {
      assertOwner();
      assertImmutableDescriptorCurrent(descriptor);
      assertImmutableInstallRecordCurrent(record, assertOwner);
    };
    assertImmutableInstallRecordCurrent(record, assertOwner);
    if (record.activation?.operation) {
      result.status = params.dryRun ? "dry-run" : "retained";
      result.warnings.push("Activation recovery is pending; all generations were retained.");
      return result;
    }
    assertCurrent();
    const selected = await verifyImmutableGeneration(
      descriptor.current.path,
      descriptor.current.sha,
    );
    assertCurrent();
    if (
      selected.identity !== descriptor.current.identity ||
      selected.buildDigest !== descriptor.current.buildDigest
    ) {
      throw new Error("Selected immutable generation changed; all releases were preserved.");
    }
    const protectedShas = new Set(
      [descriptor.current, record.prepared, record.activation?.previous]
        .filter((generation) => generation != null)
        .map((generation) => generation.sha),
    );
    const releases = path.join(root, "releases");
    const runtimeRoot = await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url });
    assertCurrent();
    if (!runtimeRoot) {
      throw new Error(
        "Cleanup runtime generation could not be identified; releases were retained.",
      );
    }
    const physicalRuntimeRoot = fs.realpathSync(runtimeRoot);
    if (path.dirname(physicalRuntimeRoot) === releases) {
      protectedShas.add(path.basename(physicalRuntimeRoot));
    }
    const deadline = performance.now() + UPDATE_CLEANUP_BUDGET_MS;
    for (const name of fs.readdirSync(releases).toSorted()) {
      assertCurrent();
      if (performance.now() >= deadline) {
        result.warnings.push(
          "Generation cleanup budget expired; remaining releases were retained.",
        );
        break;
      }
      const retiredMatch = /^\.openclaw-retired-([a-f0-9]{40})-(\d+)-(\d+)$/u.exec(name);
      const sha = retiredMatch?.[1] ?? name;
      if (protectedShas.has(sha)) {
        continue;
      }
      const generationPath = path.join(releases, name);
      try {
        if (!/^[a-f0-9]{40}$/u.test(sha)) {
          throw new Error("Unknown release entry");
        }
        const manifest = readImmutableGenerationManifest(generationPath, descriptor);
        const retiredName = `.openclaw-retired-${manifest.sha}-${manifest.identity.replace(":", "-")}`;
        if (manifest.sha !== sha || (retiredMatch && name !== retiredName)) {
          throw new Error("Generation name does not match its ownership manifest");
        }
        if (!retiredMatch) {
          const verified = await verifyImmutableGeneration(generationPath, sha);
          assertCurrent();
          if (
            verified.identity !== manifest.identity ||
            verified.buildDigest !== manifest.buildDigest
          ) {
            throw new Error("Sealed generation differs from its ownership manifest");
          }
        } else {
          await inspectImmutableGenerationTree(generationPath, false, "unlink");
          assertCurrent();
        }
        const retiredPath = path.join(releases, retiredName);
        let cleanupPath = generationPath;
        let finishing = false;
        const assertGeneration = () => {
          assertCurrent();
          if (finishing && !fs.lstatSync(cleanupPath, { throwIfNoEntry: false })) {
            return;
          }
          if (directoryIdentity(cleanupPath) !== manifest.identity) {
            throw new Error("Generation identity changed during cleanup");
          }
        };
        const assertNoProcesses = () => {
          const census = inspectOtherOpenClawProcesses({
            runId: "",
            artifactPaths: [path.join(releases, sha), retiredPath],
            custody: "all-processes",
          });
          assertGeneration();
          if (census.error || census.unverifiedPids.length || census.matchingPids.length) {
            throw new Error(
              census.error ??
                (census.unverifiedPids.length
                  ? "Host process references could not be verified"
                  : "A live process still references this generation"),
            );
          }
        };
        assertNoProcesses();
        result.eligible.push(generationPath);
        if (params.dryRun) {
          continue;
        }
        if (!retiredMatch) {
          if (fs.lstatSync(retiredPath, { throwIfNoEntry: false })) {
            throw new Error(
              "Retirement destination already exists; both directories were retained",
            );
          }
          assertGeneration();
          if (performance.now() >= deadline) {
            throw new Error("Generation cleanup budget expired");
          }
          fs.renameSync(generationPath, retiredPath);
          cleanupPath = retiredPath;
          requireDirectorySync(syncDirectorySync(releases), "Generation retirement");
        }
        const assertRemoval = () => {
          assertGeneration();
          if (performance.now() >= deadline) {
            throw new Error("Generation cleanup budget expired");
          }
        };
        const remove = async (relativePath: string, recursive = true) => {
          assertNoProcesses();
          await removePathWithinRoot({
            rootDir: releases,
            relativePath: path.join(retiredName, relativePath),
            recursive,
            force: false,
            symlinks: "unlink",
            assertBeforeMutation: assertRemoval,
          });
        };
        // Keep the sealed ownership artifact until the last three small removals.
        // Interrupted large-tree deletion can resume without re-adopting partial bytes.
        for (const child of fs.readdirSync(retiredPath).toSorted()) {
          if (child !== ".git") {
            await remove(child);
          }
        }
        for (const child of fs.readdirSync(path.join(retiredPath, ".git")).toSorted()) {
          if (child !== path.basename(IMMUTABLE_GENERATION_MANIFEST)) {
            await remove(path.join(".git", child));
          }
        }
        await remove(IMMUTABLE_GENERATION_MANIFEST, false);
        await remove(".git", false);
        assertNoProcesses();
        finishing = true;
        await removePathWithinRoot({
          rootDir: releases,
          relativePath: retiredName,
          force: false,
          assertBeforeMutation: assertRemoval,
        });
        requireDirectorySync(syncDirectorySync(releases), "Generation collection");
        result.removed.push(generationPath);
      } catch (error) {
        // Loss of owner or record currency stops the campaign, rather than adopting a successor.
        assertCurrent();
        result.warnings.push(
          `Retained ${generationPath}: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
    }
    if (!params.dryRun && result.warnings.length) {
      result.status = "retained";
    }
    return result;
  };
  // Preview must not bootstrap or acquire a mutable native executor lease.
  return params.dryRun ? collect(() => {}) : withImmutableUpdateOwner(root, collect);
}
