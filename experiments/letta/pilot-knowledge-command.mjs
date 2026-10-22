import { communityKnowledgeEvidence } from "./pilot-reply.mjs";
import {
  correctionRouteAllowed,
  parseKnowledgeCommand,
  renderKnowledgeView,
} from "./community-knowledge.mjs";

export async function answerKnowledgeCommand({
  source,
  config,
  knowledge,
  discord,
  store,
  readKnowledgeView,
  record = async () => {},
}) {
  let command;
  try {
    command = parseKnowledgeCommand(source.content);
  } catch {
    await store.queueReply(
      source.id,
      /^!knowledge\s+correct\b/i.test(source.content)
        ? "Use `!knowledge correct <a cited message link> <what needs correction>`; the correction note is required."
        : "Invalid !knowledge command.",
    );
    return true;
  }
  if (!command) return false;
  let reply;
  let knowledgeView;
  if (command.route === "correct") {
    const result = correctionRouteAllowed(config, command)
      ? await knowledge.correct({
          ...command,
          reporterId: source.authorId,
          reporterSourceId: source.id,
        })
      : { disposition: "outside-review-guild" };
    reply =
      result.disposition === "correction-opened"
        ? `Correction case ${result.correctionId} opened for [${result.sourceId}](https://discord.com/channels/${command.guildId}/${command.channelId}/${result.sourceId}). Dependent candidate views are held pending review.`
        : result.disposition === "already-open"
          ? `Correction case ${result.correctionId} is already open for [${result.sourceId}](https://discord.com/channels/${command.guildId}/${command.channelId}/${result.sourceId}); I left its reporter and review origin unchanged.`
          : result.disposition === "already-resolved"
            ? `That correction was already resolved as ${result.status}; I did not reopen or invalidate the current view.`
            : result.disposition === "origin-conflict"
              ? "That exact correction text is already bound to a different reporter or private review origin, so I left its lineage unchanged."
              : result.disposition === "outside-review-guild"
                ? "That source is outside Mudfüt's configured review guild, so I cannot open a correction case."
                : await (async () => {
                    const referenced = await discord.get(command.channelId, command.sourceId);
                    if (!referenced)
                      return "That cited source is no longer available, so I cannot open a correction case.";
                    if (referenced.author?.bot)
                      return "That link points to a Mudfüt reply, not archive evidence. Use one of the blue cited source-message links beneath the candidate you want to correct.";
                    return "That message is not evidence in the current review slice. Use one of the blue cited source-message links beneath the candidate you want to correct.";
                  })();
  } else {
    const target =
      command.route === "profile"
        ? { target: "profile", memberId: command.memberId }
        : command.route === "topic"
          ? { target: "topic", topic: command.topic }
          : { target: "history", memberId: command.memberId, topic: command.topic };
    knowledgeView = await readKnowledgeView(target);
    reply = renderKnowledgeView(knowledgeView.document, { page: command.page ?? 1 });
  }
  const commandReceipt = {
    type: "community_knowledge_command",
    route: command.route,
    ...(command.route !== "correct" ? { page: command.page ?? 1 } : {}),
    ...(knowledgeView ? { knowledgeView: communityKnowledgeEvidence(knowledgeView) } : {}),
  };
  await store.queueReply(source.id, reply, commandReceipt);
  await record({
    type: "community_knowledge_command",
    route: command.route,
    sourceId: source.id,
    receipt: commandReceipt,
  });
  return true;
}
