import {
  assembleProfile,
  evidenceDigest,
  freshnessOf,
  presentProfile,
  resolveNameCandidates,
  statementDigest,
} from "./member-profile.mjs";
import { digest, sourceRecord } from "./pilot-store.mjs";
import {
  profileReviewBatch,
  validateProfileReview,
  reviewedProfilePositions,
  PROFILE_REVIEW_CHARACTERS,
} from "./member-profile-review.mjs";
import {
  isReadOnly,
  ledgerState,
  loadMemberEvidence,
  maintainMemberProfile,
  profileTablesReady,
  loadProfileReviews,
  saveProfileReview,
  MEMBER_EVIDENCE_SQL,
} from "./member-profile-store.mjs";

const SNOWFLAKE = /^[0-9]{17,20}$/u;
const VIEWS = new Set([
  "overview",
  "topic",
  "changes",
  "evidence",
  "roster",
  "review",
  "synthesis",
]);

export const MEMBER_PROFILE_TOOL = {
  name: "member_positions",
  description:
    "Evidence-backed member profile from all available visible statements. The lexical index is not semantic understanding. view=overview provides bounded evidence plus saved model interpretations and separate processing coverage. view=topic pages a topic's claims; view=changes shows dated changes/conflicts; view=evidence opens a statement or position. view=review returns at most 32 original-backed pending statements and an exact batchToken; submit review.decisions for EVERY packet statement to save revisable interpretations. Give justified paraphrases the same concept/claimKey, preserve conditions, and classify implied sarcasm/quotation from original context instead of guessing literal endorsement. Existing reviewedConcepts help consistent naming across batches. view=synthesis pages ALL saved current interpretations, including important one-off claims. Semantic review may remain pending: never call a partial review a complete profile. Cite messageId/revisionId; originals, not summaries, are evidence. Current caller AND reply-audience visibility is supplied by the application, never the model.",
  parameters: {
    type: "object",
    properties: {
      member: { type: "string", minLength: 1, maxLength: 100 },
      topic: { type: "string", minLength: 1, maxLength: 200 },
      view: {
        type: "string",
        enum: ["overview", "topic", "changes", "evidence", "roster", "review", "synthesis"],
      },
      statementId: { type: "string", minLength: 8, maxLength: 80 },
      positionId: { type: "string", minLength: 8, maxLength: 80 },
      cursor: { type: "string", minLength: 1, maxLength: 200 },
      review: {
        type: "object",
        description:
          "Submit interpretations for every statement in the most recent review packet. Exact batchToken and evidence IDs are required. Meaning stays a revisable model interpretation.",
        properties: {
          batchToken: { type: "string", minLength: 32, maxLength: 128 },
          decisions: {
            type: "array",
            maxItems: 32,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                statementId: { type: "string" },
                disposition: {
                  type: "string",
                  enum: [
                    "position",
                    "self-description",
                    "quotation",
                    "third-party",
                    "hypothetical",
                    "sarcasm",
                    "uncertain",
                    "no-position",
                    "attribution-correction",
                    "change",
                  ],
                },
                concept: { type: "string", maxLength: 160 },
                topic: { type: "string", maxLength: 200 },
                claimKey: { type: "string", maxLength: 200 },
                proposition: { type: "string", maxLength: 2000 },
                direction: {
                  type: "string",
                  enum: ["support", "oppose", "neutral", "withdrawn", "unspecified"],
                },
                changeKind: { type: "string", enum: ["withdrawal", "reversal", "unspecified"] },
                qualifiers: { type: "array", items: { type: "string" } },
                conditions: { type: "array", items: { type: "string" } },
                sourceIds: { type: "array", items: { type: "string" } },
                evidenceStatementIds: { type: "array", items: { type: "string" } },
                exactQuote: { type: "string", maxLength: 200 },
                rationale: { type: "string", maxLength: 2000 },
              },
              required: ["statementId", "disposition"],
            },
          },
        },
        required: ["batchToken", "decisions"],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
};

export function memberProfileInput(input) {
  if (input == null)
    return {
      member: null,
      topic: null,
      view: "overview",
      statementId: null,
      positionId: null,
      cursor: null,
    };
  if (typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid member position request");
  const allowed = ["member", "topic", "view", "statementId", "positionId", "cursor", "review"];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new Error("Invalid member position request");
  const member = input.member == null ? null : String(input.member).trim();
  const topic = input.topic == null ? null : String(input.topic).trim();
  const view =
    input.view ?? (topic && member ? "topic" : member ? "overview" : topic ? "topic" : "roster");
  if (!VIEWS.has(view)) throw new Error("Invalid member position request");
  if (!member && !["overview", "roster", "topic"].includes(view))
    throw new Error("This profile view requires a member");
  if (
    input.review != null &&
    (view !== "review" ||
      !member ||
      typeof input.review !== "object" ||
      Array.isArray(input.review))
  )
    throw new Error("A profile review requires a named member and the review view");
  if (member != null && (member.length < 1 || member.length > 100))
    throw new Error("Member must be a Discord id or a name of 1–100 characters");
  if (topic != null && (topic.length < 1 || topic.length > 200))
    throw new Error("Topic must be 1–200 characters");
  for (const key of ["statementId", "positionId", "cursor"]) {
    if (
      input[key] != null &&
      (typeof input[key] !== "string" || input[key].length < 1 || input[key].length > 200)
    )
      throw new Error("Invalid member position request");
  }
  return {
    member,
    topic,
    view,
    statementId: input.statementId ?? null,
    positionId: input.positionId ?? null,
    cursor: input.cursor ?? null,
    ...(input.review != null ? { review: input.review } : {}),
  };
}

export function callerIdFromBatch(batch) {
  if (!batch?.rows) return null;
  const row = batch.rows.find((item) => item.id === batch.replyTo) ?? batch.rows[0];
  const id = row?.source?.authorId;
  return typeof id === "string" && SNOWFLAKE.test(id) ? id : null;
}

export function applicationProfileRequest(modelInput, turn) {
  const request = memberProfileInput(modelInput ?? {});
  if (
    !turn ||
    !Array.isArray(turn.visibleChannelIds) ||
    turn.visibleChannelIds.some((id) => !SNOWFLAKE.test(id))
  )
    return { unavailable: true, request };
  return {
    unavailable: false,
    request,
    visibleChannelIds: turn.visibleChannelIds.slice(),
    callerId: turn.callerId ?? null,
  };
}

export function unavailableProfile(reason = "Caller channel visibility is unresolved.") {
  return {
    scope: "unavailable",
    reason,
    coverage: {
      ledger: "not-installed",
      stale: false,
      extractionReviewCoverage: "unknown",
      sourceArchiveCoverage: "not-measured",
      visibility: "caller-channels",
    },
    guidance:
      "No profile was returned because the caller's current channel visibility is unresolved.",
  };
}

function escapeLike(value) {
  return value.replace(/[\\%_]/gu, (char) => `\\${char}`);
}

// Register actual originals shown by this result, never an extracted proposition
// masquerading as an original. The native reply path revalidates these sources.
function profileEvidenceIds(result) {
  const messages = new Set();
  const statements = new Set();
  const collect = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.messageId === "string") messages.add(value.messageId);
    if (typeof value.statementId === "string") statements.add(value.statementId);
    if (Array.isArray(value.statementIds)) value.statementIds.forEach((id) => statements.add(id));
    if (Array.isArray(value.sourceIds)) value.sourceIds.forEach((id) => messages.add(id));
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(collect);
      else if (child && typeof child === "object") collect(child);
    }
  };
  collect(result);
  return { messages, statements };
}

