import { createHash, randomUUID } from "node:crypto";
import {
  canonicalDigest,
  digest as pilotDigest,
  snowflake,
  sourceFingerprint,
} from "./pilot-store.mjs";

const MAX_ANNOTATION_SOURCES = 24;
const manifestTopicQualification =
  "Topic label is the selected manifest episode key; inspect the cited sources.";
const invalidMemoryTopicsQualification =
  "Stored topic labels are not lowercase slugs; this view uses the selected manifest episode key. Inspect the cited sources.";
const legacyManifestTopicQualification =
  "Topic label is the founder-selected manifest episode key; inspect the cited sources.";
const isManifestTopicQualification = (qualification) =>
  [
    manifestTopicQualification,
    invalidMemoryTopicsQualification,
    legacyManifestTopicQualification,
  ].includes(qualification);
const stable = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
    .join(",")}}`;
};
const sha256 = (value) => createHash("sha256").update(stable(value), "utf8").digest("hex");
// node-postgres accepts objects today, but making the JSON boundary explicit keeps
// JSONB writes independent of its prepareValue implementation and prevents the
// manifest path from regressing into the original PostgreSQL JSON failure.
const jsonb = (value) => JSON.stringify(value);
const parsed = (value) => (typeof value === "string" ? JSON.parse(value) : value);
const identifier = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,95}$/.test(value);
const text = (value, maximum) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
const historyViewKey = (memberId, topic) => `${memberId}:${topic}`;
const historyViewParts = (key) => {
  const [memberId, topic, extra] = typeof key === "string" ? key.split(":") : [];
  return extra === undefined && snowflake(memberId) && /^[a-z0-9][a-z0-9-]{0,63}$/.test(topic ?? "")
    ? { memberId, topic }
    : null;
};
const array = (value, maximum, predicate) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= maximum &&
  value.every(predicate) &&
  new Set(value).size === value.length;

const counts = (rows, key) => Object.fromEntries(rows.map((row) => [key(row), Number(row.count)]));

// This report is deliberately content-free so an operator can inspect durable
// progress without turning archive text or correction notes into another output.
export async function communityKnowledgeStatus(db) {
  const present = (await db.query("SELECT to_regclass('public.pilot_knowledge_manifests') AS name"))
    .rows[0].name;
  if (!present) return { status: "not-initialized" };
  // node-postgres serializes one client's protocol messages; keep these reads
  // explicitly sequential rather than creating concurrent-query ambiguity.
  const manifests = await db.query(
    "SELECT id,generation,created_at FROM pilot_knowledge_manifests ORDER BY created_at,id",
  );
  const sources = await db.query(
    "SELECT deleted,count(*)::int AS count FROM pilot_knowledge_sources GROUP BY deleted",
  );
  const manifestSources = await db.query(
    `SELECT CASE WHEN s.id IS NULL THEN 'missing' WHEN s.deleted THEN 'deleted' ELSE 'current' END AS status,
      count(*)::int AS count
     FROM (
       SELECT DISTINCT source_id
       FROM pilot_knowledge_episodes e
       CROSS JOIN LATERAL jsonb_array_elements_text(e.snapshot->'sourceIds') AS source_id
       UNION
       SELECT DISTINCT source_id
       FROM pilot_knowledge_episodes e
       CROSS JOIN LATERAL jsonb_array_elements_text(e.snapshot->'contextIds') AS source_id
     ) selected
     LEFT JOIN pilot_knowledge_sources s ON s.id=selected.source_id
     GROUP BY 1`,
  );
  const jobs = await db.query(
    "SELECT status,effective,count(*)::int AS count FROM pilot_knowledge_jobs GROUP BY status,effective",
  );
  const annotations = await db.query(
    "SELECT status,count(*)::int AS count FROM pilot_knowledge_annotations GROUP BY status",
  );
  const annotationQuoteCoverage = await db.query(
    `SELECT count(*)::int AS candidate,
      count(*) FILTER (WHERE candidate ? 'sourceQuotes' AND jsonb_array_length(candidate->'sourceQuotes')>0)::int AS quoted
     FROM pilot_knowledge_annotations WHERE status='candidate'`,
  );
  const views = await db.query(
    "SELECT target,count(*)::int AS count FROM pilot_knowledge_views GROUP BY target",
  );
  const exports = await db.query("SELECT count(*)::int AS count FROM pilot_knowledge_exports");
  const corrections = await db.query(
    "SELECT status,count(*)::int AS count FROM pilot_knowledge_corrections GROUP BY status",
  );
  const derivations = await db.query(
    "SELECT derivation_status AS status,count(*)::int AS count FROM pilot_knowledge_episodes GROUP BY derivation_status",
  );
  const receipts = await db.query(
    "SELECT kind,count(*)::int AS count FROM pilot_knowledge_receipts GROUP BY kind",
  );
  return {
    status: "ready",
    manifests: manifests.rows.map((row) => ({
      id: row.id,
      generation: row.generation,
      installedAt: row.created_at.toISOString(),
    })),
    observedSources: counts(sources.rows, (row) => (row.deleted ? "deleted" : "current")),
    manifestSources: counts(manifestSources.rows, (row) => row.status),
    jobs: counts(jobs.rows, (row) => `${row.status}:${row.effective ? "effective" : "duplicate"}`),
    annotations: counts(annotations.rows, (row) => row.status),
    annotationQuoteCoverage: annotationQuoteCoverage.rows[0],
    views: counts(views.rows, (row) => row.target),
    exports: Number(exports.rows[0].count),
    corrections: counts(corrections.rows, (row) => row.status),
    historicalDerivations: counts(derivations.rows, (row) => row.status),
    receipts: counts(receipts.rows, (row) => row.kind),
  };
}

export function manifestDigest(manifest) {
  return sha256(validateArchiveManifest(manifest));
}

export function archiveAuthorityDigest(connectionId, credentials) {
  if (
    !identifier(connectionId) ||
    credentials?.host !== "127.0.0.1" ||
    credentials?.user !== "mudfut_history_reader" ||
    typeof credentials?.database !== "string" ||
    !credentials.database ||
    !Number.isInteger(credentials.port) ||
    credentials.port < 1 ||
    credentials.port > 65535
  )
    throw new Error(
      "Historical derivation requires its configured loopback read-only archive role",
    );
  return sha256({
    connectionId,
    host: credentials.host,
    port: credentials.port,
    database: credentials.database,
    user: credentials.user,
  });
}

export function validateArchiveManifest(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        !["id", "schemaVersion", "archiveConnectionId", "generation", "episodes"].includes(key),
    ) ||
    !identifier(value.id) ||
    value.schemaVersion !== "community-archive-manifest-v1" ||
    !identifier(value.archiveConnectionId) ||
    !Number.isInteger(value.generation) ||
    value.generation < 1 ||
    !Array.isArray(value.episodes) ||
    value.episodes.length < 1 ||
    value.episodes.length > 6
  )
    throw new Error("Invalid community archive manifest");
  const episodeKeys = new Set();
  const targetIds = new Set();
  const episodes = value.episodes.map((episode) => {
    if (
      !episode ||
      typeof episode !== "object" ||
      Array.isArray(episode) ||
      Object.keys(episode).some(
        (key) => !["key", "label", "guildId", "channelId", "sourceIds", "contextIds"].includes(key),
      ) ||
      !identifier(episode.key) ||
      episodeKeys.has(episode.key) ||
      !text(episode.label, 160) ||
      !snowflake(episode.guildId) ||
      !snowflake(episode.channelId) ||
      !array(episode.sourceIds, 24, snowflake) ||
      !Array.isArray(episode.contextIds) ||
      episode.contextIds.length > 8 ||
      !episode.contextIds.every(snowflake) ||
      new Set([...episode.sourceIds, ...episode.contextIds]).size !==
        episode.sourceIds.length + episode.contextIds.length ||
      episode.sourceIds.some(
        (id, index) => index > 0 && BigInt(id) <= BigInt(episode.sourceIds[index - 1]),
      ) ||
      episode.sourceIds.some((id) => targetIds.has(id))
    )
      throw new Error("Invalid community archive episode");
    episodeKeys.add(episode.key);
    episode.sourceIds.forEach((id) => targetIds.add(id));
    return {
      key: episode.key,
      label: episode.label,
      guildId: episode.guildId,
      channelId: episode.channelId,
      sourceIds: [...episode.sourceIds],
      contextIds: [...episode.contextIds],
    };
  });
  return {
    id: value.id,
    schemaVersion: value.schemaVersion,
    archiveConnectionId: value.archiveConnectionId,
    generation: value.generation,
    episodes,
  };
}

export function validateAnnotation(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "id",
          "sourceIds",
          "contextSourceIds",
          "subjectIds",
          "topics",
          "interpretation",
          "qualifications",
          "uncertainty",
          "competingWith",
          "supersedes",
          "kind",
          "sourceQuotes",
          "claims",
          "processingVersion",
        ].includes(key),
    ) ||
    (value.id !== undefined && !identifier(value.id)) ||
    !array(value.sourceIds, MAX_ANNOTATION_SOURCES, snowflake) ||
    (value.contextSourceIds !== undefined &&
      (!Array.isArray(value.contextSourceIds) ||
        value.contextSourceIds.length > MAX_ANNOTATION_SOURCES ||
        !value.contextSourceIds.every(snowflake) ||
        new Set(value.contextSourceIds).size !== value.contextSourceIds.length ||
        value.contextSourceIds.some((sourceId) => value.sourceIds.includes(sourceId)))) ||
    !array(value.subjectIds, 8, snowflake) ||
    !array(value.topics, 8, (topic) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(topic)) ||
    !text(value.interpretation, 800) ||
    (value.qualifications !== undefined &&
      (!Array.isArray(value.qualifications) ||
        value.qualifications.length > 8 ||
        !value.qualifications.every((item) => text(item, 240)))) ||
    !["low", "medium", "high", "unknown"].includes(value.uncertainty ?? "unknown") ||
    (value.competingWith !== undefined &&
      (!Array.isArray(value.competingWith) ||
        value.competingWith.length > 8 ||
        !value.competingWith.every(identifier))) ||
    (value.supersedes !== undefined && !identifier(value.supersedes)) ||
    (value.kind !== undefined && !text(value.kind, 64)) ||
    (value.sourceQuotes !== undefined &&
      (!Array.isArray(value.sourceQuotes) ||
        value.sourceQuotes.length < 1 ||
        value.sourceQuotes.length > MAX_ANNOTATION_SOURCES ||
        !value.sourceQuotes.every(
          (item) =>
            item &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            Object.keys(item).length === 2 &&
            snowflake(item.sourceId) &&
            text(item.quote, 16000) &&
            value.sourceIds.includes(item.sourceId),
        ) ||
        value.sourceIds.some(
          (sourceId) => !value.sourceQuotes.some((item) => item.sourceId === sourceId),
        ))) ||
    (value.claims !== undefined &&
      (!Array.isArray(value.claims) ||
        value.claims.length < 1 ||
        value.claims.length > MAX_ANNOTATION_SOURCES ||
        !value.claims.every(
          (claim) =>
            claim &&
            typeof claim === "object" &&
            !Array.isArray(claim) &&
            Object.keys(claim).every((key) =>
              ["id", "text", "subjectIds", "anchors"].includes(key),
            ) &&
            identifier(claim.id) &&
            text(claim.text, 400) &&
            (claim.subjectIds === undefined ||
              (Array.isArray(claim.subjectIds) &&
                claim.subjectIds.length <= 8 &&
                claim.subjectIds.every(snowflake) &&
                new Set(claim.subjectIds).size === claim.subjectIds.length)) &&
            Array.isArray(claim.anchors) &&
            claim.anchors.length > 0 &&
            claim.anchors.length <= MAX_ANNOTATION_SOURCES &&
            claim.anchors.every(
              (anchor) =>
                anchor &&
                typeof anchor === "object" &&
                !Array.isArray(anchor) &&
                Object.keys(anchor).every((key) =>
                  ["sourceId", "quote", "relation", "attributedTo", "relatedClaimId"].includes(key),
                ) &&
                snowflake(anchor.sourceId) &&
                text(anchor.quote, 16000) &&
                ["supports", "qualifies", "contradicts", "context"].includes(anchor.relation) &&
                snowflake(anchor.attributedTo) &&
                (anchor.relatedClaimId === undefined || identifier(anchor.relatedClaimId)),
            ),
        ) ||
        new Set(value.claims.map((claim) => claim.id)).size !== value.claims.length ||
        value.claims.some((claim) =>
          claim.anchors.some(
            (anchor) =>
              anchor.relatedClaimId &&
              !value.claims.some((item) => item.id === anchor.relatedClaimId),
          ),
        ) ||
        value.claims.reduce((total, claim) => total + claim.anchors.length, 0) >
          MAX_ANNOTATION_SOURCES * 2)) ||
    !text(value.processingVersion, 100)
  )
    throw new Error("Invalid community annotation");
  return {
    ...(value.id ? { id: value.id } : {}),
    sourceIds: [...value.sourceIds],
    ...(value.contextSourceIds?.length ? { contextSourceIds: [...value.contextSourceIds] } : {}),
    subjectIds: [...value.subjectIds],
    topics: [...value.topics],
    interpretation: value.interpretation.trim(),
    qualifications: [...(value.qualifications ?? [])],
    uncertainty: value.uncertainty ?? "unknown",
    competingWith: [...(value.competingWith ?? [])],
    ...(value.supersedes ? { supersedes: value.supersedes } : {}),
    ...(value.kind ? { kind: value.kind.trim() } : {}),
    ...(value.sourceQuotes
      ? {
          sourceQuotes: value.sourceQuotes.map((item) => ({
            sourceId: item.sourceId,
            quote: item.quote,
          })),
        }
      : {}),
    ...(value.claims
      ? {
          claims: value.claims.map((claim) => ({
            id: claim.id,
            text: claim.text.trim(),
            ...(claim.subjectIds?.length ? { subjectIds: [...claim.subjectIds] } : {}),
            anchors: claim.anchors.map((anchor) => ({
              sourceId: anchor.sourceId,
              quote: anchor.quote,
              relation: anchor.relation,
              attributedTo: anchor.attributedTo,
              ...(anchor.relatedClaimId ? { relatedClaimId: anchor.relatedClaimId } : {}),
            })),
          })),
        }
      : {}),
    processingVersion: value.processingVersion,
  };
}

export function parseKnowledgeCommand(content) {
  if (typeof content !== "string") return null;
  const match = /^!knowledge\s+(profile|topic|history|correct)\s+(.+)$/is.exec(content.trim());
  if (!match) return null;
  const [, rawRoute, remainder] = match;
  const route = rawRoute.toLowerCase();
  const parts = remainder.trim().split(/\s+/);
  const commandPage = (base) => {
    if (parts.length === base) return undefined;
    if (
      parts.length === base + 2 &&
      parts[base] === "page" &&
      /^(?:[1-9]\d{0,3}|10000)$/.test(parts[base + 1])
    )
      return Number(parts[base + 1]);
    return null;
  };
  if (route === "profile") {
    const page = commandPage(1);
    if (page !== null && snowflake(parts[0]))
      return { route, memberId: parts[0], ...(page ? { page } : {}) };
  }
  if (route === "topic") {
    const page = commandPage(1);
    if (page !== null && /^[a-z0-9][a-z0-9-]{0,63}$/.test(parts[0] ?? ""))
      return { route, topic: parts[0], ...(page ? { page } : {}) };
  }
  if (route === "history") {
    const page = commandPage(2);
    const [memberId, topic] = parts;
    if (page !== null && snowflake(memberId) && /^[a-z0-9][a-z0-9-]{0,63}$/.test(topic ?? ""))
      return { route, memberId, topic, ...(page ? { page } : {}) };
  }
  if (route === "correct") {
    const correction =
      /^<?https:\/\/discord\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})>?\s+(.+)$/is.exec(
        remainder.trim(),
      );
    if (correction && text(correction[4], 800))
      return {
        route,
        guildId: correction[1],
        channelId: correction[2],
        sourceId: correction[3],
        note: correction[4].trim(),
      };
  }
  throw new Error("Invalid !knowledge command");
}

export function correctionRouteAllowed(config, command) {
  return (
    command?.route === "correct" &&
    snowflake(config?.guildId) &&
    command.guildId === config.guildId &&
    snowflake(command.channelId) &&
    snowflake(command.sourceId)
  );
}

export function validateKnowledgeViewQuery(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid community knowledge query");
  if (value.target === "profile") {
    if (
      Object.keys(value).some((key) => !["target", "memberId"].includes(key)) ||
      !snowflake(value.memberId)
    )
      throw new Error("Invalid community knowledge query");
    return { target: "profile", key: value.memberId };
  }
  if (value.target === "topic") {
    if (
      Object.keys(value).some((key) => !["target", "topic"].includes(key)) ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.topic ?? "")
    )
      throw new Error("Invalid community knowledge query");
    return { target: "topic", key: value.topic };
  }
  if (value.target === "history") {
    if (
      Object.keys(value).some((key) => !["target", "memberId", "topic"].includes(key)) ||
      !snowflake(value.memberId) ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.topic ?? "")
    )
      throw new Error("Invalid community knowledge query");
    return { target: "history", key: historyViewKey(value.memberId, value.topic) };
  }
  throw new Error("Invalid community knowledge query");
}

const viewSourceIds = (document) => [
  ...new Set(
    (Array.isArray(document?.entries) ? document.entries : []).flatMap((entry) => [
      ...(Array.isArray(entry?.sources) ? entry.sources.map((source) => source.sourceId) : []),
      ...(Array.isArray(entry?.contextSources)
        ? entry.contextSources.map((source) => source.sourceId)
        : []),
    ]),
  ),
];

// Read twice around source refresh. A disappeared or invalidated source therefore
// yields the current incomplete view, never the first stale candidate snapshot.
export async function retrieveCurrentKnowledgeView(knowledge, refreshSources, sourceLookup, input) {
  const { target, key } = validateKnowledgeViewQuery(input);
  let document = await knowledge.view(target, key);
  const initialIds = viewSourceIds(document);
  if (initialIds.length) await refreshSources(initialIds);
  document = await knowledge.view(target, key);
  const sourceIds = viewSourceIds(document);
  const sources = await sourceLookup(sourceIds);
  const available = new Set(sources.map((source) => source.id));
  const entries = (Array.isArray(document.entries) ? document.entries : []).filter(
    (entry) =>
      Array.isArray(entry.sources) &&
      entry.sources.length > 0 &&
      [
        ...entry.sources,
        ...(Array.isArray(entry.contextSources) ? entry.contextSources : []),
      ].every((source) => available.has(source.sourceId)),
  );
  // A source packet is atomic evidence: never render part of an interpretation
  // when any cited original is deleted, held, or unavailable in the pilot store.
  // Preserve the underlying candidate for correction/review; this is only the
  // ordinary retrieval surface failing closed.
  const candidateCount = Array.isArray(document.entries) ? document.entries.length : 0;
  const complete = entries.length === candidateCount;
  const current = complete
    ? document
    : {
        ...document,
        entries,
        incomplete: true,
        unavailableCandidateCount: candidateCount - entries.length,
        status: "candidate interpretations with incomplete current evidence",
      };
  return {
    target,
    key,
    document: current,
    sources: sources.filter((source) => viewSourceIds(current).includes(source.id)),
  };
}

const schema = `
  CREATE TABLE IF NOT EXISTS pilot_knowledge_manifests (
    id text PRIMARY KEY, sha256 text NOT NULL, generation integer NOT NULL,
    manifest jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE IF NOT EXISTS pilot_knowledge_sources (
    id text PRIMARY KEY, source jsonb NOT NULL, source_digest text NOT NULL,
    revision integer NOT NULL, generation integer NOT NULL, correction_generation integer NOT NULL DEFAULT 0,
    deleted boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE IF NOT EXISTS pilot_knowledge_source_revisions (
    source_id text NOT NULL REFERENCES pilot_knowledge_sources(id), revision integer NOT NULL,
    source jsonb NOT NULL, source_digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(source_id, revision));
  CREATE TABLE IF NOT EXISTS pilot_knowledge_episodes (
    id text PRIMARY KEY, manifest_id text NOT NULL REFERENCES pilot_knowledge_manifests(id),
    manifest_generation integer NOT NULL, snapshot jsonb NOT NULL, snapshot_digest text NOT NULL,
    derivation_status text NOT NULL DEFAULT 'eligible', derivation_work_id text,
    derivation_binding jsonb NOT NULL DEFAULT '{}'::jsonb, derivation_reason text,
    derivation_updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE IF NOT EXISTS pilot_knowledge_jobs (
    id text PRIMARY KEY, manifest_id text NOT NULL REFERENCES pilot_knowledge_manifests(id),
    episode_id text NOT NULL REFERENCES pilot_knowledge_episodes(id), source_ids text[] NOT NULL,
    source_generations jsonb NOT NULL, source_revisions jsonb NOT NULL,
    correction_generations jsonb NOT NULL DEFAULT '{}'::jsonb, candidate jsonb NOT NULL, input_digest text NOT NULL,
    logical_key text, annotation_id text, expected_annotation_revision integer,
    effective boolean NOT NULL DEFAULT true,
    status text NOT NULL CHECK(status IN ('prepared','committed','stale','requeued')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz);
  CREATE TABLE IF NOT EXISTS pilot_knowledge_annotations (
    id text NOT NULL, revision integer NOT NULL, manifest_id text NOT NULL REFERENCES pilot_knowledge_manifests(id),
    episode_id text NOT NULL REFERENCES pilot_knowledge_episodes(id), source_ids text[] NOT NULL,
    candidate jsonb NOT NULL, candidate_digest text NOT NULL,
    status text NOT NULL CHECK(status IN ('candidate','invalidated','superseded','requeued')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(id, revision));
  CREATE INDEX IF NOT EXISTS pilot_knowledge_annotations_sources ON pilot_knowledge_annotations USING gin(source_ids);
  CREATE TABLE IF NOT EXISTS pilot_knowledge_views (
    target text NOT NULL CHECK(target IN ('profile','topic','history')), key text NOT NULL,
    revision integer NOT NULL, document jsonb NOT NULL, document_digest text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(target,key));
  CREATE TABLE IF NOT EXISTS pilot_knowledge_exports (
    target text NOT NULL, key text NOT NULL, view_revision integer NOT NULL, document jsonb NOT NULL,
    exported_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(target,key));
  CREATE TABLE IF NOT EXISTS pilot_knowledge_receipts (
    id bigserial PRIMARY KEY, kind text NOT NULL, detail jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE IF NOT EXISTS pilot_knowledge_corrections (
    id uuid PRIMARY KEY, source_id text NOT NULL,
    source_revision integer NOT NULL, note_digest text NOT NULL,
    status text NOT NULL CHECK(status IN ('open','accepted','competing','reaffirmed','rejected','unavailable')),
    reporter_id text, reporter_source_id text, affected_annotation_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    review_origin text NOT NULL DEFAULT 'discord', review_note text,
    resolution_annotation_id text, resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(source_id,note_digest));`;

function sourceShape(source) {
  if (
    !source ||
    typeof source !== "object" ||
    !snowflake(source.id) ||
    !snowflake(source.guildId) ||
    !snowflake(source.channelId) ||
    !snowflake(source.authorId) ||
    !text(source.content, 16000) ||
    !text(source.createdAt, 40) ||
    !text(source.url, 300) ||
    (source.replyTo !== null && source.replyTo !== undefined && !snowflake(source.replyTo)) ||
    (source.editedAt !== null && source.editedAt !== undefined && !text(source.editedAt, 40))
  )
    throw new Error("Invalid community knowledge source");
  return {
    id: source.id,
    guildId: source.guildId,
    channelId: source.channelId,
    authorId: source.authorId,
    authorName: typeof source.authorName === "string" ? source.authorName.slice(0, 160) : null,
    content: source.content,
    createdAt: source.createdAt,
    editedAt: source.editedAt ?? null,
    replyTo: source.replyTo ?? null,
    url: source.url,
  };
}

function episodeFor(manifest, key) {
  const episode = manifest.episodes.find((item) => item.key === key);
  if (!episode) throw new Error("Community annotation episode is not in the manifest");
  return episode;
}
function receipt(db, kind, detail) {
  return db.query("INSERT INTO pilot_knowledge_receipts(kind,detail) VALUES($1,$2)", [
    kind,
    jsonb(detail),
  ]);
}

export async function communityKnowledge(db) {
  await db.query(schema);
  // Correction cases are durable audit records: the referenced source may later
  // disappear, so this must not make source cleanup or recovery impossible.
  await db.query(
    "ALTER TABLE pilot_knowledge_corrections DROP CONSTRAINT IF EXISTS pilot_knowledge_corrections_source_id_fkey",
  );
  await db.query(
    "ALTER TABLE pilot_knowledge_corrections DROP CONSTRAINT IF EXISTS pilot_knowledge_corrections_status_check",
  );
  await db.query(
    "ALTER TABLE pilot_knowledge_corrections ADD CONSTRAINT pilot_knowledge_corrections_status_check CHECK(status IN ('open','accepted','competing','reaffirmed','rejected','unavailable'))",
  );
  await db.query(
    "ALTER TABLE pilot_knowledge_corrections ADD COLUMN IF NOT EXISTS resolution_annotation_id text",
  );
  await db.query(
    "ALTER TABLE pilot_knowledge_corrections ADD COLUMN IF NOT EXISTS reporter_id text",
  );
  await db.query(
    "ALTER TABLE pilot_knowledge_corrections ADD COLUMN IF NOT EXISTS reporter_source_id text",
  );
  await db.query(
    "ALTER TABLE pilot_knowledge_corrections ADD COLUMN IF NOT EXISTS affected_annotation_ids jsonb NOT NULL DEFAULT '[]'::jsonb",
  );
  await db.query(
    "ALTER TABLE pilot_knowledge_corrections ADD COLUMN IF NOT EXISTS review_origin text NOT NULL DEFAULT 'discord'",
  );
  await db.query(
    "ALTER TABLE pilot_knowledge_corrections ADD COLUMN IF NOT EXISTS review_note text",
  );
  await db.query(
    "ALTER TABLE pilot_knowledge_corrections ADD COLUMN IF NOT EXISTS resolved_at timestamptz",
  );
  await db.query(
    "ALTER TABLE pilot_knowledge_jobs ADD COLUMN IF NOT EXISTS source_revisions jsonb",
  );
  await db.query(
    "ALTER TABLE pilot_knowledge_jobs ADD COLUMN IF NOT EXISTS effective boolean NOT NULL DEFAULT true",
  );
  await db.query(
    "ALTER TABLE pilot_knowledge_sources ADD COLUMN IF NOT EXISTS correction_generation integer NOT NULL DEFAULT 0",
  );
  await db.query(
    "ALTER TABLE pilot_knowledge_jobs ADD COLUMN IF NOT EXISTS correction_generations jsonb NOT NULL DEFAULT '{}'::jsonb",
  );
  await db.query("ALTER TABLE pilot_knowledge_jobs ADD COLUMN IF NOT EXISTS logical_key text");
  await db.query("ALTER TABLE pilot_knowledge_jobs ADD COLUMN IF NOT EXISTS annotation_id text");
  await db.query(
    "ALTER TABLE pilot_knowledge_jobs ADD COLUMN IF NOT EXISTS expected_annotation_revision integer",
  );
  await db.query(
    "ALTER TABLE pilot_knowledge_episodes ADD COLUMN IF NOT EXISTS derivation_status text NOT NULL DEFAULT 'eligible'",
  );
  await db.query(
    "ALTER TABLE pilot_knowledge_episodes ADD COLUMN IF NOT EXISTS derivation_work_id text",
  );
  await db.query(
    "ALTER TABLE pilot_knowledge_episodes ADD COLUMN IF NOT EXISTS derivation_binding jsonb NOT NULL DEFAULT '{}'::jsonb",
  );
  await db.query(
    "ALTER TABLE pilot_knowledge_episodes ADD COLUMN IF NOT EXISTS derivation_reason text",
  );
  await db.query(
    "ALTER TABLE pilot_knowledge_episodes ADD COLUMN IF NOT EXISTS derivation_updated_at timestamptz NOT NULL DEFAULT clock_timestamp()",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS pilot_knowledge_episodes_derivation ON pilot_knowledge_episodes(derivation_status,derivation_updated_at,id)",
  );
  await db.query(
    `UPDATE pilot_knowledge_episodes e SET derivation_status='derived',derivation_reason='legacy-annotation-present'
     WHERE e.derivation_status='eligible' AND EXISTS (
       SELECT 1 FROM pilot_knowledge_annotations a WHERE a.episode_id=e.id AND a.status='candidate')`,
  );
  await db.query(`DO $$ BEGIN
    IF to_regclass('public.pilot_work') IS NOT NULL THEN
      UPDATE pilot_knowledge_episodes e SET derivation_status='stale',derivation_reason='legacy-work-has-no-source-binding'
      WHERE e.derivation_status='eligible' AND EXISTS (
        SELECT 1 FROM pilot_work w WHERE w.history_episode=e.id AND w.status='done'
          AND w.history_projection IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM pilot_knowledge_annotations a WHERE a.episode_id=e.id AND a.status='candidate');
    END IF;
  END $$`);
  await db.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS pilot_knowledge_jobs_prepared_logical_key ON pilot_knowledge_jobs(logical_key) WHERE status='prepared' AND logical_key IS NOT NULL",
  );
  async function transaction(operation) {
    await db.query("BEGIN");
    try {
      const result = await operation();
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      throw error;
    }
  }
  async function manifest(id, lock = false) {
    const row = (
      await db.query(
        `SELECT * FROM pilot_knowledge_manifests WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
        [id],
      )
    ).rows[0];
    if (!row) throw new Error("Community archive manifest is unknown");
    return { ...row, manifest: validateArchiveManifest(parsed(row.manifest)) };
  }
  async function sourceRows(ids, lock = false) {
    const rows = (
      await db.query(
        `SELECT * FROM pilot_knowledge_sources WHERE id=ANY($1::text[])${lock ? " FOR UPDATE" : ""}`,
        [ids],
      )
    ).rows;
    if (rows.length !== ids.length || rows.some((row) => row.deleted))
      throw new Error("Community annotation source is not current");
    return new Map(rows.map((row) => [row.id, { ...row, source: parsed(row.source) }]));
  }
  function historicalSourceShape(source, episode) {
    if (
      !source ||
      typeof source !== "object" ||
      !snowflake(source.id) ||
      source.guildId !== episode.guildId ||
      source.channelId !== episode.channelId ||
      !snowflake(source.authorId) ||
      typeof source.content !== "string" ||
      source.content.length > 16000 ||
      !text(source.createdAt, 40) ||
      !text(source.url, 300) ||
      (source.replyTo !== null && source.replyTo !== undefined && !snowflake(source.replyTo)) ||
      (source.editedAt !== null && source.editedAt !== undefined && !text(source.editedAt, 40))
    )
      throw new Error("Invalid historical projection source");
    const canonicalUrl = `https://discord.com/channels/${episode.guildId}/${episode.channelId}/${source.id}`;
    if (source.url !== canonicalUrl)
      throw new Error("Historical projection source permalink differs from its selected episode");
    return {
      id: source.id,
      guildId: episode.guildId,
      channelId: episode.channelId,
      authorId: source.authorId,
      authorName: typeof source.authorName === "string" ? source.authorName.slice(0, 160) : null,
      content: source.content,
      createdAt: source.createdAt,
      editedAt: source.editedAt ?? null,
      replyTo: source.replyTo ?? null,
      url: canonicalUrl,
    };
  }
  async function openCorrectionSources(ids, lock = false) {
    const result = await db.query(
      `SELECT source_id FROM pilot_knowledge_corrections
       WHERE status='open' AND source_id=ANY($1::text[])${lock ? " FOR UPDATE" : ""}`,
      [ids],
    );
    return new Set(result.rows.map((row) => row.source_id));
  }
  async function pilotTablesPresent() {
    const result = await db.query(
      "SELECT to_regclass('public.pilot_sources') AS sources, to_regclass('public.pilot_source_holds') AS holds, to_regclass('public.pilot_meta') AS meta, to_regclass('public.pilot_outbox') AS outbox, to_regclass('public.pilot_work') AS work",
    );
    return Object.values(result.rows[0]).every(Boolean);
  }
  // The pilot outbox has no source dependency packet yet, so correction recovery
  // must conservatively withdraw ready output. ponytail: this is a global ready
  // outbox invalidation; add per-delivery view/source dependencies to target it.
  async function invalidateQueuedPilotDelivery(sourceId) {
    if (!(await pilotTablesPresent())) return false;
    await db.query(
      "UPDATE pilot_meta SET epoch=epoch+1,rebuild=true,relearning=true,invalid_sources=ARRAY(SELECT DISTINCT unnest(invalid_sources || ARRAY[$1]::text[]))",
      [sourceId],
    );
    await db.query("UPDATE pilot_work SET status='stale' WHERE status='prepared'");
    await db.query("DELETE FROM pilot_outbox WHERE status='ready'");
    return true;
  }
  async function scheduleCorrectionEpisodes(sourceId) {
    const present = (
      await db.query("SELECT to_regclass('public.pilot_history_episodes') AS episodes")
    ).rows[0].episodes;
    if (!present) return [];
    // A correction is a bounded re-evaluation request for the already-selected
    // episode, never a license to replay unrelated historical work.
    const queued = await db.query(
      `UPDATE pilot_history_episodes e SET status='queued',work_id=NULL,
       failure_count=0,next_attempt_at=NULL
       FROM pilot_knowledge_jobs j
       WHERE e.id=j.episode_id AND j.status='requeued' AND j.source_ids && ARRAY[$1]
         AND EXISTS(SELECT 1 FROM pilot_knowledge_corrections c
           WHERE c.source_id=$1 AND c.status='open'
             AND (c.reporter_source_id IS NOT NULL OR c.review_origin='private-operator'))
       RETURNING e.id`,
      [sourceId],
    );
    return queued.rows.map((row) => row.id);
  }
  async function invalidateOpenCorrection(sourceId, openedAt) {
    await db.query(
      "UPDATE pilot_knowledge_jobs SET status='stale',completed_at=clock_timestamp() WHERE status='prepared' AND source_ids && ARRAY[$1] AND created_at <= $2",
      [sourceId, openedAt],
    );
    await db.query(
      "UPDATE pilot_knowledge_annotations SET status='invalidated' WHERE status='candidate' AND source_ids && ARRAY[$1] AND created_at <= $2",
      [sourceId, openedAt],
    );
    await db.query(
      "UPDATE pilot_knowledge_jobs SET status='requeued' WHERE status='committed' AND effective AND source_ids && ARRAY[$1] AND completed_at <= $2",
      [sourceId, openedAt],
    );
    await invalidateAffectedViews([sourceId]);
    await invalidateQueuedPilotDelivery(sourceId);
    await scheduleCorrectionEpisodes(sourceId);
  }
  async function reconcileOpenCorrections() {
    return transaction(async () => {
      const corrections = await db.query(
        "SELECT source_id,min(created_at) AS opened_at FROM pilot_knowledge_corrections WHERE status='open' GROUP BY source_id ORDER BY source_id",
      );
      for (const row of corrections.rows)
        await invalidateOpenCorrection(row.source_id, row.opened_at);
      return corrections.rowCount;
    });
  }
  async function installManifest(input) {
    const value = validateArchiveManifest(input);
    const digest = manifestDigest(value);
    return transaction(async () => {
      const existing = (
        await db.query(
          "SELECT sha256,generation FROM pilot_knowledge_manifests WHERE id=$1 FOR UPDATE",
          [value.id],
        )
      ).rows[0];
      if (existing && (existing.sha256 !== digest || existing.generation !== value.generation))
        throw new Error(
          "Community archive manifest ID already names a different immutable selection",
        );
      if (!existing) {
        await db.query(
          "INSERT INTO pilot_knowledge_manifests(id,sha256,generation,manifest) VALUES($1,$2,$3,$4::jsonb)",
          [value.id, digest, value.generation, jsonb(value)],
        );
        for (const episode of value.episodes) {
          const snapshot = {
            manifestId: value.id,
            manifestGeneration: value.generation,
            ...episode,
          };
          await db.query(
            "INSERT INTO pilot_knowledge_episodes(id,manifest_id,manifest_generation,snapshot,snapshot_digest) VALUES($1,$2,$3,$4::jsonb,$5)",
            [
              `${value.id}:${episode.key}`,
              value.id,
              value.generation,
              jsonb(snapshot),
              sha256(snapshot),
            ],
          );
        }
        await receipt(db, "manifest-installed", {
          manifestId: value.id,
          manifestDigest: digest,
          generation: value.generation,
          episodeCount: value.episodes.length,
        });
      }
      return {
        id: value.id,
        digest,
        generation: value.generation,
        disposition: existing ? "already-installed" : "installed",
      };
    });
  }
  async function bindHistoryProjection({
    manifestId,
    episodeKey,
    historyEpisodeId,
    directSources,
    contextSources,
    archiveAuthority,
    correctionIds = [],
  }) {
    if (
      !identifier(manifestId) ||
      !identifier(episodeKey) ||
      historyEpisodeId !== `${manifestId}:${episodeKey}` ||
      !Array.isArray(directSources) ||
      !Array.isArray(contextSources) ||
      !/^[a-f0-9]{64}$/.test(archiveAuthority ?? "") ||
      !Array.isArray(correctionIds) ||
      correctionIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id)) ||
      new Set(correctionIds).size !== correctionIds.length
    )
      throw new Error("Invalid manifest-bound historical projection binding");
    const installed = await manifest(manifestId);
    const episode = episodeFor(installed.manifest, episodeKey);
    const snapshotRow = (
      await db.query(
        "SELECT snapshot,snapshot_digest FROM pilot_knowledge_episodes WHERE id=$1 AND manifest_id=$2",
        [historyEpisodeId, manifestId],
      )
    ).rows[0];
    if (
      !snapshotRow ||
      installed.generation !== installed.manifest.generation ||
      snapshotRow.snapshot_digest !== sha256(parsed(snapshotRow.snapshot))
    )
      throw new Error("Historical projection manifest snapshot is unavailable or corrupt");
    const selectedDirect = directSources.map((source) => source?.id);
    const selectedContext = contextSources.map((source) => source?.id);
    if (
      JSON.stringify(selectedDirect) !== JSON.stringify(episode.sourceIds) ||
      selectedContext.length !== episode.contextIds.length ||
      episode.contextIds.some((id) => !selectedContext.includes(id)) ||
      new Set([...selectedDirect, ...selectedContext]).size !==
        selectedDirect.length + selectedContext.length
    )
      throw new Error("Historical projection sources differ from the installed episode selection");
    const sources = [
      ...directSources.map((source) => ({ source, role: "direct" })),
      ...contextSources.map((source) => ({ source, role: "context" })),
    ].map(({ source, role }) => ({ source: historicalSourceShape(source, episode), role }));
    for (const { source } of sources) if (source.content.trim()) await registerSource(source);
    const registered = await sourceRows(
      sources.filter(({ source }) => source.content.trim()).map(({ source }) => source.id),
    );
    const sourceBindings = Object.fromEntries(
      sources.map(({ source, role }) => {
        const row = registered.get(source.id);
        return [
          source.id,
          {
            role,
            sourceDigest: sha256(source),
            ...(row
              ? {
                  knowledgeDigest: row.source_digest,
                  revision: row.revision,
                  generation: row.generation,
                  correctionGeneration: row.correction_generation,
                }
              : {
                  knowledgeDigest: null,
                  revision: null,
                  generation: null,
                  correctionGeneration: null,
                }),
          },
        ];
      }),
    );
    return {
      version: 1,
      manifestId,
      manifestDigest: installed.sha256,
      manifestGeneration: installed.generation,
      episodeId: historyEpisodeId,
      episodeDigest: snapshotRow.snapshot_digest,
      archiveConnectionId: installed.manifest.archiveConnectionId,
      archiveAuthorityDigest: archiveAuthority,
      historyEpisodeId,
      sourceIds: [...episode.sourceIds],
      contextIds: [...episode.contextIds],
      sourceDigests: Object.fromEntries(
        sources.map(({ source }) => [source.id, sourceFingerprint(source)]),
      ),
      sourceBindings,
      correctionIds: [...correctionIds],
    };
  }
  async function pendingHistoryDerivations({ limit = 1 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 6)
      throw new Error("Historical derivation batch must be between one and six episodes");
    const rows = (
      await db.query(
        `SELECT e.id AS episode_id,e.manifest_id,e.manifest_generation,e.snapshot,e.snapshot_digest,
          e.derivation_work_id,e.derivation_binding,e.derivation_reason,m.sha256 AS manifest_digest,m.manifest,
          w.history_episode,w.status AS work_status,w.source_ids,w.candidate,w.history_projection,w.created_at AS work_created_at
         FROM pilot_knowledge_episodes e
         JOIN pilot_knowledge_manifests m ON m.id=e.manifest_id
         LEFT JOIN pilot_work w ON w.id=e.derivation_work_id
         WHERE e.derivation_status='pending'
         ORDER BY e.derivation_updated_at,e.id LIMIT $1`,
        [limit],
      )
    ).rows;
    const pending = [];
    for (const row of rows) {
      const binding = parsed(row.derivation_binding);
      const candidate = parsed(row.candidate);
      const checks = {
        doneWork: row.work_status === "done",
        episodeId: row.history_episode === row.episode_id,
        manifestGeneration: row.manifest_generation === row.manifest.generation,
        episodeSnapshot: row.snapshot_digest === sha256(parsed(row.snapshot)),
        manifestDigest: row.manifest_digest === manifestDigest(parsed(row.manifest)),
        bindingVersion: binding?.version === 1,
        workId: binding?.historyWorkId === row.derivation_work_id,
        bindingManifest: binding?.manifestId === row.manifest_id,
        bindingManifestDigest: binding?.manifestDigest === row.manifest_digest,
        bindingManifestGeneration: binding?.manifestGeneration === row.manifest_generation,
        bindingEpisode: binding?.episodeId === row.episode_id,
        bindingEpisodeDigest: binding?.episodeDigest === row.snapshot_digest,
        candidateDigest: binding?.memoryCandidateDigest === canonicalDigest(candidate),
        candidateRevision:
          binding?.memoryCandidateRevision === pilotDigest(candidate?.content ?? ""),
        expectedRevision: binding?.memoryExpectedRevision === (candidate?.expectedRevision ?? null),
        directSourceIds:
          JSON.stringify([...(row.source_ids ?? [])].sort()) ===
          JSON.stringify([...(binding?.sourceIds ?? [])].sort()),
        workBinding: row.history_projection?.historyWorkId === binding?.historyWorkId,
        bindingDigest: sha256(parsed(row.history_projection)) === sha256(binding),
      };
      if (Object.values(checks).some((valid) => !valid)) {
        await completeHistoryDerivation({
          manifestId: row.manifest_id,
          episodeId: row.episode_id,
          workId: row.derivation_work_id,
          status: "stale",
          reason: "durable-work-binding-mismatch",
          detail: {
            failedChecks: Object.entries(checks)
              .filter(([, valid]) => !valid)
              .map(([name]) => name),
          },
        });
        continue;
      }
      pending.push({
        manifestId: row.manifest_id,
        manifest: validateArchiveManifest(parsed(row.manifest)),
        episodeId: row.episode_id,
        episode: parsed(row.snapshot),
        workId: row.derivation_work_id,
        candidate,
        binding,
        createdAt: row.work_created_at,
      });
    }
    return pending;
  }
  async function verifyHistoryProjection(binding, archiveAuthority) {
    if (!binding || binding.version !== 1 || !/^[a-f0-9]{64}$/.test(archiveAuthority ?? ""))
      return { current: false, reason: "invalid-binding" };
    if (binding.archiveAuthorityDigest !== archiveAuthority)
      return { current: false, reason: "archive-authority-changed" };
    const installed = await manifest(binding.manifestId);
    if (
      installed.sha256 !== binding.manifestDigest ||
      installed.generation !== binding.manifestGeneration ||
      installed.manifest.archiveConnectionId !== binding.archiveConnectionId
    )
      return { current: false, reason: "manifest-changed" };
    const snapshot = (
      await db.query(
        "SELECT snapshot_digest,derivation_status,derivation_work_id FROM pilot_knowledge_episodes WHERE id=$1 AND manifest_id=$2",
        [binding.episodeId, binding.manifestId],
      )
    ).rows[0];
    if (
      !snapshot ||
      snapshot.snapshot_digest !== binding.episodeDigest ||
      snapshot.derivation_status !== "pending" ||
      snapshot.derivation_work_id !== binding.historyWorkId
    )
      return { current: false, reason: "episode-binding-changed" };
    const currentSources = await db.query(
      "SELECT id,source_digest,revision,generation,correction_generation,deleted FROM pilot_knowledge_sources WHERE id=ANY($1::text[])",
      [Object.keys(binding.sourceBindings)],
    );
    const byId = new Map(currentSources.rows.map((row) => [row.id, row]));
    for (const [id, expected] of Object.entries(binding.sourceBindings)) {
      const row = byId.get(id);
      if (!expected.knowledgeDigest) {
        if (row && !row.deleted) return { current: false, reason: "source-registration-changed" };
      } else if (
        !row ||
        row.deleted ||
        row.source_digest !== expected.knowledgeDigest ||
        row.revision !== expected.revision ||
        row.generation !== expected.generation ||
        row.correction_generation !== expected.correctionGeneration
      ) {
        return { current: false, reason: "source-or-correction-revision-changed" };
      }
    }
    return { current: true };
  }
  async function completeHistoryDerivation({
    manifestId,
    episodeId,
    workId,
    status,
    reason,
    detail = {},
  }) {
    if (
      !identifier(manifestId) ||
      typeof episodeId !== "string" ||
      episodeId.length > 160 ||
      !episodeId.startsWith(`${manifestId}:`) ||
      !/^[0-9a-f-]{36}$/i.test(workId ?? "") ||
      !["derived", "stale", "excluded"].includes(status) ||
      !text(reason, 120) ||
      !detail ||
      typeof detail !== "object" ||
      Array.isArray(detail)
    )
      throw new Error("Invalid historical derivation outcome");
    return transaction(async () => {
      const row = (
        await db.query(
          "SELECT derivation_status,derivation_work_id,derivation_binding FROM pilot_knowledge_episodes WHERE id=$1 AND manifest_id=$2 FOR UPDATE",
          [episodeId, manifestId],
        )
      ).rows[0];
      if (!row) return { disposition: "missing", manifestId, episodeId };
      if (row.derivation_status === status && row.derivation_work_id === workId)
        return { disposition: "already-recorded", status, manifestId, episodeId };
      if (row.derivation_status !== "pending" || row.derivation_work_id !== workId)
        return { disposition: "superseded", status: row.derivation_status, manifestId, episodeId };
      await db.query(
        "UPDATE pilot_knowledge_episodes SET derivation_status=$3,derivation_reason=$4,derivation_updated_at=clock_timestamp() WHERE id=$1 AND manifest_id=$2",
        [episodeId, manifestId, status, reason],
      );
      const binding = parsed(row.derivation_binding);
      await receipt(db, "history-derivation-outcome", {
        manifestId,
        episodeId,
        workId,
        status,
        reason,
        manifestDigest: binding.manifestDigest,
        episodeDigest: binding.episodeDigest,
        memoryCandidateDigest: binding.memoryCandidateDigest,
        sourceCount: Object.keys(binding.sourceBindings ?? {}).length,
        detail,
      });
      return { disposition: "recorded", status, manifestId, episodeId };
    });
  }
  async function staleHistoryDerivations(sourceIds, reason, status = "stale") {
    if (
      !Array.isArray(sourceIds) ||
      !sourceIds.length ||
      sourceIds.some((id) => !snowflake(id)) ||
      !["stale", "excluded"].includes(status) ||
      !text(reason, 120)
    )
      throw new Error("Invalid historical derivation invalidation");
    const changed = await db.query(
      `UPDATE pilot_knowledge_episodes SET derivation_status=$2,derivation_reason=$3,
       derivation_updated_at=clock_timestamp()
       WHERE derivation_status IN ('pending','derived')
         AND (derivation_binding->'sourceIds' ?| $1::text[] OR derivation_binding->'contextIds' ?| $1::text[])`,
      [sourceIds, status, reason],
    );
    return changed.rowCount;
  }
  async function rebuild(target, key) {
    const history = target === "history" ? historyViewParts(key) : null;
    if (
      (target === "profile" && !snowflake(key)) ||
      (target === "topic" && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) ||
      (target === "history" && !history) ||
      !["profile", "topic", "history"].includes(target)
    )
      throw new Error("Invalid community knowledge view key");
    const rows = (
      await db.query(
        `SELECT a.id,a.revision,a.episode_id,a.candidate,a.created_at,e.snapshot AS episode,s.id AS source_id,s.revision AS source_revision,s.source
       FROM pilot_knowledge_annotations a
       JOIN pilot_knowledge_sources s ON s.id=ANY(a.source_ids)
       JOIN pilot_knowledge_episodes e ON e.id=a.episode_id
       WHERE a.status='candidate' AND NOT s.deleted
       ORDER BY a.created_at,a.id,a.revision,s.id`,
      )
    ).rows;
    const annotations = new Map();
    for (const row of rows) {
      const candidate = validateAnnotation(parsed(row.candidate));
      const matches =
        target === "profile"
          ? candidate.subjectIds.includes(key)
          : target === "topic"
            ? candidate.topics.includes(key)
            : candidate.subjectIds.includes(history.memberId) &&
              candidate.topics.includes(history.topic);
      if (!matches) continue;
      const annotationKey = `${row.id}:${row.revision}`;
      const entry = annotations.get(annotationKey) ?? {
        annotationId: row.id,
        annotationRevision: row.revision,
        episodeKey: row.episode_id.slice(row.episode_id.lastIndexOf(":") + 1),
        interpretation: candidate.interpretation,
        kind: candidate.kind ?? null,
        subjectIds: candidate.subjectIds,
        topics: candidate.topics,
        qualifications: candidate.qualifications,
        uncertainty: candidate.uncertainty,
        competingWith: candidate.competingWith,
        claims: candidate.claims ?? [],
        supersedes: candidate.supersedes ?? null,
        processingVersion: candidate.processingVersion,
        createdAt: row.created_at.toISOString(),
        sources: [],
        contextSources: [],
        replyBoundaries: [],
      };
      const source = parsed(row.source);
      const replyTo = source.replyTo ?? null;
      const episode = parsed(row.episode);
      const selectedEpisodeSources = new Set([...episode.sourceIds, ...episode.contextIds]);
      const replyStatus = !replyTo
        ? "not-needed"
        : candidate.sourceIds.includes(replyTo)
          ? "direct-evidence"
          : candidate.contextSourceIds?.includes(replyTo)
            ? "included-context"
            : selectedEpisodeSources.has(replyTo)
              ? "selected-parent-not-bound"
              : "outside-selected-slice";
      const sourcePacket = {
        sourceId: row.source_id,
        sourceRevision: row.source_revision,
        authorId: source.authorId,
        exactQuote: source.content,
        quoteSpans: (candidate.sourceQuotes ?? [])
          .filter((quote) => quote.sourceId === row.source_id)
          .map((quote) => quote.quote),
        canonicalPermalink: source.url,
        createdAt: source.createdAt,
        ...(replyTo
          ? {
              replyTo,
              replyBoundary: {
                status: replyStatus,
                sourceId: replyTo,
                canonicalPermalink: `https://discord.com/channels/${source.guildId}/${source.channelId}/${replyTo}`,
              },
            }
          : {}),
      };
      if (candidate.sourceIds.includes(row.source_id)) entry.sources.push(sourcePacket);
      else entry.contextSources.push(sourcePacket);
      if (replyTo)
        entry.replyBoundaries.push({
          childSourceId: row.source_id,
          parentSourceId: replyTo,
          status: replyStatus,
          dependencyRecorded: candidate.contextSourceIds?.includes(replyTo) ?? false,
          canonicalPermalink: `https://discord.com/channels/${source.guildId}/${source.channelId}/${replyTo}`,
        });
      annotations.set(annotationKey, entry);
    }
    const entries = [...annotations.values()];
    if (target === "history") {
      const earliestSourceTime = (entry) =>
        entry.sources.reduce((earliest, source) => {
          const time = Date.parse(source.createdAt);
          return Number.isFinite(time) && time < earliest ? time : earliest;
        }, Number.POSITIVE_INFINITY);
      entries.sort(
        (left, right) =>
          earliestSourceTime(left) - earliestSourceTime(right) ||
          left.annotationId.localeCompare(right.annotationId) ||
          left.annotationRevision - right.annotationRevision,
      );
    }
    const document = {
      target,
      key,
      status: "candidate interpretations with cited current sources",
      entries,
    };
    const documentDigest = sha256(document);
    return transaction(async () => {
      const existing = (
        await db.query(
          "SELECT * FROM pilot_knowledge_views WHERE target=$1 AND key=$2 FOR UPDATE",
          [target, key],
        )
      ).rows[0];
      if (existing?.document_digest === documentDigest)
        return { revision: existing.revision, document, changed: false };
      const revision = (existing?.revision ?? 0) + 1;
      await db.query(
        `INSERT INTO pilot_knowledge_views(target,key,revision,document,document_digest) VALUES($1,$2,$3,$4::jsonb,$5)
         ON CONFLICT(target,key) DO UPDATE SET revision=excluded.revision,document=excluded.document,document_digest=excluded.document_digest,updated_at=clock_timestamp()`,
        [target, key, revision, jsonb(document), documentDigest],
      );
      return { revision, document, changed: true };
    });
  }
  const viewKeys = (candidate) => {
    const profiles = candidate.subjectIds.map((key) => ["profile", key]);
    const topics = candidate.topics.map((key) => ["topic", key]);
    const histories = candidate.subjectIds.flatMap((memberId) =>
      candidate.topics.map((topic) => ["history", historyViewKey(memberId, topic)]),
    );
    return [...profiles, ...topics, ...histories];
  };
  async function invalidateViewKeys(keys) {
    for (const [target, key] of new Map(
      keys.map(([target, key]) => [`${target}:${key}`, [target, key]]),
    ).values())
      await db.query(
        "UPDATE pilot_knowledge_views SET revision=revision+1,updated_at=clock_timestamp() WHERE target=$1 AND key=$2",
        [target, key],
      );
  }
  async function invalidateAffectedViews(ids) {
    const rows = (
      await db.query(
        "SELECT candidate FROM pilot_knowledge_annotations WHERE source_ids && $1::text[]",
        [ids],
      )
    ).rows;
    await invalidateViewKeys(
      rows.flatMap((row) => viewKeys(validateAnnotation(parsed(row.candidate)))),
    );
  }
  async function rebuildAffected(ids) {
    const rows = (
      await db.query(
        "SELECT DISTINCT candidate FROM pilot_knowledge_annotations WHERE source_ids && $1::text[]",
        [ids],
      )
    ).rows;
    const profiles = new Set();
    const topics = new Set();
    const histories = new Set();
    for (const row of rows) {
      const candidate = validateAnnotation(parsed(row.candidate));
      candidate.subjectIds.forEach((id) => profiles.add(id));
      candidate.topics.forEach((topic) => topics.add(topic));
      for (const memberId of candidate.subjectIds)
        for (const topic of candidate.topics) histories.add(historyViewKey(memberId, topic));
    }
    for (const key of profiles) await rebuild("profile", key);
    for (const key of topics) await rebuild("topic", key);
    for (const key of histories) await rebuild("history", key);
  }
  async function registerSource(input) {
    const source = sourceShape(input);
    const sourceDigest = sha256(source);
    const result = await transaction(async () => {
      const current = (
        await db.query("SELECT * FROM pilot_knowledge_sources WHERE id=$1 FOR UPDATE", [source.id])
      ).rows[0];
      if (current && parsed(current.source).authorId !== source.authorId)
        throw new Error("Community source correction cannot change author");
      if (current?.source_digest === sourceDigest && !current.deleted)
        return {
          changed: false,
          id: source.id,
          revision: current.revision,
          generation: current.generation,
        };
      const revision = (current?.revision ?? 0) + 1;
      const generation = (current?.generation ?? 0) + 1;
      await db.query(
        `INSERT INTO pilot_knowledge_sources(id,source,source_digest,revision,generation,deleted) VALUES($1,$2::jsonb,$3,$4,$5,false)
         ON CONFLICT(id) DO UPDATE SET source=excluded.source,source_digest=excluded.source_digest,revision=excluded.revision,generation=excluded.generation,deleted=false,updated_at=clock_timestamp()`,
        [source.id, jsonb(source), sourceDigest, revision, generation],
      );
      await db.query(
        "INSERT INTO pilot_knowledge_source_revisions(source_id,revision,source,source_digest) VALUES($1,$2,$3::jsonb,$4)",
        [source.id, revision, jsonb(source), sourceDigest],
      );
      if (current) {
        await db.query(
          "UPDATE pilot_knowledge_jobs SET status='stale' WHERE status='prepared' AND source_ids && ARRAY[$1]",
          [source.id],
        );
        await db.query(
          "UPDATE pilot_knowledge_annotations SET status='invalidated' WHERE status='candidate' AND source_ids && ARRAY[$1]",
          [source.id],
        );
        const requeued = await db.query(
          "UPDATE pilot_knowledge_jobs SET status='requeued' WHERE status='committed' AND effective AND source_ids && ARRAY[$1] RETURNING id",
          [source.id],
        );
        await invalidateAffectedViews([source.id]);
        await staleHistoryDerivations([source.id], "selected-source-edited");
        await receipt(db, "source-corrected", {
          sourceId: source.id,
          previousGeneration: current.generation,
          generation,
          revision,
          requeuedJobCount: requeued.rowCount,
        });
      }
      return { changed: true, id: source.id, revision, generation };
    });
    if (result.changed) await rebuildAffected([source.id]);
    return result;
  }
  async function removeSource(id) {
    if (!snowflake(id)) throw new Error("Invalid community knowledge source ID");
    const changed = await transaction(async () => {
      const current = (
        await db.query("SELECT * FROM pilot_knowledge_sources WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!current || current.deleted) return false;
      await db.query(
        "UPDATE pilot_knowledge_sources SET deleted=true,generation=generation+1,updated_at=clock_timestamp() WHERE id=$1",
        [id],
      );
      await db.query(
        "UPDATE pilot_knowledge_jobs SET status='stale' WHERE status='prepared' AND source_ids && ARRAY[$1]",
        [id],
      );
      await db.query(
        "UPDATE pilot_knowledge_annotations SET status='invalidated' WHERE status='candidate' AND source_ids && ARRAY[$1]",
        [id],
      );
      const requeued = await db.query(
        "UPDATE pilot_knowledge_jobs SET status='requeued' WHERE status='committed' AND effective AND source_ids && ARRAY[$1] RETURNING id",
        [id],
      );
      await invalidateAffectedViews([id]);
      await staleHistoryDerivations([id], "selected-source-deleted", "excluded");
      await receipt(db, "source-deleted", {
        sourceId: id,
        generation: current.generation + 1,
        requeuedJobCount: requeued.rowCount,
      });
      return true;
    });
    if (changed) await rebuildAffected([id]);
    return changed;
  }
  async function prepareAnnotation({ manifestId, episodeKey, candidate }) {
    let annotation = validateAnnotation(candidate);
    return transaction(async () => {
      const entry = await manifest(manifestId, true);
      const episode = episodeFor(entry.manifest, episodeKey);
      const allowed = new Set([...episode.sourceIds, ...episode.contextIds]);
      if (
        [...annotation.sourceIds, ...(annotation.contextSourceIds ?? [])].some(
          (id) => !allowed.has(id),
        ) ||
        !annotation.sourceIds.some((id) => episode.sourceIds.includes(id))
      )
        throw new Error("Community annotation must cite the manifest episode targets");
      const directSources = await sourceRows(annotation.sourceIds, true);
      const directIds = new Set(annotation.sourceIds);
      const contextIds = new Set(annotation.contextSourceIds ?? []);
      for (const row of directSources.values()) {
        const parentId = row.source.replyTo;
        if (parentId && allowed.has(parentId) && !directIds.has(parentId)) contextIds.add(parentId);
      }
      if (contextIds.size !== (annotation.contextSourceIds ?? []).length)
        annotation = validateAnnotation({ ...annotation, contextSourceIds: [...contextIds] });
      const dependencySourceIds = [...annotation.sourceIds, ...(annotation.contextSourceIds ?? [])];
      const sources = await sourceRows(dependencySourceIds, true);
      if (
        [...sources.values()].some(
          (row) =>
            row.source.guildId !== episode.guildId || row.source.channelId !== episode.channelId,
        )
      )
        throw new Error("Community annotation source is outside the manifest episode channel");
      for (const claim of annotation.claims ?? [])
        for (const anchor of claim.anchors) {
          const source = sources.get(anchor.sourceId)?.source;
          if (
            !source ||
            !source.content.includes(anchor.quote) ||
            source.authorId !== anchor.attributedTo ||
            (anchor.relation === "context" &&
              !annotation.contextSourceIds?.includes(anchor.sourceId))
          )
            throw new Error(
              "Community claim evidence does not match its source, attribution or context role",
            );
        }
      const correctedSources = await openCorrectionSources(dependencySourceIds, true);
      if (correctedSources.size && !annotation.supersedes && !annotation.competingWith.length) {
        const previous = (
          await db.query(
            `SELECT candidate_digest FROM pilot_knowledge_annotations
             WHERE (id=$1 OR (status='invalidated' AND source_ids && $2::text[]))
             ORDER BY CASE WHEN id=$1 THEN 0 ELSE 1 END,revision DESC LIMIT 1 FOR UPDATE`,
            [annotation.id ?? null, [...correctedSources]],
          )
        ).rows[0];
        if (!previous)
          throw new Error(
            "An open correction requires an explicit revised or competing interpretation",
          );
        // A completed source revalidation may affirm unchanged wording. Its new
        // correction generation fences stale work even when the model gives the
        // re-derived source-bound interpretation a different memory key.
      }
      const sourceGenerations = Object.fromEntries(
        [...sources].map(([id, row]) => [id, row.generation]),
      );
      const sourceRevisions = Object.fromEntries(
        [...sources].map(([id, row]) => [id, row.revision]),
      );
      const correctionGenerations = Object.fromEntries(
        [...sources].map(([id, row]) => [id, row.correction_generation]),
      );
      const annotationId = annotation.id ?? randomUUID().replaceAll("-", "");
      const previous = (
        await db.query(
          "SELECT revision FROM pilot_knowledge_annotations WHERE id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE",
          [annotationId],
        )
      ).rows[0];
      const expectedAnnotationRevision = previous?.revision ?? 0;
      const logicalKey = sha256({
        manifestId,
        manifestGeneration: entry.generation,
        episodeId: `${manifestId}:${episodeKey}`,
        annotationId,
        expectedAnnotationRevision,
        sourceIds: dependencySourceIds,
        sourceGenerations,
        sourceRevisions,
        correctionGenerations,
        candidate: annotation,
      });
      const work = {
        id: randomUUID(),
        manifestId,
        manifestGeneration: entry.generation,
        episodeId: `${manifestId}:${episodeKey}`,
        sourceIds: dependencySourceIds,
        sourceGenerations,
        sourceRevisions,
        correctionGenerations,
        annotationId,
        expectedAnnotationRevision,
        logicalKey,
        candidate: annotation,
      };
      work.inputDigest = sha256(work);
      const inserted = await db.query(
        "INSERT INTO pilot_knowledge_jobs(id,manifest_id,episode_id,source_ids,source_generations,source_revisions,correction_generations,candidate,input_digest,logical_key,annotation_id,expected_annotation_revision,status) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,'prepared') ON CONFLICT DO NOTHING RETURNING id",
        [
          work.id,
          work.manifestId,
          work.episodeId,
          work.sourceIds,
          jsonb(work.sourceGenerations),
          jsonb(work.sourceRevisions),
          jsonb(work.correctionGenerations),
          jsonb(work.candidate),
          work.inputDigest,
          work.logicalKey,
          work.annotationId,
          work.expectedAnnotationRevision,
        ],
      );
      if (inserted.rowCount) return work;
      const existing = (
        await db.query(
          "SELECT * FROM pilot_knowledge_jobs WHERE logical_key=$1 AND status='prepared' FOR UPDATE",
          [logicalKey],
        )
      ).rows[0];
      if (!existing)
        throw new Error("Community annotation admission conflict changed before retry");
      return {
        id: existing.id,
        manifestId: existing.manifest_id,
        manifestGeneration: entry.generation,
        episodeId: existing.episode_id,
        sourceIds: existing.source_ids,
        sourceGenerations: parsed(existing.source_generations),
        sourceRevisions: parsed(existing.source_revisions),
        correctionGenerations: parsed(existing.correction_generations),
        annotationId: existing.annotation_id,
        expectedAnnotationRevision: existing.expected_annotation_revision,
        logicalKey: existing.logical_key,
        candidate: parsed(existing.candidate),
        inputDigest: existing.input_digest,
      };
    });
  }
  async function commitAnnotation(work) {
    let result;
    let affectedViewKeys = [];
    await transaction(async () => {
      const job = (
        await db.query("SELECT * FROM pilot_knowledge_jobs WHERE id=$1 FOR UPDATE", [work?.id])
      ).rows[0];
      const stale = async (reason) => {
        if (job?.status === "prepared")
          await db.query(
            "UPDATE pilot_knowledge_jobs SET status='stale',completed_at=clock_timestamp() WHERE id=$1",
            [job.id],
          );
        await receipt(db, "stale-worker-result", {
          workId: work?.id ?? null,
          reason,
          manifestId: work?.manifestId ?? null,
        });
        result = { disposition: "stale-source" };
      };
      if (!job || job.status !== "prepared") return stale("job-not-prepared");
      const candidate = validateAnnotation(work.candidate);
      const expected = {
        id: work.id,
        manifestId: work.manifestId,
        manifestGeneration: work.manifestGeneration,
        episodeId: work.episodeId,
        sourceIds: work.sourceIds,
        sourceGenerations: work.sourceGenerations,
        sourceRevisions: work.sourceRevisions,
        correctionGenerations: work.correctionGenerations,
        annotationId: work.annotationId,
        expectedAnnotationRevision: work.expectedAnnotationRevision,
        logicalKey: work.logicalKey,
        candidate,
      };
      if (work.inputDigest !== sha256(expected) || job.input_digest !== work.inputDigest)
        return stale("work-digest");
      const currentManifest = await manifest(work.manifestId, true);
      if (currentManifest.generation !== work.manifestGeneration)
        return stale("manifest-generation");
      const sources = await sourceRows(work.sourceIds, true).catch(() => null);
      if (
        !sources ||
        [...sources].some(
          ([id, row]) =>
            row.generation !== work.sourceGenerations[id] ||
            row.revision !== work.sourceRevisions[id] ||
            row.correction_generation !== work.correctionGenerations?.[id],
        )
      )
        return stale("source-generation");
      const annotationId = work.annotationId ?? candidate.id ?? work.id.replaceAll("-", "");
      const previous = (
        await db.query(
          "SELECT revision,candidate,candidate_digest,status FROM pilot_knowledge_annotations WHERE id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE",
          [annotationId],
        )
      ).rows[0];
      if ((previous?.revision ?? 0) !== work.expectedAnnotationRevision)
        return stale("annotation-predecessor");
      if (previous?.candidate_digest === sha256(candidate) && previous.status === "candidate") {
        await db.query(
          "UPDATE pilot_knowledge_jobs SET status='committed',effective=false,completed_at=clock_timestamp() WHERE id=$1",
          [work.id],
        );
        await receipt(db, "annotation-already-current", {
          workId: work.id,
          annotationId,
          revision: previous.revision,
          manifestId: work.manifestId,
        });
        result = { disposition: "already-applied", annotationId, revision: previous.revision };
        return;
      }
      const revision = (previous?.revision ?? 0) + 1;
      const invalidatedCandidates =
        previous?.status === "candidate" ? [validateAnnotation(parsed(previous.candidate))] : [];
      if (previous?.status === "candidate")
        await db.query(
          "UPDATE pilot_knowledge_annotations SET status='superseded' WHERE id=$1 AND revision=$2 AND status='candidate'",
          [annotationId, previous.revision],
        );
      if (candidate.supersedes)
        for (const row of (
          await db.query(
            "UPDATE pilot_knowledge_annotations SET status='superseded' WHERE id=$1 AND status='candidate' RETURNING candidate",
            [candidate.supersedes],
          )
        ).rows)
          invalidatedCandidates.push(validateAnnotation(parsed(row.candidate)));
      await db.query(
        "INSERT INTO pilot_knowledge_annotations(id,revision,manifest_id,episode_id,source_ids,candidate,candidate_digest,status) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,'candidate')",
        [
          annotationId,
          revision,
          work.manifestId,
          work.episodeId,
          work.sourceIds,
          jsonb(candidate),
          sha256(candidate),
        ],
      );
      await db.query(
        "UPDATE pilot_knowledge_jobs SET status='committed',completed_at=clock_timestamp() WHERE id=$1",
        [work.id],
      );
      affectedViewKeys = [...viewKeys(candidate), ...invalidatedCandidates.flatMap(viewKeys)];
      await invalidateViewKeys(affectedViewKeys);
      await receipt(db, "annotation-committed", {
        workId: work.id,
        annotationId,
        revision,
        manifestId: work.manifestId,
        sourceIds: work.sourceIds,
      });
      result = { disposition: "applied", annotationId, revision };
    });
    if (["applied", "already-applied"].includes(result.disposition)) {
      for (const [target, key] of affectedViewKeys.length
        ? affectedViewKeys
        : viewKeys(validateAnnotation(work.candidate)))
        await rebuild(target, key);
    }
    return result;
  }
  async function prepareExport({ target, key }) {
    const view = await rebuild(target, key);
    return {
      target,
      key,
      viewRevision: view.revision,
      document: view.document,
      documentDigest: sha256(view.document),
    };
  }
  async function commitExport(prepared) {
    return transaction(async () => {
      const current = (
        await db.query(
          "SELECT * FROM pilot_knowledge_views WHERE target=$1 AND key=$2 FOR UPDATE",
          [prepared?.target, prepared?.key],
        )
      ).rows[0];
      if (
        !current ||
        current.revision !== prepared?.viewRevision ||
        current.document_digest !== prepared?.documentDigest ||
        sha256(prepared?.document) !== prepared?.documentDigest
      ) {
        await receipt(db, "stale-export", {
          target: prepared?.target ?? null,
          key: prepared?.key ?? null,
          preparedViewRevision: prepared?.viewRevision ?? null,
          currentViewRevision: current?.revision ?? null,
        });
        return { disposition: "stale-view" };
      }
      await db.query(
        `INSERT INTO pilot_knowledge_exports(target,key,view_revision,document) VALUES($1,$2,$3,$4::jsonb)
         ON CONFLICT(target,key) DO UPDATE SET view_revision=excluded.view_revision,document=excluded.document,exported_at=clock_timestamp()`,
        [prepared.target, prepared.key, prepared.viewRevision, jsonb(prepared.document)],
      );
      return { disposition: "exported" };
    });
  }
  async function view(target, key) {
    return (await rebuild(target, key)).document;
  }
  async function correct(command) {
    if (
      !command ||
      command.route !== "correct" ||
      !snowflake(command.guildId) ||
      !snowflake(command.channelId) ||
      !snowflake(command.sourceId) ||
      !text(command.note, 800) ||
      (command.reviewOrigin !== undefined && command.reviewOrigin !== "private-operator") ||
      (command.reviewOrigin === "private-operator" &&
        (command.reporterId !== undefined || command.reporterSourceId !== undefined)) ||
      (command.reporterId !== undefined && !snowflake(command.reporterId)) ||
      (command.reporterSourceId !== undefined &&
        (!snowflake(command.reporterSourceId) || !snowflake(command.reporterId)))
    )
      throw new Error("Invalid community correction command");
    let result;
    await transaction(async () => {
      const source = (
        await db.query(
          "SELECT source,revision,deleted,correction_generation FROM pilot_knowledge_sources WHERE id=$1 FOR UPDATE",
          [command.sourceId],
        )
      ).rows[0];
      if (!source || source.deleted) {
        result = { disposition: "source-unavailable" };
        return;
      }
      const current = parsed(source.source);
      if (current.guildId !== command.guildId || current.channelId !== command.channelId) {
        result = { disposition: "source-unavailable" };
        return;
      }
      if (command.reporterSourceId !== undefined) {
        const reporter = (await sourceRows([command.reporterSourceId], true)).get(
          command.reporterSourceId,
        ).source;
        const reported = parseKnowledgeCommand(reporter.content);
        if (
          reporter.guildId !== command.guildId ||
          reporter.authorId !== command.reporterId ||
          !reported ||
          reported.route !== "correct" ||
          reported.sourceId !== command.sourceId ||
          reported.note !== command.note
        )
          throw new Error("Correction reporter source does not match the requested review");
      }
      const noteDigest = sha256(command.note);
      let correction = (
        await db.query(
          "SELECT id,status,review_origin,reporter_source_id FROM pilot_knowledge_corrections WHERE source_id=$1 AND note_digest=$2 FOR UPDATE",
          [command.sourceId, noteDigest],
        )
      ).rows[0];
      const requestedOrigin = command.reviewOrigin ?? "discord";
      if (correction) {
        if (correction.status !== "open") {
          result = {
            disposition: "already-resolved",
            status: correction.status,
            sourceId: command.sourceId,
          };
          return;
        }
        if (
          correction.review_origin !== requestedOrigin ||
          (correction.reporter_source_id ?? null) !== (command.reporterSourceId ?? null)
        ) {
          result = { disposition: "origin-conflict", sourceId: command.sourceId };
          return;
        }
        result = {
          disposition: "already-open",
          correctionId: correction.id,
          sourceId: command.sourceId,
        };
        return;
      }
      if (!correction)
        correction = (
          await db.query(
            "INSERT INTO pilot_knowledge_corrections(id,source_id,source_revision,note_digest,status,review_origin,review_note) VALUES($1,$2,$3,$4,'open',$5,$6) RETURNING id",
            [
              randomUUID(),
              command.sourceId,
              source.revision,
              noteDigest,
              requestedOrigin,
              command.reviewOrigin === "private-operator" ? command.note.trim() : null,
            ],
          )
        ).rows[0];
      await db.query(
        "UPDATE pilot_knowledge_sources SET correction_generation=correction_generation+1,updated_at=clock_timestamp() WHERE id=$1",
        [command.sourceId],
      );
      await staleHistoryDerivations([command.sourceId], "correction-generation-changed");
      await db.query(
        "UPDATE pilot_knowledge_jobs SET status='stale',completed_at=clock_timestamp() WHERE status='prepared' AND source_ids && ARRAY[$1]",
        [command.sourceId],
      );
      const invalidated = await db.query(
        "UPDATE pilot_knowledge_annotations SET status='invalidated' WHERE status='candidate' AND source_ids && ARRAY[$1] RETURNING id",
        [command.sourceId],
      );
      await invalidateAffectedViews([command.sourceId]);
      await db.query(
        "UPDATE pilot_knowledge_corrections SET reporter_id=COALESCE(reporter_id,$2),reporter_source_id=COALESCE(reporter_source_id,$3),affected_annotation_ids=CASE WHEN jsonb_array_length(affected_annotation_ids)=0 THEN $4::jsonb ELSE affected_annotation_ids END WHERE id=$1",
        [
          correction.id,
          command.reporterId ?? null,
          command.reporterSourceId ?? null,
          jsonb(invalidated.rows.map((row) => row.id)),
        ],
      );
      const requeued = await db.query(
        "UPDATE pilot_knowledge_jobs SET status='requeued' WHERE status='committed' AND effective AND source_ids && ARRAY[$1] RETURNING id",
        [command.sourceId],
      );
      await invalidateQueuedPilotDelivery(command.sourceId);
      const queuedEpisodes = await scheduleCorrectionEpisodes(command.sourceId);
      await receipt(db, "correction-opened", {
        correctionId: correction.id,
        sourceId: command.sourceId,
        sourceRevision: source.revision,
        correctionGeneration: source.correction_generation + 1,
        noteDigest,
        reporterId: command.reporterId ?? null,
        reporterSourceId: command.reporterSourceId ?? null,
        reviewOrigin: requestedOrigin,
        affectedAnnotationIds: invalidated.rows.map((row) => row.id),
        invalidatedAnnotationCount: invalidated.rowCount,
        requeuedJobCount: requeued.rowCount,
        queuedEpisodeIds: queuedEpisodes,
      });
      result = {
        disposition: "correction-opened",
        correctionId: correction.id,
        sourceId: command.sourceId,
        invalidatedAnnotationCount: invalidated.rowCount,
        queuedEpisodeIds: queuedEpisodes,
      };
    });
    if (result.disposition === "correction-opened") await rebuildAffected([command.sourceId]);
    return result;
  }
  async function resolveCorrection(input) {
    if (
      !input ||
      typeof input !== "object" ||
      !/^[0-9a-f-]{36}$/i.test(input.correctionId ?? "") ||
      !["accepted", "competing", "reaffirmed", "rejected"].includes(input.disposition) ||
      (input.annotationId !== undefined && !identifier(input.annotationId)) ||
      (["accepted", "competing", "reaffirmed"].includes(input.disposition) && !input.annotationId)
    )
      throw new Error("Invalid community correction resolution");
    let result;
    await transaction(async () => {
      const correction = (
        await db.query("SELECT * FROM pilot_knowledge_corrections WHERE id=$1 FOR UPDATE", [
          input.correctionId,
        ])
      ).rows[0];
      if (!correction) throw new Error("Unknown community correction");
      if (correction.status !== "open") {
        result = { disposition: "already-resolved", status: correction.status };
        return;
      }
      if (input.annotationId) {
        const annotation = (
          await db.query(
            "SELECT source_ids,status FROM pilot_knowledge_annotations WHERE id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE",
            [input.annotationId],
          )
        ).rows[0];
        if (
          !annotation ||
          annotation.status !== "candidate" ||
          !annotation.source_ids.includes(correction.source_id)
        )
          throw new Error("Correction resolution requires a current dependent interpretation");
      }
      await db.query(
        "UPDATE pilot_knowledge_corrections SET status=$2,resolution_annotation_id=$3,resolved_at=clock_timestamp() WHERE id=$1",
        [input.correctionId, input.disposition, input.annotationId ?? null],
      );
      await receipt(db, "correction-resolved", {
        correctionId: correction.id,
        sourceId: correction.source_id,
        disposition: input.disposition,
        annotationId: input.annotationId ?? null,
      });
      result = { disposition: "resolved", status: input.disposition };
    });
    return result;
  }
  async function completeCorrectionReviews({
    manifestId,
    episodeKey,
    candidates,
    outcomes,
    correctionIds,
  }) {
    if (
      !identifier(manifestId) ||
      !identifier(episodeKey) ||
      !Array.isArray(candidates) ||
      !Array.isArray(outcomes) ||
      candidates.length !== outcomes.length ||
      !Array.isArray(correctionIds) ||
      correctionIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id)) ||
      new Set(correctionIds).size !== correctionIds.length
    )
      throw new Error("Invalid community correction review completion");
    const completed = [];
    const completedIds = new Set();
    for (let index = 0; index < candidates.length; index++) {
      const candidate = validateAnnotation(candidates[index]);
      const outcome = outcomes[index];
      if (!["applied", "already-applied"].includes(outcome?.disposition) || !outcome.annotationId)
        continue;
      const corrections = (
        await db.query(
          `SELECT id,affected_annotation_ids FROM pilot_knowledge_corrections
           WHERE status='open' AND id=ANY($1::uuid[])
             AND source_id=ANY($2::text[])`,
          [correctionIds, candidate.sourceIds],
        )
      ).rows;
      for (const correction of corrections) {
        if (completedIds.has(correction.id)) continue;
        const previous = (
          await db.query(
            `SELECT candidate FROM pilot_knowledge_annotations
             WHERE id=ANY($1::text[]) AND status='invalidated'
             ORDER BY revision DESC LIMIT 1`,
            [parsed(correction.affected_annotation_ids)],
          )
        ).rows[0];
        const prior = previous && validateAnnotation(parsed(previous.candidate));
        const reaffirmed =
          prior &&
          prior.interpretation === candidate.interpretation &&
          JSON.stringify(prior.qualifications) === JSON.stringify(candidate.qualifications) &&
          JSON.stringify(prior.sourceIds) === JSON.stringify(candidate.sourceIds);
        const resolution = await resolveCorrection({
          correctionId: correction.id,
          disposition: reaffirmed ? "reaffirmed" : "accepted",
          annotationId: outcome.annotationId,
        });
        completed.push({ correctionId: correction.id, status: resolution.status });
        completedIds.add(correction.id);
      }
    }
    return completed;
  }
  async function completePrivateOperatorReviews({ manifestId, episodeKey, candidates, outcomes }) {
    if (!Array.isArray(candidates)) throw new Error("Invalid private operator review completion");
    const sourceIds = [
      ...new Set(candidates.flatMap((candidate) => validateAnnotation(candidate).sourceIds)),
    ];
    const correctionIds = (
      await db.query(
        `SELECT id FROM pilot_knowledge_corrections
         WHERE status='open' AND review_origin='private-operator' AND source_id=ANY($1::text[])`,
        [sourceIds],
      )
    ).rows.map((row) => row.id);
    return completeCorrectionReviews({
      manifestId,
      episodeKey,
      candidates,
      outcomes,
      correctionIds,
    });
  }
  async function receipts() {
    return (
      await db.query("SELECT id,kind,detail,created_at FROM pilot_knowledge_receipts ORDER BY id")
    ).rows.map((row) => ({ ...row, detail: parsed(row.detail) }));
  }
  async function requeuedJobs(manifestId) {
    if (manifestId !== undefined && !identifier(manifestId))
      throw new Error("Invalid community knowledge manifest ID");
    return (
      await db.query(
        `SELECT id,manifest_id,episode_id,source_ids,created_at FROM pilot_knowledge_jobs
         WHERE status='requeued'${manifestId === undefined ? "" : " AND manifest_id=$1"} ORDER BY created_at,id`,
        manifestId === undefined ? [] : [manifestId],
      )
    ).rows;
  }
  async function requeuedEpisodes(manifestId) {
    const jobs = await requeuedJobs(manifestId);
    return [...new Set(jobs.map((job) => job.episode_id))];
  }
  async function retireUnavailableCorrectionReporters(episodeId) {
    return transaction(async () => {
      const retired = (
        await db.query(
          `UPDATE pilot_knowledge_corrections c SET status='unavailable',resolved_at=clock_timestamp()
           WHERE c.status='open' AND c.review_origin='discord' AND c.reporter_source_id IS NOT NULL
             AND EXISTS(SELECT 1 FROM pilot_knowledge_jobs j
               WHERE j.status='requeued' AND j.episode_id=$1 AND j.source_ids && ARRAY[c.source_id])
             AND NOT EXISTS(SELECT 1 FROM pilot_knowledge_sources reporter
               WHERE reporter.id=c.reporter_source_id AND NOT reporter.deleted)
           RETURNING c.id,c.source_id,c.reporter_source_id`,
          [episodeId],
        )
      ).rows;
      for (const correction of retired)
        await receipt(db, "correction-unavailable", {
          correctionId: correction.id,
          sourceId: correction.source_id,
          reporterSourceId: correction.reporter_source_id,
          reason: "reporter-source-unavailable",
        });
      return retired;
    });
  }
  async function correctionReviewContexts(episodeId) {
    if (typeof episodeId !== "string" || !episodeId || episodeId.length > 200)
      throw new Error("Invalid community correction episode");
    await retireUnavailableCorrectionReporters(episodeId);
    return (
      await db.query(
        `SELECT DISTINCT c.id AS correction_id,c.source_id,c.reporter_source_id,c.reporter_id,c.note_digest,
          c.review_origin,c.review_note,
          reporter.source AS reporter_source
         FROM pilot_knowledge_corrections c JOIN pilot_knowledge_jobs j
           ON j.status='requeued' AND j.episode_id=$1 AND j.source_ids && ARRAY[c.source_id]
         LEFT JOIN pilot_knowledge_sources reporter ON reporter.id=c.reporter_source_id AND NOT reporter.deleted
         WHERE c.status='open'
           AND (c.reporter_source_id IS NOT NULL OR c.review_origin='private-operator')
         ORDER BY c.id`,
        [episodeId],
      )
    ).rows.map((row) => {
      if (row.review_origin === "private-operator") {
        if (
          row.reporter_source_id ||
          !text(row.review_note, 800) ||
          sha256(row.review_note) !== row.note_digest
        ) {
          const error = new Error("Private operator review context is unavailable");
          error.code = "HISTORY_CORRECTION_CONTEXT_UNAVAILABLE";
          throw error;
        }
        return {
          correctionId: row.correction_id,
          sourceId: row.source_id,
          reviewOrigin: "private-operator",
          reviewNote: row.review_note,
        };
      }
      const reporter = sourceShape(parsed(row.reporter_source));
      let command;
      try {
        command = parseKnowledgeCommand(reporter.content);
      } catch {
        command = null;
      }
      if (
        reporter.authorId !== row.reporter_id ||
        !command ||
        command.route !== "correct" ||
        command.sourceId !== row.source_id ||
        sha256(command.note) !== row.note_digest
      ) {
        const error = new Error("Correction reporter source no longer matches its review case");
        error.code = "HISTORY_CORRECTION_CONTEXT_UNAVAILABLE";
        throw error;
      }
      return {
        correctionId: row.correction_id,
        sourceId: row.source_id,
        reporterSourceId: row.reporter_source_id,
      };
    });
  }
  async function completeRequeuedEpisode({ manifestId, episodeKey }) {
    if (!identifier(manifestId) || !identifier(episodeKey))
      throw new Error("Invalid community knowledge requeue completion");
    const episodeId = `${manifestId}:${episodeKey}`;
    return transaction(async () => {
      const retired = await db.query(
        `UPDATE pilot_knowledge_jobs SET status='stale',effective=false,completed_at=clock_timestamp()
         WHERE status='requeued' AND manifest_id=$1 AND episode_id=$2 RETURNING id`,
        [manifestId, episodeId],
      );
      if (!retired.rowCount) return { disposition: "none", episodeId };
      await receipt(db, "requeued-episode-completed", {
        manifestId,
        episodeId,
        retiredJobCount: retired.rowCount,
      });
      return { disposition: "completed", episodeId, retiredJobCount: retired.rowCount };
    });
  }
  async function resumePrepared() {
    const jobs = (
      await db.query(
        "SELECT * FROM pilot_knowledge_jobs WHERE status='prepared' ORDER BY created_at,id",
      )
    ).rows;
    const results = [];
    for (const job of jobs) {
      const current = await manifest(job.manifest_id);
      const work = {
        id: job.id,
        manifestId: job.manifest_id,
        manifestGeneration: current.generation,
        episodeId: job.episode_id,
        sourceIds: job.source_ids,
        sourceGenerations: parsed(job.source_generations),
        sourceRevisions: parsed(job.source_revisions),
        correctionGenerations: parsed(job.correction_generations),
        annotationId: job.annotation_id ?? parsed(job.candidate).id ?? job.id.replaceAll("-", ""),
        expectedAnnotationRevision: job.expected_annotation_revision ?? 0,
        logicalKey: job.logical_key ?? null,
        candidate: parsed(job.candidate),
        inputDigest: job.input_digest,
      };
      results.push(await commitAnnotation(work));
    }
    return results;
  }
  await reconcileOpenCorrections();
  return {
    installManifest,
    bindHistoryProjection,
    pendingHistoryDerivations,
    verifyHistoryProjection,
    completeHistoryDerivation,
    staleHistoryDerivations,
    registerSource,
    removeSource,
    prepareAnnotation,
    commitAnnotation,
    resumePrepared,
    prepareExport,
    commitExport,
    view,
    correct,
    resolveCorrection,
    completeCorrectionReviews,
    completePrivateOperatorReviews,
    receipts,
    rebuild,
    requeuedJobs,
    requeuedEpisodes,
    correctionReviewContexts,
    completeRequeuedEpisode,
    reconcileOpenCorrections,
  };
}

