// Read-only demonstration. It selects and assembles profiles in memory.
// It does not create tables, maintain ledgers, or write to the corpus.
// Required environment: MUDFUT_PROFILE_DEMO=1, MUDFUT_CORPUS_HOST, MUDFUT_CORPUS_PORT,
// MUDFUT_CORPUS_USER, MUDFUT_CORPUS_DATABASE, MUDFUT_GUILD_ID.

import pg from "pg";

import { assembleProfile } from "./member-profile.mjs";
import { loadMemberEvidence } from "./member-profile-store.mjs";

if (process.env.MUDFUT_PROFILE_DEMO !== "1") {
  console.error("Refusing to run without MUDFUT_PROFILE_DEMO=1.");
  process.exit(1);
}
const required = [
  "MUDFUT_CORPUS_HOST",
  "MUDFUT_CORPUS_PORT",
  "MUDFUT_CORPUS_USER",
  "MUDFUT_CORPUS_DATABASE",
  "MUDFUT_GUILD_ID",
];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing ${key}.`);
    process.exit(1);
  }
}

const guildId = process.env.MUDFUT_GUILD_ID;
const db = new pg.Client({
  host: process.env.MUDFUT_CORPUS_HOST,
  port: Number(process.env.MUDFUT_CORPUS_PORT),
  user: process.env.MUDFUT_CORPUS_USER,
  database: process.env.MUDFUT_CORPUS_DATABASE,
  options: "-c default_transaction_read_only=on -c statement_timeout=120000",
});

function legacySample(rows) {
  const ordered = rows
    .slice()
    .sort(
      (left, right) =>
        String(left.occurredAt).localeCompare(String(right.occurredAt)) ||
        String(left.statementId).localeCompare(String(right.statementId)),
    );
  const total = ordered.length;
  const stride = Math.max(Math.floor(total / 24), 1);
  const picked = ordered.filter((_, index) => {
    const rn = index + 1;
    return rn === 1 || rn === total || rn % stride === 0;
  });
  return new Set(picked.slice(0, 24).map((row) => row.statementId));
}

function summarize(label, rows, started) {
  const profile = assembleProfile({
    member: { id: rows[0]?.memberId ?? "none", name: label },
    statements: rows,
    maintenance: { ledger: "not-installed", stale: false, updatedAt: null, changedBecause: null },
  });
  const sampled = legacySample(rows);
  const omitted = rows.filter((row) => !sampled.has(row.statementId));
  const kept = omitted[0];
  const evidence = kept
    ? assembleProfile({
        member: { id: kept.memberId, name: label },
        statements: rows,
        view: "evidence",
        statementId: kept.statementId,
      })
    : null;
  const changes = assembleProfile({
    member: { id: rows[0]?.memberId ?? "none", name: label },
    statements: rows,
    view: "changes",
  });
  return {
    label,
    memberId: rows[0]?.memberId ?? null,
    elapsedMs: Date.now() - started,
    statements: rows.length,
    messages: profile.coverage.messagesConsidered,
    topics: profile.coverage.topicsConsidered,
    positions: profile.coverage.positionsConsidered,
    current: profile.coverage.currentStatements,
    notCurrent: profile.coverage.notCurrentStatements,
    pageTopics: profile.page.returned,
    pageTotal: profile.page.total,
    oldSampleReturned: Math.min(24, sampled.size),
    omittedByOldSample: omitted.length,
    omittedStillFound: Boolean(evidence?.found),
    omittedMessageId: evidence?.evidence?.[0]?.messageId ?? null,
    omittedTopic: kept?.topic ?? null,
    selfDescriptions: profile.selfDescriptionCount,
    changes: profile.changeCount,
    conflicts: profile.conflictCount,
    contextDependent: profile.contextDependentCount,
    uncertainties: profile.uncertaintyCount,
    clustering: profile.coverage.clustering,
    ledger: profile.coverage.ledger,
    extractionReviewCoverage: profile.coverage.extractionReviewCoverage,
    firstChange: changes.rows?.find((row) => row.section === "changes")
      ? {
          messageId: changes.rows.find((row) => row.section === "changes").messageId,
          kind: "explicit-change",
        }
      : null,
    firstConflict: changes.rows?.find((row) => row.section === "conflicts") ? "present" : null,
    firstContext: changes.rows?.find((row) => row.section === "contextDependent")
      ? "present"
      : null,
    topTopics: profile.topics.slice(0, 5).map((topic) => ({
      topic: topic.topic,
      messages: topic.independentMessages,
      positions: topic.positionsConsidered,
      repeated: topic.repeatedPositions,
      singletons: topic.singletonPositions,
      previewed: topic.positions.length,
    })),
    uncertaintyKinds: profile.uncertaintyKinds,
  };
}

await db.connect();
try {
  const mode = await db.query("SHOW default_transaction_read_only");
  if (mode.rows[0].default_transaction_read_only !== "on")
    throw new Error("The demonstration connection is not read-only.");
  const volumes = await db.query(
    `SELECT subject_member_id AS id, count(*)::int AS statements,
       (SELECT author_display_name FROM messages m
        WHERE m.guild_id = s.guild_id AND m.author_id = s.subject_member_id
          AND m.deleted_at IS NULL AND m.author_display_name IS NOT NULL
        ORDER BY m.created_at DESC LIMIT 1) AS name
     FROM v2_statements s WHERE guild_id = $1
     GROUP BY guild_id, subject_member_id
     ORDER BY statements DESC`,
    [guildId],
  );
  const members = volumes.rows;
  const chosen = [
    members[0],
    members.find((row) => row.statements >= 80 && row.statements <= 400),
    [...members].reverse().find((row) => row.statements > 0 && row.statements <= 4),
  ].filter(Boolean);
  const reports = [];
  for (const member of chosen) {
    const started = Date.now();
    const rows = await loadMemberEvidence(db, guildId, member.id);
    reports.push({ name: member.name, ...summarize(member.name, rows, started) });
  }
  const prolific = reports[0];
  const hiddenCheck = await db.query(
    `SELECT r.channel_id AS channel, count(*)::int AS n
     FROM v2_statements s
     JOIN v2_source_revisions r
       ON r.guild_id = s.guild_id AND r.message_id = s.source_message_id
      AND r.revision_id = s.source_revision_id AND r.author_id = s.subject_member_id
     WHERE s.guild_id = $1 AND s.subject_member_id = $2
     GROUP BY r.channel_id ORDER BY n ASC LIMIT 1`,
    [guildId, prolific.memberId],
  );
  const hiddenChannel = hiddenCheck.rows[0]?.channel ?? null;
  let visibility = null;
  if (hiddenChannel) {
    const rows = await loadMemberEvidence(db, guildId, prolific.memberId);
    const full = assembleProfile({
      member: { id: prolific.memberId, name: prolific.name },
      statements: rows,
    });
    const filteredRows = rows.filter((row) => row.channelId !== hiddenChannel);
    const filtered = assembleProfile({
      member: { id: prolific.memberId, name: prolific.name },
      statements: filteredRows,
    });
    const hiddenIds = new Set(
      rows.filter((row) => row.channelId === hiddenChannel).map((row) => row.statementId),
    );
    visibility = {
      withheldChannelStatements: hiddenIds.size,
      fullConsidered: full.coverage.statementsConsidered,
      filteredConsidered: filtered.coverage.statementsConsidered,
      hiddenIdsAbsent: [...hiddenIds].every((id) => !filtered.audit.statementIds.includes(id)),
    };
  }
  const checkpoints = await db.query(
    `SELECT processing_state::text AS state, count(*)::int AS n
     FROM v2_processing_checkpoints
     WHERE guild_id = $1 AND process_kind = 'statement_extraction'
     GROUP BY 1 ORDER BY 1`,
    [guildId],
  );
  const changeMember = (
    await db.query(
      `SELECT subject_member_id AS id,
         (SELECT author_display_name FROM messages m
          WHERE m.guild_id = s.guild_id AND m.author_id = s.subject_member_id
            AND m.deleted_at IS NULL AND m.author_display_name IS NOT NULL
          ORDER BY m.created_at DESC LIMIT 1) AS name,
         count(*)::int AS statements
       FROM v2_statements s
       WHERE guild_id = $1 AND exact_quote ~* 'changed my mind|\\mi no longer\\M'
       GROUP BY guild_id, subject_member_id
       ORDER BY count(*) ASC
       LIMIT 1`,
      [guildId],
    )
  ).rows[0];
  let explicitChange = null;
  if (changeMember) {
    const started = Date.now();
    const rows = await loadMemberEvidence(db, guildId, changeMember.id);
    const profile = assembleProfile({
      member: { id: changeMember.id, name: changeMember.name },
      statements: rows,
      view: "changes",
    });
    const overview = assembleProfile({
      member: { id: changeMember.id, name: changeMember.name },
      statements: rows,
    });
    explicitChange = {
      name: changeMember.name,
      memberId: changeMember.id,
      statements: rows.length,
      elapsedMs: Date.now() - started,
      linkedChanges: profile.rows.filter((row) => row.section === "changes").length,
      unresolvedChangeMentions: overview.uncertaintyKinds?.["change-of-mind"] ?? 0,
      uncertaintyKinds: overview.uncertaintyKinds,
      changes: profile.rows
        .filter((row) => row.section === "changes")
        .slice(0, 3)
        .map((row) => ({
          messageId: row.messageId,
          revisionId: row.revisionId,
          topic: row.topic,
          pastPolarity: row.pastPolarity,
          currentPolarity: row.currentPolarity,
        })),
    };
  }
  console.log(
    JSON.stringify(
      {
        readOnly: true,
        wrote: false,
        guildMembersWithStatements: members.length,
        statementTotal: members.reduce((sum, row) => sum + row.statements, 0),
        extractionCheckpoints: checkpoints.rows,
        extractionReviewCoverage: "unknown",
        reports,
        visibility,
        explicitChange,
      },
      null,
      2,
    ),
  );
} finally {
  await db.end();
}
