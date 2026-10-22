import { buildGraph } from "./model.mjs";

// All names, content and IDs here are fictional. This demo is never runtime evidence.
export function demoRecords() {
  const sources = [
    {
      id: "demo-101",
      source: {
        id: "demo-101",
        authorId: "mira",
        authorName: "Mira",
        content: "Let's take the train for the observatory Friday. Parking there is a disaster.",
        createdAt: "2026-05-01T12:00:00Z",
        channelId: "demo-lobby",
        replyTo: null,
      },
      revision: 1,
      generation: 1,
      correction_generation: 1,
    },
    {
      id: "demo-102",
      source: {
        id: "demo-102",
        authorId: "theo",
        authorName: "Theo",
        content: "Mira has declared war on cars.",
        createdAt: "2026-05-01T12:01:00Z",
        channelId: "demo-lobby",
        replyTo: "demo-101",
      },
      revision: 1,
      generation: 1,
      correction_generation: 0,
    },
    {
      id: "demo-103",
      source: {
        id: "demo-103",
        authorId: "mira",
        authorName: "Mira",
        content:
          "I don't hate driving. I drive the supply van on Sundays. I meant this particular trip.",
        createdAt: "2026-05-01T12:02:00Z",
        channelId: "demo-lobby",
        replyTo: "outside-selection",
      },
      revision: 1,
      generation: 1,
      correction_generation: 0,
    },
    {
      id: "demo-104",
      source: {
        id: "demo-104",
        authorId: "rowan",
        authorName: "Rowan",
        content: "The afternoon train may be easier.",
        createdAt: "2026-05-01T12:03:00Z",
        channelId: "demo-lobby",
        replyTo: null,
      },
      revision: 2,
      generation: 2,
      correction_generation: 0,
    },
  ];
  const candidate = {
    sourceIds: ["demo-101"],
    contextSourceIds: ["demo-102"],
    subjectIds: ["mira"],
    topics: ["observatory", "transport"],
    interpretation: "Mira prefers taking the train for the observatory trip.",
    qualifications: [
      "A dated plan, not confirmation that the trip happened.",
      "Theo's reply is humorous context; it is not Mira's position.",
    ],
    uncertainty: "low",
    sourceQuotes: [
      { sourceId: "demo-101", quote: "Let's take the train for the observatory Friday." },
    ],
    claims: [
      {
        id: "trip",
        text: "Mira proposes the train for this trip.",
        subjectIds: ["mira"],
        anchors: [
          {
            sourceId: "demo-101",
            quote: "Let's take the train for the observatory Friday.",
            relation: "supports",
            attributedTo: "mira",
          },
        ],
      },
    ],
  };
  const annotations = [
    {
      id: "trip-plan",
      revision: 1,
      status: "superseded",
      manifest_id: "fictional-selection",
      episode_id: "fictional-selection:observatory",
      created_at: "2026-05-02T12:00:00Z",
      source_ids: ["demo-101"],
      candidate: {
        ...candidate,
        interpretation: "Mira prefers trains.",
        qualifications: ["Earlier interpretation; scope later corrected."],
      },
    },
    {
      id: "trip-plan",
      revision: 2,
      status: "candidate",
      manifest_id: "fictional-selection",
      episode_id: "fictional-selection:observatory",
      created_at: "2026-05-03T12:00:00Z",
      source_ids: ["demo-101", "demo-103"],
      candidate: {
        ...candidate,
        sourceIds: ["demo-101", "demo-103"],
        sourceQuotes: [
          ...candidate.sourceQuotes,
          { sourceId: "demo-103", quote: "I meant this particular trip." },
        ],
        claims: [
          {
            ...candidate.claims[0],
            anchors: [
              ...candidate.claims[0].anchors,
              {
                sourceId: "demo-103",
                quote: "I meant this particular trip.",
                relation: "qualifies",
                attributedTo: "mira",
              },
            ],
          },
        ],
      },
    },
    {
      id: "afternoon-plan",
      revision: 1,
      status: "candidate",
      manifest_id: "fictional-selection",
      episode_id: "fictional-selection:observatory",
      created_at: "2026-05-03T12:00:00Z",
      source_ids: ["demo-104"],
      candidate: {
        sourceIds: ["demo-104"],
        subjectIds: ["rowan"],
        topics: ["transport"],
        interpretation: "Rowan suggests the morning train.",
        uncertainty: "medium",
        qualifications: ["The stored message has since changed; inspect the old bound revision."],
        competingWith: ["trip-plan"],
        sourceQuotes: [{ sourceId: "demo-104", quote: "The morning train may be easier." }],
      },
    },
  ];
  const jobs = annotations.map((row) => ({
    annotation_id: row.id,
    annotation_revision: row.revision,
    source_revisions: Object.fromEntries(
      [...row.candidate.sourceIds, ...(row.candidate.contextSourceIds ?? [])].map((id) => [id, 1]),
    ),
    source_generations: Object.fromEntries(sources.map((s) => [s.id, 1])),
    correction_generations: Object.fromEntries(
      sources.map((s) => [
        s.id,
        row.id === "trip-plan" && row.revision === 2 && s.id === "demo-101" ? 1 : 0,
      ]),
    ),
  }));
  return {
    annotations,
    sources,
    jobs,
    revisions: [
      ...sources
        .filter((s) => s.revision === 1)
        .map((s) => ({ source_id: s.id, revision: 1, source: s.source })),
      {
        source_id: "demo-104",
        revision: 1,
        source: { ...sources[3].source, content: "The morning train may be easier." },
      },
    ],
    corrections: [
      {
        id: "fictional-correction",
        source_id: "demo-101",
        affected_annotation_ids: ["trip-plan"],
        status: "accepted",
        review_note: "Keep the preference specific to this trip.",
        created_at: "2026-05-03T11:00:00Z",
        resolved_at: "2026-05-03T12:00:00Z",
        resolution_annotation_id: "trip-plan",
      },
    ],
    manifests: [
      {
        id: "fictional-selection",
        generation: 1,
        created_at: "2026-05-01T00:00:00Z",
        manifest: {
          episodes: [
            {
              key: "observatory",
              label: "Fictional observatory planning",
              sourceIds: ["demo-101", "demo-103", "demo-104"],
              contextIds: ["demo-102"],
            },
          ],
        },
      },
    ],
  };
}
export function demoSnapshot() {
  const row = {
    guild_id: "fictional-server",
    channel_id: "demo-lobby",
    month: "2026-05",
    stored: 38,
    usable: 35,
    thread_rows: 2,
    reviewed: 9,
    context: 4,
    represented: 3,
    selected: 4,
    deferred: 2,
    without_review_receipt: 26,
    first: "2026-05-01T12:00:00Z",
    last: "2026-05-30T12:00:00Z",
  };
  return {
    generatedAt: new Date().toISOString(),
    mode: "FICTIONAL DEMO · not Discord history",
    graph: buildGraph(demoRecords()),
    coverage: {
      archive: {
        status: "available",
        rows: [row],
        total: row,
        inventory: "unknown",
        note: "Fictional numbers illustrate separate coverage stages. Full server inventory remains unknown.",
      },
      pilot: {
        currentCandidates: 2,
        annotationVersions: 3,
        episodes: [
          { status: "done", count: 2 },
          { status: "deferred", count: 1 },
        ],
        cache: { stored: 12, nondeleted: 12, first: row.first, last: row.last },
        memory: { entries: 5 },
      },
      stages: { reviewed: 9, context: 4, represented: 3, selected: 4, deferred: 2 },
    },
  };
}
