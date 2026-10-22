import { replyChannels, sourceRecord } from "./pilot-store.mjs";

export function liveSource(message, config) {
  if (!replyChannels(config).includes(message.channel_id))
    throw new Error("Discord source outside live reply scope");
  return sourceRecord(message, config.guildId, message.channel_id);
}

export async function pollLiveChannels(store, discord, config) {
  const { cursors } = await store.meta();
  // Each read is independent; no progress is committed unless the entire poll succeeds.
  const pages = await Promise.all(
    replyChannels(config).map(async (channelId) => {
      const messages = cursors[channelId]
        ? await discord.after(channelId, cursors[channelId])
        : await discord.recent(channelId);
      if (messages.some((message) => message.channel_id !== channelId))
        throw new Error("Discord returned a message from a different channel");
      return messages;
    }),
  );
  return pages.flat().sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}
