import assert from "node:assert/strict";
import test from "node:test";

import {
  audienceSafeChannelIds,
  resolveCallerChannels,
  resolveProfileChannels,
  visibleChannelIds,
} from "./member-visibility.mjs";

const guild = "100000000000000001";
const everyone = 1024n | (1n << 16n); // VIEW_CHANNEL + READ_MESSAGE_HISTORY
const denyView = { id: guild, type: 0, allow: "0", deny: String(1024n) };

function member(roles = [], userId = "200000000000000001") {
  return { user: { id: userId }, roles };
}

test("a channel deny is excluded, a private thread is excluded, and a public thread follows its parent", () => {
  const visible = visibleChannelIds({
    guildId: guild,
    member: member(["200000000000000010"]),
    roles: [
      { id: guild, permissions: String(everyone) },
      { id: "200000000000000010", permissions: "0" },
    ],
    channels: [
      { id: "300000000000000001", type: 0, permission_overwrites: [] },
      { id: "300000000000000002", type: 0, permission_overwrites: [denyView] },
      {
        id: "300000000000000003",
        type: 12,
        parent_id: "300000000000000001",
        permission_overwrites: [],
      },
      {
        id: "300000000000000004",
        type: 11,
        parent_id: "300000000000000001",
        permission_overwrites: [],
      },
      {
        id: "300000000000000005",
        type: 11,
        parent_id: "300000000000000002",
        permission_overwrites: [],
      },
      { id: "300000000000000006", type: 11, permission_overwrites: [] },
    ],
  });
  assert.deepEqual(visible, ["300000000000000001", "300000000000000004"]);
});

test("an administrator can read private threads through manage-threads authority", () => {
  const visible = visibleChannelIds({
    guildId: guild,
    ownerId: "200000000000000009",
    member: member([], "200000000000000009"),
    roles: [{ id: guild, permissions: "0" }],
    channels: [
      { id: "300000000000000001", type: 0, permission_overwrites: [denyView] },
      {
        id: "300000000000000003",
        type: 12,
        parent_id: "300000000000000001",
        permission_overwrites: [],
      },
    ],
  });
  assert.deepEqual(visible, ["300000000000000001", "300000000000000003"]);
});

const channel = "300000000000000001";
const hidden = "300000000000000002";
const publicThread = "300000000000000003";
const privateThread = "300000000000000004";
const user = "200000000000000001";

test("view-channel without history permission cannot expose archived statements", () => {
  assert.deepEqual(
    visibleChannelIds({
      guildId: guild,
      member: member(),
      roles: [{ id: guild, permissions: "1024" }],
      channels: [{ id: channel, type: 0 }],
    }),
    [],
  );
});

test("member history denial wins over a role allowance and applies to public threads", () => {
  const role = "200000000000000010";
  assert.deepEqual(
    visibleChannelIds({
      guildId: guild,
      member: member([role]),
      roles: [
        { id: guild, permissions: String(everyone) },
        { id: role, permissions: "0" },
      ],
      channels: [
        {
          id: channel,
          type: 0,
          permission_overwrites: [
            { id: role, type: 0, allow: String(1n << 16n), deny: "0" },
            { id: user, type: 1, allow: "0", deny: String(1n << 16n) },
          ],
        },
        { id: publicThread, type: 11, parent_id: channel },
      ],
    }),
    [],
  );
});

test("private threads require the caller's verified membership, not another member's", () => {
  const input = {
    guildId: guild,
    member: member(),
    roles: [{ id: guild, permissions: String(everyone) }],
    channels: [
      { id: channel, type: 0 },
      { id: privateThread, type: 12, parent_id: channel },
    ],
  };
  assert.deepEqual(visibleChannelIds(input), [channel]);
  assert.deepEqual(
    visibleChannelIds({ ...input, threadMembers: [{ threadId: privateThread, userId: hidden }] }),
    [channel],
  );
  assert.deepEqual(
    visibleChannelIds({ ...input, threadMembers: [{ threadId: privateThread, userId: user }] }),
    [channel, privateThread],
  );
  assert.deepEqual(
    visibleChannelIds({
      ...input,
      roles: [{ id: guild, permissions: String(everyone | (1n << 34n)) }],
    }),
    [channel, privateThread],
  );
});

