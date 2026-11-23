import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";

import { createServer } from "node:net";
import pg from "pg";

import {
  annotationCount,
  ensureMemberProfileSchema,
  ledgerState,
  loadMemberEvidence,
  loadProfileReviews,
  maintainMemberProfile,
  profileScopeKey,
  saveProfileReview,
} from "./member-profile-store.mjs";
import { memberPositions } from "./pilot-profile.mjs";

const exec = promisify(execFile);
const bin = (name) =>
  process.env.MUDFUT_PG_BIN ? join(resolve(process.env.MUDFUT_PG_BIN), name) : name;
async function postgresSkipReason() {
  for (const name of ["initdb", "pg_ctl"]) {
    let version;
    try {
      version = await exec(bin(name), ["--version"]);
    } catch (error) {
      if (process.env.MUDFUT_PG_BIN) throw error;
      return `PostgreSQL 16 integration not run: ${name} is unavailable on PATH; set MUDFUT_PG_BIN`;
    }
    if (!/\b16\./.test(version.stdout)) {
      if (process.env.MUDFUT_PG_BIN)
        throw new Error(`PostgreSQL 16 ${name} required at MUDFUT_PG_BIN`);
      return `PostgreSQL 16 integration not run: PATH resolves a different ${name} version; set MUDFUT_PG_BIN`;
    }
  }
  return false;
}
const skipPostgres = await postgresSkipReason();
const postgresTest = (name, run) => test(name, { skip: skipPostgres }, run);
const guild = "100000000000000001";
const otherGuild = "100000000000000002";
const visible = "300000000000000001";
const hidden = "300000000000000002";
let db;
let root;
let data;
let sequence = 0;
let connection;

async function client(options = {}) {
  const instance = new pg.Client({ ...connection, ...options });
  await instance.connect();
  return instance;
}

function snowflake() {
  sequence += 1;
  return String(700000000000000000n + BigInt(sequence));
}

async function sql(text, values) {
  return db.query(text, values);
}

async function add(input) {
  const id = input.id ?? snowflake();
  const revision = input.revision ?? id;
  const at = input.at ?? "2026-01-15T00:00:00.000Z";
  const hash = input.hash ?? "hash-current";
  await sql(
    `INSERT INTO messages (guild_id, channel_id, message_id, author_id, author_display_name, content, content_hash, created_at, deleted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.guild ?? guild,
      input.channel ?? visible,
      id,
      input.member,
      input.name ?? "Ada",
      input.quote,
      input.messageHash ?? hash,
      at,
      input.deletedAt ?? null,
    ],
  );
  await sql(
    `INSERT INTO v2_source_revisions (guild_id, message_id, revision_id, channel_id, author_id, content_hash, is_current, tombstoned_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.guild ?? guild,
      id,
      revision,
      input.channel ?? visible,
      input.member,
      hash,
      input.current !== false,
      input.tombstonedAt ?? null,
    ],
  );
  const statementId = input.statementId ?? id;
  await sql(
    `INSERT INTO v2_statements (
      guild_id, subject_member_id, statement_id, statement_kind, normalized_topic, normalized_proposition,
      exact_quote, extracted_assertion, source_message_id, source_revision_id, source_occurred_at,
      extractor_version, fact_identity
    ) VALUES ($1,$2,$3,'exact_quote',$4,$5,$6,NULL,$7,$8,$9,$10,$11)`,
    [
      input.guild ?? guild,
      input.member,
      statementId,
      input.topic ?? "levy",
      input.proposition ?? input.quote,
      input.quote,
      id,
      revision,
      at,
      input.extractor ?? "v2-profile-extraction-v1",
      input.fact ?? `fact-${statementId}`,
    ],
  );
  if (input.invalidated) {
    await sql(
      "INSERT INTO v2_invalidations (guild_id, artifact_id, reconciled_at) VALUES ($1,$2,NULL)",
      [input.guild ?? guild, statementId],
    );
  }
  return { id, statementId, revision };
}

test.before(async () => {
  if (skipPostgres) return;
  root = await mkdtemp(join(tmpdir(), "mudfut-profile-"));
  data = join(root, "data");
  const probe = createServer();
  const port = await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve(probe.address().port));
  });
  await new Promise((resolve) => probe.close(resolve));
  await exec(bin("initdb"), [
    "-D",
    data,
    "-U",
    "mudfut_fixture",
    "--auth=trust",
    "--encoding=UTF8",
    "--no-locale",
  ]);
  await exec(
    bin("pg_ctl"),
    [
      "-D",
      data,
      "-l",
      join(root, "server.log"),
      "-o",
      `-c listen_addresses=127.0.0.1 -c port=${port}`,
      "-w",
      "start",
    ],
    { stdio: "ignore" },
  );
  connection = {
    host: "127.0.0.1",
    port,
    user: "mudfut_fixture",
    database: "postgres",
    connectionTimeoutMillis: 5000,
  };
  db = new pg.Client(connection);
  await db.connect();
  await sql(`
    CREATE TABLE messages (
      guild_id text NOT NULL, channel_id text NOT NULL, message_id text NOT NULL,
      author_id text NOT NULL, author_display_name text, content text, content_hash text,
      created_at timestamptz NOT NULL, deleted_at timestamptz, edited_at timestamptz,
      reply_to_message_id text,
      PRIMARY KEY (guild_id, message_id)
    );
    CREATE TABLE v2_source_revisions (
      guild_id text NOT NULL, message_id text NOT NULL, revision_id text NOT NULL,
      channel_id text NOT NULL, author_id text NOT NULL, content_hash text NOT NULL,
      is_current boolean NOT NULL, tombstoned_at timestamptz,
      PRIMARY KEY (guild_id, message_id, revision_id)
    );
    CREATE TABLE v2_statements (
      guild_id text NOT NULL, subject_member_id text NOT NULL, statement_id text NOT NULL,
      statement_kind text NOT NULL, normalized_topic text NOT NULL, normalized_subject text,
      normalized_proposition text NOT NULL,
      exact_quote text, extracted_assertion text, source_message_id text NOT NULL,
      source_revision_id text NOT NULL, source_occurred_at timestamptz NOT NULL,
      extractor_version text NOT NULL, fact_identity text NOT NULL,
      PRIMARY KEY (guild_id, statement_id)
    );
    CREATE TABLE v2_invalidations (
      guild_id text NOT NULL, artifact_id text NOT NULL, reconciled_at timestamptz
    );
    CREATE TABLE v2_validity_intervals (
      guild_id text NOT NULL, member_id text NOT NULL, artifact_id text NOT NULL,
      lifecycle_state text NOT NULL, source_valid_to timestamptz, system_recorded_to timestamptz
    );
  `);
});

