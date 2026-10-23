import assert from "node:assert/strict";
import { syncKnowledgeSource } from "./pilot-discord.mjs";

const source = { id: "111111111111111111", content: "Current human text" };
const calls = [];
const knowledge = {
  registerSource: async (current) => {
    assert(current.content.trim(), "Blank content cannot be text evidence");
    calls.push(["register", current]);
  },
  removeSource: async (id) => calls.push(["remove", id]),
};
await syncKnowledgeSource(knowledge, source);
assert.equal(calls[0][1], source);
for (const content of ["", " \n\t\u00a0"]) {
  await syncKnowledgeSource(knowledge, { ...source, content });
}
assert.deepEqual(calls, [
  ["register", source],
  ["remove", source.id],
  ["remove", source.id],
]);
await assert.rejects(
  syncKnowledgeSource(
    {
      registerSource: async () => {
        throw new Error("register failed");
      },
    },
    source,
  ),
  /register failed/u,
);
await assert.rejects(
  syncKnowledgeSource(
    {
      removeSource: async () => {
        throw new Error("invalidation failed");
      },
    },
    { ...source, content: "" },
  ),
  /invalidation failed/u,
);
await syncKnowledgeSource(undefined, source);
await syncKnowledgeSource(undefined, { ...source, content: "" });
console.log("Live text registration and blank-source invalidation preserve the evidence boundary.");
