import fs from "node:fs/promises";
import path from "node:path";
import {
  canonicalPathFromExistingAncestor,
  FsSafeError,
  root as fsRoot,
} from "../infra/fs-safe.js";
import {
  prepareConversationScopedMemoryPathMatcher,
  resolveConversationScopeMemoryPathFilter,
} from "../memory/scoped-memory.js";
import {
  assertMemoryAudienceCurrent,
  assertMemoryAudienceSession,
} from "../plugins/memory-audience.js";
import type { MemoryAudience } from "../plugins/memory-provider-types.js";
import { captureAgentToolSourceExecutionGuard } from "./agent-tool-source-execution-guard.js";
import { resolveSandboxFileIdentity } from "./sandbox/file-mutation-identity.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

export type MemoryFileAccess = ReturnType<typeof createMemoryFileAccess>;

class MemoryFileScopeError extends Error {
  constructor() {
    super("Memory path is outside the current conversation audience.");
  }
}

/**
 * Ordinary file tools consume the same admitted context as recall. Canonical
 * paths are pinned by fs-safe/bridge I/O; preflight path checks alone are not
 * the source of a read or authorization for a later mutation.
 */
export function createMemoryFileAccess(params: {
  workspaceDir: string;
  audience?: MemoryAudience;
  sessionKey?: string;
  abortSignal?: AbortSignal;
  bridge?: SandboxFsBridge;
}) {
  const { audience, bridge } = params;
  const context = audience?.context;
  const matches = context ? prepareConversationScopedMemoryPathMatcher(context) : () => false;
  const filter = context ? resolveConversationScopeMemoryPathFilter(context) : undefined;
  const directories = [
    ...(filter?.exactPaths ?? []).map((entry) => path.posix.dirname(entry)),
    ...(filter?.directoryPrefixes ?? []).map((entry) => entry.slice(0, -1)),
  ];
  const assertCurrent = () => {
    captureAgentToolSourceExecutionGuard(params.abortSignal)();
    if (audience) {
      assertMemoryAudienceSession(audience, params.sessionKey);
      assertMemoryAudienceCurrent(audience);
    }
  };
  const lexicalRoot = bridge
    ? bridge.resolvePath({ filePath: params.workspaceDir }).containerPath
    : path.resolve(params.workspaceDir);
  const identity = (filePath: string) =>
    bridge
      ? resolveSandboxFileIdentity({ bridge, filePath, signal: params.abortSignal })
      : canonicalPathFromExistingAncestor(filePath);
  const relativeTo = (root: string, filePath: string) => {
    const relative = path.relative(root, filePath);
    return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      ? undefined
      : relative.split(path.sep).join("/");
  };
  const protectedPath = (relative: string | undefined) =>
    relative !== undefined &&
    (relative.toLowerCase() === "memory" ||
      relative.toLowerCase().startsWith("memory/") ||
      relative.toUpperCase() === "MEMORY.MD");
  const permits = (relative: string, directory: boolean) =>
    filter !== undefined &&
    (directory
      ? relative === "memory" ||
        directories.some((entry) => entry === relative || entry.startsWith(`${relative}/`)) ||
        filter.directoryPrefixes.some((prefix) => `${relative}/`.startsWith(prefix))
      : relative.toUpperCase() !== "MEMORY.MD" && matches(relative));
  const authorize = async (filePath: string, action: "read" | "list" | "write" | "mkdir") => {
    assertCurrent();
    const [root, canonical] = await Promise.all([
      identity(params.workspaceDir),
      identity(filePath),
    ]);
    assertCurrent();
    const relatives = [relativeTo(lexicalRoot, filePath), relativeTo(root, canonical)];
    for (const relative of relatives.filter(protectedPath)) {
      if (relative === undefined) {
        continue;
      }
      if (action === "write" || action === "mkdir") {
        throw new Error(
          "Conversation memory is written through memory_fragment_append and organized by Dream.",
        );
      }
      if (!permits(relative, action === "list")) {
        throw new MemoryFileScopeError();
      }
    }
    return canonical;
  };

  const roots = new Map<string, ReturnType<typeof fsRoot>>();
  const hostRoot = (filePath: string) => {
    const volume = path.parse(filePath).root;
    let root = roots.get(volume);
    if (!root) {
      root = fsRoot(volume);
      roots.set(volume, root);
    }
    return root;
  };
  const readFile = async (filePath: string): Promise<Buffer> => {
    const canonical = await authorize(filePath, "read");
    if (bridge) {
      if (!bridge.readFileWithSource) {
        throw new Error("Scoped memory requires a filesystem bridge with pinned read sources.");
      }
      const expectedPolicyPath = await bridge.resolveReadPolicyPath?.({ filePath });
      if (expectedPolicyPath !== undefined) {
        await authorize(expectedPolicyPath, "read");
      }
      const result = await bridge.readFileWithSource({ filePath, expectedPolicyPath });
      await authorize(result.canonicalPath, "read");
      assertCurrent();
      return result.data;
    }
    const result = await (
      await hostRoot(canonical)
    ).read(canonical, {
      symlinks: "reject",
      hardlinks: "reject",
    });
    assertCurrent();
    return result.buffer;
  };
  type FileMutation =
    | { filePath: string; action: "write"; content: string }
    | { filePath: string; action: "create"; content: string }
    | { filePath: string; action: "remove" }
    | { filePath: string; action: "mkdir" };
  async function mutation(
    params: FileMutation & { action: "create" },
  ): Promise<"created" | "exists">;
  async function mutation(params: FileMutation): Promise<"created" | "exists" | undefined>;
  async function mutation(operation: FileMutation): Promise<"created" | "exists" | undefined> {
    const { filePath, action } = operation;
    const canonical = await authorize(filePath, action === "mkdir" ? "mkdir" : "write");
    if (bridge) {
      if (!bridge.resolvePinnedMutationTarget || !bridge.supportsMutationAuthority) {
        throw new Error(
          "Scoped memory requires a filesystem bridge with pinned mutations and authority checks.",
        );
      }
      const pin = await bridge.resolvePinnedMutationTarget({ filePath, action });
      await authorize(pin.policyPath, action === "mkdir" ? "mkdir" : "write");
      assertCurrent();
      const target = {
        filePath,
        pinnedPath: pin.pinnedPath,
        signal: params.abortSignal,
        assertBeforeMutation: assertCurrent,
      };
      if (action === "mkdir") {
        await bridge.mkdirp(target);
      } else if (action === "remove") {
        await bridge.remove(target);
      } else if (action === "create") {
        if (!bridge.createFileExclusive) {
          throw new Error("Filesystem bridge does not support exclusive creation.");
        }
        return await bridge.createFileExclusive({ ...target, data: operation.content });
      } else {
        await bridge.writeFile({ ...target, data: operation.content });
      }
      return undefined;
    }
    const root = await hostRoot(canonical);
    const options = { mutationSymlinks: "reject" as const, assertBeforeMutation: assertCurrent };
    if (action === "mkdir") {
      if (canonical === root.rootReal) {
        await root.ensureRoot(options);
      } else {
        await root.mkdir(`./${path.relative(root.rootReal, canonical)}`, options);
      }
    } else if (action === "remove") {
      await root.remove(`./${path.relative(root.rootReal, canonical)}`, options);
    } else if (action === "create") {
      try {
        await root.create(canonical, operation.content, { ...options, mkdir: true });
        return "created";
      } catch (error) {
        if (error instanceof FsSafeError && error.code === "already-exists") {
          return "exists";
        }
        throw error;
      }
    } else {
      await root.write(canonical, operation.content, { ...options, mkdir: true });
    }
    return undefined;
  }
  return {
    assertCurrent,
    readFile,
    writeFile: async (filePath: string, content: string) => {
      await mutation({ filePath, action: "write", content });
    },
    createFileExclusive: async (filePath: string, content: string) =>
      await mutation({ filePath, action: "create", content }),
    remove: async (filePath: string) => {
      await mutation({ filePath, action: "remove" });
    },
    mkdir: async (filePath: string) => {
      await mutation({ filePath, action: "mkdir" });
    },
    access: async (filePath: string) => {
      const canonical = await authorize(filePath, "read");
      if (bridge) {
        const stat = await bridge.stat({ filePath });
        assertCurrent();
        if (!stat) {
          throw Object.assign(new Error("File not found"), { code: "ENOENT" });
        }
      } else {
        await fs.access(canonical);
        assertCurrent();
      }
    },
    statFile: async (filePath: string) => {
      const canonical = await authorize(filePath, "read");
      const stat = bridge
        ? await bridge.stat({ filePath })
        : await fs
            .stat(canonical)
            .then((value) => ({
              type: value.isFile()
                ? ("file" as const)
                : value.isDirectory()
                  ? ("directory" as const)
                  : ("other" as const),
              size: value.size,
              mtimeMs: value.mtimeMs,
            }))
            .catch((error: unknown) => {
              if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                return null;
              }
              throw error;
            });
      assertCurrent();
      return stat;
    },
    readDirectory: async (filePath: string) => {
      const canonical = await authorize(filePath, "list");
      let entries;
      if (bridge) {
        entries = await bridge.readDirectory?.({ filePath });
      } else {
        const root = await hostRoot(canonical);
        entries = await root.list(`./${path.relative(root.rootReal, canonical)}`, {
          withFileTypes: true,
        });
      }
      if (!entries) {
        throw new Error("Filesystem bridge does not support directory listing.");
      }
      const selected = [];
      for (const entry of entries) {
        try {
          await authorize(path.join(filePath, entry.name), entry.isDirectory ? "list" : "read");
          selected.push(entry);
        } catch (error) {
          assertCurrent();
          if (!(error instanceof MemoryFileScopeError)) {
            throw error;
          }
        }
      }
      assertCurrent();
      return selected;
    },
  };
}
