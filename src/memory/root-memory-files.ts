import fs from "node:fs/promises";
import path from "node:path";
import { isMissingPathError } from "../infra/errno.js";
import { resolveMemoryArtifactRelativePath } from "./scoped-memory.js";

export const LEGACY_UPPERCASE_ROOT_MEMORY_FILENAME = "MEMORY.md";
export const LEGACY_ROOT_MEMORY_FILENAME = "memory.md";
const ROOT_MEMORY_REPAIR_RELATIVE_DIR = ".openclaw-repair/root-memory";

/** Resolves the canonical Workspace-global memory file. */
export function resolveCanonicalWorkspaceMemoryPath(workspaceDir: string): string {
  return path.join(
    workspaceDir,
    ...resolveMemoryArtifactRelativePath({
      scope: { kind: "workspace" },
      artifactKind: "memory",
    }).split("/"),
  );
}

/** Resolves the previously canonical root MEMORY.md path. */
export function resolveLegacyUppercaseRootMemoryPath(workspaceDir: string): string {
  return path.join(workspaceDir, LEGACY_UPPERCASE_ROOT_MEMORY_FILENAME);
}

/** Resolves the legacy root memory file path for a workspace. */
export function resolveLegacyRootMemoryPath(workspaceDir: string): string {
  return path.join(workspaceDir, LEGACY_ROOT_MEMORY_FILENAME);
}

/** Resolves the repair directory used while migrating root memory files. */
export function resolveRootMemoryRepairDir(workspaceDir: string): string {
  return path.join(workspaceDir, ".openclaw-repair", "root-memory");
}

/** Checks for an exact directory entry without case-folded path lookup. */
async function exactWorkspaceEntryExists(dir: string, name: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.includes(name);
  } catch {
    return false;
  }
}

/** Checks every relative path segment without case-folded lookup. */
export async function exactWorkspaceRelativePathExists(
  workspaceDir: string,
  relativePath: string,
): Promise<boolean> {
  const segments = relativePath.split(/[\\/]+/u).filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    return false;
  }
  let current = workspaceDir;
  for (const segment of segments) {
    try {
      const entries = await fs.readdir(current, { withFileTypes: true });
      const entry = entries.find((candidate) => candidate.name === segment);
      if (!entry) {
        return false;
      }
      current = path.join(current, segment);
    } catch {
      return false;
    }
  }
  return true;
}

/** Resolves canonical Workspace memory only when it is a real file, not a symlink. */
export async function resolveCanonicalWorkspaceMemoryFile(
  workspaceDir: string,
): Promise<string | null> {
  const filePath = resolveCanonicalWorkspaceMemoryPath(workspaceDir);
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isFile() && !stat.isSymbolicLink()) {
      return filePath;
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
  return null;
}

/** Resolves the previous uppercase root path for temporary read compatibility. */
export async function resolveLegacyWorkspaceMemoryFile(
  workspaceDir: string,
): Promise<string | null> {
  if (!(await exactWorkspaceEntryExists(workspaceDir, LEGACY_UPPERCASE_ROOT_MEMORY_FILENAME))) {
    return null;
  }
  const filePath = resolveLegacyUppercaseRootMemoryPath(workspaceDir);
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() && !stat.isSymbolicLink() ? filePath : null;
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
  return null;
}

/** Skips legacy/repair paths when scanning Workspace memory files. */
export function shouldSkipWorkspaceMemoryAuxiliaryPath(params: {
  workspaceDir: string;
  absPath: string;
}): boolean {
  const relative = path.relative(params.workspaceDir, params.absPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  const normalized = relative.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return (
    normalized === LEGACY_UPPERCASE_ROOT_MEMORY_FILENAME ||
    normalized === LEGACY_ROOT_MEMORY_FILENAME ||
    normalized === ROOT_MEMORY_REPAIR_RELATIVE_DIR ||
    normalized.startsWith(`${ROOT_MEMORY_REPAIR_RELATIVE_DIR}/`)
  );
}
