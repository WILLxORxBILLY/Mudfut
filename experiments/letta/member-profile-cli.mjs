// Offline, bounded profile maintenance. Uses the installation's existing local
// databases. Only explicit `review` calls a model; nothing posts to Discord or
// creates an alternate corpus.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { state, assertPrivateState, safeError } from "./runtime.mjs";
import {
  ensureMemberProfileSchema,
  ledgerState,
  loadMemberEvidence,
  loadProfileReviews,
  maintainMemberProfile,
  saveProfileReview,
} from "./member-profile-store.mjs";
import {
  profileReviewBatch,
  validateProfileReview,
  reviewedProfilePositions,
  PROFILE_REVIEW_CHARACTERS,
} from "./member-profile-review.mjs";
import { profileExcludedMembers } from "./pilot-profile.mjs";

const ID = /^\d{17,20}$/;
const COMMANDS = new Set(["status", "maintain", "review", "review-batch", "review-apply"]);
const HELP =
  "Usage: node experiments/letta/member-profile-cli.mjs <status|maintain|review|review-batch|review-apply> --member <id> --channels <id,id,...> [--input <review.json>] [--batches <1-100>]\nUses MUDFUT_STATE_DIR. Only the explicit review command calls the configured model (one batch by default); no command posts to Discord. The channel list binds the exact review scope; it is not permission to publish. Review packets contain private originals: keep outputs outside the checkout.";

export function profileCommandArguments(args) {
  if (!args.length || args.includes("--help")) return { help: true };
  const [command, ...flags] = args;
  if (!COMMANDS.has(command)) throw new Error("Unknown profile command");
  const parsed = { command };
  for (let index = 0; index < flags.length; index += 2) {
    const name = flags[index];
    if (
      !["--member", "--channels", "--input", "--batches"].includes(name) ||
      !flags[index + 1] ||
      Object.hasOwn(parsed, name.slice(2))
    )
      throw new Error("Invalid or repeated profile option");
    parsed[name.slice(2)] = flags[index + 1];
  }
  if (!ID.test(parsed.member ?? "") || !parsed.channels)
    throw new Error("A member ID and explicit channel scope are required");
  parsed.visibleChannelIds = [...new Set(parsed.channels.split(","))].sort();
  if (!parsed.visibleChannelIds.length || parsed.visibleChannelIds.some((id) => !ID.test(id)))
    throw new Error("Invalid profile channel scope");
  if ((command === "review-apply") !== Boolean(parsed.input))
    throw new Error("Only review-apply requires an input file");
  if (
    parsed.batches != null &&
    (command !== "review" ||
      !/^\d+$/.test(parsed.batches) ||
      Number(parsed.batches) < 1 ||
      Number(parsed.batches) > 100)
  )
    throw new Error("Only model review accepts a batch budget from 1 to 100");
  parsed.maxBatches = Number(parsed.batches ?? 1);
  return parsed;
}

export async function runProfileCommand(writer, sourceDb, options) {
  if (
    !ID.test(options.guildId ?? "") ||
    !ID.test(options.memberId ?? "") ||
    !Array.isArray(options.visibleChannelIds) ||
    !options.visibleChannelIds.length ||
    options.visibleChannelIds.some((id) => !ID.test(id))
  )
    throw new Error("Invalid profile command scope");
  if (!COMMANDS.has(options.command)) throw new Error("Unknown profile command");
  const excluded = await profileExcludedMembers(writer);
  if (excluded.has(options.memberId)) throw new Error("This member has opted out of learning");
  const context = {
    guildId: options.guildId,
    memberId: options.memberId,
    sourceDb,
    visibleChannelIds: options.visibleChannelIds,
  };
  if (options.command === "maintain") return maintainMemberProfile(writer, context);
  if (options.command === "review") {
    const { nativeProfileReviewer, reviewMemberProfile } =
      await import("./member-profile-worker.mjs");
    const reviewer = options.review ?? (await nativeProfileReviewer());
    try {
      return await reviewMemberProfile({
        writer,
        sourceDb,
        ...context,
        review: reviewer,
        maxBatches: options.maxBatches ?? 1,
        signal: options.signal,
      });
    } finally {
      if (!options.review) await reviewer.close();
    }
  }
  const statements = (await loadMemberEvidence(sourceDb, options.guildId, options.memberId))
    .filter((row) => options.visibleChannelIds.includes(row.channelId))
    .map((row) => ({
      ...row,
      sourceContext: (row.sourceContext ?? []).filter((context) => !excluded.has(context.memberId)),
    }));
  let reviews = await loadProfileReviews(writer, context);
  const member = { id: options.memberId, guildId: options.guildId };
  let batch = profileReviewBatch({
    member,
    statements,
    reviews,
    maxCharacters: PROFILE_REVIEW_CHARACTERS,
  });
  if (options.command === "review-apply") {
    const checked = validateProfileReview({ batch, review: options.review });
    await saveProfileReview(writer, { ...context, records: checked.records });
    reviews = await loadProfileReviews(writer, context);
    batch = profileReviewBatch({
      member,
      statements,
      reviews,
      maxCharacters: PROFILE_REVIEW_CHARACTERS,
    });
  }
  if (options.command === "review-batch" || options.command === "review-apply") return batch;
  return {
    member,
    maintenance: await ledgerState(writer, options.guildId, options.memberId, {
      sourceDb,
      visibleChannelIds: options.visibleChannelIds,
    }),
    semantic: reviewedProfilePositions({ statements, reviews }).coverage,
  };
}

async function privateJson(name) {
  const path = join(state, name);
  const info = await stat(path);
  if (!info.isFile() || info.mode & 0o077)
    throw new Error(`${name} must be a private regular file`);
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const args = profileCommandArguments(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  assertPrivateState(state);
  const config = await privateJson("pilot.json");
  const source = await privateJson("history-postgres.json");
  const writer = new pg.Client({
    ...(await privateJson("postgres.json")),
    statement_timeout: 10000,
    connectionTimeoutMillis: 10000,
  });
  const sourceDb = new pg.Client({
    ...source,
    statement_timeout: 30000,
    connectionTimeoutMillis: 10000,
    options: "-c default_transaction_read_only=on",
  });
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Profile maintenance interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await writer.connect();
    await sourceDb.connect();
    if (args.command !== "status" && args.command !== "review-batch")
      await ensureMemberProfileSchema(writer);
    const result = await runProfileCommand(writer, sourceDb, {
      command: args.command,
      guildId: config.guildId,
      memberId: args.member,
      visibleChannelIds: args.visibleChannelIds,
      maxBatches: args.maxBatches,
      signal: controller.signal,
      review: args.input ? JSON.parse(await readFile(args.input, "utf8")) : undefined,
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    console.log(JSON.stringify(result, null, 2));
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await Promise.allSettled([writer.end(), sourceDb.end()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(safeError(error));
    process.exitCode = 1;
  });
