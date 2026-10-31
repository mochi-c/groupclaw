import fs from "node:fs/promises";
import path from "node:path";
import { resolveRootPath } from "../infra/boundary-path.js";
import { hasErrnoCode, ignoreMissingPath } from "../infra/errno.js";
import { overwriteFileHandle } from "../infra/file-descriptor.js";
import { findExistingAncestor, root as fsRoot, FsSafeError } from "../infra/fs-safe.js";
import {
  captureAgentToolSourceExecutionGuard,
  runWithAgentToolSourceExecutionScope,
} from "./agent-tool-source-execution-guard.js";
import type { MemoryFileAccess } from "./memory-file-access.js";
import {
  type MemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "./memory-write-provenance.js";
import { toRelativeWorkspacePath } from "./path-policy.js";
import { expandOsHomePrefix } from "./sessions/tools/path-utils.js";
import { toCanonicalRelativeWorkspacePath, writeHostWorkspaceFile } from "./workspace-file-ops.js";
import { resolveHostWorkspaceRoot } from "./workspace-write-scope.js";

async function openHostFileForUpdate(resolved: string) {
  try {
    const existing = await fs.stat(resolved);
    // Rollback requires the original bytes; unreadable files must fail before mutation.
    return existing.isFile() ? await fs.open(resolved, "r+") : undefined;
  } catch (error) {
    return ignoreMissingPath(error);
  }
}

export async function writeHostFile(
  absolutePath: string,
  content: string,
  abortSignal?: AbortSignal,
) {
  const assertCurrent = captureAgentToolSourceExecutionGuard(abortSignal);
  const resolved = path.resolve(expandOsHomePrefix(absolutePath));
  await runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
    assertCurrent();
    await fs.mkdir(path.dirname(resolved), { recursive: true });
  });
  const handle = await openHostFileForUpdate(resolved);
  if (!handle) {
    await runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
      assertCurrent();
      await fs.writeFile(resolved, content, "utf-8");
    });
    return;
  }
  try {
    await runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
      await overwriteFileHandle(handle, Buffer.from(content, "utf-8"), {
        beforeWrite: assertCurrent,
      });
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
          const assertCurrent = captureAgentToolSourceExecutionGuard(options?.abortSignal);
          await runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
            assertCurrent();
            await fs.mkdir(resolved, { recursive: true });
          });
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
  const roots = new Map<string, ReturnType<typeof fsRoot>>();
  const getRoot = (selectedRoot: string) => {
    let pending = roots.get(selectedRoot);
    if (!pending) {
      pending = fsRoot(selectedRoot);
      roots.set(selectedRoot, pending);
    }
    return pending;
  };
  return withMemoryWriteProvenance(
    {
      mkdir: async (dir: string) => {
        const assertCurrent = captureAgentToolSourceExecutionGuard(options?.abortSignal);
        const selectedRoot = resolveHostWorkspaceRoot(root, dir);
        const relative = toRelativeWorkspacePath(selectedRoot, dir, { allowRoot: true });
        // mkdir receives the file's parent, including directory links to the root itself.
        const resolved = await resolveRootPath({
          absolutePath: path.resolve(selectedRoot, relative),
          rootPath: selectedRoot,
          boundaryLabel: "workspace root",
        });
        const ancestor = await findExistingAncestor(resolved.rootCanonicalPath);
        if (ancestor && ancestor !== resolved.rootCanonicalPath) {
          const ancestorRoot = await fsRoot(ancestor);
          // mkdir requires a relative path; the prefix preserves literal tilde names.
          await runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
            await ancestorRoot.mkdir(`./${path.relative(ancestor, resolved.rootCanonicalPath)}`, {
              assertBeforeMutation: assertCurrent,
            });
          });
        }
        const rootHandle = await getRoot(selectedRoot);
        const canonicalRelative = toRelativeWorkspacePath(
          rootHandle.rootReal,
          resolved.canonicalPath,
          { allowRoot: true },
        );
        const mutationOptions = {
          mutationSymlinks: "reject" as const,
          assertBeforeMutation: () => {
            assertCurrent();
            toRelativeWorkspacePath(resolveHostWorkspaceRoot(root, dir), dir, { allowRoot: true });
          },
        };
        await runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
          if (canonicalRelative) {
            await rootHandle.mkdir(`./${canonicalRelative}`, mutationOptions);
          } else {
            await rootHandle.ensureRoot(mutationOptions);
          }
        });
      },
      writeFile: (absolutePath: string, content: string) =>
        writeHostWorkspaceFile(root, getRoot, absolutePath, content, options?.abortSignal),
      readFile: async (absolutePath: string) => {
        // Reads retain the workspace contract of following only symlink parents.
        const selectedRoot = resolveHostWorkspaceRoot(root, absolutePath);
        const relative = await toCanonicalRelativeWorkspacePath(selectedRoot, absolutePath);
        const rootHandle = await getRoot(selectedRoot);
        return (await rootHandle.read(path.resolve(rootHandle.rootReal, relative))).buffer;
      },
      statFile: async (absolutePath: string) => {
        const selectedRoot = resolveHostWorkspaceRoot(root, absolutePath);
        const relative = toRelativeWorkspacePath(selectedRoot, absolutePath);
        return statHostFile(path.resolve(selectedRoot, relative));
      },
      access: async (absolutePath: string) => {
        const selectedRoot = resolveHostWorkspaceRoot(root, absolutePath);
        let relative: string;
        try {
          relative = await toCanonicalRelativeWorkspacePath(selectedRoot, absolutePath);
        } catch {
          // The session tool hides access errors as "File not found"; let its
          // subsequent read propagate the actual workspace boundary error.
          return;
        }
        try {
          const rootHandle = await getRoot(selectedRoot);
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
