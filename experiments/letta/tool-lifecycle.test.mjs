import { test } from "node:test";
import assert from "node:assert/strict";
import { toolLifecycle, inlineApplicationTools } from "./pilot-tool-lifecycle.mjs";

test("application tools wait inline in only their exact conversation before the model starts", async () => {
  const definition = {
    name: "read_memory",
    label: "Memory",
    description: "Read sourced memory",
    parameters: { type: "object" },
    execute: async () => ({ content: [] }),
  };
  let command;
  await inlineApplicationTools(
    {
      agentId: "agent-test",
      conversationId: "conversation-test",
      sendCommand: async (value, options) => {
        command = value;
        assert.equal(options.responseType, "runtime_external_tools_update_response");
        return { success: true };
      },
    },
    "agent-test",
    [definition],
  );
  assert.equal(command.type, "runtime_external_tools_update");
  assert.deepEqual(command.updates[0].runtimes, [
    { agent_id: "agent-test", conversation_id: "conversation-test" },
  ]);
  assert.equal(command.updates.length, 1);
  assert.deepEqual(command.updates[0].external_tools[0].tools, [
    {
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: definition.parameters,
      auto_background: false,
    },
  ]);
  assert.equal(Object.hasOwn(definition, "auto_background"), false);
});

test("unconfirmed inline tool registration fails before a turn can proceed", async () => {
  for (const response of [{ success: false }, {}, undefined]) {
    await assert.rejects(
      inlineApplicationTools(
        {
          agentId: "agent-test",
          conversationId: "conversation-test",
          sendCommand: async () => response,
        },
        "agent-test",
        [{ name: "read_memory" }],
      ),
      /did not confirm/,
    );
  }
  const failure = new Error("transport unavailable");
  await assert.rejects(
    inlineApplicationTools(
      {
        agentId: "agent-test",
        conversationId: "conversation-test",
        sendCommand: async () => {
          throw failure;
        },
      },
      "agent-test",
      [{ name: "read_memory" }],
    ),
    (error) => error === failure,
  );
});

test("inline registration rejects a different ready agent before sending any command", async () => {
  let sent = false;
  await assert.rejects(
    inlineApplicationTools(
      {
        agentId: "other-agent",
        conversationId: "conversation-test",
        sendCommand: async () => {
          sent = true;
          return { success: true };
        },
      },
      "agent-test",
      [{ name: "read_memory" }],
    ),
    /matching agent/,
  );
  assert.equal(sent, false);
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test("accepted late writes drain before independent candidate snapshots; new calls are sealed", async () => {
  const tools = toolLifecycle();
  const gate = deferred();
  const draft = { audit: [], content: "old" };
  const task = tools.run(async () => {
    await gate.promise;
    draft.content = "new";
    draft.audit.push({ content: "new", completedAfterModelStream: tools.sealed });
  });
  tools.seal();
  let complete = false;
  const finished = tools.finish().then(() => {
    complete = true;
  });
  await assert.rejects(
    tools.run(() => {
      draft.content = "forbidden";
    }),
    /sealed/,
  );
  assert.equal(complete, false);
  gate.resolve();
  await finished;
  await task;
  const candidate = structuredClone(draft);
  assert.equal(candidate.content, "new");
  assert.equal(candidate.audit[0].completedAfterModelStream, true);
  draft.audit.push({ content: "later" });
  assert.equal(candidate.audit.length, 1);
});

test("already settled and repaired tool failures do not reject a completed turn", async () => {
  const tools = toolLifecycle();
  await assert.rejects(
    tools.run(() => {
      throw new Error("repairable");
    }),
    /repairable/,
  );
  await tools.run(() => "corrected");
  await tools.finish();
});

test("post-result failure rejects only after all outstanding tools have drained", async () => {
  const tools = toolLifecycle();
  const gate = deferred();
  const other = deferred();
  const task = tools.run(() => gate.promise);
  const late = tools.run(() => other.promise);
  tools.seal();
  const finished = tools.finish();
  const rejected = assert.rejects(finished, /late failure/);
  gate.reject(new Error("late failure"));
  await assert.rejects(task, /late failure/);
  let drained = false;
  finished
    .finally(() => {
      drained = true;
    })
    .catch(() => {});
  await Promise.resolve();
  assert.equal(drained, false);
  other.resolve();
  await late;
  await rejected;
});

test("abort closes transport before drain and no accepted callback survives cleanup", async () => {
  const tools = toolLifecycle();
  const gate = deferred();
  const events = [];
  const task = tools.run(async () => {
    await gate.promise;
    events.push("late completion");
  });
  tools.seal();
  const cleanup = (async () => {
    events.push("close");
    await tools.finish();
    events.push("cleanup done");
  })();
  assert.deepEqual(events, ["close"]);
  gate.resolve();
  await task;
  await cleanup;
  assert.deepEqual(events, ["close", "late completion", "cleanup done"]);
});

test("drain preserves the original preemption error and code", async () => {
  const tools = toolLifecycle();
  const gate = deferred();
  const preempted = Object.assign(new Error("Live input preempted history"), {
    code: "HISTORY_PREEMPTED",
  });
  const task = tools.run(() => gate.promise);
  tools.seal();
  const finished = tools.finish();
  gate.reject(preempted);
  await assert.rejects(task, (error) => error === preempted);
  await assert.rejects(
    finished,
    (error) => error === preempted && error.code === "HISTORY_PREEMPTED",
  );
  await assert.rejects(tools.finish(), (error) => error === preempted);
});
