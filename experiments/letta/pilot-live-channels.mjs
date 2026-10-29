import { replyChannels, sourceRecord, snowflake } from "./pilot-store.mjs";
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

export function discoveryBoundary(serverTime) {
  if (!Number.isSafeInteger(serverTime) || serverTime < 1420070400000)
    throw new Error("Invalid Discord enrollment clock");
  // HTTP Date has second precision: retain that whole boundary second rather than
  // dropping a first post. At most that one second may overlap pre-activation traffic.
  return ((BigInt(serverTime) - 1420070400000n) << 22n).toString();
}

export async function liveChannelPlan(discord, config) {
  const supported = [0, 2, 5, 13, 15, 16];
  const threadParents = [0, 5, 15, 16];
  const load = async () => {
    const channels =
      config.replyScope === "guild"
        ? await discord.guildChannels(config.guildId)
        : await Promise.all(replyChannels(config).map((id) => discord.channel(id)));
    if (
      !Array.isArray(channels) ||
      channels.some(
        (c, index) =>
          !snowflake(c?.id) ||
          c.guild_id !== config.guildId ||
          (config.replyScope !== "guild" &&
            (c.id !== replyChannels(config)[index] || !supported.includes(c.type))),
      ) ||
      new Set(channels.map((c) => c.id)).size !== channels.length
    )
      throw new Error("Live routes must be message-capable channels in the configured guild");
    return channels.filter((c) => supported.includes(c.type));
  };
  const observedTime = discord.serverTime?.();
  const sinceId = observedTime === undefined ? undefined : discoveryBoundary(observedTime);
  let channels = await load();
  return {
    get routes() {
      return channels.map(({ id, name, type, guild_id }) => ({ id, name, type, guild_id }));
    },
    async discover() {
      if (config.replyScope === "guild") channels = await load();
      const parents = channels.filter((c) => threadParents.includes(c.type));
      const parentIds = parents.map((c) => c.id);
      const { threads } = parentIds.length
        ? await discord.activeThreads(config.guildId)
        : { threads: [] };
      if (!Array.isArray(threads)) throw new Error("Invalid Discord thread discovery response");
      const selected = threads.filter((t) => parentIds.includes(t?.parent_id));
      if (
        selected.some(
          (t) =>
            !snowflake(t.id) ||
            t.guild_id !== config.guildId ||
            ![10, 11, 12].includes(t.type) ||
            (t.type === 10 && !parents.some((c) => c.id === t.parent_id && c.type === 5)) ||
            (t.type === 12 && !parents.some((c) => c.id === t.parent_id && c.type === 0)) ||
            (t.type === 11 &&
              !parents.some((c) => c.id === t.parent_id && [0, 15, 16].includes(c.type))),
        ) ||
        new Set(selected.map((t) => t.id)).size !== selected.length
      )
        throw new Error("Live thread identity mismatch");
      const channelIds = [
        ...channels.filter((c) => ![15, 16].includes(c.type)).map((c) => c.id),
        ...selected.map((t) => t.id),
      ];
      if (new Set(channelIds).size !== channelIds.length)
        throw new Error("Duplicate live endpoint");
      // Discord's response clock sets the durable enrollment boundary; local clock skew
      // must not discard first posts. Archived threads resume when active again.
      return { channelIds, threads: selected, routes: this.routes, parentIds, sinceId };
    },
  };
}
