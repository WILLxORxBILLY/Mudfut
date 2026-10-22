import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { state } from "../runtime.mjs";
import { loadSnapshot } from "./data.mjs";
import { demoSnapshot } from "./synthetic.mjs";

export function graphServer(load) {
  let pending;
  return createServer(async (request, response) => {
    const host = request.headers.host,
      expected = `127.0.0.1:${response.socket.localPort}`;
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    };
    const send = (status, type, content) => {
      response.writeHead(status, { ...headers, "Content-Type": type });
      response.end(content);
    };
    if (
      request.method !== "GET" ||
      host !== expected ||
      (request.headers.origin && request.headers.origin !== `http://${expected}`) ||
      request.headers["sec-fetch-site"] === "cross-site"
    )
      return send(403, "text/plain", "Loopback same-origin reads only");
    try {
      if (request.url === "/api/snapshot") {
        // ponytail: one in-flight census shares work across tabs; multi-user use would need a dedicated read replica and authenticated service.
        pending ??= Promise.resolve()
          .then(load)
          .finally(() => {
            pending = undefined;
          });
        return send(200, "application/json", JSON.stringify(await pending));
      }
      const assets = {
        "/": ["index.html", "text/html"],
        "/app.mjs": ["app.mjs", "text/javascript"],
        "/model.mjs": ["model.mjs", "text/javascript"],
        "/layout.mjs": ["layout.mjs", "text/javascript"],
        "/style.css": ["style.css", "text/css"],
      };
      const asset = Object.hasOwn(assets, request.url) ? assets[request.url] : null;
      if (!asset) return send(404, "text/plain", "Not found");
      send(200, `${asset[1]}; charset=utf-8`, await readFile(new URL(asset[0], import.meta.url)));
    } catch {
      send(
        503,
        "application/json",
        JSON.stringify({
          error:
            "Snapshot could not be read. Check the local database connection, schema, permissions or bounded query limits. Credentials and database error details are withheld.",
        }),
      );
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--demo"))
    throw new Error(
      "Use --demo for fictional data, or set MUDFUT_STATE_DIR to the existing private configuration directory",
    );
  const port = Number(process.env.KNOWLEDGE_GRAPH_PORT ?? 4317);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error("KNOWLEDGE_GRAPH_PORT must be 1024–65535");
  const server = graphServer(
    args.includes("--demo") ? async () => demoSnapshot() : () => loadSnapshot(state),
  );
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `Knowledge graph: http://127.0.0.1:${port} (${args.includes("--demo") ? "fictional demo" : "private read-only PostgreSQL"})`,
    ),
  );
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