// The first semantic pass is intentionally a projection of the existing sourced
// memory ledger, not a second model prompt.  Entries whose complete evidence is
// inside the manifest episode become loose candidates; mixed-episode entries stay
// in memory until a later episode supplies a complete, reviewable evidence set.
export function annotationsFromUnderstanding(
  entries,
  episode,
  processingVersion = "letta-memory-projection-v1",
) {
  if (!Array.isArray(entries))
    throw new Error("Community annotation projection requires memory entries");
  const allowed = new Set([...episode.sourceIds, ...episode.contextIds]);
  const targets = new Set(episode.sourceIds);
  return entries.flatMap((entry) => {
    const explicitTopics = Array.isArray(entry?.topics) ? entry.topics : null;
    // ponytail: lowercase legacy/model labels only; labels that still are not
    // slugs fall back to the episode key. Richer labels need a topic schema.
    const canonicalTopics = explicitTopics
      ? [
          ...new Set(
            explicitTopics.map((topic) => (typeof topic === "string" ? topic.toLowerCase() : "")),
          ),
        ]
      : null;
    const validTopics =
      canonicalTopics?.length > 0 &&
      canonicalTopics.every((topic) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(topic));
    // Older durable entries without per-entry topics use the selected manifest
    // episode key as a visible retrieval label.
    const topics = validTopics ? canonicalTopics : [episode.key];
    const evidence = Array.isArray(entry?.evidence) ? entry.evidence : [];
    const evidenceIds = evidence.map((item) => item?.messageId);
    const sourceIds = [...new Set(evidenceIds)];
    if (
      !array(sourceIds, MAX_ANNOTATION_SOURCES, snowflake) ||
      evidence.some((item) => !text(item?.quote, 16000)) ||
      evidenceIds.some((id) => !allowed.has(id)) ||
      !evidenceIds.some((id) => targets.has(id)) ||
      !Array.isArray(entry.subjects) ||
      !text(entry.statement, 800)
    )
      return [];
    return [
      validateAnnotation({
        id: `memory-${sha256(entry.key ?? stable(entry)).slice(0, 48)}`,
        sourceIds,
        sourceQuotes: evidence.map((item) => ({ sourceId: item.messageId, quote: item.quote })),
        subjectIds: entry.subjects,
        topics,
        interpretation: entry.statement,
        kind: entry.kind,
        qualifications: [
          ...(entry.kind === "inference"
            ? ["Projected from Mudfüt's existing revisable memory; inspect the cited sources."]
            : []),
          ...(!validTopics
            ? [
                explicitTopics === null
                  ? manifestTopicQualification
                  : invalidMemoryTopicsQualification,
              ]
            : []),
        ],
        uncertainty: entry.kind === "inference" ? "medium" : "unknown",
        processingVersion,
      }),
    ];
  });
}

