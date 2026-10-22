import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import pg from "pg";
import { state, assertPrivateState } from "./runtime.mjs";
import { validateAnnotation } from "./community-knowledge.mjs";

const fallbackTopicQualification =
  "Topic label is the founder-selected manifest episode key; inspect the cited sources.";
const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const parsed = (value) => (typeof value === "string" ? JSON.parse(value) : value);
const timestamp = (value) => (value instanceof Date ? value.toISOString() : String(value));

function sourceRecord(row) {
  const source = parsed(row.source);
  if (
    !source ||
    typeof source !== "object" ||
    source.id !== row.id ||
    typeof source.content !== "string" ||
    !source.content.trim() ||
    typeof source.url !== "string" ||
    !source.url ||
    typeof source.authorId !== "string" ||
    typeof source.createdAt !== "string"
  )
    throw new Error(`Invalid review source ${row.id}`);
  return {
    sourceId: row.id,
    sourceRevision: Number(row.revision),
    sourceGeneration: Number(row.generation),
    sourceDigest: row.source_digest,
    status: row.deleted ? "deleted" : "current",
    authorId: source.authorId,
    authorName: typeof source.authorName === "string" ? source.authorName : null,
    createdAt: source.createdAt,
    canonicalPermalink: source.url,
    replyTo: source.replyTo ?? null,
    exactMessage: source.content,
  };
}

function boundary(sourceId, sources) {
  const source = sources.get(sourceId);
  return source
    ? {
        sourceId,
        sourceRevision: source.sourceRevision,
        sourceGeneration: source.sourceGeneration,
        sourceDigest: source.sourceDigest,
        status: source.status,
        createdAt: source.createdAt,
        canonicalPermalink: source.canonicalPermalink,
      }
    : { sourceId, status: "missing" };
}

function replyBoundary(source, sources, selectedIds) {
  if (!source.replyTo) return { status: "not-needed" };
  const parent = sources.get(source.replyTo);
  return {
    status: selectedIds.has(source.replyTo) ? "included" : "outside-selected-slice",
    sourceId: source.replyTo,
    ...(parent
      ? {
          sourceRevision: parent.sourceRevision,
          sourceGeneration: parent.sourceGeneration,
          sourceDigest: parent.sourceDigest,
          sourceStatus: parent.status,
          createdAt: parent.createdAt,
          canonicalPermalink: parent.canonicalPermalink,
        }
      : {}),
  };
}

function prior(row) {
  const candidate = validateAnnotation(parsed(row.candidate));
  return {
    annotationId: row.id,
    revision: Number(row.revision),
    status: row.status,
    interpretation: candidate.interpretation,
    sourceIds: candidate.sourceIds,
    createdAt: timestamp(row.created_at),
  };
}

function evidenceTimeOrder(entry) {
  return (entry?.sources ?? [])
    .filter((source) => source?.sourceId && source?.createdAt)
    .map((source) => ({ sourceId: source.sourceId, createdAt: source.createdAt }))
    .sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.sourceId.localeCompare(right.sourceId),
    );
}

