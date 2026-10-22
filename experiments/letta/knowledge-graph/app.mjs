import { selectGraph } from "./model.mjs";
const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const number = (value) =>
  value === null || value === undefined ? "Unknown" : Number(value).toLocaleString();
const date = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "Unknown date";
let snapshot,
  selected = "",
  focus = "",
  page = 0;
const colors = {
  person: "#1e7263",
  topic: "#92662a",
  candidate: "#4f5baa",
  claim: "#8b4e82",
  message: "#566d7b",
};
const types = ["person", "message", "claim", "candidate", "topic"];
function button(text, action, className) {
  const node = el("button", text, className);
  node.type = "button";
  node.addEventListener("click", (event) => {
    const inspectWithKeyboard =
      event.detail === 0 && (node.classList.contains("record") || node.closest("#detail"));
    action();
    if (inspectWithKeyboard) {
      const heading = $("detail").querySelector("h3");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus();
      }
    }
  });
  return node;
}
function choose(id) {
  selected = id;
  showDetail();
  renderGraph();
}
function focusOn(id) {
  focus = id;
  page = 0;
  $("search").value = "";
  $("type").value = "all";
  $("status").value = "all";
  choose(id);
}
function svgEl(tag, attrs) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}
function renderGraph() {
  if (!snapshot) return;
  const view = selectGraph(snapshot.graph, {
    query: $("search").value,
    type: $("type").value,
    status: $("status").value,
    focus,
    depth: Number($("depth").value),
    limit: 100,
    offset: page * 100,
  });
  $("graph-count").textContent =
    `${number(view.total)} matching records · ${view.nodes.length} shown${focus ? " · focused neighborhood" : ""}`;
  const graph = $("graph");
  graph.replaceChildren();
  const groups = Object.fromEntries(
    types.map((type) => [type, view.nodes.filter((node) => node.type === type)]),
  );
  const height = Math.max(340, ...Object.values(groups).map((nodes) => nodes.length * 56 + 65)),
    width = Math.max(700, graph.parentElement.clientWidth),
    columnWidth = width / types.length,
    nodeWidth = columnWidth - 20,
    labelLength = Math.floor((nodeWidth - 30) / 5.5);
  graph.setAttribute("viewBox", `0 0 ${width} ${height}`);
  graph.setAttribute("width", String((width * Number($("zoom").value)) / 100));
  graph.setAttribute("height", String((height * Number($("zoom").value)) / 100));
  const positions = new Map();
  types.forEach((type, column) => {
    const title = svgEl("text", { x: column * columnWidth + 15, y: 24 });
    title.textContent = type.toUpperCase();
    graph.append(title);
    groups[type].forEach((node, index) =>
      positions.set(node.id, { x: column * columnWidth + 10, y: index * 56 + 45 }),
    );
  });
  for (const edge of view.edges) {
    const from = positions.get(edge.from),
      to = positions.get(edge.to);
    const line = svgEl("path", {
      d: `M${from.x + nodeWidth / 2} ${from.y + 17} C${from.x + nodeWidth / 2} ${from.y + 45},${to.x + nodeWidth / 2} ${to.y - 20},${to.x + nodeWidth / 2} ${to.y + 17}`,
      class: "edge",
      fill: "none",
    });
    const title = svgEl("title", {});
    title.textContent = edge.relation;
    line.append(title);
    graph.append(line);
  }
  for (const node of view.nodes) {
    const pos = positions.get(node.id),
      group = svgEl("g", {
        class: `node ${node.id === selected ? "selected" : ""}`,
        transform: `translate(${pos.x},${pos.y})`,
      });
    group.style.color = colors[node.type];
    const rect = svgEl("rect", { width: nodeWidth, height: 34, rx: 6 }),
      dot = svgEl("circle", { cx: 12, cy: 17, r: 4 }),
      text = svgEl("text", { x: 23, y: 21 });
    text.textContent =
      node.label.length > labelLength ? node.label.slice(0, labelLength - 1) + "…" : node.label;
    const title = svgEl("title", {});
    title.textContent = `${node.type}: ${node.label}`;
    group.append(title, rect, dot, text);
    group.addEventListener("click", () => choose(node.id));
    graph.append(group);
  }
  const records = $("records");
  records.replaceChildren();
  if (!view.nodes.length)
    records.append(
      el("p", "No records match these filters. Clear the focus or adjust the search."),
    );
  for (const node of view.nodes) {
    const item = button(
      "",
      () => choose(node.id),
      `record ${node.id === selected ? "selected" : ""}`,
    );
    item.append(el("small", node.type, node.type), el("span", node.label));
    item.setAttribute("aria-pressed", String(node.id === selected));
    records.append(item);
  }
  if (view.total > 100) {
    const pager = el("div", undefined, "panel-head");
    const previous = button("← Previous 100", () => {
        page--;
        renderGraph();
        $("records").querySelector(".panel-head button:not(:disabled)")?.focus();
      }),
      next = button("Next 100 →", () => {
        page++;
        renderGraph();
        $("records").querySelector(".panel-head button:not(:disabled)")?.focus();
      });
    previous.disabled = page === 0;
    next.disabled = (page + 1) * 100 >= view.total;
    pager.append(previous, el("span", `Page ${page + 1} of ${Math.ceil(view.total / 100)}`), next);
    records.append(pager);
  }
}
function sourceLink(source) {
  if (
    !source ||
    ![source.guildId, source.channelId, source.id].every((value) => /^\d{17,20}$/.test(value ?? ""))
  )
    return el("span", "No Discord link available", "meta");
  const link = el("a", "Open original in Discord ↗");
  link.href = `https://discord.com/channels/${source.guildId}/${source.channelId}/${source.id}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}
function paragraph(parent, text, className) {
  parent.append(el("p", text, className));
}
function showDetail() {
  const node = snapshot?.graph.nodes.find((item) => item.id === selected);
  if (!node) return;
  const detail = $("detail"),
    body = el("div", undefined, "detail-body");
  detail.replaceChildren(body);
  body.append(
    el("span", `${node.type.toUpperCase()} / EVIDENCE INSPECTOR`, "eyebrow"),
    el("h3", node.label),
  );
  if (node.status) body.append(el("span", node.status, "badge"));
  if (node.evidenceStatus) body.append(el("span", node.evidenceStatus, "badge"));
  if (node.date) paragraph(body, date(node.date), "meta");
  body.append(button("Focus connections", () => focusOn(node.id)));
  if (node.type === "candidate") {
    paragraph(body, `Annotation ${node.annotationId} · revision ${node.revision}`, "meta");
    paragraph(body, `Selection: ${node.manifestId} / ${node.episodeId}`, "meta");
    paragraph(
      body,
      `Attributed candidate interpretation. Recorded uncertainty: ${node.candidate.uncertainty ?? "unknown"}.`,
    );
    body.append(el("h4", "Qualifications & boundaries"));
    const qualifications = el("ul");
    for (const text of node.candidate.qualifications ?? []) qualifications.append(el("li", text));
    if (!qualifications.childNodes.length)
      qualifications.append(
        el("li", "No qualifications recorded; this does not establish certainty."),
      );
    body.append(qualifications);
    body.append(el("h4", "Original evidence"));
    for (const evidence of node.evidence) {
      const section = el("details");
      section.open = evidence.role === "direct";
      section.append(el("summary", `${evidence.role.toUpperCase()} · ${evidence.sourceId}`));
      paragraph(
        section,
        `${evidence.status} · bound revision ${evidence.revision ?? "unknown"} / current ${evidence.currentRevision ?? "unavailable"}`,
        "meta",
      );
      paragraph(section, evidence.quoteStatus, "meta");
      for (const quote of evidence.quotes) section.append(el("blockquote", quote));
      if (evidence.role === "context")
        paragraph(
          section,
          "Context helps interpretation; it is not direct evidence for the attributed claim.",
          "warning",
        );
      const source = evidence.original ?? evidence.current;
      if (source) {
        paragraph(
          section,
          `${source.authorName ?? source.authorId ?? "Unknown author"} · ${date(source.createdAt)}`,
          "meta",
        );
        paragraph(
          section,
          evidence.original
            ? "Content of the bound source revision:"
            : "Current stored content; the bound historical revision is unavailable:",
          "meta",
        );
        paragraph(section, source.content);
        section.append(sourceLink(source));
        if (
          source.replyTo &&
          !snapshot.graph.nodes.some((item) => item.id === `message:${source.replyTo}`)
        )
          paragraph(
            section,
            `Reply parent ${source.replyTo} lies outside the graph selection; its content has not been inferred.`,
            "warning",
          );
      } else
        paragraph(
          section,
          "Source unavailable. The recorded quotation remains historical annotation evidence, not a fresh verification.",
          "warning",
        );
      section.append(
        button(
          "Inspect message record",
          () => choose(`message:${evidence.sourceId}`),
          "link-button",
        ),
      );
      body.append(section);
    }
    const versions = snapshot.graph.nodes
      .filter((item) => item.type === "candidate" && item.annotationId === node.annotationId)
      .sort((a, b) => a.revision - b.revision);
    body.append(el("h4", "Revision chronology"));
    for (const version of versions)
      body.append(
        button(
          `v${version.revision} · ${version.status} · ${date(version.date)}`,
          () => choose(version.id),
          "link-button",
        ),
      );
    if (node.corrections.length) {
      body.append(el("h4", "Recorded corrections"));
      for (const correction of node.corrections) {
        paragraph(body, `${correction.status} · ${date(correction.created_at)}`);
        if (correction.review_note) paragraph(body, correction.review_note);
        if (correction.resolved_at)
          paragraph(body, `Resolved ${date(correction.resolved_at)}`, "meta");
      }
    }
  }
  if (node.type === "message") {
    paragraph(body, `Original message · stored revision ${node.revision ?? "unknown"}`, "meta");
    if (node.source) {
      paragraph(body, node.source.content ?? "Content unavailable");
      paragraph(
        body,
        `Channel ${node.channelId ?? "unknown"} · ${date(node.source.createdAt)}`,
        "meta",
      );
      body.append(sourceLink(node.source));
      if (node.outsideParent)
        paragraph(
          body,
          `Reply parent ${node.outsideParent} is outside this selected graph.`,
          "warning",
        );
    }
    paragraph(
      body,
      "Stored content is a database snapshot. Current Discord availability and edits have not been checked by this explorer.",
      "warning",
    );
  }
  if (node.type === "claim") {
    paragraph(
      body,
      "This is one claim inside a candidate interpretation; inspect the candidate for its full qualifications and revision history.",
    );
    body.append(
      button("Inspect containing candidate", () => choose(node.candidateId), "link-button"),
    );
    for (const anchor of node.claim.anchors ?? []) {
      body.append(
        el("h4", `${anchor.relation} · attributed to ${anchor.attributedTo}`),
        el("blockquote", anchor.quote),
      );
      body.append(
        button(
          `Source ${anchor.sourceId}`,
          () => choose(`message:${anchor.sourceId}`),
          "link-button",
        ),
      );
    }
  }
  body.append(el("h4", "Recorded connections"));
  const connections = snapshot.graph.edges.filter(
    (edge) => edge.from === node.id || edge.to === node.id,
  );
  for (const edge of connections) {
    const outgoing = edge.from === node.id,
      other = snapshot.graph.nodes.find((item) => item.id === (outgoing ? edge.to : edge.from));
    if (other)
      body.append(
        button(
          `${outgoing ? "→" : "←"} ${edge.relation}: ${other.label}`,
          () => choose(other.id),
          "link-button",
        ),
      );
  }
  if (!connections.length) paragraph(body, "No relationships recorded in the selected data.");
}
function renderCoverage() {
  const { archive, pilot, stages } = snapshot.coverage,
    metrics = $("metrics");
  metrics.replaceChildren();
  for (const [title, value, description] of [
    ["Stored archive rows", archive.total?.stored, "Archive denominator; inventory unknown"],
    [
      "Committed review targets",
      stages.reviewed,
      "Distinct IDs with committed episode/work receipts",
    ],
    [
      "Represented direct sources",
      stages.represented,
      "Distinct direct IDs in current candidate annotations",
    ],
    ["Deferred targets", stages.deferred, "Distinct selected IDs in deferred episodes"],
    ["Usable archive text", archive.total?.usable, "Nondeleted, nonblank, outside threads"],
    ["Loaded review context", stages.context, "Distinct context IDs; separate from targets"],
    [
      "Current candidates",
      pilot.currentCandidates,
      `${pilot.annotationVersions} retained annotation versions`,
    ],
    ["Conversational memory", pilot.memory.entries, "Memory entries are not claim annotations"],
  ]) {
    const card = el("div", undefined, "metric");
    card.append(el("span", title), el("strong", number(value)), el("span", description));
    metrics.append(card);
  }
  const notes = $("coverage-notes");
  notes.replaceChildren();
  paragraph(notes, archive.note);
  if (archive.rows.length) {
    const timestamps = archive.rows
      .flatMap((row) => [Date.parse(row.first), Date.parse(row.last)])
      .filter(Number.isFinite);
    paragraph(
      notes,
      `Archive span: ${date(Math.min(...timestamps))} to ${date(Math.max(...timestamps))} · ${new Set(archive.rows.map((row) => `${row.guild_id}/${row.channel_id}`)).size} stored channels · ${number(archive.total.thread_rows)} thread rows. Stored thread rows do not establish complete thread inventory.`,
    );
  }
  paragraph(
    notes,
    `Pilot message cache: ${number(pilot.cache.stored)} rows, ${date(pilot.cache.first)} to ${date(pilot.cache.last)}. This is a separate, possibly newer store; its rows are not added to the archive denominator.`,
  );
  paragraph(
    notes,
    `Historical episodes: ${pilot.episodes.map((row) => `${row.status}: ${number(row.count)}`).join(" · ")}. Deferred and excluded do not mean reviewed.`,
  );
  paragraph(
    notes,
    "Represented counts current candidate direct sources, including stale or unavailable evidence; inspect the graph before relying on a claim. No current full-server inventory, complete thread census or latest-edit review denominator is available.",
  );
  for (const [id, values, label] of [
    [
      "coverage-channel",
      [...new Set(archive.rows.map((row) => `${row.guild_id}/${row.channel_id}`))].sort(),
      "All stored channels",
    ],
    [
      "coverage-month",
      [...new Set(archive.rows.map((row) => row.month))].sort(),
      "All stored months",
    ],
  ]) {
    const select = $(id);
    select.replaceChildren(new Option(label, "all"));
    for (const value of values) select.add(new Option(value, value));
  }
  const manifests = $("manifests");
  manifests.replaceChildren();
  for (const manifest of snapshot.graph.manifests) {
    const item = el("details");
    item.append(
      el(
        "summary",
        `${manifest.id} · generation ${manifest.generation} · ${date(manifest.createdAt)}`,
      ),
    );
    for (const episode of manifest.episodes)
      paragraph(
        item,
        `${episode.label ?? episode.key} · ${episode.direct} direct pins / ${episode.context} context pins`,
      );
    manifests.append(item);
  }
  renderCoverageRows();
}
function renderCoverageRows() {
  const archive = snapshot.coverage.archive,
    rows = archive.rows.filter(
      (row) =>
        ($("coverage-channel").value === "all" ||
          `${row.guild_id}/${row.channel_id}` === $("coverage-channel").value) &&
        ($("coverage-month").value === "all" || row.month === $("coverage-month").value),
    );
  const body = $("coverage-rows");
  body.replaceChildren();
  for (const row of rows) {
    const tr = el("tr"),
      label = el("td", `${row.channel_id} / ${row.month}`);
    label.append(el("small", `Server ${row.guild_id}`));
    tr.append(label);
    for (const field of [
      "stored",
      "usable",
      "reviewed",
      "context",
      "represented",
      "selected",
      "deferred",
      "without_review_receipt",
    ])
      tr.append(el("td", number(row[field])));
    body.append(tr);
  }
  const matched = (field) => rows.reduce((sum, row) => sum + row[field], 0);
  $("coverage-summary").textContent =
    archive.status === "unavailable"
      ? "Archive unavailable; channel/month accounting is unknown."
      : `${rows.length} channel/month buckets · ${number(matched("stored"))} stored rows · ${number(matched("reviewed"))} matched committed review IDs. ${number(snapshot.coverage.stages.reviewed - (archive.total?.reviewed ?? 0))} reviewed IDs do not match this archive snapshot. These are counts, not a completeness percentage.`;
}
async function refresh() {
  $("refresh").disabled = true;
  $("notice").textContent = "Reading a bounded snapshot from the local stores…";
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? "Snapshot unavailable");
    snapshot = value;
    $("mode").textContent = value.mode;
    $("snapshot-time").textContent = `Snapshot ${date(value.generatedAt)}`;
    if (!snapshot.graph.nodes.some((node) => node.id === selected)) {
      selected =
        snapshot.graph.nodes.find(
          (node) => node.type === "candidate" && node.status === "candidate",
        )?.id ?? "";
      focus = selected;
      page = 0;
    }
    renderGraph();
    showDetail();
    renderCoverage();
    $("notice").textContent = `Snapshot loaded. ${snapshot.graph.notes[2]}`;
  } catch (error) {
    $("notice").textContent =
      `${error.message}${snapshot ? " The previous snapshot is still displayed; its timestamp is unchanged." : ""}`;
  } finally {
    $("refresh").disabled = false;
  }
}
$("filters").addEventListener("submit", (event) => event.preventDefault());
for (const id of ["search", "type", "status"])
  $(id).addEventListener("input", () => {
    focus = "";
    page = 0;
    renderGraph();
  });
$("depth").addEventListener("change", () => {
  page = 0;
  renderGraph();
});
$("zoom").addEventListener("input", renderGraph);
$("clear-focus").addEventListener("click", () => {
  focus = "";
  page = 0;
  renderGraph();
});
$("refresh").addEventListener("click", refresh);
for (const id of ["coverage-channel", "coverage-month"])
  $(id).addEventListener("change", renderCoverageRows);
for (const view of ["explore", "coverage"])
  $(view + "-tab").addEventListener("click", () => {
    for (const name of ["explore", "coverage"]) {
      $(name).hidden = name !== view;
      if (name === view) $(name + "-tab").setAttribute("aria-current", "page");
      else $(name + "-tab").removeAttribute("aria-current");
    }
  });
await refresh();

window.addEventListener("resize", renderGraph);
