type MemoryArtifactReference = {
  agentId: string;
  relPath: string;
  from: number;
  lines: number;
};

const REFERENCE_PREFIX = "memory:v1:";
export const MEMORY_ARTIFACT_REFERENCE_MAX_LENGTH = 8_192;

// References locate an excerpt; only the live reader can grant access to it.
export function encodeMemoryArtifactReference(
  reference: MemoryArtifactReference,
): string | undefined {
  const value =
    REFERENCE_PREFIX +
    Buffer.from(
      JSON.stringify([reference.agentId, reference.relPath, reference.from, reference.lines]),
      "utf8",
    ).toString("base64url");
  return value.length <= MEMORY_ARTIFACT_REFERENCE_MAX_LENGTH ? value : undefined;
}

export function decodeMemoryArtifactReference(value: string): MemoryArtifactReference | null {
  if (!value.startsWith(REFERENCE_PREFIX) || value.length > MEMORY_ARTIFACT_REFERENCE_MAX_LENGTH) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(value.slice(REFERENCE_PREFIX.length), "base64url").toString("utf8"),
    );
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) {
    return null;
  }
  const [agentId, relPath, from, lines]: unknown[] = parsed;
  if (
    typeof agentId !== "string" ||
    !agentId ||
    typeof relPath !== "string" ||
    !relPath.trim() ||
    typeof from !== "number" ||
    !Number.isSafeInteger(from) ||
    from < 1 ||
    typeof lines !== "number" ||
    !Number.isSafeInteger(lines) ||
    lines < 1
  ) {
    return null;
  }
  const reference = { agentId, relPath, from, lines };
  return encodeMemoryArtifactReference(reference) === value ? reference : null;
}
