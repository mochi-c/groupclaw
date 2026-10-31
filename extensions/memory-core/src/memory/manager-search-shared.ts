import { truncateUtf16Safe } from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import type {
  MemorySearchManager,
  MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export type MemoryPathFilter = NonNullable<
  NonNullable<Parameters<MemorySearchManager["search"]>[1]>["memoryPathFilter"]
>;

/** One bound predicate shared by body, path, vector, and KNN/count readers. */
export function buildMemoryPathFilter(
  filter: MemoryPathFilter | undefined,
  alias?: string,
  dialect: "sqlite" | "postgres" = "sqlite",
): { sql: string; params: string[] } {
  if (!filter) {
    return { sql: "", params: [] };
  }
  const column = alias ? `${alias}.path` : "path";
  const source = alias ? `${alias}.source` : "source";
  const clauses = [`${source} <> 'memory'`];
  const params: string[] = [];
  const position = (value: string) =>
    `${dialect === "postgres" ? "strpos" : "instr"}(${column}, ${value})`;
  if (filter.includeOutsideMemory) {
    clauses.push(`${position("'memory/'")} <> 1`);
  }
  if (filter.exactPaths.length > 0) {
    const collation = dialect === "postgres" ? '"C"' : "BINARY";
    clauses.push(
      `${column} COLLATE ${collation} IN (${filter.exactPaths.map(() => "?").join(", ")})`,
    );
    params.push(...filter.exactPaths);
  }
  for (const prefix of filter.directoryPrefixes) {
    clauses.push(`${position("?")} = 1`);
    params.push(prefix);
  }
  return { sql: ` AND (${clauses.join(" OR ")})`, params };
}

export type MemorySearchRow = {
  id: string;
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  source: MemorySource;
};

export type SearchRowResult = ReturnType<typeof projectMemorySearchRow>;

export function projectMemorySearchRow(
  row: MemorySearchRow,
  snippetMaxChars: number,
  score: number,
) {
  return {
    id: row.id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    score,
    snippet: truncateUtf16Safe(row.text, snippetMaxChars),
    source: row.source,
  };
}

export function buildMemoryModelFilter(column: string, models: string[]): string {
  return models.length === 1
    ? `${column} = ?`
    : `${column} IN (${models.map(() => "?").join(", ")})`;
}

export function resolveSnippetProjection(column: "text" | "c.text", snippetMaxChars: number) {
  const snippetByteLimit =
    Number.isSafeInteger(snippetMaxChars) && snippetMaxChars > 0 ? snippetMaxChars * 4 : undefined;
  // Byte prefixes preserve NUL in UTF-8 and UTF-16 databases. Four bytes per
  // UTF-16 unit leave final truncation to truncateUtf16Safe. SQLite returns
  // NULL for an empty BLOB substring, so retain the original empty text.
  return {
    sql:
      snippetByteLimit === undefined
        ? column
        : `COALESCE(CAST(substr(CAST(${column} AS BLOB), 1, ?) AS TEXT), ${column})`,
    params: snippetByteLimit === undefined ? [] : [snippetByteLimit],
  };
}
