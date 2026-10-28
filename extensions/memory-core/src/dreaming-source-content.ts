import path from "node:path";
import { readMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { DreamFragmentSource } from "./dreaming-fragment-state.js";
import { readFragmentEntry } from "./fragment-memory-entries.js";
import { hashMemoryContent, readMemoryContent } from "./short-term-promotion-memory-write.js";

/** Read exact producer bytes; Event frontmatter alone never establishes provenance. */
export async function readDreamSourceContent(
  workspaceDir: string,
  source: DreamFragmentSource,
): Promise<{ content: string; text?: string }> {
  const content = await readMemoryContent(
    path.join(workspaceDir, source.relativePath),
    workspaceDir,
  );
  if (source.kind === "fragment") {
    return { content, text: readFragmentEntry(content, source)?.text };
  }
  if (!source.settled || hashMemoryContent(content) !== source.hash) {
    return { content };
  }
  const provenance = await readMemoryArtifactProvenance({
    workspaceDir,
    relativePath: source.relativePath,
  });
  if (
    !provenance ||
    provenance.fileHash !== source.hash ||
    provenance.sessionId !== source.sessionId ||
    provenance.sessionKey !== source.sessionKey
  ) {
    return { content };
  }
  return { content, text: content };
}
