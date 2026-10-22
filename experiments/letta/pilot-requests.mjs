import { mkdir, readdir, readFile, writeFile, link, unlink, lstat } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "./pilot-store.mjs";
import { safeError } from "./runtime.mjs";

export function validateOperatorRequest(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !["id", "prompt", "requestedAt", "origin", "delivery"].includes(key),
    ) ||
    typeof input.id !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(input.id) ||
    typeof input.prompt !== "string" ||
    !input.prompt.trim() ||
    input.prompt.length > 16000 ||
    typeof input.requestedAt !== "string" ||
    !Number.isFinite(Date.parse(input.requestedAt)) ||
    new Date(input.requestedAt).toISOString() !== input.requestedAt ||
    input.origin !== "operator" ||
    (input.delivery !== undefined && input.delivery !== "chat")
  )
    throw new Error(
      "Operator requests need a local ID, literal prompt, UTC timestamp, operator origin and chat delivery",
    );
  return {
    id: input.id,
    prompt: input.prompt,
    requestedAt: input.requestedAt,
    origin: "operator",
    delivery: "chat",
  };
}

export async function stageOperatorRequest(directory, input) {
  const request = validateOperatorRequest(input);
  const requests = join(directory, "operator-requests");
  await mkdir(requests, { recursive: true, mode: 0o700 });
  const destination = join(requests, request.id + ".json");
  const temporary = join(requests, "." + randomUUID() + ".tmp");
  await writeFile(temporary, JSON.stringify(request) + "\n", { flag: "wx", mode: 0o600 });
  try {
    try {
      await link(temporary, destination);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (
        !(await lstat(destination)).isFile() ||
        JSON.stringify(validateOperatorRequest(JSON.parse(await readFile(destination, "utf8")))) !==
          JSON.stringify(request)
      )
        throw new Error("Operator request ID already contains a different immutable request");
    }
  } finally {
    await unlink(temporary);
  }
  return { request, path: destination, status: "selected; not yet admitted or answered" };
}

async function operatorRequestFiles(directory, reject) {
  const requests = join(directory, "operator-requests");
  const files = await readdir(requests).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const result = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".json") || file.startsWith(".")) continue;
    const path = join(requests, file);
    let bytes = Buffer.alloc(0);
    try {
      if (!(await lstat(path)).isFile()) throw new Error("Operator request must be a regular file");
      bytes = await readFile(path);
      const request = validateOperatorRequest(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      if (file !== request.id + ".json")
        throw new Error("Operator request filename differs from its ID");
      result.push({ request, path, bytes });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      if (!reject) throw error;
      await reject(path, bytes, error);
    }
  }
  return result;
}

export async function selectedOperatorRequests(directory, reject) {
  return (await operatorRequestFiles(directory, reject)).map((item) => item.request);
}

