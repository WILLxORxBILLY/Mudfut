// Session close can reject a still-pending abort request; keep the deadline cause authoritative.
export async function abortForDeadline(cancellation, active, record, otid) {
  const deadline = Object.assign(new Error("Model turn deadline exceeded"), {
    code: "MODEL_TURN_DEADLINE",
  });
  cancellation.cancel(deadline);
  try {
    await active?.abort();
  } catch (error) {
    await record({ type: "model_deadline_abort_error", otid, error: String(error) }).catch(
      () => {},
    );
  }
}
