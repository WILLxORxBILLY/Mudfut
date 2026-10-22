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
