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
  const conversations = [
    [
      "demo-201",
      "sana",
      "Sana",
      "rooftop-garden",
      "2026-06-04T16:00:00Z",
      "I'd use the roof budget for rain barrels first. Summer watering takes three trips upstairs.",
      null,
    ],
    [
      "demo-202",
      "jules",
      "Jules",
      "rooftop-garden",
      "2026-06-04T16:04:00Z",
      "I'd buy raised beds first. We can share the downstairs hose until autumn.",
      "demo-201",
    ],
    [
      "demo-203",
      "sana",
      "Sana",
      "rooftop-garden",
      "2026-06-04T16:06:00Z",
      "We agree about growing food. We disagree about which purchase comes first.",
      "demo-202",
    ],
    [
      "demo-301",
      "nia",
      "Nia",
      "little-library",
      "2026-06-09T18:00:00Z",
      "Let's keep the library open until eight on Wednesdays, while the evening class is running.",
      null,
    ],
    [
      "demo-302",
      "theo",
      "Theo",
      "little-library",
      "2026-06-09T18:02:00Z",
      "At last, the twenty-four-hour empire of books.",
      "demo-301",
    ],
    [
      "demo-303",
      "nia",
      "Nia",
      "little-library",
      "2026-06-09T18:05:00Z",
      "Just Wednesdays, and only until the class ends in July. I can cover that shift.",
      "demo-302",
    ],
    [
      "demo-401",
      "jules",
      "Jules",
      "repair-cafe",
      "2026-07-11T10:00:00Z",
      "I'll bring clamps and wood glue to Saturday's repair café. Let's start with the wobbly chairs.",
      null,
    ],
    [
      "demo-402",
      "rowan",
      "Rowan",
      "repair-cafe",
      "2026-07-11T10:05:00Z",
      "Use the side entrance for the repair café; it has a step-free route to the worktables.",
      "demo-401",
    ],
    [
      "demo-403",
      "mira",
      "Mira",
      "repair-cafe",
      "2026-07-11T10:08:00Z",
      "I'll host a quiet table away from the power tools for anyone who wants to mend clothes.",
      "demo-401",
    ],
    [
      "demo-501",
      "theo",
      "Theo",
      "night-sky",
      "2026-07-19T20:00:00Z",
      "For the meteor watch, use red torches on the field so everyone's eyes stay adjusted to the dark.",
      null,
    ],
    [
      "demo-502",
      "sana",
      "Sana",
      "night-sky",
      "2026-07-19T20:04:00Z",
      "I'll bring the star charts. If the sky is cloudy, we can use the indoor projector instead.",
      "demo-501",
    ],
  ];
  for (const [id, authorId, authorName, channelId, createdAt, content, replyTo] of conversations)
    sources.push({
      id,
      source: { id, authorId, authorName, channelId, createdAt, content, replyTo },
      revision: 1,
      generation: 1,
      correction_generation: 0,
    });
  const addInterpretation = (id, sourceIds, subjectIds, topics, interpretation, options = {}) => {
    const sourceQuotes = sourceIds.map((sourceId) => ({
      sourceId,
      quote: sources.find((s) => s.id === sourceId).source.content,
    }));
    annotations.push({
      id,
      revision: 1,
      status: "candidate",
      manifest_id: "fictional-selection",
      episode_id: `fictional-selection:${topics[0]}`,
      created_at: sources.find((s) => s.id === sourceIds.at(-1)).source.createdAt,
      source_ids: sourceIds,
      candidate: {
        sourceIds,
        subjectIds,
        topics,
        interpretation,
        sourceQuotes,
        uncertainty: "low",
        qualifications: [
          "A fictional, dated proposal; this does not establish that the activity happened.",
        ],
        claims: [
          {
            id: "proposal",
            text: interpretation,
            subjectIds,
            anchors: sourceQuotes.map(({ sourceId, quote }) => ({
              sourceId,
              quote,
              relation: "supports",
              attributedTo: sources.find((s) => s.id === sourceId).source.authorId,
            })),
          },
        ],
        ...options,
      },
    });
  };
  addInterpretation(
    "garden-water",
    ["demo-201", "demo-203"],
    ["sana"],
    ["rooftop garden", "shared budget"],
    "Sana would fund rain barrels before raised beds.",
    {
      competingWith: ["garden-beds"],
      qualifications: [
        "Agreement on growing food does not imply agreement on spending priorities.",
        "This is a purchase preference in June, not an enduring personal trait.",
      ],
    },
  );
  addInterpretation(
    "garden-beds",
    ["demo-202"],
    ["jules"],
    ["rooftop garden", "shared budget"],
    "Jules would buy raised beds before rain barrels.",
  );
  addInterpretation(
    "library-hours",
    ["demo-301", "demo-303"],
    ["nia"],
    ["little library", "evening classes"],
    "Nia offers Wednesday evening library shifts through July.",
    {
      contextSourceIds: ["demo-302"],
      qualifications: [
        "Wednesdays only, until the class ends in July.",
        "Theo's joke does not support a claim that the library is open all night.",
      ],
    },
  );
  addInterpretation(
    "repair-chairs",
    ["demo-401"],
    ["jules"],
    ["repair café", "shared tools"],
    "Jules proposes starting the repair café with wobbly chairs.",
  );
  addInterpretation(
    "repair-access",
    ["demo-402"],
    ["rowan"],
    ["repair café", "accessibility"],
    "Rowan identifies a step-free route through the side entrance.",
  );
  addInterpretation(
    "quiet-table",
    ["demo-403"],
    ["mira"],
    ["repair café", "accessibility"],
    "Mira offers a quiet table for mending clothes.",
  );
  addInterpretation(
    "night-vision",
    ["demo-501"],
    ["theo"],
    ["observatory", "night sky"],
    "Theo suggests red torches for the meteor watch.",
  );
  addInterpretation(
    "cloudy-backup",
    ["demo-502"],
    ["sana"],
    ["observatory", "night sky"],
    "Sana offers star charts and an indoor backup if it is cloudy.",
  );
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
            ...[...new Set(annotations.map((row) => row.episode_id))].map((episodeId) => {
              const members = annotations.filter((row) => row.episode_id === episodeId);
              return {
                key: episodeId.split(":").at(-1),
                label: `Fictional ${members[0].candidate.topics[0]} discussion`,
                sourceIds: [...new Set(members.flatMap((row) => row.candidate.sourceIds))],
                contextIds: [
                  ...new Set(members.flatMap((row) => row.candidate.contextSourceIds ?? [])),
                ],
              };
            }),
          ],
        },
      },
    ],
  };
}
export function demoSnapshot() {
  const rows = [
    ["demo-lobby", "2026-05", 38, 35, 9, 4, 3, 4, 2],
    ["rooftop-garden", "2026-06", 64, 60, 18, 7, 3, 24, 4],
    ["little-library", "2026-06", 42, 39, 12, 5, 2, 17, 3],
    ["repair-cafe", "2026-07", 56, 50, 16, 6, 3, 20, 2],
    ["night-sky", "2026-07", 31, 28, 8, 3, 2, 12, 1],
  ].map(
    ([channel_id, month, stored, usable, reviewed, context, represented, selected, deferred]) => ({
      guild_id: "juniper-commons",
      channel_id,
      month,
      stored,
      usable,
      reviewed,
      context,
      represented,
      selected,
      deferred,
      thread_rows: 2,
      without_review_receipt: usable - reviewed,
      first: `${month}-01T12:00:00Z`,
      last: `${month}-28T12:00:00Z`,
    }),
  );
  const totals = Object.fromEntries(
    [
      "stored",
      "usable",
      "reviewed",
      "context",
      "represented",
      "selected",
      "deferred",
      "thread_rows",
      "without_review_receipt",
    ].map((field) => [field, rows.reduce((sum, row) => sum + row[field], 0)]),
  );
  const graph = buildGraph(demoRecords());
  return {
    generatedAt: new Date().toISOString(),
    mode: "FICTIONAL DEMO · not Discord history",
    demo: {
      community: "Juniper Commons",
      description:
        "Six neighbors. A rooftop garden, a little library and a few plans worth remembering. Every person, message and number is fictional.",
      stories: [
        {
          id: "correction",
          label: "01 / A better understanding",
          title: "A preference, corrected",
          description:
            "Mira wanted a train for one trip. Follow the correction from a broad label to a specific, sourced understanding.",
          nodeId: "candidate:trip-plan@2",
          depth: 1,
        },
        {
          id: "source-edit",
          label: "02 / Evidence can change",
          title: "When the source changes",
          description:
            "Rowan edited morning to afternoon. Compare the original quotation with the current message, and see why the interpretation is stale.",
          nodeId: "candidate:afternoon-plan@1",
          depth: 1,
        },
        {
          id: "disagreement",
          label: "03 / Hold both perspectives",
          title: "One garden, two priorities",
          description:
            "Sana wants rain barrels; Jules wants raised beds. Explore the recorded disagreement without turning it into a consensus.",
          nodeId: "candidate:garden-water@1",
          depth: 1,
        },
        {
          id: "coverage",
          label: "04 / Know the boundaries",
          title: "How much is understood?",
          description:
            "Stored, reviewed and represented are different measurements. Explore five fictional channels and see what remains unknown.",
          view: "coverage",
        },
      ],
    },
    graph,
    coverage: {
      archive: {
        status: "available",
        rows,
        total: totals,
        inventory: "unknown",
        note: "All counts are fictional. These overlapping stages describe the example archive; a complete server inventory remains unknown.",
      },
      pilot: {
        currentCandidates: graph.nodes.filter(
          (n) => n.type === "candidate" && n.status === "candidate",
        ).length,
        annotationVersions: graph.nodes.filter((n) => n.type === "candidate").length,
        episodes: [
          { status: "done", count: 8 },
          { status: "deferred", count: 3 },
        ],
        cache: { stored: 24, nondeleted: 24, first: rows[0].first, last: rows.at(-1).last },
        memory: { entries: 12 },
      },
      stages: Object.fromEntries(
        ["reviewed", "context", "represented", "selected", "deferred"].map((key) => [
          key,
          totals[key],
        ]),
      ),
    },
  };
}
