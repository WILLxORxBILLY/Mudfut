// Profile history requires both channel visibility and permission to read history.
// Caller access alone is not permission to disclose a private source to a public
// destination. The profile resolver therefore applies a conservative audience
// boundary as well: the destination's public-thread family, guild-public sources,
// or sources with the same proven read policy, never channels that only the
// asking member can access.

const VIEW_CHANNEL = 1n << 10n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const READ_BITS = VIEW_CHANNEL | READ_MESSAGE_HISTORY;
const MANAGE_THREADS = 1n << 34n;
const ADMINISTRATOR = 1n << 3n;
const PUBLIC_THREAD = new Set([10, 11]);
const PRIVATE_THREAD = 12;
const THREAD = new Set([...PUBLIC_THREAD, PRIVATE_THREAD]);
const SNOWFLAKE = /^\d{17,20}$/;

function bits(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
}

function apply(permissions, allow, deny) {
  return (permissions & ~deny) | allow;
}

function overwritesOf(channel) {
  return channel.permission_overwrites ?? channel.permissionOverwrites ?? [];
}

function memberId(member) {
  return member?.user?.id ?? member?.id ?? null;
}

export function visibleChannelIds({
  guildId,
  ownerId = null,
  member,
  roles,
  channels,
  threadMembers = [],
}) {
  if (!guildId || !member || !Array.isArray(roles) || !Array.isArray(channels))
    throw new Error("Caller visibility requires the guild, member, roles, and channels");
  const userId = memberId(member);
  if (!userId || !Array.isArray(member.roles) || !Array.isArray(threadMembers))
    throw new Error("Caller membership is unresolved");
  const everyone = roles.find((role) => role.id === guildId);
  if (!everyone) throw new Error("Guild everyone role is unresolved");
  let base = bits(everyone?.permissions);
  for (const roleId of member.roles ?? []) {
    const role = roles.find((item) => item.id === roleId);
    if (role) base |= bits(role.permissions);
  }
  const administrator = Boolean(base & ADMINISTRATOR) || (ownerId != null && userId === ownerId);
  const visible = new Set();
  const permissionsFor = (channel) => {
    if (administrator) return VIEW_CHANNEL | READ_MESSAGE_HISTORY | MANAGE_THREADS;
    let permissions = base;
    const overwrites = overwritesOf(channel);
    const everyoneOverwrite = overwrites.find((overwrite) => overwrite.id === guildId);
    if (everyoneOverwrite)
      permissions = apply(permissions, bits(everyoneOverwrite.allow), bits(everyoneOverwrite.deny));
    let allow = 0n;
    let deny = 0n;
    for (const roleId of member.roles ?? []) {
      const overwrite = overwrites.find((item) => item.id === roleId && item.type !== 1);
      if (!overwrite) continue;
      allow |= bits(overwrite.allow);
      deny |= bits(overwrite.deny);
    }
    permissions = apply(permissions, allow, deny);
    const memberOverwrite = overwrites.find(
      (overwrite) => overwrite.id === userId && overwrite.type === 1,
    );
    if (memberOverwrite)
      permissions = apply(permissions, bits(memberOverwrite.allow), bits(memberOverwrite.deny));
    return permissions;
  };
  const canRead = (permissions) =>
    (permissions & (VIEW_CHANNEL | READ_MESSAGE_HISTORY)) === (VIEW_CHANNEL | READ_MESSAGE_HISTORY);
  const byId = new Map(
    channels.filter((channel) => channel?.id).map((channel) => [channel.id, channel]),
  );
  for (const channel of channels) {
    if (!channel?.id || THREAD.has(channel.type)) continue;
    if (canRead(permissionsFor(channel))) visible.add(channel.id);
  }
  for (const channel of channels) {
    if (!THREAD.has(channel.type) || (!channel.parent_id && !channel.parentId)) continue;
    const parentId = channel.parent_id ?? channel.parentId;
    const parent = byId.get(parentId);
    if (!parent || THREAD.has(parent.type) || !visible.has(parentId)) continue;
    if (
      PUBLIC_THREAD.has(channel.type) ||
      Boolean(permissionsFor(parent) & MANAGE_THREADS) ||
      threadMembers.some((entry) => entry.threadId === channel.id && entry.userId === userId)
    )
      visible.add(channel.id);
  }
  return [...visible].sort();
}

function readPolicySignature(channel) {
  return JSON.stringify(
    overwritesOf(channel)
      .map((entry) => ({
        id: entry.id,
        type: entry.type,
        allow: String(bits(entry.allow) & READ_BITS),
        deny: String(bits(entry.deny) & READ_BITS),
      }))
      .filter((entry) => entry.allow !== "0" || entry.deny !== "0")
      .sort((left, right) => left.id.localeCompare(right.id) || left.type - right.type),
  );
}

function guildPublicHistory(channel, guildId, everyone) {
  const overwrites = overwritesOf(channel);
  if (overwrites.some((entry) => Boolean(bits(entry.deny) & READ_BITS))) return false;
  const overwrite = overwrites.find((entry) => entry.id === guildId);
  const permissions = overwrite
    ? apply(bits(everyone.permissions), bits(overwrite.allow), bits(overwrite.deny))
    : bits(everyone.permissions);
  return (permissions & READ_BITS) === READ_BITS;
}

