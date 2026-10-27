import { replyChannels, sourceRecord } from "./pilot-store.mjs";
import { DiscordReadUnavailable } from "./pilot-discord.mjs";

export function liveSource(message, config) {
  if (!(config.liveChannelIds ?? replyChannels(config)).includes(message.channel_id))
    throw new Error("Discord source outside live reply scope");
  return sourceRecord(message, config.guildId, message.channel_id);
}

export async function pollLiveChannels(
  store,
  discord,
  config,
  channelIds = replyChannels(config),
  observe = async () => {},
) {
  const { cursors } = await store.meta();
  // ponytail: isolate permission and exhausted transient message reads only; startup,
  // discovery, evidence validation and delivery remain fail-closed. Upgrade to an
  // endpoint-aware scheduler before isolating those operations or adding backoff.
  const pages = await Promise.allSettled(
    channelIds.map(async (channelId) => {
      let messages;
      try {
        messages = cursors[channelId]
          ? await discord.after(channelId, cursors[channelId])
          : await discord.recent(channelId);
      } catch (error) {
        if (
          error instanceof DiscordReadUnavailable ||
          (error?.status === 403 && [50001, 50013].includes(error.code)) ||
          (error?.status === 404 && error.code === 10003)
        )
          return { messages: [], error, at: new Date().toISOString() };
        throw error;
      }
      if (messages.some((message) => message.channel_id !== channelId))
        throw new Error("Discord returned a message from a different channel");
      return { messages, at: new Date().toISOString() };
    }),
  );
  await observe(
    pages.map((page, index) => ({
      channelId: channelIds[index],
      ok: page.status === "fulfilled" && !page.value.error,
      at: page.value?.at ?? new Date().toISOString(),
      ...(page.status === "rejected"
        ? { error: page.reason }
        : page.value.error
          ? { error: page.value.error }
          : {}),
    })),
  );
  const failed = pages.find((page) => page.status === "rejected");
  if (failed) throw failed.reason;
  return {
    messages: pages
      .flatMap((page) => page.value.messages)
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)),
    emptyChannelIds: channelIds.filter(
      (id, index) =>
        !cursors[id] && !pages[index].value.error && !pages[index].value.messages.length,
    ),
  };
}

export async function liveChannelPlan(discord, config) {
  const channels = await Promise.all(replyChannels(config).map((id) => discord.channel(id)));
  if (
    channels.some(
      (c, index) =>
        c.id !== replyChannels(config)[index] ||
        c.guild_id !== config.guildId ||
        ![0, 5, 15].includes(c.type),
    )
  )
    throw new Error(
      "Live routes must be text, announcement or forum channels in the configured guild",
    );
  const forumIds = channels.filter((c) => c.type === 15).map((c) => c.id);
  const textIds = channels.filter((c) => c.type !== 15).map((c) => c.id);
  return {
    routes: channels.map(({ id, name, type }) => ({ id, name, type })),
    forumIds,
    async discover() {
      if (!forumIds.length) return { channelIds: textIds, threads: [] };
      const { threads } = await discord.activeThreads(config.guildId);
      if (!Array.isArray(threads)) throw new Error("Invalid Discord thread discovery response");
      const selected = threads.filter((t) => forumIds.includes(t.parent_id));
      if (selected.some((t) => t.guild_id !== config.guildId || t.type !== 11))
        throw new Error("Forum thread identity mismatch");
      // ponytail: poll active discussions; archived discussions resume at their durable
      // cursor when reopened. Add archived-thread reconciliation for offline-only activity.
      return { channelIds: [...textIds, ...selected.map((t) => t.id)], threads: selected };
    },
  };
}