export function buildReviewPackage({
  annotations,
  sources,
  priors = [],
  competitors = [],
  views = [],
  generatedAt,
  sourceSnapshotAt = generatedAt,
}) {
  const sourceMap = new Map(sources.map((row) => [row.sourceId, row]));
  const priorsById = new Map();
  for (const item of priors) {
    const list = priorsById.get(item.annotationId) ?? [];
    list.push(item);
    priorsById.set(item.annotationId, list);
  }
  const competitorById = new Map(competitors.map((item) => [item.annotationId, item]));
  const requiredHistoryKeys = new Set(
    annotations.flatMap((row) =>
      row.candidate.subjectIds.flatMap((memberId) =>
        row.candidate.topics.map((topic) => `${memberId}:${topic}`),
      ),
    ),
  );
  const historyViews = views
    .filter((view) => view.target === "history" && requiredHistoryKeys.has(view.key))
    .map((view) => {
      const entries = (view.document?.entries ?? []).map((entry, viewOrderIndex) => {
        const sourceTimeOrder = evidenceTimeOrder(entry);
        return {
          viewOrderIndex,
          annotationId: entry.annotationId,
          annotationRevision: Number(entry.annotationRevision),
          annotationCreatedAt: entry.createdAt,
          sourceTimeOrder,
          earliestSourceTime: sourceTimeOrder[0]?.createdAt ?? null,
        };
      });
      const dated = entries.filter((entry) => entry.earliestSourceTime);
      return {
        key: view.key,
        revision: Number(view.revision),
        documentDigest: view.documentDigest,
        storedEntryOrder: entries,
        orderedByEarliestEvidenceTime: dated.every(
          (entry, index) =>
            index === 0 ||
            Date.parse(dated[index - 1].earliestSourceTime) <= Date.parse(entry.earliestSourceTime),
        ),
        orderCheckBasis:
          "stored array order compared with each entry's earliest cited source createdAt; annotation createdAt is retained separately",
      };
    });
  const selectedViewRefs = (candidate, row) => {
    const expected = new Set();
    candidate.subjectIds.forEach((id) => expected.add(`profile:${id}`));
    candidate.topics.forEach((topic) => expected.add(`topic:${topic}`));
    candidate.subjectIds.forEach((id) =>
      candidate.topics.forEach((topic) => expected.add(`history:${id}:${topic}`)),
    );
    return views
      .filter((view) => expected.has(`${view.target}:${view.key}`))
      .map((view) => {
        const entry = view.document?.entries?.find(
          (item) =>
            item.annotationId === row.annotationId &&
            Number(item.annotationRevision) === Number(row.revision),
        );
        return {
          target: view.target,
          key: view.key,
          revision: Number(view.revision),
          documentDigest: view.documentDigest,
          annotationRevisionStatus: entry ? "present" : "not-present",
          ...(entry ? { renderedInterpretation: entry.interpretation } : {}),
        };
      });
  };
  const semantic = {
    fallbackTopicLabels: 0,
    unknownUncertainty: 0,
    noCompetingLinks: 0,
    missingCompetingReferences: 0,
  };
  const directIds = new Set();
  const boundaryIds = new Set();
  const statements = annotations.map((row) => {
    const candidate = validateAnnotation(row.candidate);
    const episode = row.episode;
    if (!episode || typeof episode !== "object" || !Array.isArray(episode.sourceIds))
      throw new Error(`Invalid review episode ${row.episodeId}`);
    const episodeSourceIds = [...episode.sourceIds];
    const episodeContextIds = [...(episode.contextIds ?? [])];
    const episodeSelectedIds = new Set([...episodeSourceIds, ...episodeContextIds]);
    const directEvidence = candidate.sourceIds.map((sourceId) => {
      directIds.add(sourceId);
      const source = sourceMap.get(sourceId);
      if (!source) return { sourceId, status: "missing", quoteSpans: [] };
      return {
        ...source,
        quoteSpans: (candidate.sourceQuotes ?? [])
          .filter((item) => item.sourceId === sourceId)
          .map((item) => item.quote),
        replyBoundary: replyBoundary(source, sourceMap, episodeSelectedIds),
      };
    });
    [...episodeSourceIds, ...episodeContextIds, ...(candidate.contextSourceIds ?? [])].forEach(
      (id) => boundaryIds.add(id),
    );
    const fallbackTopicLabel = candidate.qualifications.includes(fallbackTopicQualification);
    const unknownUncertainty = candidate.uncertainty === "unknown";
    const noCompetingLinks = candidate.competingWith.length === 0;
    const competingInterpretations = candidate.competingWith.map((annotationId) => {
      const match = competitorById.get(annotationId);
      if (match) return match;
      semantic.missingCompetingReferences += 1;
      return { annotationId, status: "missing" };
    });
    if (fallbackTopicLabel) semantic.fallbackTopicLabels += 1;
    if (unknownUncertainty) semantic.unknownUncertainty += 1;
    if (noCompetingLinks) semantic.noCompetingLinks += 1;
    return {
      annotationId: row.annotationId,
      revision: Number(row.revision),
      annotationStatus: "candidate",
      candidateDigest: row.candidateDigest,
      manifestId: row.manifestId,
      manifestGeneration: Number(row.manifestGeneration),
      episode: {
        id: row.episodeId,
        key: episode.key,
        label: episode.label,
        sourceBoundary: episodeSourceIds.map((sourceId) => boundary(sourceId, sourceMap)),
        contextBoundary: episodeContextIds.map((sourceId) => boundary(sourceId, sourceMap)),
        annotationContext: (candidate.contextSourceIds ?? []).map((sourceId) =>
          boundary(sourceId, sourceMap),
        ),
      },
      derivedStatement: candidate.interpretation,
      kind: candidate.kind ?? null,
      subjectIds: candidate.subjectIds,
      topics: candidate.topics,
      qualifications: candidate.qualifications,
      uncertainty: candidate.uncertainty,
      directEvidence,
      replyDependencies: directEvidence
        .filter((source) => source.replyBoundary?.status !== "not-needed")
        .map((source) => ({
          childSourceId: source.sourceId,
          parentSourceId: source.replyBoundary.sourceId,
          boundary: source.replyBoundary.status,
          dependencyRecordedOnAnnotation: (candidate.contextSourceIds ?? []).includes(
            source.replyBoundary.sourceId,
          ),
          interpretationDependency:
            "not-recorded; review whether this parent is needed to resolve the statement",
        })),
      contextualSources: [...new Set([...episodeSourceIds, ...episodeContextIds])]
        .filter((sourceId) => !candidate.sourceIds.includes(sourceId))
        .map((sourceId) => {
          const source = sourceMap.get(sourceId);
          return source
            ? {
                ...source,
                relationshipToAnnotation: episodeSourceIds.includes(sourceId)
                  ? "uncited-selected-episode-source"
                  : "selected-episode-context",
                replyBoundary: replyBoundary(source, sourceMap, episodeSelectedIds),
              }
            : {
                sourceId,
                status: "missing",
                relationshipToAnnotation: episodeSourceIds.includes(sourceId)
                  ? "uncited-selected-episode-source"
                  : "selected-episode-context",
              };
        }),
      sourceTimeOrder: [...directEvidence]
        .filter((source) => source.createdAt)
        .sort(
          (left, right) =>
            Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
            left.sourceId.localeCompare(right.sourceId),
        )
        .map(({ sourceId, createdAt }) => ({ sourceId, createdAt })),
      historySortBasis:
        "sourceTimeOrder is sorted by cited source createdAt; stored history view position is reported separately",
      viewLineage: selectedViewRefs(candidate, row),
      competingInterpretations,
      priorAndSupersededInterpretations: priorsById.get(row.annotationId) ?? [],
      processingVersion: candidate.processingVersion,
      createdAt: row.createdAt,
      semanticFlags: { fallbackTopicLabel, unknownUncertainty, noCompetingLinks },
    };
  });
  const tally = (ids) =>
    [...ids].reduce(
      (counts, id) => {
        counts[sourceMap.get(id)?.status ?? "missing"] += 1;
        return counts;
      },
      { current: 0, deleted: 0, missing: 0 },
    );
  return {
    schemaVersion: "community-knowledge-review-package-v2",
    generatedAt,
    sourceSnapshotAt,
    scope:
      "Read-only package of current candidate annotations; it does not alter source, annotation, view, or delivery state.",
    currentness: {
      candidateStatements: statements.length,
      directEvidenceSources: tally(directIds),
      episodeBoundarySources: tally(boundaryIds),
      allCurrentDirectEvidence: tally(directIds).deleted === 0 && tally(directIds).missing === 0,
    },
    reviewStatements: statements,
    historyViews,
    semanticAudit: {
      ...semantic,
      note: "These flags identify review work still needed; they do not by themselves invalidate a source-bound statement.",
    },
    conclusions: {
      implementationContract:
        "The package records current candidate annotations beside immutable source revisions and exact message links. It is evidence for package coverage, not a claim that semantic review is complete.",
      semanticQuality:
        "Inspect the explicit fallback-topic, unknown-uncertainty, no-competing-link, and missing-reference counts before relying on an interpretation.",
      publicDeliveryProof:
        "Not included. This read-only private package neither sends public messages nor proves public delivery.",
    },
  };
}