function quoteSpanIndexes(source, quote) {
  const spans = source?.quoteSpans ?? [];
  const exact = spans.flatMap((span, index) => (span === quote ? [index + 1] : []));
  if (exact.length) return exact;
  const contained = spans.flatMap((span, index) =>
    span.includes(quote) || quote.includes(span) ? [index + 1] : [],
  );
  return contained.length === 1 ? contained : [];
}

export function renderKnowledgeView(document, { page = 1 } = {}) {
  if (!Number.isInteger(page) || page < 1 || page > 10000)
    throw new Error("Invalid community knowledge page");
  const heading =
    document.target === "profile"
      ? `Profile ${document.key}`
      : document.target === "topic"
        ? `Topic ${document.key}`
        : `History ${document.key.replace(":", " / ")}`;
  const allEntries = Array.isArray(document.entries) ? document.entries : [];
  const citeable = (entry) => {
    if (!entry || typeof entry.interpretation !== "string") return false;
    const directSources = Array.isArray(entry.sources) ? entry.sources : [];
    const contextSources = Array.isArray(entry.contextSources) ? entry.contextSources : [];
    const sources = [...directSources, ...contextSources];
    const ids = new Set(sources.filter(Boolean).map((source) => source.sourceId));
    const claims = entry.claims ?? [];
    return (
      directSources.length > 0 &&
      sources.every(
        (source) =>
          source &&
          snowflake(source.sourceId) &&
          Number.isInteger(source.sourceRevision) &&
          typeof source.canonicalPermalink === "string" &&
          source.canonicalPermalink.length > 0,
      ) &&
      Array.isArray(claims) &&
      claims.every(
        (claim) =>
          claim &&
          Array.isArray(claim.anchors) &&
          claim.anchors.every((anchor) => anchor && ids.has(anchor.sourceId)),
      )
    );
  };
  const entries = allEntries.filter(citeable);
  const previouslyUnavailable = Number.isInteger(document.unavailableCandidateCount)
    ? Math.max(0, document.unavailableCandidateCount)
    : 0;
  const withheld = previouslyUnavailable + (allEntries.length - entries.length);
  const withheldReason = "because current source evidence is unavailable or incomplete";
  if (!entries.length) {
    const unavailable = withheld
      ? ` ${withheld} candidate${withheld === 1 ? " was" : "s were"} withheld ${withheldReason}.`
      : "";
    return `${heading}: no current cited candidate interpretations.${unavailable}`;
  }
  const fallbackTopic = entries.some((entry) =>
    (entry.qualifications ?? []).some(isManifestTopicQualification),
  );
  const lines = [
    `${heading} — cited candidate interpretations.`,
    "Candidates, not settled facts; open source links for wording and context.",
    "Claim maps appear only when recorded; citations alone do not map each clause.",
  ];
  if (fallbackTopic) lines.push("Topic label: selected archive episode.");
  if (withheld)
    lines.push(
      `${withheld} candidate${withheld === 1 ? " was" : "s were"} withheld ${withheldReason}.`,
    );
  const commandForPage = (number) => {
    if (document.target === "profile") return `!knowledge profile ${document.key} page ${number}`;
    if (document.target === "topic") return `!knowledge topic ${document.key} page ${number}`;
    const parts = historyViewParts(document.key);
    if (parts) return `!knowledge history ${parts.memberId} ${parts.topic} page ${number}`;
    throw new Error("Invalid community knowledge view document");
  };
  const footer = (number, total) =>
    number < total
      ? `Page ${number} of ${total} · next: \`${commandForPage(number + 1)}\``
      : `Page ${number} of ${total} · end of current candidates.`;
  const prefix = lines.join("\n");
  const maximumBlockLength = 1800 - prefix.length - footer(9999, 10000).length - 2;
  const continuationBlocks = (entry, index) => {
    const candidate = index + 1;
    const output = [];
    const wrap = (label, value) => {
      const text = String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return;
      const first = `• Candidate ${candidate} — ${label}: `;
      const next = `  Candidate ${candidate} (continued) — ${label}: `;
      let line = first;
      let firstLine = true;
      for (const word of text.split(" ")) {
        const baseLength = firstLine ? first.length : next.length;
        const separator = line.length > baseLength ? " " : "";
        if (line.length + separator.length + word.length <= maximumBlockLength) {
          line += separator + word;
          continue;
        }
        if (line.length > baseLength) {
          output.push(line);
          line = next;
          firstLine = false;
        }
        let part = "";
        for (const character of word) {
          if (line.length + part.length + character.length > maximumBlockLength) {
            output.push(line + part);
            line = next;
            firstLine = false;
            part = "";
          }
          part += character;
        }
        line += part;
      }
      if (line !== first && line !== next) output.push(line);
    };
    const atomic = (label, value) => {
      const line = `• Candidate ${candidate} — ${label}: ${value}`;
      if (line.length > maximumBlockLength)
        throw new Error("An atomic community citation exceeds the safe render limit");
      output.push(line);
    };
    wrap("interpretation", entry.interpretation);
    if (entry.kind) atomic("kind", entry.kind);
    atomic("uncertainty", entry.uncertainty === "unknown" ? "unassessed" : entry.uncertainty);
    if (entry.episodeKey) atomic("episode", entry.episodeKey);
    if (entry.competingWith?.length) atomic("competing readings", entry.competingWith.length);
    if (entry.supersedes) atomic("lineage", "supersedes an earlier candidate");
    for (const qualification of (entry.qualifications ?? []).filter(
      (item) => !isManifestTopicQualification(item),
    ))
      wrap("note", qualification);
    for (const boundary of (entry.replyBoundaries ?? []).filter((item) =>
      ["selected-parent-not-bound", "outside-selected-slice"].includes(item.status),
    )) {
      const label =
        boundary.status === "outside-selected-slice"
          ? "reply parent outside selected evidence; its role in this interpretation is unreviewed"
          : "selected reply parent not bound as candidate context; its role in this interpretation is unreviewed";
      const link = `[${boundary.parentSourceId}](${boundary.canonicalPermalink})`;
      atomic(label, link);
    }
    for (const source of entry.sources)
      atomic(
        "source citation",
        `[${source.sourceId} r${source.sourceRevision}](${source.canonicalPermalink})`,
      );
    for (const source of entry.contextSources ?? [])
      atomic(
        "context citation",
        `[${source.sourceId} r${source.sourceRevision}](${source.canonicalPermalink})`,
      );
    if (!(entry.claims ?? []).length) atomic("claim map", "claim-level evidence map not recorded");
    for (const claim of entry.claims ?? []) {
      const subjects = claim.subjectIds?.length ? `; subjects ${claim.subjectIds.join(", ")}` : "";
      wrap(`claim ${claim.id}${subjects}`, claim.text);
      for (const anchor of claim.anchors) {
        const source = [...entry.sources, ...(entry.contextSources ?? [])].find(
          (item) => item.sourceId === anchor.sourceId,
        );
        const spans = quoteSpanIndexes(source, anchor.quote);
        const attribution = `${anchor.relation} by ${anchor.attributedTo}${spans.length ? `, quote span${spans.length > 1 ? "s" : ""} ${spans.join(",")}` : " (context span)"}`;
        const link = source
          ? `[${anchor.sourceId} r${source.sourceRevision}](${source.canonicalPermalink})`
          : `[${anchor.sourceId}]`;
        atomic(
          "claim anchor",
          `${attribution}: ${link}${anchor.relatedClaimId ? ` (related claim ${anchor.relatedClaimId})` : ""}`,
        );
      }
    }
    return output;
  };
  const blocks = [];
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex];
    const qualifications = (entry.qualifications ?? []).filter(
      (qualification) => !isManifestTopicQualification(qualification),
    );
    const competingWith = Array.isArray(entry.competingWith) ? entry.competingWith : [];
    const lineage = [
      ...(competingWith.length ? [`competing readings: ${competingWith.length}`] : []),
      ...(entry.supersedes ? ["supersedes an earlier candidate"] : []),
    ];
    const context = [
      ...(entry.kind ? [`kind: ${entry.kind}`] : []),
      `uncertainty: ${entry.uncertainty === "unknown" ? "unassessed" : entry.uncertainty}`,
      ...(entry.episodeKey ? [`episode: ${entry.episodeKey}`] : []),
      ...lineage,
      ...qualifications.map((qualification) => `note: ${qualification}`),
      ...(entry.replyBoundaries ?? [])
        .filter((boundary) =>
          ["selected-parent-not-bound", "outside-selected-slice"].includes(boundary.status),
        )
        .map((boundary) =>
          boundary.status === "outside-selected-slice"
            ? `reply parent outside selected evidence; its role in this interpretation is unreviewed: [${boundary.parentSourceId}](${boundary.canonicalPermalink})`
            : `selected reply parent not bound as candidate context; its role in this interpretation is unreviewed: [${boundary.parentSourceId}](${boundary.canonicalPermalink})`,
        ),
    ].join(" · ");
    const citations = entry.sources
      .map(
        (source) => `[${source.sourceId} r${source.sourceRevision}](${source.canonicalPermalink})`,
      )
      .join(" ");
    const contextCitations = (entry.contextSources ?? [])
      .map(
        (source) => `[${source.sourceId} r${source.sourceRevision}](${source.canonicalPermalink})`,
      )
      .join(" ");
    const claimMap = (entry.claims ?? []).map((claim) => {
      const subjects = claim.subjectIds?.length ? `; subjects ${claim.subjectIds.join(", ")}` : "";
      const anchors = claim.anchors
        .map((anchor) => {
          const source = [...entry.sources, ...(entry.contextSources ?? [])].find(
            (item) => item.sourceId === anchor.sourceId,
          );
          const spans = quoteSpanIndexes(source, anchor.quote);
          return `${anchor.relation} by ${anchor.attributedTo}${spans.length ? `, quote span${spans.length > 1 ? "s" : ""} ${spans.join(",")}` : " (context span)"}: ${source ? `[${anchor.sourceId} r${source.sourceRevision}](${source.canonicalPermalink})` : `[${anchor.sourceId}]`}${anchor.relatedClaimId ? ` (related claim ${anchor.relatedClaimId})` : ""}`;
        })
        .join("; ");
      return `  claim ${claim.id}${subjects}: ${claim.text}\n    ${anchors}`;
    });
    const block = `• ${entry.interpretation}\n  ${context}\n  ${citations}${contextCitations ? `\n  context: ${contextCitations}` : ""}${claimMap.length ? `\n${claimMap.join("\n")}` : "\n  claim-level evidence map not recorded"}`;
    const compactClaimMap = (entry.claims ?? []).map((claim) => {
      const anchors = claim.anchors.map((anchor) => {
        const source = [...entry.sources, ...(entry.contextSources ?? [])].find(
          (item) => item.sourceId === anchor.sourceId,
        );
        const spans = quoteSpanIndexes(source, anchor.quote);
        return `${anchor.relation}:${anchor.attributedTo}>${anchor.sourceId}${spans.length ? `#${spans.join(",")}` : ":context"}${anchor.relatedClaimId ? `~${anchor.relatedClaimId}` : ""}`;
      });
      return `${claim.id}[${claim.subjectIds?.join(",") ?? ""}]=${anchors.join(",")}`;
    });
    const compactBlock = `• ${entry.interpretation}\n  ${context}\n  ${citations}${contextCitations ? `\n  context: ${contextCitations}` : ""}${compactClaimMap.length ? `\n  claim map: ${compactClaimMap.join("; ")}` : "\n  claim-level evidence map not recorded"}`;
    const selectedBlock = block.length <= compactBlock.length ? block : compactBlock;
    if (selectedBlock.length <= maximumBlockLength) blocks.push(selectedBlock);
    else blocks.push(...continuationBlocks(entry, entryIndex));
  }
  // ponytail: page commands stop at 10,000; raise the parser and render ceiling together if a view outgrows it.
  // Footer width depends on page number and total pages. Repack until the
  // estimated total is exact so long history keys do not waste page capacity.
  let expectedPages = 1;
  let pages;
  for (let attempt = 0; attempt < 10000; attempt++) {
    pages = [[]];
    let used = 0;
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      const pageNumber = pages.length;
      const footerReserve =
        index === blocks.length - 1
          ? footer(pageNumber, pageNumber).length
          : footer(pageNumber, Math.max(expectedPages, pageNumber + 1)).length;
      const pageBudget = 1800 - prefix.length - footerReserve - 2;
      if (
        pages.at(-1).length &&
        (block.length > pageBudget || used + block.length + 1 > pageBudget)
      ) {
        pages.push([]);
        used = 0;
        const nextPage = pages.length;
        const nextFooterReserve =
          index === blocks.length - 1
            ? footer(nextPage, nextPage).length
            : footer(nextPage, Math.max(expectedPages, nextPage + 1)).length;
        const nextPageBudget = 1800 - prefix.length - nextFooterReserve - 2;
        if (block.length > nextPageBudget)
          throw new Error("A cited candidate exceeds the safe community view render limit");
      } else if (block.length > pageBudget)
        throw new Error("A cited candidate exceeds the safe community view render limit");
      pages.at(-1).push(block);
      used += block.length + (pages.at(-1).length > 1 ? 1 : 0);
    }
    if (pages.length > 10000)
      throw new Error("Community knowledge view exceeds the 10000-page addressable limit");
    if (pages.length === expectedPages) break;
    expectedPages = pages.length;
    if (attempt === 9999)
      throw new Error("Community knowledge pagination could not stabilize its page count");
  }
  if (page > pages.length)
    return `${heading}: page ${page} is no longer available; the refreshed view has ${pages.length} page${pages.length === 1 ? "" : "s"}. Restart with \`${commandForPage(1)}\`.`;
  const output = [prefix, ...pages[page - 1], footer(page, pages.length)].join("\n");
  if (output.length > 1800)
    throw new Error("Community knowledge pagination exceeded the safe render limit");
  return output;
}