test("private membership cannot bypass missing parent history permission", () => {
  assert.deepEqual(
    visibleChannelIds({
      guildId: guild,
      member: member(),
      roles: [{ id: guild, permissions: "1024" }],
      channels: [
        { id: channel, type: 0 },
        { id: privateThread, type: 12, parent_id: channel },
      ],
      threadMembers: [{ threadId: privateThread, userId: user }],
    }),
    [],
  );
});

function discordDouble(overrides = {}) {
  return {
    guild: async () => ({ id: guild, owner_id: "200000000000000099" }),
    guildMember: async () => member(),
    guildRoles: async () => [{ id: guild, permissions: String(everyone) }],
    guildChannels: async () => [
      { id: channel, type: 0 },
      { id: hidden, type: 0 },
    ],
    activeThreads: async () => ({ threads: [] }),
    ...overrides,
  };
}

test("resolver fetches active threads separately and archived candidates by exact id", async () => {
  const archived = "300000000000000005";
  const calls = [];
  const discord = discordDouble({
    activeThreads: async () => ({ threads: [{ id: publicThread, type: 11, parent_id: channel }] }),
    channel: async (id) => {
      calls.push(id);
      return { id: archived, guild_id: guild, type: 11, parent_id: channel };
    },
  });
  assert.deepEqual(
    await resolveCallerChannels(discord, guild, user, { candidateChannelIds: [archived] }),
    [channel, hidden, publicThread, archived],
  );
  assert.deepEqual(calls, [archived]);
});

test("resolver verifies private thread membership for this caller", async () => {
  const calls = [];
  const discord = discordDouble({
    activeThreads: async () => ({ threads: [{ id: privateThread, type: 12, parent_id: channel }] }),
    threadMember: async (threadId, userId) => {
      calls.push([threadId, userId]);
      return { id: threadId, user_id: userId };
    },
  });
  assert.deepEqual(await resolveCallerChannels(discord, guild, user), [
    channel,
    hidden,
    privateThread,
  ]);
  assert.deepEqual(calls, [[privateThread, user]]);
  discord.threadMember = async () => {
    throw Object.assign(new Error("not invited"), { code: 10007 });
  };
  assert.deepEqual(await resolveCallerChannels(discord, guild, user), [channel, hidden]);
});

test("public reply audience excludes unrelated channels even for a privileged caller", async () => {
  const discord = discordDouble({
    guildRoles: async () => [{ id: guild, permissions: String(1n << 3n) }],
    guildChannels: async () => [
      { id: channel, type: 0 },
      { id: hidden, type: 0, permission_overwrites: [denyView] },
    ],
    activeThreads: async () => ({
      threads: [
        { id: publicThread, type: 11, parent_id: channel },
        { id: privateThread, type: 12, parent_id: channel },
      ],
    }),
  });
  assert.deepEqual(await resolveProfileChannels(discord, guild, user, channel), [
    channel,
    publicThread,
  ]);
  assert.deepEqual(await resolveProfileChannels(discord, guild, user, privateThread), [
    channel,
    publicThread,
    privateThread,
  ]);
});

test("audience filtering never treats another private thread as a safe sibling", () => {
  const other = "300000000000000005";
  const channels = [
    { id: channel, type: 0 },
    { id: publicThread, type: 11, parent_id: channel },
    { id: privateThread, type: 12, parent_id: channel },
    { id: other, type: 12, parent_id: channel },
    { id: hidden, type: 0 },
  ];
  assert.deepEqual(audienceSafeChannelIds(channels, publicThread), [channel, publicThread]);
  assert.deepEqual(audienceSafeChannelIds(channels, privateThread), [
    channel,
    publicThread,
    privateThread,
  ]);
  assert.deepEqual(audienceSafeChannelIds([{ id: publicThread, type: 11 }], publicThread), []);
});

test("unreadable destinations, missing caller identity, and cross-guild channel metadata fail closed", async () => {
  const denied = discordDouble({ guildRoles: async () => [{ id: guild, permissions: "0" }] });
  assert.deepEqual(await resolveProfileChannels(denied, guild, user, channel), []);
  await assert.rejects(
    () => resolveProfileChannels(discordDouble(), guild, null, channel),
    /identity/,
  );
  await assert.rejects(
    () =>
      resolveCallerChannels(
        discordDouble({ guildMember: async () => member([], hidden) }),
        guild,
        user,
      ),
    /identity mismatch/,
  );
  await assert.rejects(
    () =>
      resolveCallerChannels(
        discordDouble({
          channel: async (id) => ({ id, type: 11, parent_id: channel, guild_id: hidden }),
        }),
        guild,
        user,
        { candidateChannelIds: [publicThread] },
      ),
    /guild mismatch/,
  );
});