export async function loadCurrentReviewData(db) {
  const candidates = (
    await db.query(
      `SELECT a.id,a.revision,a.candidate_digest,a.manifest_id,m.generation AS manifest_generation,a.episode_id,a.candidate,a.created_at,e.snapshot AS episode
       FROM pilot_knowledge_annotations a
       JOIN pilot_knowledge_episodes e ON e.id=a.episode_id
       JOIN pilot_knowledge_manifests m ON m.id=a.manifest_id
       WHERE a.status='candidate'
       ORDER BY a.created_at,a.id,a.revision`,
    )
  ).rows.map((row) => ({
    annotationId: row.id,
    revision: row.revision,
    candidateDigest: row.candidate_digest,
    manifestId: row.manifest_id,
    manifestGeneration: row.manifest_generation,
    episodeId: row.episode_id,
    candidate: validateAnnotation(parsed(row.candidate)),
    createdAt: timestamp(row.created_at),
    episode: parsed(row.episode),
  }));
  const sourceIds = new Set();
  const annotationIds = new Set();
  const competingIds = new Set();
  for (const row of candidates) {
    annotationIds.add(row.annotationId);
    [
      ...row.candidate.sourceIds,
      ...(row.candidate.contextSourceIds ?? []),
      ...row.episode.sourceIds,
      ...(row.episode.contextIds ?? []),
    ].forEach((id) => sourceIds.add(id));
    row.candidate.competingWith.forEach((id) => competingIds.add(id));
  }
  const sourceRows = sourceIds.size
    ? (
        await db.query(
          "SELECT id,revision,generation,source_digest,deleted,source FROM pilot_knowledge_sources WHERE id=ANY($1::text[])",
          [[...sourceIds]],
        )
      ).rows.map(sourceRecord)
    : [];
  const replyParentIds = new Set(
    sourceRows.map((source) => source.replyTo).filter((id) => id && !sourceIds.has(id)),
  );
  if (replyParentIds.size) {
    const parents = (
      await db.query(
        "SELECT id,revision,generation,source_digest,deleted,source FROM pilot_knowledge_sources WHERE id=ANY($1::text[])",
        [[...replyParentIds]],
      )
    ).rows.map(sourceRecord);
    sourceRows.push(...parents);
  }
  const priorRows = annotationIds.size
    ? (
        await db.query(
          "SELECT id,revision,status,candidate,created_at FROM pilot_knowledge_annotations WHERE id=ANY($1::text[]) AND status<>'candidate' ORDER BY id,revision",
          [[...annotationIds]],
        )
      ).rows.map(prior)
    : [];
  const competitorRows = competingIds.size
    ? (
        await db.query(
          `SELECT DISTINCT ON (id) id,revision,status,candidate,created_at
           FROM pilot_knowledge_annotations WHERE id=ANY($1::text[]) ORDER BY id,revision DESC`,
          [[...competingIds]],
        )
      ).rows.map(prior)
    : [];
  const viewRows = (
    await db.query(
      "SELECT target,key,revision,document_digest,document FROM pilot_knowledge_views ORDER BY target,key",
    )
  ).rows.map((row) => ({
    target: row.target,
    key: row.key,
    revision: row.revision,
    documentDigest: row.document_digest,
    document: parsed(row.document),
  }));
  return {
    annotations: candidates,
    sources: sourceRows,
    priors: priorRows,
    competitors: competitorRows,
    views: viewRows,
  };
}

