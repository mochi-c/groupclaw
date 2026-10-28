import fs from "node:fs/promises";
import path from "node:path";
import { resolveRootPath } from "../infra/boundary-path.js";
import { hasErrnoCode } from "../infra/errors.js";
import { overwriteFileHandle } from "../infra/file-descriptor.js";
import {
  canonicalPathFromExistingAncestor,
  findExistingAncestor,
  root as fsRoot,
  FsSafeError,
} from "../infra/fs-safe.js";
import { captureAgentToolSourceExecutionGuard } from "./agent-tool-source-execution-guard.js";
import type { MemoryFileAccess } from "./memory-file-access.js";
import {
  type MemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "./memory-write-provenance.js";
import { toRelativeWorkspacePath } from "./path-policy.js";
import { expandOsHomePrefix } from "./sessions/tools/path-utils.js";

async function openHostFileForUpdate(resolved: string) {
  try {
    const existing = await fs.stat(resolved);
    // Rollback requires the original bytes; unreadable files must fail before mutation.
    return existing.isFile() ? await fs.open(resolved, "r+") : undefined;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export async function writeHostFile(
  absolutePath: string,
  content: string,
  abortSignal?: AbortSignal,
) {
  const assertCurrent = captureAgentToolSourceExecutionGuard(abortSignal);
  const resolved = path.resolve(expandOsHomePrefix(absolutePath));
  assertCurrent();
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const handle = await openHostFileForUpdate(resolved);
  if (!handle) {
    assertCurrent();
    await fs.writeFile(resolved, content, "utf-8");
    return;
  }
  try {
    await overwriteFileHandle(handle, Buffer.from(content, "utf-8"), {
      beforeWrite: assertCurrent,
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function resolveHostPath(filePath: string): string {
  return path.resolve(expandOsHomePrefix(filePath));
}

async function statHostFile(absolutePath: string) {
  try {
    const stat = await fs.stat(absolutePath);
    return {
      type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    } as const;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

async function writeWorkspaceFile(
  root: string,
  getRoot: () => ReturnType<typeof fsRoot>,
  absolutePath: string,
  content: string,
  abortSignal?: AbortSignal,
) {
  const assertCurrent = captureAgentToolSourceExecutionGuard(abortSignal);
  // Reject lexical escapes before opening the lazily created workspace root.
  const relative = toRelativeWorkspacePath(root, absolutePath);
  const rootHandle = await getRoot();
  // Absolute admitted paths preserve literal "~" workspace directories.
  await rootHandle.write(path.resolve(rootHandle.rootReal, relative), content, {
    mkdir: true,
    mutationSymlinks: "follow-parents-within-root",
    assertBeforeMutation: assertCurrent,
  });
}

export function createHostMutationOperations(
  root: string,
  options?: {
    workspaceOnly?: boolean;
    abortSignal?: AbortSignal;
    memoryWriteProvenance?: MemoryWriteProvenanceObserver;
    memoryFileAccess?: MemoryFileAccess;
  },
) {
  const workspaceOnly = options?.workspaceOnly ?? false;
  if (options?.memoryFileAccess) {
    return withMemoryWriteProvenance(options.memoryFileAccess, options.memoryWriteProvenance);
  }
  if (!workspaceOnly) {
    return withMemoryWriteProvenance(
      {
        mkdir: async (dir: string) => {
          const resolved = resolveHostPath(dir);
          captureAgentToolSourceExecutionGuard(options?.abortSignal)();
          await fs.mkdir(resolved, { recursive: true });
        },
        writeFile: (filePath: string, content: string) =>
          writeHostFile(filePath, content, options?.abortSignal),
        readFile: async (absolutePath: string) => fs.readFile(resolveHostPath(absolutePath)),
        statFile: (absolutePath: string) => statHostFile(resolveHostPath(absolutePath)),
        access: async (absolutePath: string) => {
          await fs.access(resolveHostPath(absolutePath));
        },
      } as const,
      options?.memoryWriteProvenance,
    );
  }

  // Tool construction must not open a handle or leave a rejecting promise when
  // the workspace directory has not yet been created.
  let rootPromise: ReturnType<typeof fsRoot> | undefined;
  const getRoot = () => (rootPromise ??= fsRoot(root));
  return withMemoryWriteProvenance(
    {
      mkdir: async (dir: string) => {
        const assertCurrent = captureAgentToolSourceExecutionGuard(options?.abortSignal);
        const relative = toRelativeWorkspacePath(root, dir, { allowRoot: true });
        // mkdir receives the file's parent, including directory links to the root itself.
        const resolved = await resolveRootPath({
          absolutePath: path.resolve(root, relative),
          rootPath: root,
          boundaryLabel: "workspace root",
        });
        const ancestor = await findExistingAncestor(resolved.rootCanonicalPath);
        if (ancestor && ancestor !== resolved.rootCanonicalPath) {
          const ancestorRoot = await fsRoot(ancestor);
          // mkdir requires a relative path; the prefix preserves literal tilde names.
          await ancestorRoot.mkdir(`./${path.relative(ancestor, resolved.rootCanonicalPath)}`, {
            assertBeforeMutation: assertCurrent,
          });
        }
        const rootHandle = await getRoot();
        const canonicalRelative = toRelativeWorkspacePath(
          rootHandle.rootReal,
          resolved.canonicalPath,
          { allowRoot: true },
        );
        assertCurrent();
        const mutationOptions = {
          mutationSymlinks: "reject" as const,
          assertBeforeMutation: assertCurrent,
        };
        if (canonicalRelative) {
          await rootHandle.mkdir(`./${canonicalRelative}`, mutationOptions);
        } else {
          await rootHandle.ensureRoot(mutationOptions);
        }
      },
      writeFile: (absolutePath: string, content: string) =>
        writeWorkspaceFile(root, getRoot, absolutePath, content, options?.abortSignal),
      readFile: async (absolutePath: string) => {
        // Reads retain the workspace contract of following only symlink parents.
        const relative = await toCanonicalRelativeWorkspacePath(root, absolutePath);
        const rootHandle = await getRoot();
        return (await rootHandle.read(path.resolve(rootHandle.rootReal, relative))).buffer;
      },
      statFile: async (absolutePath: string) => {
        const relative = toRelativeWorkspacePath(root, absolutePath);
        return statHostFile(path.resolve(root, relative));
      },
      access: async (absolutePath: string) => {
        let relative: string;
        try {
          relative = await toCanonicalRelativeWorkspacePath(root, absolutePath);
        } catch {
          // The session tool hides access errors as "File not found"; let its
          // subsequent read propagate the actual workspace boundary error.
          return;
        }
        try {
          const rootHandle = await getRoot();
          const opened = await rootHandle.open(path.resolve(rootHandle.rootReal, relative));
          await opened.handle.close().catch(() => {});
        } catch (error) {
          if (error instanceof FsSafeError && error.code === "not-found") {
            throw Object.assign(new Error(`Sandbox FS error (ENOENT): ${absolutePath}`), {
              code: "ENOENT",
            });
          }
          if (error instanceof FsSafeError && error.code === "outside-workspace") {
            // Preserve the subsequent read's boundary error, as above.
            return;
          }
          throw error;
        }
      },
    } as const,
    options?.memoryWriteProvenance,
  );
}

async function toCanonicalRelativeWorkspacePath(
  root: string,
  absolutePath: string,
): Promise<string> {
  const lexicalRelative = toRelativeWorkspacePath(root, absolutePath);
  const lexicalPath = path.resolve(root, lexicalRelative);
  const parentPath = path.dirname(lexicalPath);
  const [rootReal, canonicalParentPath] = await Promise.all([
    fs.realpath(root),
    canonicalPathFromExistingAncestor(parentPath),
  ]);
  const canonicalPath = path.join(canonicalParentPath, path.basename(lexicalPath));
  return toRelativeWorkspacePath(rootReal, canonicalPath);
}
