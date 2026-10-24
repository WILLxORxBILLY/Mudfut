export class ArchiveUnavailable extends Error {
  constructor(cause) {
    super("Historical archive is paused; inspect its status and restart after repair", { cause });
    this.code = "ARCHIVE_UNAVAILABLE";
  }
}

// ponytail: an archive failure pauses this reader until the worker is restarted.
// Add a bounded reconnect command if restarting after archive repair becomes frequent.
// Never retry a query, advance a history cursor, or share the native writer's client.
export function archiveReader(client, { report = async () => {}, now = Date.now } = {}) {
  let failure,
    reportFailure,
    closing,
    ended = false;
  let status = { state: "unverified", at: new Date(now()).toISOString() };
  let reporting = Promise.resolve();
  const publish = (next) => {
    status = { ...next, at: new Date(now()).toISOString() };
    const snapshot = { ...status };
    reporting = reporting.then(() => report(snapshot));
    void reporting.catch(() => {});
    return reporting;
  };
  const close = () => {
    ended = true;
    return (closing ??= Promise.resolve().then(() => client.end()));
  };
  const pause = async (error) => {
    if (!failure) {
      failure = new ArchiveUnavailable(error);
      const code =
        typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : null;
      // A failed read transaction is rolled back by closing this separate connection.
      const closed = close().catch(() => {});
      await publish({
        state: "paused",
        failedAt: new Date(now()).toISOString(),
        lastReadAt: status.lastReadAt ?? null,
        code,
      });
      await closed.catch(() => {});
    }
    await reporting;
    return failure;
  };
  client.on("error", (error) => {
    if (!ended)
      void pause(error).catch((cause) => {
        reportFailure = cause;
      });
  });
  return {
    get paused() {
      if (reportFailure) throw reportFailure;
      return Boolean(failure);
    },
    status: () => ({ ...status }),
    async connect() {
      try {
        await client.connect();
      } catch (error) {
        throw await pause(error);
      }
      if (reportFailure) throw reportFailure;
      if (failure) throw failure;
      await publish({ state: "connected" });
    },
    async query(sql, args) {
      if (reportFailure) throw reportFailure;
      if (failure) {
        await reporting;
        // Callers retain their normal rollback cleanup; the retired connection
        // has already rolled back. Do not reconnect or hide the original failure.
        if (typeof sql === "string" && /^ROLLBACK\s*;?\s*$/i.test(sql)) {
          await closing?.catch(() => {});
          return { rows: [], rowCount: 0, command: "ROLLBACK" };
        }
        throw failure;
      }
      let result;
      try {
        result = await client.query(sql, args);
      } catch (error) {
        throw await pause(error);
      }
      if (failure) throw failure;
      if (
        typeof sql === "string" &&
        /^\s*(SELECT|WITH)\b/i.test(sql) &&
        (status.state !== "available" || now() - Date.parse(status.at) >= 10000)
      )
        await publish({ state: "available", lastReadAt: new Date(now()).toISOString() });
      return result;
    },
    end: close,
  };
}

export async function optionalArchive(action) {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof ArchiveUnavailable)) throw error;
    return { disposition: "deferred", reason: "archive-paused" };
  }
}

export async function archiveToolBoundary(action, unavailable = async () => {}) {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof ArchiveUnavailable)) throw error;
    await unavailable();
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "ARCHIVE_UNAVAILABLE",
            coverage:
              "This operation did not complete. No source absence or search exhaustion can be inferred. Use other validated evidence or explain the missing evidence.",
          }),
        },
      ],
    };
  }
}
