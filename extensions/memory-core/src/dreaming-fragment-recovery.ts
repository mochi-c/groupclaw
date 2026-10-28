import path from "node:path";
import {
  withAdmittedDreamSources,
  type DreamFragmentAdmissionParams,
} from "./dreaming-fragment-policy.js";
import {
  readDreamFragmentSources,
  writeDreamFragmentNotebook,
  writeDreamFragmentSource,
  type DreamFragmentSource,
  type DreamFragmentNotebook,
} from "./dreaming-fragment-state.js";
import { readDreamSourceContent } from "./dreaming-source-content.js";
import { readFragmentEntry } from "./fragment-memory-entries.js";
import { listMemoryEntryOrigins, recordMemoryEntryOrigins } from "./memory-entry-origins.js";
import { makeWorkspaceDirectory } from "./memory-workspace-files.js";
import {
  buildPromotionMarker,
  commitMemoryContent,
  hashMemoryContent,
  readMemoryContent,
  resolveMemoryWritePath,
} from "./short-term-promotion-memory-write.js";

export async function recoverPendingFragmentDream(
  params: DreamFragmentAdmissionParams,
  notebook: DreamFragmentNotebook,
): Promise<number> {
  const pending = notebook.pending;
  if (!pending) {
    return 0;
  }
  const covered = new Set([
    ...(pending.discard ?? []),
    ...pending.publications.flatMap((publication) => publication.coveredSourceIds ?? []),
  ]);
  if (
    pending.clean.some((id) => !covered.has(id)) ||
    pending.clean.some((id) => pending.topics.some((topic) => topic.sourceIds.includes(id))) ||
    pending.publications.some((publication) =>
      publication.coveredSourceIds?.some((id) => !publication.sourceIds.includes(id)),
    ) ||
    pending.processed.some(
      (id) =>
        pending.evidence.sources.some((source) => source.id === id && source.kind === "fragment") &&
        !pending.clean.includes(id),
    )
  ) {
    throw new Error(
      "Dream pending plan lacks complete source coverage; preserve sources and replan before cleanup",
    );
  }
  const sources = await readDreamFragmentSources(params.workspaceDir);
  const referenced = new Set([
    ...pending.evidence.sources.map((source) => source.id),
    ...pending.processed,
    ...pending.clean,
    ...pending.publications.flatMap((publication) => publication.sourceIds),
  ]);
  const selected = sources.filter((source) => referenced.has(source.id));
  if (selected.length !== referenced.size) {
    throw new Error("Dream publication source receipts are missing; recovery deferred");
  }
  for (const receipt of pending.evidence.sources) {
    const current = selected.find((source) => source.id === receipt.id)!;
    // Closing a source changes its live admission path, not its captured input.
    // Canonical facts remain immutable and every recovery reacquires authority.
    const identity = ({
      processed: _processed,
      lastAttemptAtMs: _attempt,
      endedSession: _ended,
      ...source
    }: DreamFragmentSource) => JSON.stringify(source);
    if (identity(current) !== identity(receipt)) {
      throw new Error("Dream source identity changed after planning; recovery deferred");
    }
  }
  if (
    hashMemoryContent(JSON.stringify(notebook.topics)) !== pending.evidence.topicsHash ||
    hashMemoryContent(JSON.stringify(notebook.artifacts ?? [])) !== pending.evidence.artifactsHash
  ) {
    throw new Error("Dream working evidence changed after planning; recovery deferred");
  }
  return withAdmittedDreamSources(params, selected, async (admitted) => {
    const assertCurrent = () => {
      params.assertCurrent();
      for (const item of admitted) {
        item.assertCurrent();
      }
    };
    assertCurrent();
    if (new Set(admitted.map((item) => item.policy.partition)).size > 1) {
      throw new Error("Dream recovery audiences are no longer compatible");
    }
    const originsByAgent = await Promise.all(
      [...new Set(selected.map((source) => source.agentId))].map((agentId) =>
        listMemoryEntryOrigins({
          agentId,
          entryKeys: selected
            .filter((source) => source.agentId === agentId)
            .map((source) => source.id),
        }),
      ),
    );
    const sourceOrigins = originsByAgent.flat();
    assertCurrent();
    for (const source of selected) {
      if (
        !sourceOrigins.some(
          (origin) =>
            origin.entryKey === source.id &&
            origin.agentId === source.agentId &&
            origin.sessionId === source.sessionId &&
            origin.sessionKey === source.sessionKey,
        )
      ) {
        throw new Error("Dream input has missing durable source provenance; recovery deferred");
      }
    }
    for (const input of pending.evidence.inputs) {
      const source = selected.find((item) => item.id === input.id)!;
      const { content, text } = await readDreamSourceContent(params.workspaceDir, source);
      assertCurrent();
      if (source.hash !== input.hash || text === undefined) {
        const cleanup = pending.cleanup?.find(
          (receipt) =>
            receipt.path === source.relativePath && receipt.sourceIds.includes(source.id),
        );
        if (
          source.hash !== input.hash ||
          source.kind !== "fragment" ||
          !pending.clean.includes(source.id) ||
          !cleanup ||
          content !== cleanup.after
        ) {
          throw new Error("Dream model input changed after planning; recovery deferred");
        }
        const replacements = pending.publications.filter((publication) =>
          publication.sourceIds.includes(source.id),
        );
        for (const publication of replacements) {
          if (
            !publication.verified ||
            (await readMemoryContent(
              path.join(params.workspaceDir, publication.target),
              params.workspaceDir,
            )) !== publication.after
          ) {
            throw new Error("Dream replacement changed after source cleanup; recovery deferred");
          }
        }
      }
    }
    for (const target of pending.evidence.targets) {
      const content = await readMemoryContent(
        path.join(params.workspaceDir, target.path),
        params.workspaceDir,
      );
      assertCurrent();
      const publication = pending.publications.find((item) => item.target === target.path);
      if (
        hashMemoryContent(content) !== target.hash &&
        (!publication || content !== publication.after)
      ) {
        throw new Error("Dream target evidence changed after planning; recovery deferred");
      }
    }
    for (const receipt of pending.evidence.curated) {
      const content = await readMemoryContent(
        path.join(params.workspaceDir, receipt.path),
        params.workspaceDir,
      );
      assertCurrent();
      if (!readFragmentEntry(content, receipt)) {
        const removal = pending.publications.find(
          (publication) =>
            publication.target === receipt.path &&
            publication.verified &&
            publication.after === content,
        );
        if (!removal) {
          throw new Error("Dream curated input changed after planning; recovery deferred");
        }
      }
    }
    for (const publication of pending.publications) {
      for (const id of publication.sourceIds) {
        const item = admitted.find((candidate) => candidate.source.id === id);
        if (
          !item?.policy.targets.some(
            (target) =>
              target.path === publication.target ||
              (target.archive &&
                publication.target.startsWith(`${path.posix.dirname(target.path)}/Archive/`)),
          )
        ) {
          throw new Error("Dream publication target is no longer admitted");
        }
      }
      const filePath = path.join(params.workspaceDir, publication.target);
      const current = await readMemoryContent(filePath, params.workspaceDir);
      assertCurrent();
      const origins = sourceOrigins.filter((origin) =>
        publication.sourceIds.includes(origin.entryKey),
      );
      for (const agentId of new Set(origins.map((origin) => origin.agentId))) {
        assertCurrent();
        await recordMemoryEntryOrigins({
          agentId,
          entryKey: publication.id,
          origins: origins.filter((origin) => origin.agentId === agentId),
        });
      }
      if (current !== publication.after) {
        if (publication.verified || current !== publication.before) {
          throw new Error(
            "Dream target changed after planning; preserve sources and pending receipt",
          );
        }
        for (const id of publication.sourceIds) {
          const source = selected.find((item) => item.id === id)!;
          if (
            !source.processed &&
            (await readDreamSourceContent(params.workspaceDir, source)).text === undefined
          ) {
            throw new Error("Dream recovery source changed before publication");
          }
        }
        await makeWorkspaceDirectory(params.workspaceDir, path.dirname(filePath));
        const writePath = await resolveMemoryWritePath(filePath, params.workspaceDir);
        assertCurrent();
        await commitMemoryContent({
          workspaceDir: params.workspaceDir,
          filePath: writePath,
          content: publication.after,
          expectedHash: hashMemoryContent(publication.before),
          tempPrefix: ".openclaw-dream-",
          assertCurrent,
        });
      }
      if ((await readMemoryContent(filePath, params.workspaceDir)) !== publication.after) {
        throw new Error("Dream publication outcome could not be verified");
      }
      assertCurrent();
      publication.verified = true;
      await writeDreamFragmentNotebook(params.workspaceDir, notebook);
    }
    const cleanupPaths = new Map<string, DreamFragmentSource[]>();
    for (const id of pending.clean) {
      const item = admitted.find((candidate) => candidate.source.id === id);
      if (!item || item.source.kind !== "fragment") {
        throw new Error("Dream cleanup requires an admitted Fragment");
      }
      const entries = cleanupPaths.get(item.source.relativePath) ?? [];
      entries.push(item.source);
      cleanupPaths.set(item.source.relativePath, entries);
    }
    for (const [relativePath, entries] of cleanupPaths) {
      const filePath = path.join(params.workspaceDir, relativePath);
      const content = await readMemoryContent(filePath, params.workspaceDir);
      for (const publication of pending.publications.filter((candidate) =>
        entries.some((entry) => candidate.sourceIds.includes(entry.id)),
      )) {
        if (
          !publication.verified ||
          (await readMemoryContent(
            path.join(params.workspaceDir, publication.target),
            params.workspaceDir,
          )) !== publication.after
        ) {
          throw new Error("Dream replacement changed before source cleanup; preserve source");
        }
      }
      assertCurrent();
      let receipt = pending.cleanup?.find((item) => item.path === relativePath);
      if (!receipt) {
        let after = content;
        for (const source of entries) {
          const entry = readFragmentEntry(after, source);
          if (!entry) {
            throw new Error("Dream cleanup source changed; reread before removing it");
          }
          after = after.slice(0, entry.start) + after.slice(entry.end);
        }
        receipt = {
          path: relativePath,
          sourceIds: entries.map((source) => source.id),
          before: content,
          after,
        };
        (pending.cleanup ??= []).push(receipt);
        // Reserve the exact preimage and outcome before destructive publication.
        await writeDreamFragmentNotebook(params.workspaceDir, notebook);
      }
      assertCurrent();
      if (content !== receipt.after) {
        if (content !== receipt.before) {
          throw new Error("Dream cleanup target changed; preserve pending work");
        }
        await commitMemoryContent({
          workspaceDir: params.workspaceDir,
          filePath,
          content: receipt.after,
          expectedHash: hashMemoryContent(receipt.before),
          tempPrefix: ".openclaw-dream-clean-",
          assertCurrent,
        });
      }
      if ((await readMemoryContent(filePath, params.workspaceDir)) !== receipt.after) {
        throw new Error("Dream cleanup outcome could not be verified");
      }
      assertCurrent();
    }
    for (const source of selected) {
      if (pending.processed.includes(source.id)) {
        assertCurrent();
        await writeDreamFragmentSource(params.workspaceDir, { ...source, processed: true });
      }
    }
    assertCurrent();
    const retired = new Set(
      pending.publications.flatMap((publication) => publication.coveredEntries ?? []),
    );
    const artifacts = [
      ...(notebook.artifacts ?? []).filter((artifact) => !retired.has(artifact.id)),
      ...pending.publications
        .filter(
          (publication) =>
            !retired.has(publication.id) &&
            publication.after.includes(buildPromotionMarker(publication.id)),
        )
        .map(({ id, target, sourceIds }) => ({ id, target, sourceIds })),
    ];
    await writeDreamFragmentNotebook(params.workspaceDir, {
      version: 2,
      topics: pending.topics,
      ...(artifacts.length ? { artifacts } : {}),
    });
    return pending.publications.length;
  });
}