export function profileSources(result, rows, guildId) {
  const { messages, statements } = profileEvidenceIds(result);
  const sources = new Map();
  for (const row of rows) {
    if (
      row.freshness !== "current" ||
      typeof row.sourceContent !== "string" ||
      (!messages.has(row.messageId) && !statements.has(row.statementId))
    )
      continue;
    sources.set(row.messageId, {
      id: row.messageId,
      guildId,
      channelId: row.channelId,
      authorId: row.memberId,
      authorName: row.authorName ?? null,
      content: row.sourceContent,
      createdAt: new Date(row.sourceCreatedAt ?? row.occurredAt).toISOString(),
      editedAt: row.sourceEditedAt ? new Date(row.sourceEditedAt).toISOString() : null,
      replyTo: row.replyTo ?? null,
      url: `https://discord.com/channels/${guildId}/${row.channelId}/${row.messageId}`,
    });
    for (const context of row.sourceContext ?? []) {
      if (
        context.visible !== true ||
        context.freshness !== "current" ||
        context.channelId !== row.channelId ||
        typeof context.content !== "string"
      )
        continue;
      sources.set(context.messageId, {
        id: context.messageId,
        guildId,
        channelId: context.channelId,
        authorId: context.memberId,
        authorName: context.authorName ?? null,
        content: context.content,
        createdAt: new Date(context.occurredAt).toISOString(),
        editedAt: context.editedAt ? new Date(context.editedAt).toISOString() : null,
        url: `https://discord.com/channels/${guildId}/${context.channelId}/${context.messageId}`,
      });
    }
  }
  return [...sources.values()];
}

