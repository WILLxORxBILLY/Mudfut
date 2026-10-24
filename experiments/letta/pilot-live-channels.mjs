import { replyChannels, sourceRecord } from "./pilot-store.mjs";

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
  // Each read is independent; no progress is committed unless the entire poll succeeds.
  const pages = await Promise.allSettled(
    channelIds.map(async (channelId) => {
      const messages = cursors[channelId]
        ? await discord.after(channelId, cursors[channelId])
        : await discord.recent(channelId);
      if (messages.some((message) => message.channel_id !== channelId))
        throw new Error("Discord returned a message from a different channel");
      return { messages, at: new Date().toISOString() };
    }),
  );
  await observe(
    pages.map((page, index) => ({
      channelId: channelIds[index],
      ok: page.status === "fulfilled",
      at: page.value?.at ?? new Date().toISOString(),
      ...(page.status === "rejected" ? { error: page.reason } : {}),
    })),
  );
  const failed = pages.find((page) => page.status === "rejected");
  if (failed) throw failed.reason;
  return pages
    .flatMap((page) => page.value.messages)
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
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
