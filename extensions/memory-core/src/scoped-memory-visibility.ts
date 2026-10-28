import {
  prepareConversationScopedMemoryPathMatcher,
  resolveConversationScopeMemoryPathFilter,
} from "openclaw/plugin-sdk/memory-core-host-engine-fs";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { MemoryToolOptions } from "./memory-tool-contract.js";

// Conversation-scoped recall authorization. The host-minted audience lists the
// admitted artifacts; paths are identity for filtering, never access grants.
export type ScopedMemoryContext = NonNullable<
  NonNullable<MemoryToolOptions["memoryAudience"]>["context"]
>;

export { resolveConversationScopeMemoryPathFilter };

/**
 * Whether one workspace-relative memory path is readable for the admitted
 * conversation. Without an audience context the caller is not conversation
 * scoped (CLI/maintenance) and keeps existing readability. Inside a
 * conversation only the workspace root file and admitted Channel/Thread/User
 * directories pass: unscoped legacy files and other conversations' artifacts
 * fail closed. Paths outside memory/ are operator-configured shared sources.
 */
export function isConversationScopedMemoryPath(
  relativePath: string,
  context: ScopedMemoryContext,
): boolean {
  return prepareConversationScopedMemoryPathMatcher(context)(relativePath);
}

/**
 * Filter indexed memory-file hits to the admitted conversation scope. Session
 * transcript hits have their own visibility owner, and non-memory sources are
 * operator-configured shared corpora.
 */
export function filterMemorySearchHitsByConversationScope(params: {
  hits: MemorySearchResult[];
  context: ScopedMemoryContext;
}): MemorySearchResult[] {
  const matches = prepareConversationScopedMemoryPathMatcher(params.context);
  return params.hits.filter((hit) => hit.source !== "memory" || matches(hit.path));
}