export async function operatorRequests(store, directory, record = async () => {}) {
  const db = store.db;
  await db.query(`CREATE TABLE IF NOT EXISTS pilot_operator_requests (
    id text PRIMARY KEY, request jsonb NOT NULL, request_hash text NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','done','failed')),
    work_id text, reply text, validation_ids text[] NOT NULL DEFAULT '{}', reply_evidence jsonb,
    error jsonb, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz);
    CREATE TABLE IF NOT EXISTS pilot_operator_admission_failures (
      fingerprint text PRIMARY KEY, path text NOT NULL, content_sha256 text NOT NULL,
      content_bytes bytea NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE OR REPLACE FUNCTION pilot_operator_admission_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Operator admission failures are append-only'; END $$;
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='pilot_operator_admission_immutable' AND tgrelid='pilot_operator_admission_failures'::regclass) THEN
        CREATE TRIGGER pilot_operator_admission_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON pilot_operator_admission_failures FOR EACH STATEMENT EXECUTE FUNCTION pilot_operator_admission_append_only();
      END IF;
    END $$;`);
  // Operator recovery joins this durable request queue to the growing JSONB work
  // ledger on every idle cycle. Keep that lookup index-backed before it can starve
  // request admission behind the worker statement timeout.
  await db.query(
    "CREATE INDEX IF NOT EXISTS pilot_work_operator_request_lookup ON pilot_work ((candidate->>'operatorRequestId'),status,created_at,id)",
  );
  async function reject(path, bytes, error) {
    const contentSha256 = digest(bytes),
      fingerprint = digest(path + "\n" + contentSha256);
    const detail = JSON.stringify({
      name: error.name ?? "Error",
      message: safeError(error),
      code: error.code ?? null,
    });
    const inserted = await db.query(
      `INSERT INTO pilot_operator_admission_failures(fingerprint,path,content_sha256,content_bytes,detail)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING fingerprint`,
      [fingerprint, path, contentSha256, bytes, detail],
    );
    const id = basename(path, ".json");
    await db.query(
      `UPDATE pilot_operator_requests SET status='failed',error=$2,completed_at=now()
      WHERE id=$1 AND status='queued' AND NOT EXISTS(SELECT 1 FROM pilot_work w WHERE w.candidate->>'operatorRequestId'=$1 AND w.status IN ('prepared','done'))`,
      [id, detail],
    );
    if (inserted.rowCount)
      await record({
        type: "operator_admission_quarantined",
        path,
        contentSha256,
        publicDelivery: false,
      });
  }
  async function enroll() {
    // ponytail: three local examples need no filesystem watcher; scan immutable
    // manifests on admission. A large request history should use a durable inbox cursor.
    for (const { request, path, bytes } of await operatorRequestFiles(directory, reject)) {
      const text = JSON.stringify(request),
        hash = digest(text);
      const inserted = await db.query(
        `INSERT INTO pilot_operator_requests(id,request,request_hash)
        VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
        [request.id, text, hash],
      );
      const saved = (
        await db.query("SELECT request_hash FROM pilot_operator_requests WHERE id=$1", [request.id])
      ).rows[0];
      if (saved.request_hash !== hash) {
        await reject(
          path,
          bytes,
          new Error("Operator request ID cannot be reused with different input"),
        );
        continue;
      }
      if (inserted.rowCount)
        await record({
          type: "operator_request_queued",
          requestId: request.id,
          origin: request.origin,
          delivery: request.delivery,
        });
    }
  }
  async function reconcile() {
    const rows = (
      await db.query(`SELECT DISTINCT ON (r.id) r.id,w.id AS work_id,w.reply,w.validation_ids,w.candidate
      FROM pilot_operator_requests r JOIN pilot_work w ON w.candidate->>'operatorRequestId'=r.id
      WHERE r.status='queued' AND w.status='done' ORDER BY r.id,w.created_at,w.id`)
    ).rows;
    for (const row of rows) {
      if (typeof row.reply !== "string" || !row.reply.trim() || row.reply.length > 2000) {
        await db.query(
          "UPDATE pilot_operator_requests SET status='failed',work_id=$2,error=$3,completed_at=now() WHERE id=$1 AND status='queued'",
          [
            row.id,
            row.work_id,
            JSON.stringify({ message: "Completed operator work has no valid reply" }),
          ],
        );
        await record({ type: "operator_request_failed", requestId: row.id, workId: row.work_id });
        continue;
      }
      await db.query(
        `UPDATE pilot_operator_requests SET status='done',work_id=$2,reply=$3,validation_ids=$4,
        reply_evidence=$5,completed_at=now() WHERE id=$1 AND status='queued'`,
        [
          row.id,
          row.work_id,
          row.reply,
          row.validation_ids,
          JSON.stringify(row.candidate.replyEvidence ?? null),
        ],
      );
      await record({
        type: "operator_request_done",
        requestId: row.id,
        workId: row.work_id,
        publicDelivery: false,
      });
    }
    return rows.length;
  }
  return {
    reconcile,
    async next() {
      await enroll();
      await reconcile();
      // The pilot's existing advisory lock owns this single writer. Prepared
      // candidates block regeneration until normal memory recovery finishes.
      const row = (
        await db.query(`SELECT r.request FROM pilot_operator_requests r WHERE r.status='queued'
        AND NOT EXISTS(SELECT 1 FROM pilot_work w WHERE w.candidate->>'operatorRequestId'=r.id AND w.status IN ('prepared','done'))
        ORDER BY r.created_at,r.id LIMIT 1`)
      ).rows[0];
      return row
        ? {
            rows: [],
            replyTo: null,
            operatorRequest: validateOperatorRequest(row.request),
            context: {},
          }
        : null;
    },
    async fail(id, error) {
      await reconcile();
      const result = await db.query(
        `UPDATE pilot_operator_requests SET status='failed',error=$2,completed_at=now()
        WHERE id=$1 AND status='queued' AND NOT EXISTS(SELECT 1 FROM pilot_work w WHERE w.candidate->>'operatorRequestId'=$1 AND w.status IN ('prepared','done')) RETURNING id`,
        [
          id,
          JSON.stringify({
            name: error?.name ?? "Error",
            message: safeError(error),
            code: error?.code ?? null,
          }),
        ],
      );
      if (result.rowCount)
        await record({ type: "operator_request_failed", requestId: id, publicDelivery: false });
      return Boolean(result.rowCount);
    },
    status: async () =>
      (await db.query("SELECT * FROM pilot_operator_requests ORDER BY created_at,id")).rows,
  };
}