test.after(async () => {
  await db?.end().catch(() => {});
  if (data)
    await exec(bin("pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"], {
      stdio: "ignore",
    }).catch(() => {});
  if (root) {
    const trash = join(homedir(), ".Trash");
    await mkdir(trash, { recursive: true });
    const preserved = join(trash, basename(root));
    await rename(root, preserved);
    console.info(`Preserved fictional profile fixture cluster in Trash: ${preserved}`);
  }
});

postgresTest(
  "maintenance is idempotent, resumable, isolated, and stale after a source edit",
  async () => {
    const member = "200000000000000011";
    const other = "200000000000000012";
    const before = (await sql("SELECT count(*)::int AS n FROM v2_statements")).rows[0].n;
    const first = await add({ member, quote: "I support the levy", name: "Ada" });
    await add({ member: other, quote: "I support the harbor", name: "Bea", topic: "harbor" });
    const firstRun = await maintainMemberProfile(db, {
      guildId: guild,
      memberId: member,
      now: new Date("2026-08-01T00:00:00.000Z"),
    });
    assert.equal(firstRun.status, "recorded");
    const otherRun = await maintainMemberProfile(db, {
      guildId: guild,
      memberId: other,
      now: new Date("2026-08-01T00:00:00.000Z"),
    });
    const again = await maintainMemberProfile(db, {
      guildId: guild,
      memberId: member,
      now: new Date("2026-09-01T00:00:00.000Z"),
    });
    assert.equal(again.status, "unchanged");
    const annotations = await annotationCount(db, guild, member);
    assert.equal(annotations.n, 1);
    assert.equal(new Date(annotations.at).toISOString(), "2026-08-01T00:00:00.000Z");
    assert.equal((await sql("SELECT count(*)::int AS n FROM v2_statements")).rows[0].n, before + 2);

    const interrupted = "200000000000000013";
    await add({ member: interrupted, quote: "I support the levy" });
    await assert.rejects(
      () =>
        maintainMemberProfile(db, {
          guildId: guild,
          memberId: interrupted,
          stopWhileRunning: true,
        }),
      /interrupted/,
    );
    const running = (
      await sql(
        "SELECT processing_state, completed_at FROM member_profile_heads WHERE member_id = $1",
        [interrupted],
      )
    ).rows[0];
    assert.equal(running.processing_state, "running");
    assert.equal(running.completed_at, null);
    assert.equal((await ledgerState(db, guild, interrupted)).ledger, "running");
    const resumed = await maintainMemberProfile(db, { guildId: guild, memberId: interrupted });
    assert.equal(resumed.status, "recorded");
    assert.equal((await ledgerState(db, guild, interrupted)).ledger, "current");

    const failing = "200000000000000014";
    await add({ member: failing, quote: "I support the levy" });
    await assert.rejects(
      () =>
        maintainMemberProfile(db, { guildId: guild, memberId: failing, failBeforeCommit: true }),
      /failed/,
    );
    const failed = (
      await sql(
        "SELECT processing_state, completed_at, error_code FROM member_profile_heads WHERE member_id = $1",
        [failing],
      )
    ).rows[0];
    assert.equal(failed.processing_state, "failed");
    assert.equal(failed.completed_at, null);
    assert.equal(failed.error_code, "FORCED_FAILURE");
    assert.notEqual((await ledgerState(db, guild, failing)).ledger, "current");

    const added = await add({
      member,
      quote: "I oppose the bridge",
      topic: "bridge",
      at: "2026-03-01T00:00:00.000Z",
    });
    const updated = await maintainMemberProfile(db, {
      guildId: guild,
      memberId: member,
      now: new Date("2026-10-01T00:00:00.000Z"),
    });
    assert.equal(updated.status, "updated");
    assert.equal(updated.changedBecause, "evidence-changed");
    assert.equal(updated.previousStatementCount, 1);
    assert.equal((await annotationCount(db, guild, member)).n, 2);
    assert.equal(new Date(otherRun.completedAt).toISOString(), "2026-08-01T00:00:00.000Z");
    const kept = await annotationCount(db, guild, other);
    assert.equal(kept.n, 1);
    assert.equal(
      (
        await sql(
          "SELECT statement_id FROM member_profile_annotations WHERE member_id = $1 AND statement_id = $2",
          [member, added.statementId],
        )
      ).rowCount,
      1,
    );

    await maintainMemberProfile(db, {
      guildId: guild,
      memberId: member,
      visibleChannelIds: [visible],
    });
    await sql("UPDATE v2_source_revisions SET is_current = false WHERE message_id = $1", [
      first.id,
    ]);
    await sql("UPDATE messages SET content_hash = 'edited' WHERE message_id = $1", [first.id]);
    const stale = await ledgerState(db, guild, member);
    assert.equal(stale.ledger, "pending");
    assert.equal(stale.stale, true);
    const shown = await memberPositions(db, {
      guildId: guild,
      memberId: member,
      member,
      visibleChannelIds: [visible],
      maintain: false,
      view: "topic",
      topic: "levy",
    });
    assert.equal(shown.coverage.stale, true);
    assert.equal(shown.coverage.ledger, "pending");
    assert.equal(shown.positions[0].status, "historical");
    assert.equal(shown.positions[0].evidence[0].freshness, "edited");
    const refreshed = await maintainMemberProfile(db, { guildId: guild, memberId: member });
    assert.equal(refreshed.changedBecause, "evidence-changed");
    assert.equal((await ledgerState(db, guild, member)).ledger, "current");
  },
);