function attachProfileEvidence(result, rows, guildId) {
  const { statements } = profileEvidenceIds(result);
  return {
    ...result,
    sources: profileSources(result, rows, guildId),
    profileReferences: rows
      .filter((row) => row.freshness === "current" && statements.has(row.statementId))
      .map((row) => ({
        guildId,
        memberId: row.memberId,
        statementId: row.statementId,
        channelId: row.channelId,
        inputDigest: statementDigest(row),
      })),
  };
}

export async function validateProfileArtifacts(
  history,
  references,
  { visibleChannelIds, excluded = new Set() } = {},
) {
  if (!Array.isArray(references) || references.length > 1024 || !Array.isArray(visibleChannelIds))
    throw new Error("Invalid profile artifact validation packet");
  const groups = new Map();
  for (const reference of references) {
    if (!visibleChannelIds.includes(reference.channelId) || excluded.has(reference.memberId))
      throw new Error("Profile artifact is no longer visible");
    const key = `${reference.guildId}:${reference.memberId}`;
    const group = groups.get(key) ?? [];
    group.push(reference);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const { rows } = await history.query(
      `SELECT * FROM (${MEMBER_EVIDENCE_SQL}) evidence WHERE evidence."statementId" = ANY($4::text[])`,
      [
        group[0].guildId,
        group[0].memberId,
        visibleChannelIds,
        group.map((item) => item.statementId),
      ],
    );
    const current = new Map(
      rows.map((row) => [
        row.statementId,
        {
          ...row,
          freshness: freshnessOf(row),
          sourceContext: (row.sourceContext ?? []).filter((item) => !excluded.has(item.memberId)),
        },
      ]),
    );
    for (const reference of group) {
      const row = current.get(reference.statementId);
      if (!row || row.freshness !== "current" || statementDigest(row) !== reference.inputDigest)
        throw new Error("Profile evidence was revised or invalidated during generation");
    }
  }
}

export async function validateProfileOriginals(transport, sources) {
  if (!Array.isArray(sources) || sources.length > 256)
    throw new Error("Invalid profile original-source packet");
  for (const expected of sources) {
    const original = await transport.get(expected.channelId, expected.id);
    if (!original) throw new Error("Profile source disappeared during generation");
    const actual = sourceRecord(original, expected.guildId, expected.channelId);
    if (
      actual.id !== expected.id ||
      actual.authorId !== expected.authorId ||
      actual.content !== expected.content ||
      Date.parse(actual.createdAt) !== Date.parse(expected.createdAt) ||
      (actual.editedAt ? Date.parse(actual.editedAt) : null) !==
        (expected.editedAt ? Date.parse(expected.editedAt) : null)
    )
      throw new Error("Profile source changed during generation");
  }
}

