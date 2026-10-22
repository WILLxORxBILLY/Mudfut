import { performance } from "node:perf_hooks";

export function timingTrace(details) {
  const started = performance.now();
  const event = { type: "latency", startedAt: new Date().toISOString(), ...details, stages: [] };
  return {
    event,
    async measure(phase, action) {
      const start = performance.now();
      let success = false;
      try {
        const value = await action();
        success = true;
        return value;
      } finally {
        event.stages.push({
          phase,
          offsetMs: start - started,
          durationMs: performance.now() - start,
          success,
        });
      }
    },
  };
}