postgresTest(
  "profiles do not cross guilds or hidden channels, and renames stay attached to the id",
  async () => {
    const member = "200000000000000021";
    const renamed = "200000000000000022";
    const collision = "200000000000000023";
    await add({ member, quote: "I support the visible levy", topic: "visiblelevy" });
    await add({ member, quote: "HIDDEN_CHANNEL_SECRET", topic: "secretlevy", channel: hidden });
    await add({
      guild: otherGuild,
      member,
      quote: "OTHER_GUILD_SECRET",
      topic: "otherlevy",
      channel: visible,
    });
    await add({
      member,
      quote: "I support the deleted levy",
      topic: "deletedlevy",
      deletedAt: "2026-02-01T00:00:00.000Z",
    });
    await add({
      member,
      quote: "I support the invalidated levy",
      topic: "invalidlevy",
      invalidated: true,
    });
    const result = await memberPositions(db, {
      guildId: guild,
      member,
      profileWriter: db,
      visibleChannelIds: [visible],
      view: "overview",
    });
    const body = JSON.stringify(result);
    assert.equal(body.includes("HIDDEN_CHANNEL_SECRET"), false);
    assert.equal(body.includes("OTHER_GUILD_SECRET"), false);
    assert.equal(result.coverage.statementsConsidered, 3);
    assert.equal(result.coverage.ledger, "current");
    assert.equal(
      result.topics
        .flatMap((topic) => topic.positions)
        .some((item) => item.topic === "visiblelevy"),
      true,
    );
    const deleted = await memberPositions(db, {
      guildId: guild,
      member,
      visibleChannelIds: [visible],
      view: "topic",
      topic: "deletedlevy",
      maintain: false,
    });
    assert.equal(deleted.positions[0].status, "historical");
    assert.equal(deleted.positions[0].evidence[0].freshness, "deleted");
    const invalidated = await memberPositions(db, {
      guildId: guild,
      member,
      visibleChannelIds: [visible],
      view: "topic",
      topic: "invalidlevy",
      maintain: false,
    });
    assert.equal(invalidated.positions[0].evidence[0].freshness, "invalidated");

    await add({
      member: renamed,
      name: "Old Name",
      quote: "I support the archive",
      topic: "archive",
      at: "2026-01-01T00:00:00.000Z",
    });
    await add({
      member: renamed,
      name: "New Name",
      quote: "I support the archive index",
      topic: "index",
      at: "2026-06-01T00:00:00.000Z",
    });
    const byOld = await memberPositions(db, {
      guildId: guild,
      member: "Old Name",
      visibleChannelIds: [visible],
      maintain: false,
    });
    assert.equal(byOld.member.id, renamed);
    assert.equal(byOld.member.name, "New Name");
    await add({
      member: collision,
      name: "Old Name",
      quote: "I support a different archive",
      topic: "otherarchive",
    });
    const ambiguous = await memberPositions(db, {
      guildId: guild,
      member: "Old Name",
      visibleChannelIds: [visible],
      maintain: false,
    });
    assert.equal(ambiguous.scope, "ambiguous");
    assert.equal(
      ambiguous.members.some((item) => item.id === renamed && item.name === "New Name"),
      true,
    );
    assert.equal(
      ambiguous.members.some((item) => item.id === collision),
      true,
    );
  },
);

postgresTest(
  "visibility scope canonicalization and isolated ledgers do not expose hidden progress",
  async () => {
    const member = "200000000000000031";
    await add({ member, quote: "I support the visible harbor", channel: visible });
    await add({ member, quote: "I support the private harbor", channel: hidden });
    assert.equal(profileScopeKey([visible, hidden, visible]), profileScopeKey([hidden, visible]));
    assert.notEqual(profileScopeKey([]), profileScopeKey());
    const first = await maintainMemberProfile(db, {
      guildId: guild,
      memberId: member,
      visibleChannelIds: [visible],
      now: new Date("2026-03-01Z"),
    });
    await maintainMemberProfile(db, {
      guildId: guild,
      memberId: member,
      visibleChannelIds: [hidden],
      now: new Date("2026-04-01Z"),
    });
    assert.equal(first.statementCount, 1);
    const before = await ledgerState(db, guild, member, { visibleChannelIds: [visible] });
    assert.equal(before.statementCount, 1);
    await add({ member, quote: "I oppose the private bridge", channel: hidden });
    const after = await ledgerState(db, guild, member, { visibleChannelIds: [visible] });
    assert.deepEqual(after, before);
    assert.equal(
      (await ledgerState(db, guild, member, { visibleChannelIds: [hidden] })).ledger,
      "pending",
    );
    assert.equal(
      (await ledgerState(db, guild, member, { visibleChannelIds: [] })).ledger,
      "not-installed",
    );
    assert.equal((await ledgerState(db, guild, member)).ledger, "not-installed");
    const stored = await sql(
      "SELECT channel_id FROM member_profile_annotations WHERE member_id = $1 AND visibility_scope = $2",
      [member, profileScopeKey([visible])],
    );
    assert.deepEqual(stored.rows, [{ channel_id: visible }]);
  },
);