export async function profileCandidateChannels(history, guildId) {
  if (!SNOWFLAKE.test(guildId)) throw new Error("Invalid profile guild");
  const { rows } = await history.query(
    "SELECT DISTINCT channel_id FROM v2_source_revisions WHERE guild_id = $1 ORDER BY channel_id",
    [guildId],
  );
  return rows.map((row) => row.channel_id).filter((id) => SNOWFLAKE.test(id));
}

export async function profileArchiveReady(history) {
  const { rows } = await history.query(
    `SELECT bool_and(to_regclass(name) IS NOT NULL AND
      COALESCE(has_table_privilege(to_regclass(name), 'SELECT'), false)) AS ready
     FROM unnest($1::text[]) AS required(name)`,
    [
      [
        "messages",
        "v2_statements",
        "v2_source_revisions",
        "v2_invalidations",
        "v2_validity_intervals",
      ],
    ],
  );
  return rows[0]?.ready === true;
}

export async function profileExcludedMembers(writer, botId = null) {
  const excluded = new Set(botId ? [botId] : []);
  if (!writer) return excluded;
  const relation = await writer.query("SELECT to_regclass('pilot_optouts') AS name");
  if (relation.rows[0]?.name) {
    const optouts = await writer.query("SELECT author_id FROM pilot_optouts");
    for (const row of optouts.rows) excluded.add(row.author_id);
  }
  return excluded;
}

async function sightings(history, guildId, visibleChannelIds, query, excluded) {
  const { rows } = await history.query(
    `SELECT author_id AS id, author_display_name AS name, max(created_at) AS "seenAt"
     FROM messages
     WHERE guild_id = $1 AND deleted_at IS NULL AND channel_id = ANY($2::text[])
       AND author_display_name IS NOT NULL
       AND NOT (author_id = ANY($3::text[]))
       AND author_id IN (
         SELECT author_id FROM messages
         WHERE guild_id = $1 AND deleted_at IS NULL AND channel_id = ANY($2::text[])
           AND author_display_name IS NOT NULL
           AND NOT (author_id = ANY($3::text[]))
           AND (lower(author_display_name) = lower($4) OR author_display_name ILIKE $5 ESCAPE '\\')
       )
     GROUP BY author_id, author_display_name
     ORDER BY author_id`,
    [guildId, visibleChannelIds, excluded, query, `%${escapeLike(query)}%`],
  );
  return rows;
}

