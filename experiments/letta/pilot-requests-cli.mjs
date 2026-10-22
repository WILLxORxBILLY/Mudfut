import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import pg from "pg";
import { digest } from "./pilot-store.mjs";
import { state, assertPrivateState, safeError } from "./runtime.mjs";
import { stageOperatorRequest, selectedOperatorRequests } from "./pilot-requests.mjs";

try {
  assertPrivateState(state);
  if (process.argv[2] === "stage" && process.argv.length === 4) {
    const input = JSON.parse(await readFile(resolve(process.argv[3]), "utf8"));
    console.log(JSON.stringify(await stageOperatorRequest(state, input), null, 2));
  } else if (process.argv[2] === "status" && process.argv.length === 3) {
    const db = new pg.Client({
      ...JSON.parse(await readFile(join(state, "postgres.json"), "utf8")),
      options: "-c default_transaction_read_only=on",
    });
    await db.connect();
    try {
      const exists = (
        await db.query("SELECT to_regclass('pilot_operator_requests') IS NOT NULL AS present")
      ).rows[0].present;
      const admitted = exists
        ? (await db.query("SELECT * FROM pilot_operator_requests ORDER BY created_at,id")).rows
        : [];
      const rejectedFiles = [];
      const selected = await selectedOperatorRequests(state, async (path, bytes, error) =>
        rejectedFiles.push({ path, contentSha256: digest(bytes), error: safeError(error) }),
      );
      const quarantineExists = (
        await db.query(
          "SELECT to_regclass('pilot_operator_admission_failures') IS NOT NULL AS present",
        )
      ).rows[0].present;
      const quarantinedAdmissions = quarantineExists
        ? (
            await db.query(
              "SELECT fingerprint,path,content_sha256,detail,created_at FROM pilot_operator_admission_failures ORDER BY created_at,fingerprint",
            )
          ).rows
        : [];
      console.log(
        JSON.stringify(
          {
            requests: selected.map(
              (request) =>
                admitted.find((row) => row.id === request.id) ?? {
                  id: request.id,
                  request,
                  status: "selected; not yet admitted or answered",
                },
            ),
            archivedReceipts: admitted.filter(
              (row) => !selected.some((request) => request.id === row.id),
            ),
            rejectedFiles,
            quarantinedAdmissions,
            publicDelivery: false,
          },
          null,
          2,
        ),
      );
    } finally {
      await db.end();
    }
  } else throw new Error("Use stage /absolute/private/request.json or status");
} catch (error) {
  console.error(safeError(error));
  process.exitCode = 1;
}