postgresTest("separate derived database maintains from a read-only source connection", async () => {
  const member = "200000000000000032";
  await add({ member, quote: "I support the source harbor" });
  await sql("CREATE DATABASE member_profile_derived_fixture");
  const reader = await client({ options: "-c default_transaction_read_only=on" });
  const writer = await client({ database: "member_profile_derived_fixture" });
  try {
    assert.equal(
      (await reader.query("SHOW default_transaction_read_only")).rows[0]
        .default_transaction_read_only,
      "on",
    );
    assert.equal(
      (await writer.query("SELECT to_regclass('public.messages') AS name")).rows[0].name,
      null,
    );
    const result = await maintainMemberProfile(writer, {
      guildId: guild,
      memberId: member,
      sourceDb: reader,
      visibleChannelIds: [visible],
    });
    assert.equal(result.statementCount, 1);
    assert.equal(
      (await ledgerState(writer, guild, member, { sourceDb: reader, visibleChannelIds: [visible] }))
        .ledger,
      "current",
    );
    assert.equal(
      (await annotationCount(writer, guild, member, { visibleChannelIds: [visible] })).n,
      1,
    );
    await assert.rejects(
      () => reader.query("CREATE TABLE forbidden_source_write (id integer)"),
      /read-only/,
    );
  } finally {
    await reader.end();
    await writer.end();
  }
});

