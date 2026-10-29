import assert from "node:assert/strict";
import { discordReplyTo, sourceRecord } from "./pilot-store.mjs";

const guild = "111111111111111111",
  channel = "222222222222222222",
  parent = "333333333333333333";
const message = {
  id: "444444444444444444",
  type: 19,
  channel_id: channel,
  guild_id: guild,
  author: { id: "555555555555555555", username: "Member" },
  content: "A reply",
  timestamp: "2026-01-01T00:00:00Z",
  message_reference: { message_id: parent, channel_id: channel, guild_id: guild },
};
assert.equal(discordReplyTo(message, guild, channel), parent);
assert.equal(sourceRecord(message, guild, channel).replyTo, parent);
assert.throws(
  () => sourceRecord({ ...message, guild_id: parent }, guild, channel),
  /Invalid Discord source message/,
);
const { guild_id: _omitted, ...messageWithoutGuild } = message;
assert.equal(sourceRecord(messageWithoutGuild, guild, channel).guildId, guild);

assert.equal(
  discordReplyTo({ ...message, message_reference: { message_id: parent } }, guild, channel),
  parent,
);
assert.equal(
  discordReplyTo(
    { ...message, message_reference: { ...message.message_reference, type: 0 } },
    guild,
    channel,
  ),
  parent,
);
for (const type of [undefined, null, 0, 6, 21])
  assert.equal(discordReplyTo({ ...message, type }, guild, channel), null);
for (const reference of [
  { ...message.message_reference, type: 1 },
  { ...message.message_reference, type: 2 },
  { ...message.message_reference, channel_id: parent },
  { ...message.message_reference, guild_id: parent },
  { ...message.message_reference, message_id: "not-an-id" },
  null,
])
  assert.equal(discordReplyTo({ ...message, message_reference: reference }, guild, channel), null);
assert.equal(discordReplyTo({ ...message, guild_id: parent }, guild, channel), null);
assert.equal(discordReplyTo({ ...message, channel_id: parent }, guild, channel), null);
assert.equal(
  sourceRecord(
    { ...message, message_reference: { ...message.message_reference, type: 1 } },
    guild,
    channel,
  ).replyTo,
  null,
);

assert.equal(
  discordReplyTo(
    { id: "2", type: 19, channel_id: "3", message_reference: { message_id: "1" } },
    "4",
    "3",
  ),
  "1",
);
for (const id of ["0", "01", "-1", "1e3", "18446744073709551616", message.id])
  assert.equal(
    discordReplyTo({ ...message, message_reference: { message_id: id } }, guild, channel),
    null,
  );
assert.equal(
  discordReplyTo(
    { ...message, message_reference: { message_id: "18446744073709551615" } },
    guild,
    channel,
  ),
  "18446744073709551615",
);
console.log(
  "Reply references require reply type, default reference semantics, valid identity and matching scope.",
);
