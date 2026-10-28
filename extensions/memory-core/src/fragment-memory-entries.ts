import { buildPromotionMarker, hashMemoryContent } from "./short-term-promotion-memory-write.js";

export function readFragmentEntry(
  content: string,
  source: { id: string; hash: string },
): { start: number; end: number; text: string } | undefined {
  const opening = `${buildPromotionMarker(source.id)}\n`;
  const closing = `<!-- openclaw-memory-end:${source.id} -->\n`;
  const start = content.indexOf(opening);
  if (start < 0 || content.includes(opening, start + opening.length)) {
    return undefined;
  }
  const endStart = content.indexOf(closing, start + opening.length);
  if (endStart < 0 || content.includes(closing, endStart + closing.length)) {
    return undefined;
  }
  const end = endStart + closing.length;
  const bytes = content.slice(start, end);
  if (hashMemoryContent(bytes) !== source.hash) {
    return undefined;
  }
  return { start, end, text: content.slice(start + opening.length, endStart) };
}