async function currentName(history, guildId, memberId, visibleChannelIds) {
  const { rows } = await history.query(
    `SELECT author_display_name AS name
     FROM messages
     WHERE guild_id = $1 AND author_id = $2 AND deleted_at IS NULL
       AND channel_id = ANY($3::text[]) AND author_display_name IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [guildId, memberId, visibleChannelIds],
  );
  return rows[0]?.name ?? null;
}

export async function memberPositions(history, input) {
  if (!history || !SNOWFLAKE.test(input?.guildId ?? ""))
    throw new Error("Member positions require the archive");
  if (
    !Array.isArray(input.visibleChannelIds) ||
    input.visibleChannelIds.some((id) => !SNOWFLAKE.test(id))
  )
    return unavailableProfile();
  const request = memberProfileInput({
    member: input.member,
    topic: input.topic,
    view: input.view,
    statementId: input.statementId,
    positionId: input.positionId,
    cursor: input.cursor,
    review: input.review,
  });
  const visible = input.visibleChannelIds;
  const excluded = await profileExcludedMembers(input.profileWriter, input.botId);
  for (const member of input.excludedMembers ?? []) excluded.add(member);
  if (!request.member && request.view !== "topic") {
    const rosterScope = digest(
      JSON.stringify({
        guild: input.guildId,
        visible: [...visible].sort(),
        excluded: [...excluded].sort(),
      }),
    );
    let offset = 0;
    if (request.cursor) {
      let page;
      try {
        page = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"));
      } catch {
        throw new Error("Invalid member roster cursor");
      }
      if (
        page.view !== "roster" ||
        page.scope !== rosterScope ||
        !Number.isSafeInteger(page.offset) ||
        page.offset < 0
      )
        throw new Error("Invalid member roster cursor");
      offset = page.offset;
    }
    const { rows } = await history.query(
      `WITH names AS (
         SELECT DISTINCT ON (author_id) author_id, author_display_name
         FROM messages
         WHERE guild_id = $1 AND deleted_at IS NULL AND channel_id = ANY($2::text[])
           AND NOT (author_id = ANY($3::text[])) AND author_display_name IS NOT NULL
         ORDER BY author_id, created_at DESC
       ),
       counts AS (
         SELECT s.subject_member_id, count(*)::int AS statements
         FROM v2_statements s
         JOIN v2_source_revisions r
           ON r.guild_id = s.guild_id AND r.message_id = s.source_message_id
          AND r.revision_id = s.source_revision_id AND r.author_id = s.subject_member_id
         WHERE s.guild_id = $1 AND r.channel_id = ANY($2::text[])
         GROUP BY 1
       )
       SELECT n.author_id AS id, n.author_display_name AS name, COALESCE(c.statements, 0)::int AS statements,
         count(*) OVER()::int AS total
       FROM names n LEFT JOIN counts c ON c.subject_member_id = n.author_id
       ORDER BY statements DESC, name, n.author_id
       LIMIT 80 OFFSET $4`,
      [input.guildId, visible, [...excluded], offset],
    );
    return {
      scope: "roster",
      returned: rows.length,
      members: rows.map(({ total, ...member }) => member),
      total: rows[0]?.total ?? offset,
      truncated: rows.length > 0 && offset + rows.length < rows[0].total,
      nextCursor:
        rows.length > 0 && offset + rows.length < rows[0].total
          ? Buffer.from(
              JSON.stringify({ view: "roster", scope: rosterScope, offset: offset + rows.length }),
            ).toString("base64url")
          : null,
      coverage: {
        extractionReviewCoverage: "unknown",
        sourceArchiveCoverage: "not-measured",
        visibility: "caller-channels",
      },
      guidance:
        "Counts include only statements in channels this caller can view. A count is not a complete profile, and zero is not proof a member was fully reviewed.",
    };
  }
  if (!request.member && request.topic) {
    const topicScope = digest(
      JSON.stringify({
        guild: input.guildId,
        visible: [...visible].sort(),
        excluded: [...excluded].sort(),
        topic: request.topic,
      }),
    );
    let offset = 0;
    if (request.cursor) {
      let page;
      try {
        page = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"));
      } catch {
        throw new Error("Invalid topic roster cursor");
      }
      if (
        page.view !== "topic-roster" ||
        page.scope !== topicScope ||
        !Number.isSafeInteger(page.offset) ||
        page.offset < 0
      )
        throw new Error("Invalid topic roster cursor");
      offset = page.offset;
    }
    const { rows } = await history.query(
      `SELECT s.subject_member_id AS id, count(*)::int AS statements, count(DISTINCT s.source_message_id)::int AS messages,
         count(*) OVER()::int AS total
       FROM v2_statements s
       JOIN v2_source_revisions r
         ON r.guild_id = s.guild_id AND r.message_id = s.source_message_id
        AND r.revision_id = s.source_revision_id AND r.author_id = s.subject_member_id
       WHERE s.guild_id = $1 AND r.channel_id = ANY($2::text[])
         AND NOT (s.subject_member_id = ANY($4::text[]))
         AND to_tsvector('simple', concat_ws(' ', s.normalized_topic, s.normalized_proposition))
           @@ plainto_tsquery('simple', $3)
       GROUP BY s.subject_member_id
       ORDER BY statements DESC, id
       LIMIT 20 OFFSET $5`,
      [input.guildId, visible, request.topic, [...excluded], offset],
    );
    const truncated = rows.length > 0 && offset + rows.length < rows[0].total;
    return {
      scope: "topic-roster",
      topic: request.topic,
      truncated,
      members: rows.map(({ total, ...member }) => member),
      total: rows[0]?.total ?? offset,
      nextCursor: truncated
        ? Buffer.from(
            JSON.stringify({
              view: "topic-roster",
              scope: topicScope,
              offset: offset + rows.length,
            }),
          ).toString("base64url")
        : null,
      guidance: truncated
        ? "This is one page of members with visible statements matching the topic. Continue with nextCursor for the rest; these counts are not profiles."
        : "Counts are visible statements matching the topic. They are not finished profiles.",
    };
  }
  if (excluded.has(request.member))
    return unavailableProfile("A profile is not available for this member.");
  let member = { id: request.member, name: null, matchedNames: [] };
  if (!SNOWFLAKE.test(request.member)) {
    const resolved = resolveNameCandidates(
      request.member,
      await sightings(history, input.guildId, visible, request.member, [...excluded]),
    );
    if (resolved.scope !== "resolved") {
      return {
        scope: resolved.scope,
        query: request.member,
        members: resolved.members,
        truncated: resolved.truncated ?? false,
        guidance:
          resolved.scope === "ambiguous"
            ? "Ask which member before constructing a profile. Names are limited to channels the caller can view."
            : "No visible member matched that name.",
      };
    }
    member = resolved.member;
  } else {
    member = {
      id: request.member,
      name: await currentName(history, input.guildId, request.member, visible),
      matchedNames: [],
    };
  }
  let maintenance = {
    ledger: "not-installed",
    updatedAt: null,
    changedBecause: null,
    stale: false,
  };
  const writer = input.profileWriter ?? null;
  const ledger = writer ?? history;
  if (await profileTablesReady(ledger)) {
    if (writer && input.maintain !== false) {
      try {
        await maintainMemberProfile(writer, {
          guildId: input.guildId,
          memberId: member.id,
          sourceDb: history,
          visibleChannelIds: visible,
          now: input.now,
          stopWhileRunning: input.stopWhileRunning,
          failBeforeCommit: input.failBeforeCommit,
        });
      } catch (error) {
        if (!isReadOnly(error)) throw error;
      }
    }
    maintenance = await ledgerState(ledger, input.guildId, member.id, {
      sourceDb: history,
      visibleChannelIds: visible,
    });
  }
  const evidence = (await loadMemberEvidence(history, input.guildId, member.id))
    .filter((row) => row.channelId && visible.includes(row.channelId))
    .map((row) => ({
      ...row,
      sourceContext: (row.sourceContext ?? []).filter((context) => !excluded.has(context.memberId)),
    }));
  let reviews = writer
    ? await loadProfileReviews(writer, {
        guildId: input.guildId,
        memberId: member.id,
        visibleChannelIds: visible,
      })
    : [];
  if (request.view === "review") {
    const reviewMember = { id: member.id, name: member.name, guildId: input.guildId };
    const batch = profileReviewBatch({
      member: reviewMember,
      statements: evidence,
      reviews,
      maxCharacters: PROFILE_REVIEW_CHARACTERS,
    });
    if (request.review) {
      if (!writer)
        return unavailableProfile(
          "Profile review storage is not configured; the archive remains read-only.",
        );
      const checked = validateProfileReview({ batch, review: request.review });
      if (input.validateOriginals)
        await input.validateOriginals(
          profileSources({ statements: batch.statements }, evidence, input.guildId),
        );
      await saveProfileReview(writer, {
        guildId: input.guildId,
        memberId: member.id,
        visibleChannelIds: visible,
        records: checked.records,
      });
      reviews = await loadProfileReviews(writer, {
        guildId: input.guildId,
        memberId: member.id,
        visibleChannelIds: visible,
      });
    }
    const next = profileReviewBatch({
      member: reviewMember,
      statements: evidence,
      reviews,
      maxCharacters: PROFILE_REVIEW_CHARACTERS,
    });
    const result = {
      scope: "member-review",
      member,
      view: "review",
      ...next,
      storage: writer ? "installed" : "not-installed",
      reviewedConcepts: reviewedProfilePositions({ statements: evidence, reviews })
        .positions.slice(0, 24)
        .map(({ concept, claimKey, proposition, qualifiers, conditions }) => ({
          concept,
          claimKey,
          proposition,
          qualifiers,
          conditions,
        })),
    };
    return attachProfileEvidence(result, evidence, input.guildId);
  }
  const profile = assembleProfile({
    member: { id: member.id, name: member.name ?? null },
    statements: evidence,
    view: ["roster", "synthesis"].includes(request.view) ? "overview" : request.view,
    topic: request.topic,
    cursor: request.view === "synthesis" ? null : request.cursor,
    positionId: request.positionId,
    statementId: request.statementId,
    maintenance,
  });
  const result = presentProfile(profile);
  const reviewed = reviewedProfilePositions({ statements: evidence, reviews });
  const interpreted = reviewed.positions.filter(
    (position) =>
      !request.topic ||
      [position.topic, position.concept].some((value) =>
        value?.toLowerCase().includes(request.topic.toLowerCase()),
      ),
  );
  const publicSemanticPosition = (position) => {
    const { interpretations, ...item } = position;
    return {
      ...item,
      evidence: item.evidence.slice(0, 2),
      evidenceTotal: item.evidence.length,
      evidencePreview: item.evidence.length > 2 ? "open-with-evidence-view" : "complete",
    };
  };
  const semanticScope = digest(
    JSON.stringify({
      member: member.id,
      visible: [...visible].sort(),
      topic: request.topic,
      evidence: evidenceDigest(evidence),
      positions: reviewed.positions.map((position) => position.positionId),
    }),
  );
  let semanticOffset = 0;
  if (request.view === "synthesis" && request.cursor) {
    let page;
    try {
      page = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"));
    } catch {
      throw new Error("Invalid semantic profile cursor");
    }
    if (
      page.member !== member.id ||
      page.scope !== semanticScope ||
      page.view !== "synthesis" ||
      !Number.isSafeInteger(page.offset) ||
      page.offset < 0
    )
      throw new Error("Invalid semantic profile cursor");
    semanticOffset = page.offset;
  }
  const semanticPage = interpreted.slice(semanticOffset, semanticOffset + 16);
  const semantic = {
    ...reviewed,
    positions: semanticPage.map(publicSemanticPosition),
    returned: semanticPage.length,
    total: interpreted.length,
    truncated: semanticOffset + semanticPage.length < interpreted.length,
    nextCursor:
      semanticOffset + semanticPage.length < interpreted.length
        ? Buffer.from(
            JSON.stringify({
              view: "synthesis",
              member: member.id,
              scope: semanticScope,
              offset: semanticOffset + semanticPage.length,
            }),
          ).toString("base64url")
        : null,
    // Every interpretation keeps its evidence, but never re-send the entire
    // maintenance record set inside a bounded conversational reply.
    changes: reviewed.changes.slice(0, 8),
    corrections: reviewed.corrections.slice(0, 8),
    uncertainties: reviewed.uncertainties.slice(0, 8),
  };
  const answer = {
    ...(request.view === "synthesis"
      ? { scope: "member", member, view: "synthesis", coverage: result.coverage }
      : result),
    semantic,
    guidance: `${result.guidance} Semantic interpretations are explicitly model-proposed. If pendingStatements is nonzero, use view=review to consider original context and save decisions; do not call the lexical grouping a completed understanding.`,
  };
  return attachProfileEvidence(answer, evidence, input.guildId);
}

export function memberProfileExecute(memberProfiles, callerVisibility, callerFrom) {
  return async (input) => {
    let visibleChannelIds = null;
    let callerId = null;
    try {
      callerId = callerFrom ? callerFrom() : null;
      visibleChannelIds = callerVisibility ? await callerVisibility() : null;
    } catch {
      return unavailableProfile("Caller channel visibility could not be resolved.");
    }
    const request = applicationProfileRequest(input ?? {}, { callerId, visibleChannelIds });
    if (request.unavailable) return unavailableProfile();
    return memberProfiles(request.request, {
      callerId: request.callerId,
      visibleChannelIds: request.visibleChannelIds,
    });
  };
}

export function buildMemberProfileTool(execute) {
  return { ...MEMBER_PROFILE_TOOL, execute };
}