async function privateJson(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.mode & 0o077)
    throw new Error(`${path} must be a private regular file`);
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

export async function writeReviewPackage(destination, reviewPackage) {
  assertPrivateState(destination);
  const output = resolve(destination);
  await mkdir(output, { recursive: false, mode: 0o700 });
  const statementFile = join(output, "STATEMENT-REVIEW.json");
  const summaryFile = join(output, "SUMMARY.json");
  await writeJson(statementFile, reviewPackage);
  await writeJson(summaryFile, {
    schemaVersion: reviewPackage.schemaVersion,
    generatedAt: reviewPackage.generatedAt,
    sourceSnapshotAt: reviewPackage.sourceSnapshotAt,
    currentness: reviewPackage.currentness,
    semanticAudit: reviewPackage.semanticAudit,
    historyViews: reviewPackage.historyViews,
    conclusions: reviewPackage.conclusions,
  });
  const index = {
    schemaVersion: reviewPackage.schemaVersion,
    generatedAt: reviewPackage.generatedAt,
    files: [
      { name: "STATEMENT-REVIEW.json", sha256: digest(await readFile(statementFile, "utf8")) },
      { name: "SUMMARY.json", sha256: digest(await readFile(summaryFile, "utf8")) },
    ],
  };
  await writeJson(join(output, "INDEX.json"), index);
  return { output, index };
}

async function main() {
  const [flag, destination] = process.argv.slice(2);
  if (flag !== "--out" || !destination || process.argv.length !== 4)
    throw new Error("Use --out /private/path/to/new-review-package");
  assertPrivateState(state);
  const output = resolve(destination);
  if (
    !relative(resolve(dirname(output)), output) ||
    !output.startsWith(resolve(dirname(output)) + sep)
  )
    throw new Error("Review package destination must be a child directory");
  const db = new pg.Client(await privateJson(join(state, "postgres.json")));
  try {
    await db.connect();
    await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const sourceSnapshotAt = timestamp(
      (await db.query("SELECT transaction_timestamp() AS at")).rows[0].at,
    );
    const data = await loadCurrentReviewData(db);
    await db.query("COMMIT");
    const reviewPackage = buildReviewPackage({
      ...data,
      generatedAt: new Date().toISOString(),
      sourceSnapshotAt,
    });
    const written = await writeReviewPackage(output, reviewPackage);
    console.log(
      JSON.stringify({
        output: written.output,
        ...reviewPackage.currentness,
        semanticAudit: reviewPackage.semanticAudit,
      }),
    );
  } finally {
    await db.query("ROLLBACK").catch(() => {});
    await db.end().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname))
  await main();
