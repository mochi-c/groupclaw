import { randomUUID } from "node:crypto";
import path from "node:path";
import { DREAM_FRAGMENT_SYSTEM_PROMPT, parseDreamFragmentPlan } from "./dreaming-fragment-plan.js";
import {
  withAdmittedDreamSources,
  type DreamFragmentAdmissionParams,
} from "./dreaming-fragment-policy.js";
import { recoverPendingFragmentDream } from "./dreaming-fragment-recovery.js";
import {
  readDreamFragmentNotebook,
  readDreamFragmentSources,
  writeDreamFragmentNotebook,
  writeDreamFragmentSource,
  type DreamFragmentSource,
  type DreamFragmentNotebook,
} from "./dreaming-fragment-state.js";
import type { DreamingCompletion } from "./dreaming-narrative.js";
import { readDreamSourceContent } from "./dreaming-source-content.js";
import { readFragmentEntry } from "./fragment-memory-entries.js";
import {
  withMemoryDreamJob,
  withMemoryWorkspaceLock,
  withMemoryWorkspacePreparation,
} from "./memory-workspace-lock.js";
import {
  buildPromotionMarker,
  hashMemoryContent,
  readMemoryContent,
} from "./short-term-promotion-memory-write.js";

type Params = DreamFragmentAdmissionParams & {
  agentId: string;
  subagent: DreamingCompletion;
  nowMs: number;
  logger: { info(message: string): void; warn(message: string): void };
};

function chooseSources(sources: DreamFragmentSource[], nowMs: number): DreamFragmentSource[] {
  const pending = sources.filter(
    (source) => !source.processed && (source.kind !== "event" || source.settled),
  );
  const oldest = pending
    .toSorted(
      (a, b) =>
        (a.lastAttemptAtMs ?? 0) - (b.lastAttemptAtMs ?? 0) || a.createdAtMs - b.createdAtMs,
    )
    .slice(0, 16);
  const remaining = pending
    .filter((source) => !oldest.includes(source))
    .toSorted((a, b) => {
      const recentA = a.createdAtMs >= nowMs - 14 * 86_400_000;
      const recentB = b.createdAtMs >= nowMs - 14 * 86_400_000;
      return Number(recentB) - Number(recentA) || b.createdAtMs - a.createdAtMs;
    });
  const scopes = new Map<string, DreamFragmentSource[]>();
  for (const source of remaining) {
    const scope = path.posix.dirname(source.relativePath);
    const entries = scopes.get(scope) ?? [];
    entries.push(source);
    scopes.set(scope, entries);
  }
  const selected = [...oldest];
  while (scopes.size && selected.length < 80) {
    for (const [scope, entries] of scopes) {
      const next = entries.shift();
      if (next) {
        selected.push(next);
      }
      if (!entries.length) {
        scopes.delete(scope);
      }
      if (selected.length === 80) {
        break;
      }
    }
  }
  return selected;
}

export async function runFragmentDreaming(params: Params): Promise<void> {
  return withMemoryDreamJob(params.workspaceDir, () => runAdmittedFragmentDreaming(params));
}

