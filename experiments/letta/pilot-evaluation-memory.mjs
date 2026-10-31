import { digest } from "./pilot-store.mjs";
import { encodeUnderstanding } from "./pilot-memory.mjs";
import { postgresUnderstanding } from "./pilot-memory-postgres.mjs";

// Fresh evaluation agents have no legacy note to import. Supply an empty
// structured snapshot only for that case; PostgreSQL owns every later revision.
export function evaluationMemory(db, legacy, options) {
  return postgresUnderstanding(
    db,
    {
      ...legacy,
      async read() {
        const saved = await legacy.read();
        if (saved.content) return saved;
        const content = encodeUnderstanding([]);
        return { content, revision: digest(content) };
      },
    },
    options,
  );
}