postgresTest(
  "per-member ownership serializes distinct clients and an old failure cannot overwrite the next run",
  async () => {
    const member = "200000000000000033";
    await add({ member, quote: "I support the first harbor" });
    const firstWriter = await client();
    const nextWriter = await client();
    const reader = await client({ options: "-c default_transaction_read_only=on" });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let initialReady;
    const initial = new Promise((resolve) => {
      initialReady = resolve;
    });
    let reads = 0;
    const pausedSource = {
      query: async (...args) => {
        const result = await reader.query(...args);
        if (++reads === 1) {
          initialReady();
          await gate;
        }
        return result;
      },
    };
    let first;
    let next;
    try {
      first = maintainMemberProfile(firstWriter, {
        guildId: guild,
        memberId: member,
        sourceDb: pausedSource,
        visibleChannelIds: [visible],
      }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await initial;
      let nextFinished = false;
      next = maintainMemberProfile(nextWriter, {
        guildId: guild,
        memberId: member,
        sourceDb: reader,
        visibleChannelIds: [visible],
      }).then((result) => {
        nextFinished = true;
        return result;
      });
      await delay(50);
      assert.equal(nextFinished, false, "the second client must wait for the same member/scope");
      await add({ member, quote: "I support the second harbor" });
      release();
      assert.equal((await first).error?.code, "EVIDENCE_CHANGED");
      assert.equal((await next).statementCount, 2);
      const head = await ledgerState(nextWriter, guild, member, {
        sourceDb: reader,
        visibleChannelIds: [visible],
      });
      assert.equal(head.ledger, "current");
      assert.equal(head.statementCount, 2);
    } finally {
      release();
      await Promise.allSettled([first, next].filter(Boolean));
      await firstWriter.end();
      await nextWriter.end();
      await reader.end();
    }
  },
);

postgresTest(
  "final source revalidation rolls back annotations and preserves the last completed digest",
  async () => {
    const member = "200000000000000034";
    const firstSource = await add({ member, quote: "I support the initial harbor" });
    const writer = await client();
    const reader = await client({ options: "-c default_transaction_read_only=on" });
    try {
      const initial = await maintainMemberProfile(writer, {
        guildId: guild,
        memberId: member,
        sourceDb: reader,
      });
      await add({ member, quote: "I oppose the second harbor" });
      let changed = false;
      const changingWriter = {
        query: async (text, values) => {
          const result = await writer.query(text, values);
          if (!changed && text.includes("INSERT INTO member_profile_annotations")) {
            changed = true;
            await sql(
              "UPDATE messages SET content_hash = 'changed-during-profile-write' WHERE message_id = $1",
              [firstSource.id],
            );
          }
          return result;
        },
      };
      await assert.rejects(
        () =>
          maintainMemberProfile(changingWriter, {
            guildId: guild,
            memberId: member,
            sourceDb: reader,
          }),
        (error) => error.code === "EVIDENCE_CHANGED",
      );
      const head = (
        await writer.query(
          "SELECT processing_state, evidence_digest FROM member_profile_heads WHERE member_id = $1",
          [member],
        )
      ).rows[0];
      assert.equal(head.processing_state, "failed");
      assert.equal(head.evidence_digest, initial.digest);
      assert.equal((await annotationCount(writer, guild, member)).n, 1);
    } finally {
      await reader.end();
      await writer.end();
    }
  },
);

postgresTest(
  "pool transactions use dedicated clients and concurrent same-client calls serialize",
  async () => {
    const a = "200000000000000035";
    const b = "200000000000000036";
    await add({ member: a, quote: "I support the pooled harbor" });
    await add({ member: b, quote: "I support the serial harbor" });
    const pool = new pg.Pool({ ...connection, max: 2 });
    try {
      const results = await Promise.all([
        maintainMemberProfile(pool, { guildId: guild, memberId: a }),
        maintainMemberProfile(pool, { guildId: guild, memberId: a }),
      ]);
      assert.deepEqual(results.map((result) => result.status).sort(), ["recorded", "unchanged"]);
      assert.equal(pool.idleCount, pool.totalCount);
      const same = await Promise.all([
        maintainMemberProfile(db, { guildId: guild, memberId: b }),
        maintainMemberProfile(db, { guildId: guild, memberId: b }),
      ]);
      assert.deepEqual(
        same.map((result) => result.status),
        ["recorded", "unchanged"],
      );
    } finally {
      await pool.end();
    }
  },
);

postgresTest(
  "semantic reviews append idempotently, return latest records, and never cross visibility scope",
  async () => {
    const member = "200000000000000037";
    const base = {
      statementId: "fictional-statement",
      inputDigest: "a".repeat(64),
      validated: true,
      memberId: member,
      guildId: guild,
      disposition: "assertion",
      evidence: [],
    };
    const input = {
      guildId: guild,
      memberId: member,
      visibleChannelIds: [visible],
      records: [base],
    };
    assert.equal((await saveProfileReview(db, input)).inserted, 1);
    assert.equal((await saveProfileReview(db, input)).inserted, 0);
    assert.deepEqual(await loadProfileReviews(db, input), [base]);
    assert.deepEqual(await loadProfileReviews(db, { ...input, visibleChannelIds: [hidden] }), []);
    assert.deepEqual(
      await loadProfileReviews(db, { ...input, memberId: "200000000000000038" }),
      [],
    );
    assert.deepEqual(await loadProfileReviews(db, { ...input, guildId: otherGuild }), []);
    const revised = { ...base, disposition: "uncertain" };
    assert.equal((await saveProfileReview(db, { ...input, records: [revised] })).inserted, 1);
    assert.deepEqual(await loadProfileReviews(db, input), [revised]);
    const rows = await sql(
      "SELECT record FROM member_profile_reviews WHERE member_id = $1 ORDER BY review_id",
      [member],
    );
    assert.deepEqual(
      rows.rows.map((row) => row.record),
      [base, revised],
    );
    await assert.rejects(
      () =>
        sql("UPDATE member_profile_reviews SET record = '{}'::jsonb WHERE member_id = $1", [
          member,
        ]),
      /append-only/,
    );
    assert.equal(
      (
        await sql("SELECT count(*)::int AS n FROM member_profile_reviews WHERE member_id = $1", [
          member,
        ])
      ).rows[0].n,
      2,
    );
  },
);

postgresTest(
  "completed invalidations and closed validity remain historical after reconciliation",
  async () => {
    const member = "200000000000000039";
    const invalid = await add({
      member,
      quote: "I support the invalidated harbor",
      invalidated: true,
    });
    const closed = await add({ member, quote: "I support the closed harbor" });
    const current = await add({ member, quote: "I support the current harbor" });
    await sql("UPDATE v2_invalidations SET reconciled_at = now() WHERE artifact_id = $1", [
      invalid.statementId,
    ]);
    await sql(
      `INSERT INTO v2_validity_intervals
      (guild_id, member_id, artifact_id, lifecycle_state, source_valid_to, system_recorded_to)
     VALUES ($1,$2,$3,'invalidated',now(),now()), ($1,$2,$4,'current',NULL,NULL)`,
      [guild, member, closed.statementId, current.statementId],
    );
    const rows = await loadMemberEvidence(db, guild, member, { visibleChannelIds: [visible] });
    assert.equal(
      rows.find((row) => row.statementId === invalid.statementId).freshness,
      "invalidated",
    );
    assert.equal(
      rows.find((row) => row.statementId === closed.statementId).freshness,
      "invalidated",
    );
    assert.equal(rows.find((row) => row.statementId === current.statementId).freshness, "current");
    const initial = await maintainMemberProfile(db, { guildId: guild, memberId: member });
    await sql(
      "UPDATE v2_statements SET source_occurred_at = '2026-07-01Z' WHERE statement_id = $1",
      [current.statementId],
    );
    assert.equal((await ledgerState(db, guild, member)).ledger, "pending");
    assert.notEqual(
      (await maintainMemberProfile(db, { guildId: guild, memberId: member })).digest,
      initial.digest,
    );
  },
);

postgresTest("read-only profile viewing does not create a missing member head", async () => {
  const member = "200000000000000040";
  await add({ member, quote: "I support the read-only harbor" });
  const reader = await client({ options: "-c default_transaction_read_only=on" });
  try {
    const result = await memberPositions(reader, {
      guildId: guild,
      member,
      visibleChannelIds: [visible],
      view: "overview",
    });
    assert.equal(result.coverage.ledger, "not-installed");
    assert.equal(
      (
        await sql("SELECT count(*)::int AS n FROM member_profile_heads WHERE member_id = $1", [
          member,
        ])
      ).rows[0].n,
      0,
    );
  } finally {
    await reader.end();
  }
});

postgresTest(
  "different visibility scopes may complete independently while one scope is paused",
  async () => {
    const member = "200000000000000041";
    await add({ member, quote: "I support the visible scope", channel: visible });
    await add({ member, quote: "I support the hidden scope", channel: hidden });
    const a = await client();
    const b = await client();
    let ready;
    const started = new Promise((resolve) => {
      ready = resolve;
    });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let once = true;
    let first;
    try {
      const source = {
        query: async (...args) => {
          const result = await db.query(...args);
          if (once) {
            once = false;
            ready();
            await gate;
          }
          return result;
        },
      };
      first = maintainMemberProfile(a, {
        guildId: guild,
        memberId: member,
        sourceDb: source,
        visibleChannelIds: [visible],
      });
      await started;
      const second = await maintainMemberProfile(b, {
        guildId: guild,
        memberId: member,
        sourceDb: db,
        visibleChannelIds: [hidden],
      });
      assert.equal(second.statementCount, 1);
      release();
      const result = await first;
      assert.equal(result.statementCount, 1);
      assert.notEqual(result.digest, second.digest);
    } finally {
      release();
      await first?.catch(() => {});
      await a.end();
      await b.end();
    }
  },
);

postgresTest(
  "explicit schema migration retains old unscoped receipts while adding scoped heads",
  async () => {
    const member = "200000000000000042";
    await add({ member, quote: "I support the migrated archive" });
    await sql("CREATE DATABASE member_profile_legacy_fixture");
    const legacy = await client({ database: "member_profile_legacy_fixture" });
    try {
      await legacy.query(`
      CREATE TABLE member_profile_heads (
        guild_id text NOT NULL, member_id text NOT NULL, profile_version text NOT NULL,
        processing_state text NOT NULL, evidence_digest text, previous_digest text,
        statement_count integer, previous_statement_count integer,
        started_at timestamptz, completed_at timestamptz, error_code text,
        PRIMARY KEY (guild_id, member_id)
      );
      CREATE TABLE member_profile_annotations (
        guild_id text NOT NULL, statement_id text NOT NULL, member_id text NOT NULL,
        profile_version text NOT NULL, input_digest text NOT NULL, topic_key text NOT NULL,
        discourse_role text NOT NULL, freshness text NOT NULL,
        source_message_id text NOT NULL, source_revision_id text NOT NULL,
        channel_id text, extractor_version text NOT NULL,
        occurred_at timestamptz, annotated_at timestamptz NOT NULL,
        PRIMARY KEY (guild_id, statement_id)
      );
    `);
      await legacy.query(
        `INSERT INTO member_profile_heads
        (guild_id,member_id,profile_version,processing_state,evidence_digest,statement_count,completed_at)
       VALUES ($1,$2,'old-version','complete','preserved-receipt',1,'2026-01-01Z')`,
        [guild, member],
      );
      await legacy.query(
        `INSERT INTO member_profile_annotations
        (guild_id,statement_id,member_id,profile_version,input_digest,topic_key,discourse_role,
         freshness,source_message_id,source_revision_id,extractor_version,annotated_at)
       VALUES ($1,'old-statement',$2,'old-version','old-input','harbor','assertion',
         'current','old-source','old-revision','old-extractor','2026-01-01Z')`,
        [guild, member],
      );
      await ensureMemberProfileSchema(legacy);
      const receipt = (
        await legacy.query(
          "SELECT evidence_digest, visibility_scope FROM member_profile_heads WHERE member_id = $1",
          [member],
        )
      ).rows[0];
      assert.deepEqual(receipt, { evidence_digest: "preserved-receipt", visibility_scope: "all" });
      await maintainMemberProfile(legacy, {
        guildId: guild,
        memberId: member,
        sourceDb: db,
        visibleChannelIds: [visible],
      });
      assert.equal(
        (
          await legacy.query(
            "SELECT count(*)::int AS n FROM member_profile_heads WHERE member_id = $1",
            [member],
          )
        ).rows[0].n,
        2,
      );
      assert.equal(
        (
          await legacy.query(
            "SELECT count(*)::int AS n FROM member_profile_annotations WHERE member_id = $1",
            [member],
          )
        ).rows[0].n,
        2,
      );
      assert.equal(
        (
          await legacy.query(
            "SELECT input_digest FROM member_profile_annotations WHERE statement_id = 'old-statement'",
          )
        ).rows[0].input_digest,
        "old-input",
      );
    } finally {
      await legacy.end();
    }
  },
);

postgresTest(
  "public profile flow persists exact review packets, expires edited interpretations, and isolates a hidden scope",
  async () => {
    const member = "200000000000000043";
    const original = "I support more ferry sailings when the public pier is accessible.";
    const nonposition = "I have no view about that proposal.";
    const first = await add({
      member,
      quote: original,
      proposition: "Ferry funding is good",
      topic: "transport",
    });
    const second = await add({ member, quote: nonposition, topic: "transport" });
    await sql("CREATE DATABASE member_profile_flow_fixture");
    const reader = await client({ options: "-c default_transaction_read_only=on" });
    const writer = await client({ database: "member_profile_flow_fixture" });
    try {
      await ensureMemberProfileSchema(writer); // Explicit startup writer path.
      let originalChecks = 0;
      const input = {
        guildId: guild,
        member,
        visibleChannelIds: [visible],
        profileWriter: writer,
        validateOriginals: async (sources) => {
          originalChecks += 1;
          assert.deepEqual(
            new Set(sources.map((source) => source.id)),
            new Set([first.id, second.id]),
          );
          assert.deepEqual(
            new Set(sources.map((source) => source.content)),
            new Set([original, nonposition]),
          );
          assert.equal(
            sources.every((source) => source.authorId === member && source.channelId === visible),
            true,
          );
          assert.equal(
            sources.some((source) => source.content === "Ferry funding is good"),
            false,
          );
        },
      };
      const batch = await memberPositions(reader, { ...input, view: "review" });
      assert.equal(batch.coverage.pendingStatements, 2);
      assert.equal(batch.statements.length, 2);
      assert.equal(
        batch.statements.every((row) => row.guildId === guild),
        true,
      );
      assert.equal(
        batch.statements.find((row) => row.statementId === first.statementId).sourceContent,
        original,
      );
      const decisions = batch.statements.map((row) =>
        row.statementId === first.statementId
          ? {
              statementId: row.statementId,
              disposition: "position",
              concept: "ferry-service",
              claimKey: "frequent-accessible-ferries",
              proposition: "Ada supports more ferries when the pier is accessible",
              direction: "support",
              conditions: ["Only when the public pier is accessible"],
              sourceIds: [row.messageId],
              exactQuote: original,
            }
          : {
              statementId: row.statementId,
              disposition: "no-position",
              sourceIds: [row.messageId],
              rationale: "The source explicitly withholds a view.",
            },
      );
      const saved = await memberPositions(reader, {
        ...input,
        view: "review",
        review: { batchToken: batch.batchToken, decisions },
      });
      assert.equal(originalChecks, 1);
      assert.equal(saved.coverage.reviewedStatements, 2);
      assert.equal(saved.coverage.pendingStatements, 0);
      assert.equal(saved.statements.length, 0);
      const overview = await memberPositions(reader, { ...input, view: "overview" });
      const synthesis = await memberPositions(reader, { ...input, view: "synthesis" });
      for (const result of [overview, synthesis]) {
        assert.equal(result.semantic.coverage.reviewedStatements, 2);
        assert.equal(result.semantic.coverage.pendingStatements, 0);
        assert.equal(
          result.semantic.positions.length,
          1,
          "no-position is reviewed, not unread or endorsed",
        );
        assert.equal(result.semantic.positions[0].concept, "ferry-service");
        assert.deepEqual(result.semantic.positions[0].conditions, [
          "Only when the public pier is accessible",
        ]);
        assert.equal(
          result.sources.some((source) => source.id === first.id && source.content === original),
          true,
        );
      }
      assert.equal(
        (
          await loadProfileReviews(writer, {
            guildId: guild,
            memberId: member,
            visibleChannelIds: [visible],
          })
        ).length,
        2,
      );

      const changedContent = `${original} I now also require a published operating budget.`;
      await sql(
        "UPDATE messages SET content = $2, content_hash = 'new-flow-hash', edited_at = now() WHERE message_id = $1",
        [first.id, changedContent],
      );
      const stale = await memberPositions(reader, { ...input, view: "synthesis", maintain: false });
      assert.equal(stale.coverage.ledger, "pending");
      assert.equal(stale.semantic.positions.length, 0);
      assert.equal(
        stale.semantic.coverage.reviewedStatements,
        1,
        "the no-position review remains valid",
      );

      // Archive publication makes the edited original current again. The old
      // interpretation must not count as a review of this changed input.
      const revision = snowflake();
      await sql("UPDATE v2_source_revisions SET is_current = false WHERE message_id = $1", [
        first.id,
      ]);
      await sql(
        `INSERT INTO v2_source_revisions
        (guild_id,message_id,revision_id,channel_id,author_id,content_hash,is_current)
       VALUES ($1,$2,$3,$4,$5,'new-flow-hash',true)`,
        [guild, first.id, revision, visible, member],
      );
      await sql("UPDATE v2_statements SET source_revision_id = $2 WHERE statement_id = $1", [
        first.statementId,
        revision,
      ]);
      const pending = await memberPositions(reader, {
        ...input,
        view: "synthesis",
        maintain: false,
      });
      assert.equal(pending.semantic.positions.length, 0);
      assert.equal(pending.semantic.coverage.reviewedStatements, 1);
      assert.equal(pending.semantic.coverage.pendingStatements, 1);
      const next = await memberPositions(reader, { ...input, view: "review", maintain: false });
      assert.equal(next.statements.length, 1);
      assert.equal(next.statements[0].sourceContent, changedContent);
      assert.notEqual(next.batchToken, batch.batchToken);

      const hiddenView = await memberPositions(reader, {
        ...input,
        view: "synthesis",
        visibleChannelIds: [hidden],
      });
      assert.equal(hiddenView.semantic.coverage.eligibleStatements, 0);
      assert.equal(hiddenView.semantic.coverage.reviewedStatements, 0);
      assert.equal(hiddenView.semantic.positions.length, 0);
      assert.deepEqual(hiddenView.sources, []);
      assert.deepEqual(
        await loadProfileReviews(writer, {
          guildId: guild,
          memberId: member,
          visibleChannelIds: [hidden],
        }),
        [],
      );
      const hiddenLedger = await ledgerState(writer, guild, member, {
        sourceDb: reader,
        visibleChannelIds: [hidden],
      });
      assert.equal(hiddenLedger.statementCount, 0);
      assert.equal(hiddenLedger.previousStatementCount, null);
    } finally {
      await reader.end();
      await writer.end();
    }
  },
);

postgresTest(
  "reply-parent context stays visible, current, bounded, and separate from the member's evidence",
  async () => {
    const member = "200000000000000044";
    const parentAuthor = "200000000000000045";
    const parentId = snowflake();
    const parentText = "The council proposes adding three more application forms.";
    await sql(
      `INSERT INTO messages
      (guild_id,channel_id,message_id,author_id,author_display_name,content,content_hash,created_at)
     VALUES ($1,$2,$3,$4,'Bea',$5,'parent-hash-1','2026-01-14Z')`,
      [guild, visible, parentId, parentAuthor, parentText],
    );
    const child = await add({ member, quote: "Perfect, more forms to fill.", topic: "council" });
    await sql("UPDATE messages SET reply_to_message_id = $2 WHERE message_id = $1", [
      child.id,
      parentId,
    ]);
    const options = { guildId: guild, member, profileWriter: db, visibleChannelIds: [visible] };
    const rows = await loadMemberEvidence(db, guild, member, { visibleChannelIds: [visible] });
    assert.equal(
      rows.length,
      1,
      "the other author's unextracted original is not a subject statement",
    );
    const context = rows[0].sourceContext;
    assert.equal(context.length, 1);
    assert.deepEqual(
      { ...context[0], occurredAt: new Date(context[0].occurredAt).toISOString() },
      {
        guildId: guild,
        messageId: parentId,
        memberId: parentAuthor,
        authorName: "Bea",
        channelId: visible,
        occurredAt: "2026-01-14T00:00:00.000Z",
        editedAt: null,
        contentHash: "parent-hash-1",
        revisionId: "archive:parent-hash-1",
        content: parentText,
        visible: true,
        freshness: "current",
      },
    );
    const batch = await memberPositions(db, { ...options, view: "review" });
    assert.equal(batch.statements[0].memberId, member);
    assert.equal(batch.statements[0].sourceContext[0].memberId, parentAuthor);
    const decision = {
      statementId: child.statementId,
      disposition: "sarcasm",
      sourceIds: [child.id],
      rationale:
        "The short reply is interpreted against the other author's proposal, not as literal praise.",
    };
    await assert.rejects(
      () =>
        memberPositions(db, {
          ...options,
          view: "review",
          review: {
            batchToken: batch.batchToken,
            decisions: [{ ...decision, sourceIds: [child.id, parentId] }],
          },
        }),
      /Foreign profile review source/,
    );
    await assert.rejects(
      () =>
        memberPositions(db, {
          ...options,
          view: "review",
          review: {
            batchToken: batch.batchToken,
            decisions: [{ ...decision, evidenceStatementIds: [child.statementId, parentId] }],
          },
        }),
      /evidence must belong/,
    );
    const saved = await memberPositions(db, {
      ...options,
      view: "review",
      review: { batchToken: batch.batchToken, decisions: [decision] },
    });
    assert.equal(saved.coverage.reviewedStatements, 1);
    assert.equal(saved.coverage.pendingStatements, 0);
    const initial = await maintainMemberProfile(db, {
      guildId: guild,
      memberId: member,
      visibleChannelIds: [visible],
    });
    const parentRevision = snowflake();
    await sql(
      `INSERT INTO v2_source_revisions
      (guild_id,message_id,revision_id,channel_id,author_id,content_hash,is_current)
     VALUES ($1,$2,$3,$4,$5,'parent-hash-1',true)`,
      [guild, parentId, parentRevision, visible, parentAuthor],
    );
    const preferred = await loadMemberEvidence(db, guild, member, { visibleChannelIds: [visible] });
    assert.equal(preferred[0].sourceContext[0].revisionId, parentRevision);
    const preferredHead = await maintainMemberProfile(db, {
      guildId: guild,
      memberId: member,
      visibleChannelIds: [visible],
    });
    assert.notEqual(preferredHead.digest, initial.digest);
    const preferredBatch = await memberPositions(db, { ...options, view: "review" });
    const preferredReview = await memberPositions(db, {
      ...options,
      view: "review",
      review: {
        batchToken: preferredBatch.batchToken,
        decisions: [decision],
      },
    });
    assert.equal(preferredReview.coverage.pendingStatements, 0);
    await sql(
      "UPDATE messages SET content = $2, content_hash = 'parent-hash-2', edited_at = '2026-02-01Z' WHERE message_id = $1",
      [parentId, "The council is withdrawing its proposal for more application forms."],
    );
    assert.equal(
      (await ledgerState(db, guild, member, { visibleChannelIds: [visible] })).ledger,
      "pending",
    );
    const edited = await memberPositions(db, { ...options, view: "review", maintain: false });
    assert.equal(edited.coverage.reviewedStatements, 0);
    assert.equal(edited.coverage.pendingStatements, 1);
    assert.equal(edited.statements[0].sourceContext[0].revisionId, "archive:parent-hash-2");
    assert.equal(
      new Date(edited.statements[0].sourceContext[0].editedAt).toISOString(),
      "2026-02-01T00:00:00.000Z",
    );
    assert.notEqual(edited.batchToken, batch.batchToken);
    const changed = await maintainMemberProfile(db, {
      guildId: guild,
      memberId: member,
      visibleChannelIds: [visible],
    });
    assert.notEqual(
      changed.digest,
      preferredHead.digest,
      "editing an existing context object must change its digest",
    );
    const beforeDeletion = await memberPositions(db, { ...options, view: "review" });
    const beforeDeletionSaved = await memberPositions(db, {
      ...options,
      view: "review",
      review: {
        batchToken: beforeDeletion.batchToken,
        decisions: [{ ...decision, disposition: "uncertain" }],
      },
    });
    assert.equal(beforeDeletionSaved.coverage.pendingStatements, 0);
    await sql("UPDATE messages SET deleted_at = now() WHERE message_id = $1", [parentId]);
    assert.deepEqual(
      (await loadMemberEvidence(db, guild, member, { visibleChannelIds: [visible] }))[0]
        .sourceContext,
      [],
    );
    assert.equal(
      (await ledgerState(db, guild, member, { visibleChannelIds: [visible] })).ledger,
      "pending",
    );
    const deletedParent = await memberPositions(db, {
      ...options,
      view: "review",
      maintain: false,
    });
    assert.equal(deletedParent.coverage.reviewedStatements, 0);
    assert.equal(deletedParent.coverage.pendingStatements, 1);
    await sql("UPDATE messages SET deleted_at = NULL, channel_id = $2 WHERE message_id = $1", [
      parentId,
      hidden,
    ]);
    assert.deepEqual(
      (await loadMemberEvidence(db, guild, member, { visibleChannelIds: [visible, hidden] }))[0]
        .sourceContext,
      [],
      "a visible-but-different channel is still not safe reply context",
    );
    await sql("UPDATE messages SET reply_to_message_id = $2 WHERE message_id = $1", [
      child.id,
      snowflake(),
    ]);
    assert.deepEqual(
      (await loadMemberEvidence(db, guild, member, { visibleChannelIds: [visible] }))[0]
        .sourceContext,
      [],
    );
  },
);
