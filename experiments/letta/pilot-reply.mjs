import { validateOperatorRequest } from "./pilot-requests.mjs";
import { decodeUnderstanding, isCorrectionRequest } from "./pilot-memory.mjs";
export { isCorrectionRequest } from "./pilot-memory.mjs";

export const recallQuery = (input, batch) =>
  input.query ??
  (input.subjects?.length || input.keys?.length
    ? ""
    : (batch.operatorRequest?.prompt ?? batch.rows.map((row) => row.source.content).join(" ")));

export const turnExpectsReply = (batch) => Boolean(batch.replyTo || batch.operatorRequest);

export const recallOptions = (input, batch) => ({
  ...input,
  query: recallQuery(input, batch),
  // A question's author is not necessarily its subject. Default direct recall
  // must not hide another member's answer or a competing community viewpoint.
  subjects:
    input.subjects ??
    (input.query === undefined && !turnExpectsReply(batch)
      ? batch.rows.map((r) => r.source.authorId)
      : []),
  includeInferences: input.includeInferences ?? true,
});

export const communityKnowledgeEvidence = (result) => ({
  target: result.target,
  key: result.key,
  sourceIds: result.sources.map((source) => source.id),
  candidates: (result.document?.entries ?? []).map((entry) => ({
    annotationId: entry.annotationId,
    annotationRevision: entry.annotationRevision,
    sourceRevisions: (entry.sources ?? []).map((source) => ({
      sourceId: source.sourceId,
      sourceRevision: source.sourceRevision,
    })),
    contextSourceRevisions: (entry.contextSources ?? []).map((source) => ({
      sourceId: source.sourceId,
      sourceRevision: source.sourceRevision,
    })),
  })),
  incomplete: Boolean(result.document?.incomplete),
  available: Array.isArray(result.document?.entries) && result.document.entries.length > 0,
});

export const correctionRequestSourceIds = (batch) =>
  new Set(
    [
      ...batch.rows.map((row) => row.source),
      ...(batch.context?.priorMessages ?? []),
      ...(batch.context?.surroundingMessages ?? []),
      ...(batch.context?.correctionRequests ?? []).map((request) => request.reporterSource),
    ]
      .filter(isCorrectionRequest)
      .map((source) => source.id),
  );

export function durableCandidate(batch, result) {
  return {
    ...result.candidate,
    ...(batch.operatorRequest ? { operatorRequestId: batch.operatorRequest.id } : {}),
    // A direct reply needs the same durable dependency trace as an operator
    // request; correct prose alone cannot prove what retrieval or memory it used.
    ...(turnExpectsReply(batch) ? { replyEvidence: result.replyEvidence } : {}),
  };
}

