// Pure projection: PostgreSQL records remain authoritative; this graph is disposable.
const list = (value) => (Array.isArray(value) ? value : []);
const key = (type, id) => `${type}:${id}`;
export const annotationKey = (row) => key("candidate", `${row.id}@${row.revision}`);

export function buildGraph({
  annotations = [],
  sources = [],
  revisions = [],
  jobs = [],
  corrections = [],
  manifests = [],
}) {
  const nodes = new Map(),
    edges = [],
    seen = new Set();
  const sourceMap = new Map(sources.map((row) => [row.id, row]));
  const revisionMap = new Map(revisions.map((row) => [`${row.source_id}@${row.revision}`, row]));
  const jobMap = new Map(
    jobs.map((row) => [`${row.annotation_id}@${row.annotation_revision}`, row]),
  );
  const latest = new Map(),
    byId = new Map(),
    predecessors = new Map(),
    names = new Map();
  for (const source of sources)
    if (source.source?.authorId)
      names.set(source.source.authorId, source.source.authorName ?? source.source.authorId);
  for (const row of annotations) {
    const group = byId.get(row.id) ?? [];
    group.push(row);
    byId.set(row.id, group);
  }
  for (const group of byId.values()) {
    group.sort((a, b) => a.revision - b.revision);
    group.forEach((row, index) => {
      if (index) predecessors.set(annotationKey(row), group[index - 1]);
    });
  }
  for (const row of annotations)
    if (!latest.has(row.id) || latest.get(row.id).revision < row.revision) latest.set(row.id, row);
  const add = (node) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
    return node.id;
  };
  const edge = (from, to, relation, explicit = true) => {
    const id = JSON.stringify([from, to, relation]);
    if (!seen.has(id)) {
      edges.push({ from, to, relation, explicit });
      seen.add(id);
    }
  };
  for (const row of sources) {
    const source = row.source ?? {};
    const available = !row.deleted && source.id === row.id && typeof source.content === "string";
    const id = add({
      id: key("message", row.id),
      type: "message",
      label: `${source.authorName ?? source.authorId ?? "Unknown author"}: ${(source.content ?? "Unavailable").slice(0, 90)}`,
      date: source.createdAt,
      channelId: source.channelId,
      status: available ? "stored" : "unavailable",
      source,
      revision: row.revision,
      checkedAt: row.updated_at,
    });
    const author = add({
      id: key("person", source.authorId ?? "unknown"),
      type: "person",
      label: source.authorName ?? source.authorId ?? "Unknown author",
    });
    edge(author, id, "said");
  }
  for (const row of annotations) {
    const candidate = row.candidate ?? {},
      id = annotationKey(row),
      job = jobMap.get(`${row.id}@${row.revision}`);
    const evidence = [
      ...list(candidate.sourceIds).map((sourceId) => ({ sourceId, role: "direct" })),
      ...list(candidate.contextSourceIds).map((sourceId) => ({ sourceId, role: "context" })),
    ].map((item) => {
      const current = sourceMap.get(item.sourceId),
        revision = job?.source_revisions?.[item.sourceId];
      const original =
        revisionMap.get(`${item.sourceId}@${revision}`)?.source ??
        (revision === current?.revision ? current?.source : null);
      const valid =
        current &&
        !current.deleted &&
        current.source?.id === item.sourceId &&
        typeof current.source?.content === "string";
      const stale =
        valid &&
        job &&
        (revision !== current.revision ||
          job.source_generations?.[item.sourceId] !== current.generation ||
          job.correction_generations?.[item.sourceId] !== current.correction_generation);
      const quotes = [
        ...list(candidate.sourceQuotes)
          .filter((quote) => quote.sourceId === item.sourceId)
          .map((quote) => quote.quote),
        ...list(candidate.claims).flatMap((claim) =>
          list(claim.anchors)
            .filter((anchor) => anchor.sourceId === item.sourceId)
            .map((anchor) => anchor.quote),
        ),
      ];
      return {
        ...item,
        revision: revision ?? null,
        currentRevision: current?.revision ?? null,
        status: !valid
          ? "unavailable"
          : stale
            ? "stale"
            : !job
              ? "unknown"
              : "matches stored revision",
        quoteStatus: !quotes.length
          ? "no exact quote recorded"
          : original &&
              quotes.every(
                (quote) => typeof quote === "string" && original.content?.includes(quote),
              ) &&
              list(candidate.claims)
                .flatMap((claim) => list(claim.anchors))
                .filter((anchor) => anchor.sourceId === item.sourceId)
                .every((anchor) => anchor.attributedTo === original.authorId)
            ? "exact in bound revision"
            : "unverified quote",
        quotes: [...new Set(quotes)],
        original,
        current: current?.source ?? null,
      };
    });
    const evidenceStatus = evidence.some((item) => item.status === "unavailable")
      ? "unavailable"
      : evidence.some(
            (item) =>
              item.status === "stale" ||
              (item.status !== "unknown" && item.quoteStatus === "unverified quote"),
          )
        ? "stale"
        : evidence.some(
              (item) =>
                item.status === "unknown" ||
                (item.role === "direct" && item.quoteStatus === "no exact quote recorded"),
            )
          ? "unknown"
          : "matches stored revision";
    add({
      id,
      type: "candidate",
      label: candidate.interpretation ?? row.id,
      status: row.status,
      evidenceStatus,
      date: row.created_at,
      candidate,
      evidence,
      annotationId: row.id,
      revision: row.revision,
      manifestId: row.manifest_id,
      episodeId: row.episode_id,
      corrections: corrections.filter(
        (correction) =>
          list(correction.affected_annotation_ids).includes(row.id) ||
          evidence.some((item) => item.sourceId === correction.source_id),
      ),
    });
    for (const subject of list(candidate.subjectIds)) {
      const subjectId = add({
        id: key("person", subject),
        type: "person",
        label: names.get(subject) ?? subject,
      });
      edge(id, subjectId, "about");
    }
    for (const topic of list(candidate.topics)) {
      const topicId = add({ id: key("topic", topic), type: "topic", label: topic });
      edge(id, topicId, "tagged");
    }
    for (const item of evidence) {
      const sourceId = add({
        id: key("message", item.sourceId),
        type: "message",
        label: `Unavailable source ${item.sourceId}`,
        status: "unavailable",
      });
      edge(sourceId, id, item.role === "direct" ? "direct evidence" : "context only");
    }
    for (const claim of list(candidate.claims)) {
      const claimId = add({
        id: key("claim", `${row.id}@${row.revision}/${claim.id}`),
        type: "claim",
        label: claim.text,
        status: row.status,
        evidenceStatus,
        date: row.created_at,
        claim,
        candidateId: id,
      });
      edge(id, claimId, "contains claim");
      for (const anchor of list(claim.anchors)) {
        const sourceId = add({
          id: key("message", anchor.sourceId),
          type: "message",
          label: `Unavailable source ${anchor.sourceId}`,
          status: "unavailable",
        });
        edge(sourceId, claimId, anchor.relation);
        if (anchor.relatedClaimId)
          edge(
            claimId,
            key("claim", `${row.id}@${row.revision}/${anchor.relatedClaimId}`),
            "relates to claim",
          );
      }
    }
    for (const other of list(candidate.competingWith))
      if (latest.has(other))
        edge(id, annotationKey(latest.get(other)), "competes with identity (latest revision)");
    if (candidate.supersedes && latest.has(candidate.supersedes))
      edge(
        id,
        annotationKey(latest.get(candidate.supersedes)),
        "supersedes identity (latest revision)",
      );
    const predecessor = predecessors.get(id);
    if (predecessor) edge(id, annotationKey(predecessor), "revises");
  }
  for (const row of sources)
    if (row.source?.replyTo) {
      const parentId = key("message", row.source.replyTo);
      if (nodes.has(parentId)) edge(key("message", row.id), parentId, "replies to");
      else nodes.get(key("message", row.id)).outsideParent = row.source.replyTo;
    }
  return {
    nodes: [...nodes.values()],
    edges,
    manifests: manifests.map((row) => ({
      id: row.id,
      generation: row.generation,
      createdAt: row.created_at,
      episodes: list(row.manifest?.episodes).map(({ key, label, sourceIds, contextIds }) => ({
        key,
        label,
        direct: list(sourceIds).length,
        context: list(contextIds).length,
      })),
    })),
    notes: [
      "Every edge comes from a stored record; no inferred social relationships are generated.",
      "Candidate interpretations and recorded claim relations are attributed annotations, not established facts.",
      "Evidence checks compare stored PostgreSQL revisions. Discord edit/deletion freshness is unknown until the existing worker rechecks it.",
    ],
  };
}

export function selectGraph(
  graph,
  { query = "", type = "all", status = "all", focus = "", depth = 1, limit = 100, offset = 0 } = {},
) {
  const term = query.toLocaleLowerCase();
  let matches = graph.nodes.filter(
    (node) =>
      (type === "all" || node.type === type) &&
      (status === "all" || node.status === status || node.evidenceStatus === status) &&
      JSON.stringify(node).toLocaleLowerCase().includes(term),
  );
  if (focus) {
    const ids = new Set([focus]);
    for (let hop = 0; hop < depth; hop++)
      for (const edge of graph.edges.filter((edge) => ids.has(edge.from) || ids.has(edge.to))) {
        ids.add(edge.from);
        ids.add(edge.to);
      }
    matches = matches.filter((node) => ids.has(node.id));
  }
  matches.sort(
    (a, b) =>
      (a.type === "candidate" ? 0 : 1) - (b.type === "candidate" ? 0 : 1) ||
      a.id.localeCompare(b.id),
  );
  const nodes = matches.slice(offset, offset + limit),
    ids = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
    total: matches.length,
  };
}