export function audienceSafeChannelIds(
  channels,
  destinationChannelId,
  { guildId, roles = [] } = {},
) {
  const byId = new Map(
    channels.filter((channel) => channel?.id).map((channel) => [channel.id, channel]),
  );
  const destination = byId.get(destinationChannelId);
  if (!destination) return [];
  const rootId = THREAD.has(destination.type)
    ? (destination.parent_id ?? destination.parentId)
    : destination.id;
  const root = byId.get(rootId);
  if (!root || THREAD.has(root.type)) return [];
  // A private-thread audience can read its parent and the parent's public
  // threads, but other private threads never become safe sibling sources.
  const safe = new Set([destination.id, rootId]);
  const everyone = roles.find((role) => role.id === guildId);
  const destinationPolicy = readPolicySignature(root);
  for (const channel of channels) {
    if (!channel?.id || channel.type === PRIVATE_THREAD) continue;
    const sourceRoot = PUBLIC_THREAD.has(channel.type)
      ? byId.get(channel.parent_id ?? channel.parentId)
      : channel;
    if (!sourceRoot || THREAD.has(sourceRoot.type)) continue;
    if (sourceRoot.id === rootId) {
      safe.add(channel.id);
      continue;
    }
    if (!everyone) continue;
    // Age-gated history must not be exported into a non-age-gated destination.
    if (sourceRoot.nsfw === true && root.nsfw !== true) continue;
    // Same guild means the base role permissions are shared. Equal read-bit
    // overwrite policies prove equal channel readership without enumerating
    // every member. Alternatively the source is genuinely guild-public and
    // contains no role/member history denial. Merely being public to this caller
    // (including administrators) proves neither condition.
    if (
      guildPublicHistory(sourceRoot, guildId, everyone) ||
      readPolicySignature(sourceRoot) === destinationPolicy
    )
      safe.add(channel.id);
  }
  return [...safe].sort();
}

async function loadCallerVisibility(discord, guildId, userId, candidateChannelIds = []) {
  if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(userId))
    throw new Error("Caller identity is unresolved");
  if (!Array.isArray(candidateChannelIds) || candidateChannelIds.some((id) => !SNOWFLAKE.test(id)))
    throw new Error("Profile source channels are invalid");
  const [guild, member, roles, channels] = await Promise.all([
    discord.guild(guildId),
    discord.guildMember(guildId, userId),
    discord.guildRoles(guildId),
    discord.guildChannels(guildId),
  ]);
  if (guild?.id !== guildId || memberId(member) !== userId || !Array.isArray(channels))
    throw new Error("Discord caller visibility identity mismatch");
  const byId = new Map(
    channels.filter((channel) => channel?.id).map((channel) => [channel.id, channel]),
  );
  // GET /guilds/:id/channels does not contain threads. Active threads come from
  // their own guild endpoint; exact candidate reads cover archived threads.
  if (typeof discord.activeThreads === "function") {
    const active = await discord.activeThreads(guildId);
    if (!Array.isArray(active?.threads)) throw new Error("Discord thread visibility is unresolved");
    for (const channel of active.threads) {
      if (channel.guild_id && channel.guild_id !== guildId)
        throw new Error("Discord thread guild mismatch");
      byId.set(channel.id, channel);
    }
  }
  const loadExact = async (id) => {
    if (byId.has(id)) return;
    if (typeof discord.channel !== "function")
      throw new Error("Discord source channel is unresolved");
    let channel;
    try {
      channel = await discord.channel(id);
    } catch (error) {
      if (error?.code === 10003 || error?.code === 50001 || error?.code === 50013) return;
      throw error;
    }
    if (!channel) return;
    if (channel.id !== id || channel.guild_id !== guildId)
      throw new Error("Discord source channel guild mismatch");
    byId.set(id, channel);
  };
  for (const id of [...new Set(candidateChannelIds)]) await loadExact(id);
  for (const channel of [...byId.values()])
    if (THREAD.has(channel.type)) {
      const parentId = channel.parent_id ?? channel.parentId;
      if (parentId) await loadExact(parentId);
    }
  const threadMembers = [];
  if (typeof discord.threadMember === "function")
    for (const channel of byId.values()) {
      if (channel.type !== PRIVATE_THREAD) continue;
      try {
        const entry = await discord.threadMember(channel.id, userId);
        if (entry?.id === channel.id && entry?.user_id === userId)
          threadMembers.push({ threadId: channel.id, userId });
      } catch (error) {
        // Unknown member/access denied means no verified invitation. Other
        // failures must not be misrepresented as a successful permissions read.
        if (![10007, 10003, 50001, 50013].includes(error?.code)) throw error;
      }
    }
  const allChannels = [...byId.values()];
  const readable = visibleChannelIds({
    guildId,
    ownerId: guild?.owner_id ?? null,
    member,
    roles,
    channels: allChannels,
    threadMembers,
  });
  return { readable, channels: allChannels, roles };
}

export async function resolveCallerChannels(discord, guildId, userId, options = {}) {
  const { readable } = await loadCallerVisibility(
    discord,
    guildId,
    userId,
    options.candidateChannelIds,
  );
  return readable;
}

export async function resolveProfileChannels(
  discord,
  guildId,
  userId,
  destinationChannelId,
  { candidateChannelIds = [] } = {},
) {
  if (!SNOWFLAKE.test(destinationChannelId)) throw new Error("Reply destination is unresolved");
  const { readable, channels, roles } = await loadCallerVisibility(discord, guildId, userId, [
    destinationChannelId,
    ...candidateChannelIds,
  ]);
  if (!readable.includes(destinationChannelId)) return [];
  const safe = new Set(audienceSafeChannelIds(channels, destinationChannelId, { guildId, roles }));
  return readable.filter((id) => safe.has(id));
}