export function turnInput(batch, revision, botId) {
  const request = batch.operatorRequest && validateOperatorRequest(batch.operatorRequest);
  if (request && (batch.replyTo || batch.rows.length))
    throw new Error("An operator request cannot impersonate a Discord source");
  const targets = batch.rows.map((row) => row.id);
  const correctionSourceIds = [...correctionRequestSourceIds(batch)];
  const supplied = new Set([
    ...targets,
    ...(batch.context?.priorMessages ?? []).map((source) => source.id),
    ...(batch.context?.surroundingMessages ?? []).map((source) => source.id),
    ...correctionSourceIds,
  ]);
  return {
    kind: turnExpectsReply(batch) ? "direct" : "ambient",
    addressedToBot: turnExpectsReply(batch),
    bot: { name: "Mudfüt", id: botId },
    ...(request ? { operatorRequest: request } : {}),
    memoryContract: {
      revision,
      observationTargetIds: targets,
      ...(batch.rows.some((row) => row.generation_failures > 0)
        ? {
            repairInstruction:
              "A prior attempt ended without complete observation decisions and committed nothing. Before finishing, call update_memory with an explicit retained/irrelevant decision for every observationTargetId, even when upsert and remove are empty. Repair validation errors; do not declare useful evidence irrelevant just to finish. The original messages remain authoritative.",
          }
        : {}),
      contextOnlyIds: [...supplied].filter((id) => !targets.includes(id)),
      instruction:
        "Only observationTargetIds need retained/irrelevant decisions. Context-only messages are surrounding evidence, not extra targets. Preserve valid proposals while repairing other errors. Read memory before changing it. Consolidate the same person/topic across episodes through explicit lineage; preserve changed views, dates, prior source lineage and contrary perspectives. Use provisional useful inferences naturally without turning them into facts. Notice recurring participation patterns, shared experiences and linked playful replies in surrounding or retrieved originals as well as targets. Retain useful social context and running jokes with exact source attribution; distinguish humorous self-description from a measured habit or promise. A tentative relationship inference needs direct linked exchanges and importance 1; warmth alone does not establish private friendship. Each substantive clause of a retained or consolidated statement needs its own supporting original in that entry's evidence, including inherited clauses. Add the actual source rather than borrowing support from a separate entry; split independent claims when needed. Do not auto-retain every archive hit. For lineage action extend, copy statement, kind and subjects exactly; changed wording needs revise with newer evidence. Do not merge unrelated topics that share a word." +
        (correctionSourceIds.length ||
        batch.context?.correctionRequests?.some((item) => item.reviewOrigin === "private-operator")
          ? " correctionRequests identify a reported or private operator interpretation for review. A reporterSource or private operator review is review context, not community evidence: do not cite it in memory. A correction request that is an observation target still needs an irrelevant decision. Re-read the cited original targets and revise only when those originals support a qualified, changed or competing interpretation; otherwise preserve uncertainty."
          : "") +
        (request
          ? " This is an actual operator request, not a community member utterance or an observation source. Its prompt supplies no evidence about members. Call update_memory with an empty observations array when there are no targets, including when upsert and remove are empty. Community understanding may use only sourced originals returned by the application tools."
          : ""),
    },
    answerContract: {
      instruction:
        "For a narrow factual question, stop after retained understanding sufficiently supports the answer; do not turn it into a historical investigation merely because more archive is available. Search for a specific missing or ambiguous fact, material qualification, or requested development. For topic catch-up or crux questions, explain who argued what, how positions developed, concrete agreement, and the remaining disagreement. Distinguish an attributed claim from your tentative synthesis; do not invent a changed view from silence or different speakers. With partial coverage, say no revision was observed in inspected evidence instead of claiming a person never softened or changed a position. Check each substantive clause against its own supporting sources; a related memory entry does not automatically support every clause of a consolidated statement. Use retained understanding and original conversations together. For broader historical questions, browse bounded chronological archive pages and expand a relevant anchor into its surrounding discussion before generalizing from matching hits. When a relevant first page has unread candidates, follow at least one continuation before a broad synthesis, or explain the specific budget or relevance reason for stopping. For developments over time, also sample the later end with oldestFirst false and expand a later anchor; an early keyword cluster cannot establish how the discussion ended. Keep date bounds broad enough to include later qualifications. Archive tools can return automaticGapInspection with an uninspected gap lead. This is not a relevance judgment and does not itself read extra originals. After assessing context, use inspect_archive_gap with two relevant returned original IDs and a reason when a missing intervening development could materially affect the answer. Choose the coherent discussion rather than the widest unrelated interval. Its query-free originals are separately scoped from the original keyword page. Assess their relevance. If a material interval remains unread, use its continuation or the supplied chronological bounds now, including the actual reply parents of short qualifications; do not finish by merely listing the gap or wait for an operator to identify it. If time or source access prevents further inspection, identify that specific limit and keep conclusions scoped. Check an earlier or contrary perspective when relevant. Identify the actual speakers from sourced memory or originals, then inspect their intervening messages in the same channel/date range with authorIds and no topic keywords; qualifications often stop repeating the original vocabulary. Use read_memory by subject, its omitted-key hints and shared-source context as leads, not proof of relevance. For topic matches, distinguish lexical candidates, off-topic inspected material and relevant coherent exchanges; do not count all returned candidates as relevant discussion coverage. Broaden stemming only when literal search misses useful variants, then inspect context for sense collisions. State the actual period inspected and remaining gaps concisely: query bounds and matching pages are not exhaustive reading, and an exhausted bounded snapshot is not the whole archive. Use reply references to resolve speakers, quotes and antecedents; proximity alone does not prove an exchange. Do not identify unseen images, interpret an unopened link as a read source, or fill in missing quoted material from guesses. An unavailable reply parent does not establish the pictured building, joke target or antecedent, even when a nearby message names one. Aim for 1200–1600 characters with at most two source links; prioritize the useful crux, clear attribution and honest coverage over a catalogue of every point. Keep a conversational answer appropriate to the question, not a compulsory history report for casual banter. Never turn an operator question or your own synthesis into unsourced member memory.",
    },
    messages: batch.rows.map((row) => row.source),
    context: batch.context,
    instruction: request
      ? "Answer operatorRequest.prompt naturally through the ordinary reply behavior. Return the answer only."
      : batch.replyTo
        ? "Respond naturally to this member in the room."
        : "Observe quietly and revise memory when useful. No public reply.",
  };
}

// A trace records what was available, not a claim about hidden model reasoning.
export function replyEvidence(initial, batch) {
  const before = new Map(
    (decodeUnderstanding(initial.content) ?? []).map((entry) => [entry.key, entry]),
  );
  const trace = {
    memoryRevisionBeforeTurn: initial.revision,
    immediateTargetIds: batch.rows.map((row) => row.id),
    immediateContextIds: [
      ...(batch.context?.priorMessages ?? []),
      ...(batch.context?.surroundingMessages ?? []),
    ].map((source) => source.id),
    memoryReads: [],
    archiveReads: [],
    historyReads: [],
    communityKnowledgeReads: [],
  };
  return {
    observe(
      name,
      input,
      result,
      { completedAfterModelStream = false, initiatedBy = "model" } = {},
    ) {
      if (name === "read_memory")
        trace.memoryReads.push({
          completedAfterModelStream,
          input,
          revision: result.revision,
          entries: result.entries.map((entry) => ({
            entry,
            origin:
              JSON.stringify(before.get(entry.key)) === JSON.stringify(entry)
                ? "durable-before-turn"
                : "new-or-revised-in-turn-draft",
          })),
          sources: result.sources,
          coverage: result.coverage,
        });
      if (["search_archive", "browse_archive", "read_discussion"].includes(name))
        trace.archiveReads.push({
          tool: name,
          initiatedBy,
          input,
          sources: result.sources,
          coverage: Object.fromEntries(Object.entries(result).filter(([key]) => key !== "sources")),
          completedAfterModelStream,
        });
      if (name === "read_memory_history")
        trace.historyReads.push({ input, result, completedAfterModelStream });
      if (name === "read_community_knowledge")
        trace.communityKnowledgeReads.push({
          ...communityKnowledgeEvidence(result),
          completedAfterModelStream,
        });
    },
    snapshot() {
      return structuredClone(trace);
    },
  };
}

export const correctionReporterIds = (requests) => [
  ...new Set(requests.map((request) => request.reporterSourceId).filter(Boolean)),
];