test("network permission lookup errors are surfaced rather than treated as successful visibility", async () => {
  await assert.rejects(
    () =>
      resolveProfileChannels(
        discordDouble({
          activeThreads: async () => {
            throw new Error("network down");
          },
        }),
        guild,
        user,
        channel,
      ),
    /network down/,
  );
  await assert.rejects(
    () =>
      resolveCallerChannels(
        discordDouble({
          activeThreads: async () => ({
            threads: [{ id: privateThread, type: 12, parent_id: channel }],
          }),
          threadMember: async () => {
            throw new Error("membership read down");
          },
        }),
        guild,
        user,
      ),
    /membership read down/,
  );
});

test("a genuinely guild-public sibling and its public thread are audience-safe", async () => {
  const discord = discordDouble({
    activeThreads: async () => ({ threads: [{ id: publicThread, type: 11, parent_id: hidden }] }),
  });
  assert.deepEqual(await resolveProfileChannels(discord, guild, user, channel), [
    channel,
    hidden,
    publicThread,
  ]);
});

test("a guild-public-looking source with a role or member history deny is not audience-safe", async () => {
  const role = "200000000000000010";
  for (const overwrite of [
    { id: role, type: 0, allow: "0", deny: String(1n << 16n) },
    { id: "200000000000000099", type: 1, allow: "0", deny: String(1n << 16n) },
  ]) {
    const discord = discordDouble({
      guildChannels: async () => [
        { id: channel, type: 0 },
        { id: hidden, type: 0, permission_overwrites: [overwrite] },
      ],
    });
    // The asker can read both; a different destination reader may not.
    assert.deepEqual(await resolveCallerChannels(discord, guild, user), [channel, hidden]);
    assert.deepEqual(await resolveProfileChannels(discord, guild, user, channel), [channel]);
  }
});

test("identical restricted readership is allowed, including a source public thread", async () => {
  const role = "200000000000000010";
  const policy = [denyView, { id: role, type: 0, allow: "1024", deny: "0" }];
  const discord = discordDouble({
    guildMember: async () => member([role]),
    guildRoles: async () => [
      { id: guild, permissions: String(everyone) },
      { id: role, permissions: "0" },
    ],
    guildChannels: async () => [
      { id: channel, type: 0, permission_overwrites: policy },
      { id: hidden, type: 0, permission_overwrites: [...policy].reverse() },
    ],
    activeThreads: async () => ({ threads: [{ id: publicThread, type: 11, parent_id: hidden }] }),
  });
  assert.deepEqual(await resolveProfileChannels(discord, guild, user, channel), [
    channel,
    hidden,
    publicThread,
  ]);
});

test("different restricted readership is refused even when the asker belongs to both roles", async () => {
  const role = "200000000000000010";
  const otherRole = "200000000000000011";
  const discord = discordDouble({
    guildMember: async () => member([role, otherRole]),
    guildRoles: async () => [
      { id: guild, permissions: String(everyone) },
      { id: role, permissions: "0" },
      { id: otherRole, permissions: "0" },
    ],
    guildChannels: async () => [
      {
        id: channel,
        type: 0,
        permission_overwrites: [denyView, { id: role, type: 0, allow: "1024", deny: "0" }],
      },
      {
        id: hidden,
        type: 0,
        permission_overwrites: [denyView, { id: otherRole, type: 0, allow: "1024", deny: "0" }],
      },
    ],
  });
  assert.deepEqual(await resolveCallerChannels(discord, guild, user), [channel, hidden]);
  assert.deepEqual(await resolveProfileChannels(discord, guild, user, channel), [channel]);
});

test("age-restricted source history is not disclosed to an unrestricted destination", async () => {
  const discord = discordDouble({
    guildChannels: async () => [
      { id: channel, type: 0 },
      { id: hidden, type: 0, nsfw: true },
    ],
  });
  assert.deepEqual(await resolveProfileChannels(discord, guild, user, channel), [channel]);
});
