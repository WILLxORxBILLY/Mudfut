import { sourceFingerprint } from "./pilot-store.mjs";
import { decodeUnderstanding } from "./pilot-memory.mjs";
import { annotationsFromUnderstanding } from "./community-knowledge.mjs";

const idsMatch = (actual, expected) =>
  actual.length === expected.length && expected.every((id) => actual.includes(id));

// Reconcile one committed, manifest-bound episode per worker turn; the worker
// polls and services urgent replies between episodes instead of holding a batch lock.
export async function reconcilePendingHistoryDerivations(
  knowledge,
  { loadEpisode, archiveAuthority, shouldYield = async () => false },
) {
  if (typeof loadEpisode !== "function" || typeof archiveAuthority !== "function")
    throw new Error("Historical derivation recovery requires injected archive readers");
  const [item] = await knowledge.pendingHistoryDerivations({ limit: 1 });
  if (!item) return { disposition: "idle" };
  const { binding, manifest, episode, manifestId, episodeId, workId, candidate } = item;
  const stale = async (reason, detail = {}) =>
    knowledge.completeHistoryDerivation({
      manifestId,
      episodeId,
      workId,
      status: "stale",
      reason,
      detail,
    });
  const excluded = async (reason, detail = {}) =>
    knowledge.completeHistoryDerivation({
      manifestId,
      episodeId,
      workId,
      status: "excluded",
      reason,
      detail,
    });

  if ((await archiveAuthority(manifest)) !== binding.archiveAuthorityDigest)
    return stale("archive-authority-changed", {
      archiveConnectionId: manifest.archiveConnectionId,
    });
  if (await shouldYield()) return { disposition: "deferred", reason: "live-priority" };
  const loaded = await loadEpisode(episode, shouldYield);
  if (!loaded) return { disposition: "deferred", reason: "live-priority" };
  const directSources = (loaded.rows ?? []).map((row) => row.source);
  const contextSources = loaded.context ?? [];
  const selectedSources = [...directSources, ...contextSources];
  const expectedIds = [...binding.sourceIds, ...binding.contextIds];
  const actualIds = selectedSources.map((source) => source.id);
  const excludedIds = (loaded.excluded ?? []).map((item) => item.id);
  if (
    loaded.excluded?.length ||
    !idsMatch(
      directSources.map((source) => source.id),
      binding.sourceIds,
    ) ||
    !idsMatch(
      contextSources.map((source) => source.id),
      binding.contextIds,
    ) ||
    !idsMatch(actualIds, expectedIds)
  ) {
    const deletion = (loaded.excluded ?? []).some((item) =>
      ["deleted", "ineligible in archive", "bot or system message"].includes(item.reason),
    );
    const outcome = deletion
      ? await excluded("selected-source-no-longer-eligible", {
          excludedCount: loaded.excluded.length,
          excludedIds,
        })
      : await stale("selected-source-set-changed", {
          expectedSourceCount: expectedIds.length,
          currentSourceCount: actualIds.length,
        });
    for (const source of selectedSources)
      if (source.content?.trim()) await knowledge.registerSource(source);
    for (const id of excludedIds) await knowledge.removeSource(id);
    return outcome;
  }

  const changed = selectedSources.filter(
    (source) => binding.sourceDigests[source.id] !== sourceFingerprint(source),
  );
  if (changed.length) {
    const outcome = await stale("selected-source-content-changed", {
      changedSourceCount: changed.length,
      changedRoles: changed.map((source) => binding.sourceBindings[source.id]?.role ?? "unknown"),
    });
    for (const source of changed)
      if (source.content?.trim()) await knowledge.registerSource(source);
    return outcome;
  }

  for (const source of selectedSources)
    if (source.content.trim()) await knowledge.registerSource(source);
  const verified = await knowledge.verifyHistoryProjection(
    binding,
    await archiveAuthority(manifest),
  );
  if (!verified.current) return stale(verified.reason);

  const entries = decodeUnderstanding(candidate?.content);
  if (!entries) return excluded("committed-memory-candidate-invalid");
  const projected = annotationsFromUnderstanding(entries, episode);
  if (!projected.length) return excluded("committed-memory-has-no-eligible-annotations");
  const sourcesById = new Map(selectedSources.map((source) => [source.id, source]));
  const invalidQuoteCount = projected.filter((annotation) =>
    (annotation.sourceQuotes ?? []).some(
      (quote) => !sourcesById.get(quote.sourceId)?.content.includes(quote.quote),
    ),
  ).length;
  if (invalidQuoteCount)
    return excluded("committed-memory-source-quote-invalid", {
      projectedCount: projected.length,
      invalidQuoteCount,
    });
  const outcomes = [];
  for (const annotation of projected) {
    const work = await knowledge.prepareAnnotation({
      manifestId,
      episodeKey: episode.key,
      candidate: annotation,
    });
    outcomes.push(await knowledge.commitAnnotation(work));
  }
  if (outcomes.some((outcome) => !["applied", "already-applied"].includes(outcome.disposition)))
    return stale("annotation-job-rejected", {
      projectedCount: projected.length,
      staleCount: outcomes.filter((outcome) => outcome.disposition === "stale-source").length,
    });
  const correctionReviewCompletions = await knowledge.completeCorrectionReviews({
    manifestId,
    episodeKey: episode.key,
    candidates: projected,
    outcomes,
    correctionIds: binding.correctionIds,
  });
  await knowledge.completeRequeuedEpisode({ manifestId, episodeKey: episode.key });
  const result = await knowledge.completeHistoryDerivation({
    manifestId,
    episodeId,
    workId,
    status: "derived",
    reason: "committed-memory-projected",
    detail: {
      projectedCount: projected.length,
      alreadyCurrentCount: outcomes.filter((outcome) => outcome.disposition === "already-applied")
        .length,
      correctionReviewCount: correctionReviewCompletions.length,
    },
  });
  return { ...result, projectedCount: projected.length, correctionReviewCompletions };
}
