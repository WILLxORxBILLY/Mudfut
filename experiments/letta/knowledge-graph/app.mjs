import { selectGraph } from "./model.mjs";
import { layoutGraph } from "./layout.mjs";
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
const typeLabels = {
  person: "Person",
  message: "Message",
  claim: "Claim",
  candidate: "Interpretation",
  topic: "Topic",
};
let activeStory = "",
  camera = { x: 0, y: 0 },
  mapSize = { width: 1000, height: 560 };
function showView(view) {
  for (const name of ["explore", "coverage"]) {
    $(name).hidden = name !== view;
    if (name === view) $(name + "-tab").setAttribute("aria-current", "page");
    else $(name + "-tab").removeAttribute("aria-current");
  }
  if (view === "explore") renderGraph();
}
function resetCamera() {
  camera = { x: 0, y: 0 };
  $("zoom").value = "100";
}
function updateCamera() {
  const scale = Number($("zoom").value) / 100;
  const { width, height } = mapSize;
  $("graph").setAttribute(
    "viewBox",
    `${camera.x + (width * (1 - 1 / scale)) / 2} ${camera.y + (height * (1 - 1 / scale)) / 2} ${width / scale} ${height / scale}`,
  );
}
function renderStories() {
  const stories = $("stories");
  stories.replaceChildren();
  $("demo-guide").hidden = !snapshot.demo;
  for (const story of snapshot.demo?.stories ?? []) {
    const card = button("", () => openStory(story.id), "story-card");
    card.setAttribute("aria-pressed", String(story.id === activeStory));
    card.append(
      el("span", story.label, "eyebrow"),
      el("strong", story.title),
      el(
        "span",
        story.id === activeStory ? "Exploring now ↗" : "Explore this story →",
        "story-action",
      ),
    );
    stories.append(card);
  }
  const story = snapshot.demo?.stories.find((item) => item.id === activeStory);
  $("story-title").textContent = story?.title ?? "Follow your curiosity.";
  $("story-description").textContent =
    story?.description ??
    "Search for a person or idea, select a record, and follow its connections back to the original words.";
}
function openStory(id) {
  const story = snapshot.demo?.stories.find((item) => item.id === id);
  if (!story) return;
  activeStory = id;
  resetCamera();
  renderStories();
  if (story.view === "coverage") showView("coverage");
  else {
    $("depth").value = String(story.depth);
    showView("explore");
    focusOn(story.nodeId);
  }
}
function wholeMap() {
  activeStory = "";
  focus = "";
  selected = "";
  page = 0;
  for (const id of ["type", "status"]) $(id).value = "all";
  $("search").value = "";
  resetCamera();
  renderStories();
  showDetail();
  renderGraph();
}
function button(text, action, className) {
  const node = el("button", text, className);
  node.type = "button";
  node.addEventListener("click", (event) => {
    const inspectWithKeyboard =
      event.detail === 0 && (node.classList.contains("record") || node.closest("#detail"));
    action();
    if (event.detail === 0 && node.classList.contains("story-card"))
      $("stories").querySelector('[aria-pressed="true"]')?.focus();
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
  resetCamera();
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
  $("read-evidence").hidden = !snapshot.graph.nodes.some((node) => node.id === selected);
  const graph = $("graph");
  graph.replaceChildren();
  const compact = graph.parentElement.clientWidth < 600 && view.nodes.length <= 12;
  const width = Math.max(compact ? 360 : 800, graph.parentElement.clientWidth),
    height = compact ? 660 : Math.max(530, Math.ceil(view.nodes.length / 9) * 100);
  graph.style.width = `${width}px`;
  graph.style.height = `${height}px`;
  mapSize = { width, height };
  const positions = layoutGraph(view.nodes, view.edges, width, height);
  const connected = new Set([selected]);
  for (const edge of view.edges)
    if (edge.from === selected || edge.to === selected) {
      connected.add(edge.from);
      connected.add(edge.to);
    }
  const hasSelection = view.nodes.some((node) => node.id === selected);
  updateCamera();
  $("map-empty").hidden = view.nodes.length > 0;
  graph.parentElement.hidden = !view.nodes.length;
  for (const edge of view.edges) {
    const from = positions.get(edge.from),
      to = positions.get(edge.to);
    const active = edge.from === selected || edge.to === selected;
    const contextual = /context|compet|revis|supersed/.test(edge.relation);
    const line = svgEl("path", {
      d: `M${from.x} ${from.y} Q${(from.x + to.x) / 2 + (to.y - from.y) * 0.08} ${(from.y + to.y) / 2 - (to.x - from.x) * 0.08},${to.x} ${to.y}`,
      class: `edge ${active ? "active" : ""} ${contextual ? "contextual" : ""} ${hasSelection && !active ? "dimmed" : ""}`,
      fill: "none",
    });
    const title = svgEl("title", {});
    title.textContent = edge.relation;
    line.append(title);
    graph.append(line);
  }
  let labelCount = 0;
  for (const edge of view.edges) {
    if ((edge.from !== selected && edge.to !== selected) || labelCount++ >= 5) continue;
    const from = positions.get(edge.from),
      to = positions.get(edge.to);
    const label = svgEl("text", {
      x: (from.x + to.x) / 2,
      y: (from.y + to.y) / 2 - 6,
      class: "edge-label",
      "text-anchor": "middle",
    });
    label.textContent = edge.relation.replace(" identity (latest revision)", "");
    graph.append(label);
  }
  for (const node of view.nodes) {
    const pos = positions.get(node.id);
    const group = svgEl("g", {
      class: `node ${node.type} ${node.id === selected ? "selected" : ""} ${hasSelection && !connected.has(node.id) ? "dimmed" : ""}`,
      transform: `translate(${pos.x},${pos.y})`,
      role: "button",
      tabindex: "0",
      "aria-label": `${typeLabels[node.type]}: ${node.label}`,
      "aria-pressed": String(node.id === selected),
    });
    group.style.color = colors[node.type];
    const title = svgEl("title", {});
    title.textContent = `${typeLabels[node.type]}: ${node.label}`;
    group.append(title);
    if (node.type === "candidate" || node.type === "topic") {
      const w = node.type === "candidate" ? 170 : 110,
        h = node.type === "candidate" ? 56 : 30;
      group.append(
        svgEl("rect", {
          x: -w / 2,
          y: -h / 2,
          width: w,
          height: h,
          rx: node.type === "topic" ? 15 : 9,
          class: "node-shape",
        }),
      );
    } else if (node.type === "claim")
      group.append(svgEl("path", { d: "M0 -17 L17 0 L0 17 L-17 0 Z", class: "node-shape" }));
    else {
      group.append(svgEl("circle", { r: node.type === "person" ? 23 : 8, class: "node-shape" }));
      if (node.type === "person") {
        const initial = svgEl("text", { y: 5, "text-anchor": "middle", class: "initial" });
        initial.textContent = [...node.label][0] ?? "";
        group.append(initial);
      }
    }
    const limit = node.type === "candidate" ? 23 : 18;
    const label =
      node.type === "message" ? `${node.source?.authorName ?? "Unknown"} · message` : node.label;
    const words = label.split(/\s+/),
      lines = [""];
    for (const word of words) {
      if ((lines.at(-1) + " " + word).trim().length > limit && lines.at(-1)) lines.push(word);
      else lines[lines.length - 1] = (lines.at(-1) + " " + word).trim();
    }
    const shown = lines.slice(0, node.type === "candidate" ? 2 : 1);
    if (lines.length > shown.length)
      shown[shown.length - 1] = shown.at(-1).slice(0, limit - 1) + "…";
    const startY =
      node.type === "candidate" ? -4 : node.type === "topic" ? 4 : node.type === "person" ? 43 : 32;
    shown.forEach((text, index) => {
      const line = svgEl("text", {
        y: startY + index * 16,
        "text-anchor": "middle",
        class: "node-label",
      });
      line.textContent = text.length > limit ? text.slice(0, limit - 1) + "…" : text;
      group.append(line);
    });
    if (node.type === "candidate") {
      const badge = svgEl("text", { y: 21, "text-anchor": "middle", class: "node-meta" });
      badge.textContent =
        node.status === "superseded"
          ? "EARLIER VERSION"
          : node.evidenceStatus === "stale"
            ? "SOURCE CHANGED"
            : `INTERPRETATION · V${node.revision}`;
      group.append(badge);
    }
    group.addEventListener("click", () => choose(node.id));
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        choose(node.id);
        const heading = $("detail").querySelector("h3");
        heading.tabIndex = -1;
        heading.focus();
      }
    });
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
    item.append(el("small", typeLabels[node.type], node.type), el("span", node.label));
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
  if (!node) {
    $("detail").replaceChildren();
    const empty = el("div", undefined, "empty-detail");
    empty.append(
      el("span", "EVIDENCE INSPECTOR", "eyebrow"),
      el("h3", "Every idea has a source."),
      el(
        "p",
        "Select a person, topic or interpretation to follow its recorded connections. Open a message to see the original words.",
      ),
    );
    $("detail").append(empty);
    return;
  }
  const detail = $("detail"),
    body = el("div", undefined, "detail-body");
  detail.replaceChildren(body);
  body.append(
    el("span", `${typeLabels[node.type].toUpperCase()} / EVIDENCE INSPECTOR`, "eyebrow"),
    el("h3", node.label),
  );
  if (node.status) body.append(el("span", node.status, "badge"));
  if (node.evidenceStatus)
    body.append(
      el(
        "span",
        node.evidenceStatus,
        `badge ${node.evidenceStatus === "stale" || node.evidenceStatus === "unavailable" ? "caution" : ""}`,
      ),
    );
  if (node.date) paragraph(body, date(node.date), "meta");
  body.append(button("Focus connections", () => focusOn(node.id)));
  if (node.type === "candidate") {
    const previous = snapshot.graph.nodes
      .filter(
        (item) =>
          item.type === "candidate" &&
          item.annotationId === node.annotationId &&
          item.revision < node.revision,
      )
      .sort((a, b) => b.revision - a.revision)[0];
    if (previous) {
      const change = el("div", undefined, "revision-comparison");
      change.append(
        el("span", "UNDERSTANDING, REVISED", "eyebrow"),
        el("p", `Earlier · ${previous.label}`, "earlier"),
        el("p", `Now · ${node.label}`, "current"),
        button("Inspect earlier interpretation →", () => choose(previous.id), "link-button"),
      );
      body.append(change);
    }
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
      const sourceWasEdited =
        evidence.original && evidence.current && evidence.revision !== evidence.currentRevision;
      if (!sourceWasEdited)
        for (const quote of evidence.quotes) section.append(el("blockquote", quote));
      if (evidence.role === "context")
        paragraph(
          section,
          "Context helps interpretation; it is not direct evidence for the attributed claim.",
          "warning",
        );
      if (sourceWasEdited) {
        const comparison = el("div", undefined, "source-comparison");
        comparison.append(
          el("h4", "The source was edited"),
          el("span", `BOUND REVISION ${evidence.revision}`, "eyebrow"),
          el("blockquote", evidence.original.content),
          el("span", `CURRENT REVISION ${evidence.currentRevision}`, "eyebrow"),
          el("blockquote", evidence.current.content),
        );
        section.append(comparison);
      }
      const source = evidence.original ?? evidence.current;
      if (source) {
        paragraph(
          section,
          `${source.authorName ?? source.authorId ?? "Unknown author"} · ${date(source.createdAt)}`,
          "meta",
        );
        if (!sourceWasEdited && !evidence.quotes.includes(source.content)) {
          paragraph(
            section,
            evidence.original
              ? "Content of the bound source revision:"
              : "Current stored content; the bound historical revision is unavailable:",
            "meta",
          );
          paragraph(section, source.content);
        }
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
  if (node.type === "candidate") {
    const metadata = el("details");
    metadata.append(el("summary", "Record metadata"));
    paragraph(metadata, `Annotation ${node.annotationId} · revision ${node.revision}`, "meta");
    paragraph(metadata, `Selection: ${node.manifestId} / ${node.episodeId}`, "meta");
    body.append(metadata);
  }
  if (node.type === "person" || node.type === "topic") {
    paragraph(
      body,
      node.type === "person"
        ? "Follow this person's messages and the interpretations attributed to them. A shared topic does not establish a social relationship."
        : "Follow the interpretations tagged with this topic. Different perspectives stay attributed to their original speakers.",
    );
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
    $("mode").textContent = value.demo ? "Fictional demo" : value.mode;
    document.body.classList.toggle("is-demo", Boolean(value.demo));
    if (value.demo) {
      $("community-name").textContent = "WELCOME TO " + value.demo.community.toUpperCase();
      $("community-description").textContent = value.demo.description;
      $("refresh").textContent = "Reload demo ↻";
      $("footer-note").textContent =
        "Fictional data. Local, read-only exploration. No model, Discord or database connection.";
    }
    renderStories();
    $("snapshot-time").textContent = `Snapshot ${date(value.generatedAt)}`;
    if (!value.demo && !snapshot.graph.nodes.some((node) => node.id === selected)) {
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
    if (value.demo && !activeStory && !$("search").value && !selected)
      openStory(value.demo.stories[0].id);
    $("notice").textContent = value.demo
      ? "Demo ready. Every person, message and coverage count shown here is fictional."
      : `Snapshot loaded. ${snapshot.graph.notes[2]}`;
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
    activeStory = "";
    resetCamera();
    renderStories();
    page = 0;
    renderGraph();
  });
$("depth").addEventListener("change", () => {
  page = 0;
  renderGraph();
});
$("zoom").addEventListener("input", updateCamera);
$("fit").addEventListener("click", () => {
  resetCamera();
  updateCamera();
});
$("empty-reset").addEventListener("click", () => {
  wholeMap();
  $("search").focus();
});
$("read-evidence").addEventListener("click", () => {
  const heading = $("detail").querySelector("h3");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    $("detail").scrollIntoView({ block: "start" });
  }
});
$("clear-focus").addEventListener("click", wholeMap);
$("refresh").addEventListener("click", refresh);
for (const id of ["coverage-channel", "coverage-month"])
  $(id).addEventListener("change", renderCoverageRows);
for (const view of ["explore", "coverage"])
  $(view + "-tab").addEventListener("click", () => showView(view));
let drag;
$("graph").addEventListener("pointerdown", (event) => {
  if (event.target.closest(".node") || event.button !== 0) return;
  const box = $("graph").getBoundingClientRect(),
    viewBox = $("graph").viewBox.baseVal;
  drag = {
    x: event.clientX,
    y: event.clientY,
    camera: { ...camera },
    scale: Math.max(viewBox.width / box.width, viewBox.height / box.height),
  };
  $("graph").setPointerCapture(event.pointerId);
  $("graph").classList.add("panning");
});
$("graph").addEventListener("pointermove", (event) => {
  if (!drag) return;
  camera = {
    x: drag.camera.x - (event.clientX - drag.x) * drag.scale,
    y: drag.camera.y - (event.clientY - drag.y) * drag.scale,
  };
  updateCamera();
});
for (const event of ["pointerup", "pointercancel", "lostpointercapture"])
  $("graph").addEventListener(event, () => {
    drag = null;
    $("graph").classList.remove("panning");
  });
await refresh();
window.addEventListener("resize", () => {
  resetCamera();
  renderGraph();
});
