// The pinned SDK's tool mapper omits auto_background; set it on the exact
// conversation through its supported protocol before starting a turn.
export async function inlineApplicationTools(session, agentId, tools) {
  if (!agentId || !session.conversationId || !tools.length)
    throw new Error("Inline tools require an agent, conversation and application tools");
  const response = await session.sendCommand(
    {
      type: "runtime_external_tools_update",
      updates: [
        {
          runtimes: [{ agent_id: agentId, conversation_id: session.conversationId }],
          external_tools: [
            {
              tools: tools.map(({ name, label, description, parameters }) => ({
                name,
                label,
                description,
                parameters,
                auto_background: false,
              })),
            },
          ],
        },
      ],
    },
    { responseType: "runtime_external_tools_update_response" },
  );
  if (response?.success !== true)
    throw new Error("SDK did not confirm inline application-tool execution");
}

// The SDK dispatches external tools independently of its result stream and close().
export function toolLifecycle() {
  let sealed = false;
  let outstanding;
  let completion;
  const pending = new Set();
  const seal = () => {
    if (sealed) return;
    sealed = true;
    outstanding = [...pending];
  };
  return {
    get sealed() {
      return sealed;
    },
    run(action) {
      if (sealed) return Promise.reject(new Error("Model turn tool boundary is sealed"));
      const task = Promise.resolve().then(action);
      pending.add(task);
      task.then(
        () => pending.delete(task),
        () => pending.delete(task),
      );
      return task;
    },
    seal,
    finish() {
      seal();
      return (completion ??= Promise.allSettled(outstanding).then((results) => {
        // Settled failures before the boundary may already have been repaired by the model.
        const failed = results.find((result) => result.status === "rejected");
        if (failed) throw failed.reason;
      }));
    },
  };
}
