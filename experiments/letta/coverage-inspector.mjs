// Offline operator projection only: no database, Discord, model or server connection.
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

export const metricDefinitions = {
  archived: ["Archived", "Stored source IDs in this archive snapshot; not all Discord history."],
  searchable: [
    "Searchable",
    "Archive sources eligible for current text retrieval; not proof of review.",
  ],
  reviewedExactCurrentRevision: [
    "Reviewed · exact current revision",
    "A durable review proof matches the current source revision.",
  ],
  reviewedStaleRevision: [
    "Reviewed · earlier revision",
    "A review exists for a different source revision; current-revision review is not established.",
  ],
  reviewUnknownRevision: [
    "Reviewed · revision unknown",
    "A completed explicit review decision exists but its revision binding cannot be established.",
  ],
  reviewedTemporalCurrentCandidates: [
    "Temporal reconstruction · not directly bound",
    "An overlapping reconstruction-only tier within unknown-revision reviews; never exact-current review proof.",
  ],
  unreviewed: [
    "Without an explicit review decision",
    "The collector found no matching completed explicit review decision; this does not assess relevance.",
  ],
  retainedProvenance: [
    "Retained provenance",
    "Distinct cited sources in retained memory, counted independently of exact-revision review.",
  ],
  pending: ["Pending", "Sources with pending work evidence; pending is not completed review."],
  unknown: [
    "Unknown accounting",
    "Sources whose accounting cannot be established by this collector.",
  ],
  excluded: [
    "Excluded evidence",
    "Sources explicitly excluded by the collector; policy-excluded channels are a separate scope fact.",
  ],
};
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const fail = () => {
  throw new Error("Invalid coverage snapshot: check its documented metadata schema and bounds");
};
const text = (value, limit = 1000) => typeof value === "string" && value.length <= limit;
const timestamp = (value) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    return false;
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value.slice(0, 10);
};
const count = (value) => value === null || (Number.isSafeInteger(value) && value >= 0);
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail();
}
function metrics(value) {
  keys(value, Object.keys(metricDefinitions));
  if (Object.values(value).some((value) => !count(value))) fail();
  if (value.archived != null && value.searchable != null && value.searchable > value.archived)
    fail();
  if (
    value.reviewedTemporalCurrentCandidates != null &&
    value.reviewUnknownRevision != null &&
    value.reviewedTemporalCurrentCandidates > value.reviewUnknownRevision
  )
    fail();
}
export function safeSourceUrl(value) {
  const match =
    typeof value === "string" &&
    /^https:\/\/discord\.com\/channels\/([1-9]\d{0,19})\/([1-9]\d{0,19})\/([1-9]\d{0,19})$/.exec(
      value,
    );
  return match && match.slice(1).every((id) => BigInt(id) <= 18446744073709551615n) ? value : null;
}
// A bounded metadata tree allows collector proof details without accepting bodies or credentials.
function metadata(value, depth = 0) {
  if (depth > 6) fail();
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    text(value, 4000)
  )
    return;
  if (Array.isArray(value)) {
    if (value.length > 100) fail();
    value.forEach((item) => metadata(item, depth + 1));
    return;
  }
  if (!object(value) || Object.keys(value).length > 50) fail();
  for (const [key, item] of Object.entries(value)) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(key) ||
      /password|secret|token|credential|cookie|authorization|content$|body$|statement$|interpretation$/i.test(
        key,
      )
    )
      fail();
    metadata(item, depth + 1);
  }
}
export function validateSnapshot(value) {
  keys(value, [
    "schemaVersion",
    "generatedAt",
    "capturedAt",
    "scope",
    "summary",
    "channels",
    "limitations",
    "definitions",
    "sourceCoverage",
    "freshness",
  ]);
  if (value.schemaVersion !== "mudfut-coverage-v1" || !timestamp(value.generatedAt)) fail();
  keys(value.capturedAt, ["archive", "native", "cloudProof"]);
  if (Object.values(value.capturedAt).some((time) => time !== null && !timestamp(time))) fail();
  metadata(value.scope);
  if (value.freshness !== undefined) metadata(value.freshness);
  metrics(value.summary);
  if (
    !Array.isArray(value.channels) ||
    value.channels.length > 2000 ||
    !Array.isArray(value.limitations) ||
    !value.limitations.every((note) => text(note, 4000))
  )
    fail();
  if (value.definitions !== undefined) {
    if (!Array.isArray(value.definitions) || value.definitions.length > 30) fail();
    const definitions = new Set();
    for (const definition of value.definitions) {
      keys(definition, ["key", "label", "description", "unit"]);
      if (
        !Object.hasOwn(metricDefinitions, definition.key) ||
        definitions.has(definition.key) ||
        !text(definition.label, 200) ||
        !text(definition.description, 4000) ||
        !text(definition.unit, 200)
      )
        fail();
      definitions.add(definition.key);
    }
  }
  const ids = new Set();
  let sourceCount = 0;
  for (const channel of value.channels) {
    keys(channel, [
      "id",
      "name",
      "parentId",
      "scope",
      "metrics",
      "notes",
      "sources",
      "sourcesComplete",
      "sourcesSelection",
      "sourcesLimit",
    ]);
    if (
      !text(channel.id, 100) ||
      !channel.id ||
      ids.has(channel.id) ||
      (channel.name !== undefined && channel.name !== null && !text(channel.name, 200)) ||
      (channel.parentId !== undefined && channel.parentId !== null && !text(channel.parentId, 100))
    )
      fail();
    ids.add(channel.id);
    metrics(channel.metrics);
    if (
      (channel.scope !== undefined &&
        !["archived", "policy-excluded", "native-only"].includes(channel.scope)) ||
      !Array.isArray(channel.notes) ||
      !channel.notes.every((note) => text(note, 4000)) ||
      !Array.isArray(channel.sources)
    )
      fail();
    if (
      (channel.sourcesComplete !== undefined && typeof channel.sourcesComplete !== "boolean") ||
      (channel.sourcesSelection !== undefined && !text(channel.sourcesSelection, 4000)) ||
      (channel.sourcesLimit !== undefined && !count(channel.sourcesLimit))
    )
      fail();
    const sources = new Set();
    for (const source of channel.sources) {
      keys(source, [
        "id",
        "url",
        "createdAt",
        "currentContentHash",
        "currentEditedAt",
        "archiveState",
        "reviewStatus",
        "reviewDecision",
        "reviewedAt",
        "proof",
        "retainedProvenance",
      ]);
      if (
        !text(source.id, 100) ||
        !source.id ||
        sources.has(source.id) ||
        (source.url != null && !safeSourceUrl(source.url))
      )
        fail();
      sources.add(source.id);
      sourceCount++;
      if (
        (source.createdAt != null && !timestamp(source.createdAt)) ||
        (source.currentEditedAt != null && !timestamp(source.currentEditedAt)) ||
        (source.reviewedAt != null && !timestamp(source.reviewedAt))
      )
        fail();
      for (const field of ["currentContentHash", "archiveState", "reviewStatus", "reviewDecision"])
        if (source[field] !== undefined && source[field] !== null && !text(source[field], 500))
          fail();
      if (source.proof !== undefined && source.proof !== null && !text(source.proof, 4000)) fail();
      if (
        (source.reviewStatus !== undefined &&
          !["current", "stale", "unknown-revision", "unreviewed"].includes(source.reviewStatus)) ||
        (source.reviewDecision !== undefined &&
          source.reviewDecision !== null &&
          !["retained", "irrelevant"].includes(source.reviewDecision))
      )
        fail();
      if (
        (source.reviewStatus === "current" && source.proof !== "direct-immutable-binding") ||
        (source.proof === "temporal-reconstruction-only" &&
          source.reviewStatus !== "unknown-revision")
      )
        fail();
      if (source.url && !source.url.endsWith(`/${source.id}`)) fail();
      if (source.retainedProvenance !== undefined) {
        keys(source.retainedProvenance, ["currentEntries", "historicalVersions"]);
        if (!Object.values(source.retainedProvenance).every(count)) fail();
      }
    }
  }
  if (value.sourceCoverage !== undefined) {
    keys(value.sourceCoverage, ["included", "totalKnown", "selection", "complete"]);
    if (
      value.sourceCoverage.included !== sourceCount ||
      !count(value.sourceCoverage.totalKnown) ||
      (value.sourceCoverage.totalKnown !== null && value.sourceCoverage.totalKnown < sourceCount) ||
      !text(value.sourceCoverage.selection, 4000) ||
      typeof value.sourceCoverage.complete !== "boolean" ||
      (value.sourceCoverage.complete && value.sourceCoverage.totalKnown !== sourceCount)
    )
      fail();
  }
  // ponytail: one bounded offline snapshot, up to 10,000 source details; larger audits need paginated exports, not a second data store.
  if (sourceCount > 10000) fail();
  return value;
}
export function scriptJson(value) {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function inspect(snapshot, definitions) {
  const byId = (id) => document.getElementById(id);
  const element = (tag, value) => {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = String(value);
    return node;
  };
  const format = (value) => (value == null ? "Unknown" : Number(value).toLocaleString());
  const describe = (value) =>
    value == null
      ? "Unknown"
      : typeof value === "object"
        ? JSON.stringify(value, null, 2)
        : String(value);
  let page = 0;
  const suppliedDefinitions = Object.fromEntries(
    (snapshot.definitions ?? []).map((item) => [item.key, item]),
  );
  function metricList(values) {
    const list = element("dl");
    list.className = "metrics";
    for (const [key, [title, definition]] of Object.entries(definitions)) {
      const item = element("div"),
        value = element("dd", format(values[key]));
      value.append(
        element(
          "p",
          `${suppliedDefinitions[key]?.description ?? definition} Unit: ${suppliedDefinitions[key]?.unit ?? "distinct sources"}.`,
        ),
      );
      item.append(element("dt", suppliedDefinitions[key]?.label ?? title), value);
      list.append(item);
    }
    return list;
  }
  function metadata(parent, value) {
    const list = element("dl");
    list.className = "metadata";
    for (const [key, item] of Object.entries(value ?? {})) {
      list.append(element("dt", key), element("dd", describe(item)));
    }
    parent.append(list);
  }
  function age() {
    const hours = (Date.now() - Date.parse(snapshot.generatedAt)) / 3600000;
    byId("age").textContent =
      `${hours < 0 ? "Snapshot timestamp is in the future; check the collector clock." : `Snapshot age: ${Math.floor(hours)} hour(s). ${hours >= 24 ? "This snapshot is over 24 hours old. " : ""}`}No live updates. Recollect and regenerate to see later state.`;
  }
  byId("generated").textContent = snapshot.generatedAt;
  const captures = element("dl");
  captures.className = "metadata";
  for (const [key, time] of Object.entries(snapshot.capturedAt)) {
    captures.append(element("dt", `${key} captured`), element("dd", time ?? "Unknown"));
  }
  byId("captures").append(captures);
  byId("summary").append(metricList(snapshot.summary));
  metadata(byId("scope"), snapshot.scope);
  if (snapshot.freshness) {
    byId("scope").append(element("h3", "Collector freshness proofs"));
    metadata(byId("scope"), snapshot.freshness);
  }
  for (const note of snapshot.limitations) byId("limitations").append(element("li", note));
  const select = byId("channel"),
    status = byId("status"),
    statuses = new Set();
  snapshot.channels.forEach((channel) => {
    const option = element(
      "option",
      `${channel.name ?? channel.id}${channel.scope ? ` · ${channel.scope}` : ""}`,
    );
    option.value = channel.id;
    select.append(option);
    channel.sources.forEach((source) => {
      if (source.reviewStatus) statuses.add(source.reviewStatus);
    });
  });
  for (const value of [...statuses].sort()) {
    const option = element("option", value);
    option.value = value;
    status.append(option);
  }
  function render() {
    const query = byId("search").value.toLocaleLowerCase(),
      channelId = select.value,
      review = status.value;
    const channels = snapshot.channels.filter(
      (channel) =>
        (!channelId || channel.id === channelId) &&
        (!query ||
          `${channel.id} ${channel.name ?? ""} ${channel.scope ?? ""} ${channel.notes.join(" ")}`
            .toLocaleLowerCase()
            .includes(query) ||
          channel.sources.some((source) =>
            JSON.stringify(source).toLocaleLowerCase().includes(query),
          )),
    );
    const rows = byId("channels");
    rows.replaceChildren();
    for (const channel of channels) {
      const tr = element("tr"),
        label = element("th"),
        button = element("button", channel.name ?? channel.id);
      label.scope = "row";
      button.type = "button";
      button.addEventListener("click", () => {
        select.value = channel.id;
        page = 0;
        render();
        byId("source-heading").focus();
      });
      label.append(
        button,
        element("small", `${channel.id}${channel.scope ? ` · ${channel.scope}` : ""}`),
      );
      tr.append(label);
      for (const field of [
        "archived",
        "searchable",
        "reviewedExactCurrentRevision",
        "reviewedStaleRevision",
        "reviewUnknownRevision",
        "retainedProvenance",
        "pending",
      ])
        tr.append(element("td", format(channel.metrics[field])));
      rows.append(tr);
    }
    byId("channel-count").textContent =
      `${channels.length} channel rows shown. Summary totals remain the collector's full snapshot counts; rows may overlap through parent/thread rollups.`;
    const chosen = snapshot.channels.find((channel) => channel.id === channelId),
      details = byId("channel-detail");
    details.replaceChildren();
    if (chosen) {
      details.append(element("h3", chosen.name ?? chosen.id), metricList(chosen.metrics));
      chosen.notes.forEach((note) => details.append(element("p", note)));
    }
    const found = channels.flatMap((channel) =>
      channel.sources
        .filter(
          (source) =>
            (!review || source.reviewStatus === review) &&
            (!query ||
              `${channel.id} ${channel.name ?? ""} ${JSON.stringify(source)}`
                .toLocaleLowerCase()
                .includes(query)),
        )
        .map((source) => ({ channel, source })),
    );
    const pages = Math.max(1, Math.ceil(found.length / 50));
    page = Math.min(page, pages - 1);
    const sourceList = byId("sources");
    sourceList.replaceChildren();
    for (const { channel, source } of found.slice(page * 50, page * 50 + 50)) {
      const detail = element("details"),
        summary = element(
          "summary",
          `${source.id} · ${source.reviewStatus ?? "review status unknown"}`,
        );
      detail.append(summary, element("p", `Channel: ${channel.name ?? channel.id}`));
      if (source.url) {
        const link = element("a", "Open original source in Discord");
        link.href = source.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        detail.append(link);
      }
      const fields = { ...source };
      delete fields.url;
      delete fields.proof;
      delete fields.retainedProvenance;
      metadata(detail, fields);
      detail.append(element("h3", "Durable review proof"));
      metadata(detail, objectOrNote(source.proof));
      detail.append(element("h3", "Retained memory provenance · separate evidence"));
      metadata(detail, objectOrNote(source.retainedProvenance));
      sourceList.append(detail);
    }
    const allKnown =
      snapshot.sourceCoverage?.complete === true &&
      channels.every((channel) => channel.sourcesComplete === true);
    byId("results").textContent =
      `${found.length.toLocaleString()} matching exported source details · page ${page + 1} of ${pages}. ${allKnown ? "Collector marks this export complete for its stated scope." : "Source drill-down is a bounded or incomplete metadata selection; it is not the archive denominator."}`;
    byId("selection").textContent = [
      snapshot.sourceCoverage?.selection,
      chosen?.sourcesSelection,
      chosen?.sourcesLimit != null ? `Channel source-detail limit: ${chosen.sourcesLimit}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (!found.length)
      sourceList.append(
        element(
          "p",
          "No exported source details match these filters. This does not establish absence from the archive.",
        ),
      );
    byId("previous").disabled = page === 0;
    byId("next").disabled = page + 1 >= pages;
  }
  function objectOrNote(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : { evidence: value ?? "Not supplied by this collector; unknown" };
  }
  byId("filters").addEventListener("submit", (event) => event.preventDefault());
  for (const node of [byId("search"), select, status])
    node.addEventListener(node.tagName === "INPUT" ? "input" : "change", () => {
      page = 0;
      render();
    });
  for (const [id, step] of [
    ["previous", -1],
    ["next", 1],
  ])
    byId(id).addEventListener("click", () => {
      page += step;
      render();
      byId("source-heading").focus();
    });
  age();
  setInterval(age, 60_000);
  render();
}

const style = `
:root{font:16px/1.5 system-ui,sans-serif;color:#1c302b;background:#f5f6f1}*{box-sizing:border-box}body{margin:0 auto;max-width:1400px;padding:24px}h1{font:600 32px/1.15 Georgia,serif;margin:8px 0}h2{font-size:21px;margin-top:32px}h3{font-size:16px}p,li{max-width:95ch}header{border-bottom:1px solid #bacbc0;padding-bottom:20px}small,.muted{display:block;color:#4d625b;font-size:13px}a{color:#155a49}button,input,select{font:inherit;padding:10px;border:1px solid #91a89a;background:white;border-radius:4px;color:inherit;min-height:44px}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}:focus-visible{outline:3px solid #a46511;outline-offset:3px}.notice{padding:14px 18px;border-left:4px solid #916c24;background:#f4ead2}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(205px,1fr));gap:12px;margin:16px 0}.metrics>div{border:1px solid #ced8ce;background:#fff;border-radius:5px;padding:16px}.metrics dt{font-size:13px;font-weight:600}.metrics dd{font-size:27px;margin:6px 0}.metrics p{font-size:12px;color:#4d625b;margin:0}.metadata{display:grid;grid-template-columns:minmax(100px,1fr) minmax(0,3fr);gap:5px 14px;font-size:13px}.metadata dt{font-weight:600;overflow-wrap:anywhere}.metadata dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.filters{display:flex;flex-wrap:wrap;gap:14px;align-items:end;margin:24px 0}.filters label{display:grid;gap:6px;font-size:13px;flex:1;min-width:180px}.filters input,.filters select{width:100%;min-width:0}.table-scroll{overflow:auto;max-width:100%;border:1px solid #ced8ce}table{border-collapse:collapse;width:100%;font-size:13px;background:#fff}th,td{padding:12px;text-align:right;border-bottom:1px solid #d9e2d8;vertical-align:top}th:first-child{text-align:left;min-width:170px}thead th{font-size:12px;background:#e9eee6}th button{font-size:13px;text-align:left;max-width:250px;overflow-wrap:anywhere}th small{font-weight:400;margin-top:5px}caption{text-align:left;padding:12px;color:#4d625b;font-size:12px}details{border:1px solid #ced8ce;border-radius:4px;padding:14px;background:#fff;margin:12px 0}summary{cursor:pointer;font-weight:600;overflow-wrap:anywhere}details>h3{margin-top:22px}footer{border-top:1px solid #bacbc0;padding:18px 0;margin-top:32px;font-size:13px}.pager{display:flex;justify-content:space-between;gap:14px}.skip{position:absolute;top:-100px;background:white;padding:12px}.skip:focus{top:6px}#source-heading:focus{outline:3px solid #a46511;outline-offset:3px}#limitations{padding-left:22px}@media(max-width:500px){body{padding:14px}h1{font-size:27px}.metrics{grid-template-columns:1fr}.metadata{grid-template-columns:1fr}.metadata dd{margin-bottom:10px}.filters label{min-width:0;flex-basis:100%}}
`;
export function renderInspector(input) {
  const snapshot = validateSnapshot(input);
  const script = `(${inspect.toString()})(${scriptJson(snapshot)},${scriptJson(metricDefinitions)});`;
  const hash = (value) => createHash("sha256").update(value).digest("base64");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(style)}'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"><meta name="referrer" content="no-referrer"><title>Coverage & provenance · offline snapshot</title><style>${style}</style></head><body><a class="skip" href="#report">Skip to report</a><header><small>LOCAL OPERATOR REPORT / READ ONLY</small><h1>Coverage & provenance</h1><p>Independent evidence measures, not a processing funnel. Archived, searchable, reviewed and retained sources can overlap. Unknown values are not zero. Current revision means current at the collector capture, not a live Discord check.</p><p>Generated <time id="generated"></time></p><p id="age" class="notice"></p><div id="captures"></div></header><main id="report"><h2>Snapshot accounting</h2><div id="summary"></div><details><summary>Scope, exclusions and limits</summary><div id="scope"></div><ul id="limitations"></ul></details><form id="filters" class="filters" role="search"><label>Search channel, source ID or provenance<input id="search" type="search" maxlength="300"></label><label>Channel<select id="channel"><option value="">All exported channels</option></select></label><label>Source review status<select id="status"><option value="">All exported statuses</option></select></label></form><h2>Channel coverage</h2><p id="channel-count" role="status"></p><div class="table-scroll"><table><caption>Independent source counts; unknown metrics remain unknown. Choose a channel to inspect all its exported metrics and source details.</caption><thead><tr><th scope="col">Channel</th><th scope="col">Archived</th><th scope="col">Searchable</th><th scope="col">Reviewed exact revision</th><th scope="col">Reviewed earlier revision</th><th scope="col">Review revision unknown</th><th scope="col">Retained provenance</th><th scope="col">Pending</th></tr></thead><tbody id="channels"></tbody></table></div><div id="channel-detail"></div><h2 id="source-heading" tabindex="-1">Source & memory evidence</h2><p id="results" role="status" aria-live="polite"></p><p id="selection" class="muted"></p><div id="sources"></div><div class="pager"><button type="button" id="previous">Previous 50</button><button type="button" id="next">Next 50</button></div><noscript><p>This report needs its embedded script enabled to inspect the snapshot. It makes no network requests.</p></noscript></main><footer>Static metadata report. The collector owns evidence and denominators; this view does not recollect, review, repair or write runtime state. Source links open only when selected.</footer><script>${script}</script></body></html>`;
}

function outsideRepository(path) {
  let ancestor = resolve(path);
  const missing = [];
  while (!existsSync(ancestor)) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  const physical = resolve(realpathSync(ancestor), ...missing),
    repo = realpathSync(resolve(import.meta.dirname, "../..")),
    rel = relative(repo, physical);
  if (
    !isAbsolute(rel) &&
    rel !== ".." &&
    !rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/"))
  )
    throw new Error("Snapshot and output must be outside the repository");
}
export async function writeInspector(inputPath, outputPath) {
  outsideRepository(inputPath);
  outsideRepository(outputPath);
  const info = await lstat(inputPath);
  if (!info.isFile() || info.mode & 0o077 || info.size > 16 * 1024 * 1024)
    throw new Error("Snapshot must be a private regular JSON file of at most 16 MiB");
  const html = renderInspector(JSON.parse(await readFile(inputPath, "utf8")));
  await writeFile(outputPath, html, { flag: "wx", mode: 0o600 });
}
function openReport(path) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [path]]
      : process.platform === "win32"
        ? ["rundll32.exe", ["url.dll,FileProtocolHandler", pathToFileURL(path).href]]
        : ["xdg-open", [path]];
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? accept()
        : reject(new Error("Could not open report; open the generated HTML file manually")),
    );
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output, ...options] = process.argv.slice(2);
  if (!input || !output || options.length > 1 || options.some((option) => option !== "--open"))
    throw new Error(
      "Use coverage-inspector.mjs /private/snapshot.json /private/report.html [--open]",
    );
  try {
    await writeInspector(resolve(input), resolve(output));
    console.log("Offline coverage report written; snapshot state was not changed.");
    if (options.includes("--open")) await openReport(resolve(output));
  } catch (error) {
    console.error(
      error.code === "EEXIST"
        ? "Output already exists; choose a new report path to preserve it."
        : error instanceof SyntaxError
          ? "Snapshot is not valid JSON."
          : error.message,
    );
    process.exitCode = 1;
  }
}
