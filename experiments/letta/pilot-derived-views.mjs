import { createHash } from "node:crypto";

// Local-only contract for the bounded Mini pilot. It has no database, Discord,
// archive, model, or export I/O. A later durable adapter must preserve its
// source-generation and conditional-export checks.
const required = (value, code) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
};
const digest = (value) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const sourceDigest = (source) =>
  digest({
    sourceId: source.sourceId,
    revisionId: source.revisionId,
    authorId: source.authorId,
    exactQuote: source.exactQuote,
    canonicalPermalink: source.canonicalPermalink,
  });
const ordered = (entries) =>
  [...entries].sort((a, b) =>
    [a.sourceId, a.sourceRevisionId, a.interpretation]
      .join("\0")
      .localeCompare([b.sourceId, b.sourceRevisionId, b.interpretation].join("\0")),
  );
const entry = (interpretation) => ({
  interpretation: interpretation.interpretation,
  sourceId: interpretation.source.sourceId,
  sourceRevisionId: interpretation.source.revisionId,
  authorId: interpretation.source.authorId,
  exactQuote: interpretation.source.exactQuote,
  canonicalPermalink: interpretation.source.canonicalPermalink,
});

function validate(interpretation) {
  if (!interpretation || typeof interpretation !== "object" || Array.isArray(interpretation))
    throw new Error("Derived interpretation must be an object");
  const { subjectMemberId, topic, interpretation: text, source } = interpretation;
  for (const value of [
    subjectMemberId,
    topic,
    text,
    source?.sourceId,
    source?.revisionId,
    source?.authorId,
    source?.exactQuote,
    source?.canonicalPermalink,
  ])
    required(value, "Derived interpretation has incomplete attribution");
  if (subjectMemberId !== source.authorId)
    throw new Error("Derived interpretation must attribute the source to its author");
}

function validateSource(source) {
  for (const value of [
    source?.sourceId,
    source?.revisionId,
    source?.authorId,
    source?.exactQuote,
    source?.canonicalPermalink,
  ])
    required(value, "Source identity is incomplete");
}

// `correctSource` invalidates only the one source contribution, then rebuilds
// its two dependent views. ponytail: this local Map is O(n) per rebuild; a
// durable dependency index is the upgrade when the bounded pilot leaves one episode.
export function derivedViewWorker() {
  const sources = new Map(),
    contributions = new Map(),
    profiles = new Map(),
    wikis = new Map(),
    exports = new Map(),
    receipts = [];
  let nextRevision = 1,
    nextReceipt = 1;
  const recordReceipt = (receipt) =>
    receipts.push(Object.freeze({ receiptId: nextReceipt++, ...receipt }));
  const rebuildProfile = (memberId) => {
    const view = {
      memberId,
      revision: nextRevision++,
      entries: ordered(
        [...contributions.values()]
          .filter((item) => item.memberId === memberId)
          .map((item) => item.entry),
      ),
    };
    profiles.set(memberId, view);
    return view;
  };
  const rebuildWiki = (topic) => {
    const view = {
      topic,
      revision: nextRevision++,
      entries: ordered(
        [...contributions.values()]
          .filter((item) => item.topic === topic)
          .map((item) => item.entry),
      ),
    };
    wikis.set(topic, view);
    return view;
  };
  const rebuild = (contribution) => {
    rebuildProfile(contribution.memberId);
    rebuildWiki(contribution.topic);
  };
  return {
    registerSource(source) {
      validateSource(source);
      if (sources.has(source.sourceId)) throw new Error("Source is already registered");
      sources.set(source.sourceId, { source, generation: 1 });
    },
    correctSource(source) {
      validateSource(source);
      const current = sources.get(source.sourceId);
      if (!current) throw new Error("Source is unknown");
      if (current.source.revisionId === source.revisionId)
        throw new Error("Source correction must change revision");
      if (current.source.authorId !== source.authorId)
        throw new Error("Source correction cannot change author");
      sources.set(source.sourceId, { source, generation: current.generation + 1 });
      const old = contributions.get(source.sourceId);
      if (old) {
        contributions.delete(source.sourceId);
        rebuild(old);
      }
    },
    prepare(interpretation) {
      validate(interpretation);
      const current = sources.get(interpretation.source.sourceId);
      if (!current || sourceDigest(current.source) !== sourceDigest(interpretation.source)) {
        throw new Error("Source is not current");
      }
      return {
        workId: digest({
          interpretation,
          sourceGeneration: current.generation,
          sourceIdentityDigest: sourceDigest(current.source),
        }),
        sourceId: interpretation.source.sourceId,
        sourceRevisionId: interpretation.source.revisionId,
        sourceGeneration: current.generation,
        sourceIdentityDigest: sourceDigest(current.source),
        interpretation,
      };
    },
    apply(work) {
      validate(work?.interpretation);
      const current = sources.get(work.sourceId);
      if (
        !current ||
        current.source.revisionId !== work.sourceRevisionId ||
        current.generation !== work.sourceGeneration ||
        sourceDigest(current.source) !== work.sourceIdentityDigest ||
        work.interpretation.source.sourceId !== work.sourceId ||
        work.interpretation.source.revisionId !== work.sourceRevisionId ||
        work.workId !==
          digest({
            interpretation: work.interpretation,
            sourceGeneration: work.sourceGeneration,
            sourceIdentityDigest: work.sourceIdentityDigest,
          })
      ) {
        recordReceipt({
          type: "stale-worker-result",
          workId: typeof work.workId === "string" ? work.workId : null,
          sourceId: work.sourceId,
          preparedSourceRevisionId: work.sourceRevisionId,
          currentSourceRevisionId: current?.source.revisionId ?? null,
        });
        return { disposition: "stale-source" };
      }
      const contribution = {
        memberId: work.interpretation.subjectMemberId,
        topic: work.interpretation.topic,
        entry: entry(work.interpretation),
      };
      contributions.set(work.sourceId, contribution);
      return {
        disposition: "applied",
        profile: rebuildProfile(contribution.memberId),
        wiki: rebuildWiki(contribution.topic),
      };
    },
    readProfile(memberId) {
      return profiles.get(memberId);
    },
    readWiki(topic) {
      return wikis.get(topic);
    },
    prepareExport({ target, key }) {
      if (target !== "profile" && target !== "wiki") throw new Error("Unknown export target");
      required(key, "Export key is required");
      const view = target === "profile" ? profiles.get(key) : wikis.get(key);
      if (!view) throw new Error("Export target has no current view");
      return { target, key, viewRevision: view.revision, document: JSON.stringify(view) };
    },
    commitExport(prepared) {
      const current =
        prepared?.target === "profile"
          ? profiles.get(prepared.key)
          : prepared?.target === "wiki"
            ? wikis.get(prepared.key)
            : undefined;
      if (!current || current.revision !== prepared.viewRevision) {
        recordReceipt({
          type: "stale-export",
          target: prepared?.target ?? null,
          key: prepared?.key ?? null,
          preparedViewRevision: prepared?.viewRevision ?? null,
          currentViewRevision: current?.revision ?? null,
        });
        return { disposition: "stale-view" };
      }
      exports.set(`${prepared.target}\0${prepared.key}`, {
        viewRevision: prepared.viewRevision,
        document: prepared.document,
      });
      return { disposition: "exported" };
    },
    readExport({ target, key }) {
      return exports.get(`${target}\0${key}`);
    },
    readReceipts() {
      return Object.freeze(receipts.map((receipt) => Object.freeze({ ...receipt })));
    },
  };
}
