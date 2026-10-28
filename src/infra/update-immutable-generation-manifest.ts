import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { requireDirectorySync, syncDirectorySync } from "./directory-durability.js";
import { packageActivationIdentitySchema } from "./package-update-activation-schema.js";
import type { ImmutableInstallDescriptor } from "./update-immutable-install-schema.js";

export const IMMUTABLE_GENERATION_MANIFEST = ".git/openclaw-generation.json";

const manifestSchema = z.strictObject({
  version: z.literal(1),
  root: z.string(),
  rootIdentity: packageActivationIdentitySchema,
  releasesIdentity: packageActivationIdentitySchema,
  sha: z.string().regex(/^[a-f0-9]{40}$/u),
  identity: packageActivationIdentitySchema,
  buildDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});

/** Build artifact, sealed with its private Git metadata; never backfill unknown releases. */
export function writeImmutableGenerationManifest(
  generationPath: string,
  ownership: Pick<ImmutableInstallDescriptor, "root" | "rootIdentity" | "releasesIdentity"> & {
    sha: string;
  },
  buildDigest: string,
): void {
  const stat = fs.lstatSync(generationPath);
  const manifest = manifestSchema.parse({
    version: 1,
    root: ownership.root,
    rootIdentity: ownership.rootIdentity,
    releasesIdentity: ownership.releasesIdentity,
    sha: ownership.sha,
    identity: `${stat.dev}:${stat.ino}`,
    buildDigest,
  });
  const git = path.join(generationPath, ".git");
  if (!fs.lstatSync(git).isDirectory() || fs.realpathSync(git) !== git) {
    throw new Error("Generation ownership requires independent physical Git metadata.");
  }
  const fd = fs.openSync(path.join(generationPath, IMMUTABLE_GENERATION_MANIFEST), "wx", 0o444);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(manifest)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  requireDirectorySync(syncDirectorySync(git), "Immutable generation manifest");
}

export function readImmutableGenerationManifest(
  generationPath: string,
  descriptor: Pick<ImmutableInstallDescriptor, "root" | "rootIdentity" | "releasesIdentity">,
) {
  const file = path.join(generationPath, IMMUTABLE_GENERATION_MANIFEST);
  const git = path.dirname(file);
  if (!fs.lstatSync(git).isDirectory() || fs.realpathSync(git) !== git) {
    throw new Error("Generation ownership metadata is not a physical directory.");
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== 0 ||
      stat.nlink !== 1 ||
      (stat.mode & 0o222) !== 0 ||
      stat.size > 16 * 1024
    ) {
      throw new Error("Generation ownership manifest is not sealed and bounded.");
    }
    const manifest = manifestSchema.parse(JSON.parse(fs.readFileSync(fd, "utf8")));
    const generation = fs.lstatSync(generationPath);
    if (
      !generation.isDirectory() ||
      generation.uid !== 0 ||
      fs.realpathSync(generationPath) !== generationPath ||
      manifest.root !== descriptor.root ||
      manifest.rootIdentity !== descriptor.rootIdentity ||
      manifest.releasesIdentity !== descriptor.releasesIdentity ||
      manifest.identity !== `${generation.dev}:${generation.ino}` ||
      generation.dev.toString() !== descriptor.releasesIdentity.split(":")[0]
    ) {
      throw new Error("Generation ownership manifest does not match this installation.");
    }
    return manifest;
  } finally {
    fs.closeSync(fd);
  }
}