async function runAdmittedFragmentDreaming(params: Params): Promise<void> {
  await withMemoryWorkspaceLock(params.workspaceDir, async () => {
    await recoverPendingFragmentDream(params, await readDreamFragmentNotebook(params.workspaceDir));
  });
  const sources = await readDreamFragmentSources(params.workspaceDir);
  const notebook = await readDreamFragmentNotebook(params.workspaceDir);
  const continuation = sources
    .filter((candidate) => notebook.topics.some((topic) => topic.sourceIds.includes(candidate.id)))
    .toSorted((a, b) => (a.lastAttemptAtMs ?? 0) - (b.lastAttemptAtMs ?? 0))
    .slice(0, 16);
  const selected = [
    ...new Set([
      ...continuation,
      ...chooseSources(sources, params.nowMs).slice(0, 80 - continuation.length),
    ]),
  ];
  if (!selected.length) {
    return;
  }
  // Admission is per source so one missing policy cannot starve other scopes.
  const groups = new Map<string, DreamFragmentSource[]>();
  for (const source of selected) {
    await withMemoryWorkspaceLock(params.workspaceDir, async () => {
      params.assertCurrent();
      await writeDreamFragmentSource(params.workspaceDir, {
        ...source,
        lastAttemptAtMs: params.nowMs,
      });
    });
    try {
      await withAdmittedDreamSources(params, [source], async ([item]) => {
        if (item) {
          const group = groups.get(item.policy.partition) ?? [];
          group.push(source);
          groups.set(item.policy.partition, group);
        }
      });
    } catch (error) {
      params.logger.warn(`memory-core: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const batch of groups.values()) {
    const unfinished = sources.filter(
      (source) =>
        notebook.topics.some((topic) => topic.sourceIds.includes(source.id)) ||
        notebook.artifacts?.some((artifact) => artifact.sourceIds.includes(source.id)),
    );
    // Topics remain audience-bound. Incompatible topics are excluded from this model pass.
    const topicSources: DreamFragmentSource[] = [];
    for (const source of unfinished) {
      if (batch.some((item) => item.id === source.id)) {
        continue;
      }
      try {
        await withAdmittedDreamSources(params, [source], async ([item]) => {
          if (
            item &&
            groups.has(item.policy.partition) &&
            groups.get(item.policy.partition) === batch
          ) {
            topicSources.push(source);
          }
        });
      } catch {
        // Keep unresolved topics outside this pass; explicit forget owns removal.
      }
    }
    await withAdmittedDreamSources(
      params,
      [...batch, ...topicSources.slice(0, 80)],
      async (admitted) => {
        const assertCurrent = () => admitted.forEach((item) => item.assertCurrent());
        const snapshot = await withMemoryWorkspacePreparation(params.workspaceDir, async () => {
          const latest = await readDreamFragmentNotebook(params.workspaceDir);
          const inputs: Array<{
            id: string;
            text: string;
            scope: string;
            kind: DreamFragmentSource["kind"];
            payloadTrust?: "trusted" | "untrusted";
          }> = [];
          let chars = 0;
          for (const item of admitted.filter((candidate) => batch.includes(candidate.source))) {
            const { text } = await readDreamSourceContent(params.workspaceDir, item.source);
            assertCurrent();
            if (text === undefined || chars + text.length > 64_000) {
              continue;
            }
            chars += text.length;
            inputs.push({
              id: item.source.id,
              text,
              kind: item.source.kind,
              ...(item.source.kind === "event" ? { payloadTrust: item.source.payloadTrust } : {}),
              scope: item.policy.targets
                .filter((target) => target.kind === "thread" || target.kind === "channel")
                .map((target) => target.path)
                .join(" -> "),
            });
          }
          const targets = [
            ...new Map(
              admitted
                .flatMap((item) => item.policy.targets)
                .map((target) => [target.path, target]),
            ).values(),
          ];
          const allowed = new Set(admitted.map((item) => item.source.id));
          const artifactRecords = (latest.artifacts ?? []).filter((artifact) =>
            artifact.sourceIds.every((id) => allowed.has(id)),
          );
          const archiveTargets = artifactRecords.flatMap((artifact) => {
            const target = targets.find(
              (candidate) =>
                candidate.archive &&
                artifact.target.startsWith(`${path.posix.dirname(candidate.path)}/Archive/`),
            );
            return target ? [{ ...target, path: artifact.target, existingArchive: true }] : [];
          });
          const targetVersions = await Promise.all(
            [
              ...new Map(
                [...targets, ...archiveTargets].map((target) => [target.path, target]),
              ).values(),
            ].map(async (target, index) =>
              Object.assign({}, target, {
                id: `target-${index}`,
                content: await readMemoryContent(
                  path.join(params.workspaceDir, target.path),
                  params.workspaceDir,
                ),
              }),
            ),
          );
          const curated = [];
          for (const artifact of artifactRecords) {
            const target = targets.find(
              (candidate) =>
                candidate.path === artifact.target ||
                (candidate.archive &&
                  artifact.target.startsWith(`${path.posix.dirname(candidate.path)}/Archive/`)),
            );
            if (!target) {
              continue;
            }
            const content = await readMemoryContent(
              path.join(params.workspaceDir, artifact.target),
              params.workspaceDir,
            );
            const opening = `${buildPromotionMarker(artifact.id)}\n`;
            const closing = `<!-- openclaw-memory-end:${artifact.id} -->\n`;
            const start = content.indexOf(opening);
            const end = content.indexOf(closing, start + opening.length);
            if (start < 0 || end < 0) {
              continue;
            }
            const hash = hashMemoryContent(content.slice(start, end + closing.length));
            const entry = readFragmentEntry(content, { id: artifact.id, hash });
            if (entry) {
              curated.push({ ...artifact, hash, text: entry.text });
            }
          }
          let targetChars = 0;
          const boundedTargets = targetVersions.filter((target) => {
            if (target.content.length > 48_000 || targetChars + target.content.length > 96_000) {
              params.logger.warn("memory-core: Dream deferred an oversized target");
              return false;
            }
            targetChars += target.content.length;
            return true;
          });
          let curatedChars = 0;
          const boundedCurated = curated.filter((entry) => {
            if (curatedChars + entry.text.length > 64_000) {
              return false;
            }
            curatedChars += entry.text.length;
            return true;
          });
          assertCurrent();
          const topics = latest.topics.filter((topic) =>
            topic.sourceIds.every((id) => allowed.has(id)),
          );
          return {
            inputs,
            evidenceSources: admitted.map((item) => item.source),
            targets: boundedTargets.slice(0, 24),
            curated: boundedCurated.slice(0, 40),
            topics,
            notebook: latest,
          };
        });
        if (!snapshot.inputs.length && !snapshot.topics.length) {
          return;
        }
        const completion = await params.subagent.complete({
          agentId: params.agentId,
          extraSystemPrompt: DREAM_FRAGMENT_SYSTEM_PROMPT,
          message: JSON.stringify({
            fragments: snapshot.inputs,
            notebook: snapshot.topics,
            curated: snapshot.curated,
            targets: snapshot.targets.map((target) => ({
              id: target.id,
              scope: target.kind,
              subject: target.label,
              content: target.content,
              archive: Boolean(target.archive),
            })),
          }),
          timeoutMs: 120_000,
        });
        assertCurrent();
        const known = new Set([
          ...snapshot.inputs.map((input) => input.id),
          ...snapshot.topics.flatMap((topic) => topic.sourceIds),
          ...snapshot.curated.flatMap((entry) => entry.sourceIds),
        ]);
        const plan = parseDreamFragmentPlan(completion.text, known);
        await withMemoryWorkspaceLock(params.workspaceDir, async () => {
          assertCurrent();
          const current = await readDreamFragmentNotebook(params.workspaceDir);
          if (JSON.stringify(current) !== JSON.stringify(snapshot.notebook)) {
            throw new Error("Dream notebook changed during analysis; defer this plan");
          }
          for (const input of snapshot.inputs) {
            const source = admitted.find((item) => item.source.id === input.id)!.source;
            const { text } = await readDreamSourceContent(params.workspaceDir, source);
            assertCurrent();
            if (text === undefined) {
              throw new Error("Dream source changed during analysis; defer publication");
            }
          }
          const publications = plan.publications.map((publication, index) => {
            const target = snapshot.targets.find(
              (candidate) => candidate.id === publication.targetId,
            );
            if (
              !target ||
              publication.sourceIds.some(
                (id) =>
                  !admitted
                    .find((item) => item.source.id === id)
                    ?.policy.targets.some(
                      (candidate) =>
                        candidate.path === target.path ||
                        (candidate.archive &&
                          target.path.startsWith(`${path.posix.dirname(candidate.path)}/Archive/`)),
                    ),
              )
            ) {
              throw new Error("Dream plan selected a target outside the source audience");
            }
            if (publication.kind === "archive" && (!target.archive || !publication.completed)) {
              throw new Error("Dream Archive requires an admitted target and completed matter");
            }
            const id = `dream-${randomUUID()}`;
            const outputPath =
              publication.kind === "archive" && !("existingArchive" in target)
                ? target.archive!(params.nowMs + index)
                : target.path;
            if ("existingArchive" in target && publication.kind !== "archive") {
              throw new Error("Dream Archive additions must use Archive publication");
            }
            const before =
              publication.kind === "archive" && !("existingArchive" in target)
                ? ""
                : target.content;
            const covered = (publication.coveredEntries ?? []).map((entryId) => {
              const entry = snapshot.curated.find((candidate) => candidate.id === entryId);
              if (
                !entry ||
                entry.sourceIds.some((sourceId) => !publication.sourceIds.includes(sourceId)) ||
                entry.target.includes("/Archive/")
              ) {
                throw new Error("Dream cleanup requires complete admitted Memory evidence");
              }
              return entry;
            });
            const citations = [
              ...new Set(
                publication.sourceIds.map((sourceId) => {
                  const source = admitted.find((item) => item.source.id === sourceId)!.source;
                  return `sessions/${source.agentId}/${source.sessionId}`;
                }),
              ),
            ];
            const body = publication.content
              .split("\n")
              .map((line) => `  ${line}`)
              .join("\n");
            const addition = `${buildPromotionMarker(id)}\n- ${publication.reason}\n${body}\n  Source: ${citations.join("; ")}\n<!-- openclaw-memory-end:${id} -->\n`;
            return {
              id,
              target: outputPath,
              sourceIds: publication.sourceIds,
              coveredSourceIds: publication.coveredSourceIds ?? [],
              before,
              after: `${before}${before.endsWith("\n\n") || !before ? "" : "\n\n"}${addition}`,
              coveredEntries: covered.map((entry) => entry.id),
            };
          });
          // Exact curated removals are publication operations too, so recovery
          // verifies every replacement before deleting covered lower-level text.
          const covered = snapshot.curated.filter((entry) =>
            publications.some((publication) => publication.coveredEntries.includes(entry.id)),
          );
          for (const entry of covered) {
            const filePath = path.join(params.workspaceDir, entry.target);
            const currentContent = await readMemoryContent(filePath, params.workspaceDir);
            const matched = readFragmentEntry(currentContent, entry);
            if (!matched) {
              throw new Error("Dream covered Memory changed during analysis");
            }
            const sameTarget = publications.find(
              (publication) => publication.target === entry.target,
            );
            if (sameTarget) {
              const occurrence = readFragmentEntry(sameTarget.after, entry);
              if (!occurrence || sameTarget.before !== currentContent) {
                throw new Error("Dream consolidation target changed during analysis");
              }
              sameTarget.after =
                sameTarget.after.slice(0, occurrence.start) +
                sameTarget.after.slice(occurrence.end);
            } else {
              publications.push({
                id: `dream-${randomUUID()}`,
                target: entry.target,
                sourceIds: entry.sourceIds,
                coveredSourceIds: [],
                before: currentContent,
                after: currentContent.slice(0, matched.start) + currentContent.slice(matched.end),
                coveredEntries: [],
              });
            }
          }
          if (
            publications.length > 8 ||
            publications.reduce(
              (sum, publication) => sum + publication.before.length + publication.after.length,
              0,
            ) > 300_000
          ) {
            throw new Error("Dream publication capacity exceeded; preserve sources");
          }
          if (
            new Set(publications.map((publication) => publication.target)).size !==
            publications.length
          ) {
            throw new Error("Dream plan must organize each target into one publication");
          }
          const carriedTopics = current.topics.filter(
            (topic) =>
              !snapshot.topics.includes(topic) && !topic.sourceIds.every((id) => known.has(id)),
          );
          const clean = [
            ...new Set([
              ...plan.discard,
              ...plan.publications.flatMap((publication) => publication.coveredSourceIds ?? []),
            ]),
          ].filter(
            (id) =>
              admitted.find((item) => item.source.id === id)?.source.kind === "fragment" &&
              !plan.topics.some((topic) => topic.sourceIds.includes(id)),
          );
          const processed = [
            ...new Set([
              ...plan.processed,
              ...plan.discard,
              ...publications.flatMap((publication) => publication.sourceIds),
              ...clean,
              ...plan.topics.flatMap((topic) => topic.sourceIds),
            ]),
          ].filter(
            (id) =>
              admitted.find((item) => item.source.id === id)?.source.kind === "event" ||
              clean.includes(id),
          );
          const next: DreamFragmentNotebook = {
            version: 2,
            topics: current.topics,
            ...(current.artifacts ? { artifacts: current.artifacts } : {}),
            pending: {
              evidence: {
                sources: snapshot.evidenceSources,
                inputs: snapshot.inputs.map((input) => ({
                  id: input.id,
                  hash: admitted.find((item) => item.source.id === input.id)!.source.hash,
                })),
                targets: snapshot.targets.map((target) => ({
                  path: target.path,
                  hash: hashMemoryContent(target.content),
                })),
                curated: snapshot.curated.map((entry) => ({
                  id: entry.id,
                  path: entry.target,
                  hash: entry.hash,
                })),
                topicsHash: hashMemoryContent(JSON.stringify(current.topics)),
                artifactsHash: hashMemoryContent(JSON.stringify(current.artifacts ?? [])),
              },
              publications,
              discard: plan.discard,
              clean,
              processed,
              topics: [...carriedTopics, ...plan.topics],
            },
          };
          await writeDreamFragmentNotebook(params.workspaceDir, next);
          await recoverPendingFragmentDream(params, next);
          params.logger.info(
            `memory-core: Dream organized ${processed.length} Fragment entries and published ${publications.length} artifacts.`,
          );
        });
      },
    ).catch(async (error: unknown) => {
      params.assertCurrent();
      // One Workspace notebook owns recovery. Never let another batch replace
      // a durable pending plan, including an uncertain publication outcome.
      const current = await readDreamFragmentNotebook(params.workspaceDir);
      params.assertCurrent();
      if (current.pending) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      params.logger.warn(
        `memory-core: Dream deferred a batch of ${batch.length} Fragment entries; retry next pass: ${reason}`,
      );
    });
  }
}
