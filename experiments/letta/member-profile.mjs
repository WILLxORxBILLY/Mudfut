// Evidence-backed member profiles from extracted statements.
// A message with no statement is not treated as unread, and one statement is
// not treated as every claim in that message. Near-duplicate extractions are
// not independent confirmation. Lexical grouping is not a new claim.

import { createHash } from "node:crypto";

export const PROFILE_VERSION = "member-profile-v2";

export const PROFILE_LIMITATIONS = Object.freeze({
  extractionReviewCoverage: "unknown",
  sourceArchiveCoverage: "not-measured",
  conversationalCorrection:
    "A denial or change counts only when that statement is among this member's extracted evidence. Another member's remark cannot rewrite this profile. A !knowledge correct command is not a belief edit. A denial keeps the earlier statement and marks the dispute.",
  topicGrouping:
    "Topics and overlapping positions are grouped lexically from extracted text. This is not a semantic ontology.",
  completeness:
    "Every visible statement being considered is not complete knowledge of the member. The archive and the extraction are partial. A message without a stored statement was not counted as unreviewed, and one stored statement does not prove every claim in a message was extracted.",
});

const STOP = new Set(
  "a an the of and or to in on for about with from by at as is are was were be been being that this these those it its into over under than then so if when while unless about just not no nor".split(
    " ",
  ),
);
const POLARITY_WORDS = new Set(
  "support supports favor favors favour favours endorse endorses oppose opposes reject rejects against agree agrees disagree disagrees".split(
    " ",
  ),
);
const OVERVIEW_TOPICS = 6;
const OVERVIEW_POSITIONS = 3;
const PAGE = 8;
const NEAR_DUPLICATE = 0.72;

const SARCASM =
  /(?:^|\W)\/s(?:\W|$)|<sarcasm>|\*sarcasm\*|\byeah right\b|\bsure jan\b|\bthis is sarcasm\b/i;
const KNOWLEDGE_CORRECT = /^\s*(?:<@!?\d+>\s+)?!knowledge\s+correct\b/i;
const ATTRIBUTION =
  /\b(?:that is not my (?:position|view|belief)|that(?:'s| is) not what i (?:said|meant|believe)|i (?:never|did not|didn't) (?:say|said|claim|claimed|believe|believed) that)\b/i;
const QUOTE_ATTR =
  /\b(?:according to|quoted)\b|\b(?:he|she|they)\s+(?:said|says|wrote|claims|claimed)\b/i;
const FIRST_PERSON = /\b(?:i|i'm|i’m|i've|i’ve|i'd|i’d|my|we|we're|we’re)\b/i;
const THIRD_PARTY =
  /\b(?:he|she|they|people)\s+(?:thinks?|believes?|supports?|opposes?|wants?|says)\b/i;
const SELF_DESCRIPTION =
  /\b(?:i am|i'm|i’m)\s+(?:a|an)\s+\p{L}|\b(?:i am|i'm|i’m)\s+from\b|\bmy (?:job|work|background|degree|name|family|career)\b/iu;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function tokens(value) {
  return (
    String(value ?? "")
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((token) => token.length > 1 && !STOP.has(token)) ?? []
  );
}

export function topicKey(topic) {
  const parts = [...new Set(tokens(topic))].sort();
  return parts.join("-") || "untagged";
}

function clip(value, max) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function iso(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return new Date(value).toISOString();
  return null;
}

export function statementText(row) {
  return [row.quote, row.assertion, row.proposition].find(
    (value) => typeof value === "string" && value.trim(),
  );
}

function originalClaimContext(row) {
  const text = statementText(row) ?? "";
  if (typeof row.sourceContent !== "string" || !row.quote) return text;
  const start = row.sourceContent.indexOf(row.quote);
  if (start < 0) return text;
  const before = row.sourceContent.slice(0, start);
  const boundary = Math.max(
    before.lastIndexOf("\n"),
    before.lastIndexOf("."),
    before.lastIndexOf("?"),
    before.lastIndexOf("!"),
  );
  const after = row.sourceContent.slice(start + row.quote.length);
  const stop = after.search(/[.!?\n]/);
  return row.sourceContent
    .slice(boundary + 1, stop < 0 ? row.sourceContent.length : start + row.quote.length + stop)
    .trim();
}

function polarityOf(text) {
  let rest = String(text ?? "")
    .replaceAll("’", "'")
    .toLocaleLowerCase("en-US");
  // Withholding support is not opposition, nor does withdrawing opposition
  // establish support. Preserve the distinction for later semantic review.
  if (
    /\b(?:do not|don't|never|not)\s+(?:really\s+|strongly\s+)?(?:support|favor|favour|endorse|agree with|oppose|reject|disagree with)\b/i.test(
      rest,
    )
  )
    return "withheld";
  let support = 0;
  let oppose = 0;
  const consume = (pattern, kind) => {
    const next = rest.replace(pattern, " ");
    if (next !== rest) {
      if (kind === "support") support += 1;
      else oppose += 1;
      rest = next;
    }
  };
  consume(
    /\b(?:do not|don't|never|not)\s+(?:really\s+|strongly\s+)?(?:support|favor|favour|endorse|accept|agree with)\b/gi,
    "oppose",
  );
  consume(
    /\b(?:do not|don't|never|not)\s+(?:really\s+|strongly\s+)?(?:oppose|reject|disagree with)\b/gi,
    "support",
  );
  consume(
    /\b(?:support|supports|favor|favors|favour|favours|endorse|endorses|agree with|agrees with)\b/gi,
    "support",
  );
  consume(/\b(?:oppose|opposes|reject|rejects|disagree with|disagrees with|against)\b/gi, "oppose");
  if (support > 0 && oppose > 0) return "mixed";
  if (support > 0) return "support";
  if (oppose > 0) return "oppose";
  return "unspecified";
}

function qualifierOf(text) {
  const match = String(text).match(
    /\b(?:only if|as long as|provided that|unless|if|when)\b\s+([^.]{1,160})/i,
  );
  if (!match) return null;
  const phrase = match[0].trim();
  return phrase || null;
}

function objectTokens(text) {
  return tokens(text).filter((token) => !POLARITY_WORDS.has(token));
}

export function classifyStatement(row) {
  const text = originalClaimContext(row);
  const context = row.sourceContent ?? text;
  const base = {
    role: "uncertain",
    polarity: "unspecified",
    pastPolarity: null,
    currentPolarity: null,
    qualifier: null,
    retiresPrior: false,
    literalEndorsement: false,
    relationHint: "none",
    uncertainty: "The extracted wording does not establish a position.",
  };
  if (!text.trim()) return base;
  if (KNOWLEDGE_CORRECT.test(text)) {
    return {
      ...base,
      role: "control-command",
      uncertainty: "A knowledge-correction command does not edit a member's beliefs.",
    };
  }
  if (ATTRIBUTION.test(text)) {
    return {
      ...base,
      role: "attribution-correction",
      relationHint: "attribution-correction",
      polarity: polarityOf(text),
      uncertainty: "The member disputed an attribution. The earlier statement stays in the record.",
    };
  }
  if (SARCASM.test(context)) {
    return {
      ...base,
      role: "sarcasm",
      uncertainty: "Sarcasm is not a literal endorsement. The intended position is not stated.",
    };
  }
  const committed = FIRST_PERSON.test(text);
  const quoted = /["“]([^"”]+)["”]/gu;
  const insideQuotation =
    typeof row.quote === "string" &&
    [...context.matchAll(quoted)].some((match) => match[1].includes(row.quote));
  if (
    (QUOTE_ATTR.test(text) && !/^\s*i\s+(?:think|believe|support|oppose)\b/i.test(text)) ||
    (insideQuotation && QUOTE_ATTR.test(context)) ||
    (/^\s*>/m.test(context) && !committed)
  ) {
    return {
      ...base,
      role: "quotation",
      uncertainty: "This reports someone else's words. It is not this member's position.",
    };
  }
  if (/^(?:suppose|supposing|imagine|what if|hypothetically)\b/i.test(text.trim()) && !committed) {
    return {
      ...base,
      role: "hypothetical",
      uncertainty: "This is a hypothetical without a commitment. It is not a position.",
    };
  }
  if (THIRD_PARTY.test(text) && !/\bi (?:support|oppose|think|believe|want)\b/i.test(text)) {
    return {
      ...base,
      role: "third-party",
      polarity: polarityOf(text),
      uncertainty:
        "This describes someone else's view. It does not establish this member's position.",
    };
  }
  const noLonger = /\bi(?:'m|’m| am)? no longer\b/i.test(text);
  const usedTo = /\bi used to\b/i.test(text);
  const changed = /\bchanged my mind\b|\bi was wrong about\b/i.test(text);
  const nowSplit = text.split(/\b(?:but now|and now)\b/i);
  if (noLonger || ((usedTo || changed) && nowSplit.length > 1) || usedTo || changed) {
    let pastPolarity = "unknown";
    let currentPolarity = "unknown";
    let retiresPrior = false;
    if (noLonger) {
      pastPolarity = polarityOf(
        text
          .split(/\bno longer\b/i)
          .at(-1)
          .split(/\b(?:but|now|instead)\b/i)[0],
      );
      currentPolarity = "withdrawn";
      const replacement = text.match(/\b(?:now|instead)\s+(?:i\s+)?(.+)/i);
      if (replacement && ["support", "oppose"].includes(polarityOf(replacement[1])))
        currentPolarity = polarityOf(replacement[1]);
      retiresPrior = pastPolarity === "support" || pastPolarity === "oppose";
    } else if (nowSplit.length > 1) {
      pastPolarity = polarityOf(nowSplit[0]);
      const current = polarityOf(nowSplit.slice(1).join(" "));
      currentPolarity = current === "unspecified" || current === "mixed" ? "unknown" : current;
      retiresPrior = currentPolarity === "support" || currentPolarity === "oppose";
    } else {
      const past = polarityOf(text);
      pastPolarity = past === "unspecified" || past === "mixed" ? "unknown" : past;
    }
    return {
      ...base,
      role: "change-of-mind",
      polarity: currentPolarity === "unknown" ? "unspecified" : currentPolarity,
      pastPolarity,
      currentPolarity,
      retiresPrior,
      literalEndorsement: retiresPrior && currentPolarity !== "withdrawn",
      relationHint: "explicit-change",
      qualifier: qualifierOf(text),
      uncertainty: retiresPrior
        ? null
        : "The member described an earlier view. That does not state the current one, and it does not erase other statements.",
    };
  }
  const polarity = polarityOf(text);
  const qualifier = /^(?:what if)\b/i.test(text.trim()) ? null : qualifierOf(text);
  if (
    SELF_DESCRIPTION.test(text) &&
    (polarity === "unspecified" || polarity === "mixed") &&
    text.length < 180
  ) {
    return {
      ...base,
      role: "self-description",
      literalEndorsement: true,
      uncertainty: null,
    };
  }
  if (polarity === "mixed") {
    return {
      ...base,
      role: "uncertain",
      polarity,
      qualifier,
      uncertainty:
        "The wording contains opposing commitments. No single position was taken from it.",
    };
  }
  return {
    ...base,
    role: "own-position",
    polarity,
    qualifier,
    literalEndorsement: true,
    uncertainty: null,
  };
}

export function freshnessOf(row) {
  if (row.revisionFound === false || row.messageFound === false) return "inaccessible";
  if (
    row.messageFound === true &&
    (typeof row.sourceContent !== "string" || !row.sourceContent.trim())
  )
    return "inaccessible";
  if (
    (row.messageAuthorId && row.memberId && row.messageAuthorId !== row.memberId) ||
    (row.messageChannelId && row.channelId && row.messageChannelId !== row.channelId)
  )
    return "invalidated";
  if (row.deletedAt || row.tombstonedAt) return "deleted";
  if (row.invalidated) return "invalidated";
  if (
    !row.isCurrent ||
    (row.revisionHash && row.messageHash && row.revisionHash !== row.messageHash)
  )
    return "edited";
  if (
    row.kind === "exact_quote" &&
    typeof row.sourceContent === "string" &&
    (!row.quote || !row.sourceContent.includes(row.quote))
  )
    return "invalidated";
  return "current";
}

export function statementDigest(row) {
  return sha256(
    [
      PROFILE_VERSION,
      row.statementId,
      row.revisionId ?? "",
      row.extractorVersion ?? "",
      row.freshness,
      row.channelId ?? "",
      row.topic ?? "",
      row.proposition ?? "",
      row.quote ?? "",
      row.assertion ?? "",
      row.factIdentity ?? "",
      iso(row.occurredAt) ?? "",
      row.memberId ?? "",
      row.sourceContent ?? "",
      row.subject ?? "",
      JSON.stringify(row.sourceContext ?? []),
    ].join("\0"),
  );
}

export function evidenceDigest(rows) {
  const parts = rows.map((row) => statementDigest(row)).sort();
  return sha256([PROFILE_VERSION, String(parts.length), ...parts].join("\0"));
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function mode(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])),
  )[0][0];
}

function evidenceRow(item) {
  const usable = item.freshness === "current";
  return {
    statementIds: item.statementIds,
    messageId: item.messageId,
    revisionId: item.revisionId,
    at: item.at,
    freshness: item.freshness,
    extractorVersions: item.extractorVersions,
    proposition: usable ? clip(item.proposition, 240) : null,
    quote: usable ? clip(item.quote ?? item.assertion, 180) : null,
    contentWithheld: !usable,
    factIdentities: item.factIdentities,
  };
}

function positionFrom(memberId, topicLabel, items) {
  const sorted = items
    .slice()
    .sort(
      (a, b) => String(a.at).localeCompare(String(b.at)) || a.messageId.localeCompare(b.messageId),
    );
  const representative =
    [...sorted].reverse().find((item) => item.freshness === "current") ?? sorted.at(-1);
  const statementIds = sorted.flatMap((item) => item.statementIds).sort();
  const historical = sorted.every((item) => item.freshness !== "current");
  const current = sorted.filter((item) => item.freshness === "current");
  return {
    positionId: sha256(
      [
        memberId,
        representative.topicKey,
        representative.role,
        representative.polarity,
        representative.qualifier ?? "",
        ...statementIds,
      ].join("\0"),
    ).slice(0, 32),
    topic: topicLabel,
    topicKey: representative.topicKey,
    role: representative.role,
    polarity: representative.polarity,
    qualifier: representative.qualifier,
    conditional: Boolean(representative.qualifier),
    status: historical ? "historical" : "current",
    literalEndorsement: true,
    speakerDisputed: false,
    independentMessages: new Set(current.map((item) => item.messageId)).size,
    historicalMessages: new Set(
      sorted.filter((item) => item.freshness !== "current").map((item) => item.messageId),
    ).size,
    statementCount: statementIds.length,
    extractorVersions: [...new Set(sorted.flatMap((item) => item.extractorVersions))].sort(),
    duplicateExtractionsAreNotExtraEvidence:
      statementIds.length > new Set(sorted.map((item) => item.messageId)).size,
    representative: {
      proposition: representative.proposition,
      statementId: representative.statementIds[0],
      messageId: representative.messageId,
      revisionId: representative.revisionId,
      at: representative.at,
      freshness: representative.freshness,
      copiedFromStatement: true,
    },
    interpretation: null,
    items: sorted,
    tokens: representative.objectTokens,
  };
}

function mergeNear(groups) {
  const parent = groups.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const frequency = new Map();
  for (const group of groups)
    for (const token of group.tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  const index = new Map();
  groups.forEach((group, groupIndex) => {
    if (group.tokens.size < 3) return;
    // Exact Jaccard prefix filtering replaces the old 400-group/40-posting
    // cutoffs: a large topic must not silently lose near-duplicate matching.
    const ordered = [...group.tokens].sort(
      (a, b) => frequency.get(a) - frequency.get(b) || a.localeCompare(b),
    );
    const prefix = ordered.slice(
      0,
      ordered.length - Math.ceil(NEAR_DUPLICATE * ordered.length) + 1,
    );
    const partition = `${group.role}\0${group.polarity}\0${group.qualifier ?? ""}\0`;
    const candidates = new Set();
    for (const token of prefix)
      for (const candidate of index.get(partition + token) ?? []) candidates.add(candidate);
    for (const candidate of candidates) {
      const other = groups[candidate];
      if (
        Math.min(group.tokens.size, other.tokens.size) /
          Math.max(group.tokens.size, other.tokens.size) >=
          NEAR_DUPLICATE &&
        jaccard(group.tokens, other.tokens) >= NEAR_DUPLICATE
      ) {
        parent[find(candidate)] = find(groupIndex);
      }
    }
    for (const token of prefix) {
      const list = index.get(partition + token) ?? [];
      list.push(groupIndex);
      index.set(partition + token, list);
    }
  });
  const merged = new Map();
  groups.forEach((group, groupIndex) => {
    const root = find(groupIndex);
    const existing = merged.get(root);
    if (!existing) merged.set(root, { ...group, items: group.items.slice() });
    else existing.items.push(...group.items);
  });
  return { groups: [...merged.values()], clustering: "near-duplicate" };
}

function clusterRole(items) {
  const buckets = new Map();
  for (const item of items) {
    const key = [item.role, item.polarity, item.qualifier ?? "", item.objectSignature].join("\0");
    const bucket = buckets.get(key) ?? [];
    bucket.push(item);
    buckets.set(key, bucket);
  }
  const seeds = [...buckets.values()].map((grouped) => ({
    role: grouped[0].role,
    polarity: grouped[0].polarity,
    qualifier: grouped[0].qualifier ?? null,
    tokens: grouped[0].objectTokens,
    items: grouped,
  }));
  return mergeNear(seeds);
}

function overlaps(position, item) {
  if (position.topicKey !== item.topicKey) return false;
  if (!position.tokens.size || !item.objectTokens.size) return position.topicKey === item.topicKey;
  return jaccard(position.tokens, item.objectTokens) >= 0.45;
}

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor, view, scope) {
  if (cursor == null || cursor === "") return { offset: 0 };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid profile cursor");
  }
  if (
    !payload ||
    payload.view !== view ||
    payload.scope !== scope ||
    !Number.isInteger(payload.offset) ||
    payload.offset < 0
  )
    throw new Error("Invalid profile cursor");
  return payload;
}

function publicPosition(position, evidenceLimit) {
  const preview = position.items.slice(0, evidenceLimit);
  return {
    positionId: position.positionId,
    topic: position.topic,
    role: position.role,
    polarity: position.polarity,
    qualifier: position.qualifier,
    conditional: position.conditional,
    status: position.status,
    literalEndorsement: position.literalEndorsement,
    speakerDisputed: position.speakerDisputed,
    independentMessages: position.independentMessages,
    statementCount: position.statementCount,
    extractorVersions: position.extractorVersions,
    duplicateExtractionsAreNotExtraEvidence: position.duplicateExtractionsAreNotExtraEvidence,
    representative: {
      ...position.representative,
      proposition:
        position.representative.freshness === "current"
          ? clip(position.representative.proposition, 240)
          : null,
    },
    interpretation: null,
    evidence: preview.map(evidenceRow),
    evidenceTotal: position.items.length,
    evidencePreview:
      preview.length < position.items.length ? "open-with-evidence-view" : "complete",
  };
}

function prepare(statements) {
  const classified = statements.map((row) => {
    const judgment = classifyStatement(row);
    const text = statementText(row) ?? "";
    let claim = text.replace(/\b(?:only if|as long as|provided that|unless|if|when)\b.*$/i, " ");
    if (judgment.role === "change-of-mind") {
      const parts = claim.split(/\b(?:but now|and now)\b/i);
      claim = parts.length > 1 ? parts.slice(1).join(" ") : claim;
      claim = claim.replace(
        /\b(?:changed my mind|i was wrong about|i(?:'m|’m| am)? no longer|i used to)\b/gi,
        " ",
      );
    }
    let objects = objectTokens(claim);
    if (judgment.role === "attribution-correction")
      objects = objects.filter((token) => !["position", "view", "belief", "my"].includes(token));
    return {
      ...row,
      ...judgment,
      at: iso(row.occurredAt),
      topicKey: topicKey(row.topic),
      objectTokens: new Set(objects),
      objectSignature: [...objects].sort().join(" "),
      claimSignature: String(row.proposition ?? text)
        .normalize("NFKC")
        .trim()
        .toLocaleLowerCase("en-US"),
      text,
    };
  });
  const byMessage = new Map();
  for (const row of classified) {
    const key = `${row.messageId}\0${row.revisionId ?? ""}\0${row.freshness}`;
    const group = byMessage.get(key) ?? [];
    group.push(row);
    byMessage.set(key, group);
  }
  const items = [];
  const disagreements = [];
  for (const messageRows of byMessage.values()) {
    // Different assertions in one message remain separate. Only competing
    // extractions of the same claim can disagree or corroborate one another.
    const claims = [];
    for (const row of messageRows) {
      const matching = claims.find((claim) =>
        claim.some(
          (candidate) =>
            candidate.topicKey === row.topicKey &&
            candidate.qualifier === row.qualifier &&
            (candidate.extractorVersion !== row.extractorVersion ||
              candidate.polarity === row.polarity) &&
            (candidate.claimSignature === row.claimSignature ||
              (candidate.extractorVersion !== row.extractorVersion &&
                (candidate.objectSignature === row.objectSignature ||
                  jaccard(candidate.objectTokens, row.objectTokens) >= NEAR_DUPLICATE))),
        ),
      );
      if (matching) matching.push(row);
      else claims.push([row]);
    }
    for (const group of claims) {
      const endorsing = group.filter((row) =>
        ["own-position", "self-description", "change-of-mind"].includes(row.role),
      );
      const nonEndorsing = group.filter((row) => !endorsing.includes(row));
      const polarities = new Set(
        group
          .map((row) => row.polarity)
          .filter((value) => value === "support" || value === "oppose"),
      );
      if (group.some((row) => row.role === "sarcasm")) {
        items.push(
          collapse(
            group,
            group.find((row) => row.role === "sarcasm"),
          ),
        );
        continue;
      }
      if ((endorsing.length && nonEndorsing.length) || polarities.size > 1) {
        disagreements.push(group);
        continue;
      }
      const preferred = group
        .slice()
        .sort(
          (left, right) =>
            right.text.length - left.text.length ||
            left.statementId.localeCompare(right.statementId),
        )[0];
      items.push(collapse(group, preferred));
    }
  }
  return { items, disagreements };
}

function collapse(group, preferred) {
  return {
    ...preferred,
    statementIds: group.map((row) => row.statementId).sort(),
    extractorVersions: [...new Set(group.map((row) => row.extractorVersion))].sort(),
    factIdentities: [...new Set(group.map((row) => row.factIdentity).filter(Boolean))].sort(),
  };
}

export function assembleProfile({
  member,
  statements,
  view = "overview",
  topic = null,
  cursor = null,
  positionId = null,
  statementId = null,
  maintenance = null,
}) {
  const visible = statements.filter((row) => row && row.statementId && row.messageId);
  const { items, disagreements } = prepare(visible);
  const topicItems = new Map();
  for (const item of items) {
    const list = topicItems.get(item.topicKey) ?? [];
    list.push(item);
    topicItems.set(item.topicKey, list);
  }
  let clustering = "near-duplicate";
  const positions = [];
  const selfDescriptions = [];
  const uncertainties = disagreements.map((group) => ({
    kind: "extractor-disagreement",
    literalEndorsement: false,
    intendedPosition: null,
    messageId: group[0].messageId,
    statementIds: group.map((row) => row.statementId),
    at: group[0].at,
    note: "Extractors disagree on this message. Neither reading is treated as confirmation.",
  }));
  for (const grouped of topicItems.values()) {
    const label = mode(grouped.map((item) => item.topic));
    const byRole = new Map();
    for (const item of grouped) {
      const list = byRole.get(item.role) ?? [];
      list.push(item);
      byRole.set(item.role, list);
    }
    for (const [role, roleItems] of byRole) {
      const clustered = clusterRole(roleItems);
      if (clustered.clustering === "exact-signature") clustering = "exact-signature";
      for (const cluster of clustered.groups) {
        if (role === "self-description") {
          for (const item of cluster.items.filter((item) => item.freshness === "current")) {
            selfDescriptions.push({
              proposition: clip(item.proposition, 240),
              quote: clip(item.quote ?? item.assertion, 180),
              statementId: item.statementIds[0],
              messageId: item.messageId,
              revisionId: item.revisionId,
              at: item.at,
              freshness: item.freshness,
              copiedFromStatement: true,
            });
          }
          continue;
        }
        if (
          role === "own-position" ||
          (role === "change-of-mind" && cluster.items.some((item) => item.literalEndorsement))
        ) {
          const endorsing = cluster.items.filter((item) => item.literalEndorsement);
          if (endorsing.length) positions.push(positionFrom(member.id, label, endorsing));
        }
        for (const item of cluster.items.filter((item) => item.freshness === "current")) {
          if (
            item.uncertainty &&
            !["own-position", "change-of-mind", "attribution-correction"].includes(item.role)
          ) {
            uncertainties.push({
              kind: item.role,
              literalEndorsement: false,
              intendedPosition: item.literalEndorsement ? clip(item.proposition, 240) : null,
              statementId: item.statementIds[0],
              messageId: item.messageId,
              revisionId: item.revisionId,
              at: item.at,
              quote: clip(item.quote ?? item.assertion, 180),
              note: item.uncertainty,
            });
          }
        }
      }
    }
  }
  const changes = [];
  for (const item of items
    .filter((candidate) => candidate.role === "change-of-mind" && candidate.freshness === "current")
    .sort((left, right) => String(left.at).localeCompare(String(right.at)))) {
    const related = positions.filter(
      (position) =>
        position.role === "own-position" &&
        overlaps(position, item) &&
        position.items.some((evidence) => evidence.at && item.at && evidence.at < item.at),
    );
    if (!item.retiresPrior) {
      uncertainties.push({
        kind: "change-of-mind",
        literalEndorsement: false,
        intendedPosition: null,
        statementId: item.statementIds[0],
        messageId: item.messageId,
        revisionId: item.revisionId,
        at: item.at,
        quote: clip(item.text, 180),
        note: item.uncertainty,
      });
      continue;
    }
    const retired = related.filter(
      (position) =>
        position.polarity !== item.polarity &&
        (item.pastPolarity === "unknown" ||
          item.pastPolarity === "unspecified" ||
          item.pastPolarity === position.polarity),
    );
    for (const position of retired) {
      const allEarlier = position.items.every(
        (evidence) => evidence.at && item.at && evidence.at < item.at,
      );
      if (allEarlier) position.status = "former";
      changes.push({
        kind: "explicit-change",
        topic: position.topic,
        fromPositionId: position.positionId,
        at: item.at,
        messageId: item.messageId,
        revisionId: item.revisionId,
        statementId: item.statementIds[0],
        pastPolarity: item.pastPolarity,
        currentPolarity: item.currentPolarity,
        appliesBefore: item.at,
        expressedAgainLater: !allEarlier,
        evidence: [evidenceRow(position.items[0]), evidenceRow(item)],
        note: "The member explicitly retired the earlier position. The earlier statement remains as history.",
      });
    }
    if (!retired.length) {
      uncertainties.push({
        kind: "change-of-mind",
        literalEndorsement: item.literalEndorsement,
        intendedPosition: item.literalEndorsement ? clip(item.proposition, 240) : null,
        statementId: item.statementIds[0],
        messageId: item.messageId,
        revisionId: item.revisionId,
        at: item.at,
        note: "An explicit change is present, but no earlier overlapping position is in the visible evidence.",
      });
    }
  }
  for (const item of items.filter(
    (candidate) => candidate.role === "attribution-correction" && candidate.freshness === "current",
  )) {
    const sameTopic = positions.filter(
      (position) =>
        position.topicKey === item.topicKey &&
        position.status === "current" &&
        position.items.every((evidence) => evidence.at && item.at && evidence.at <= item.at),
    );
    const overlapped = item.objectTokens.size
      ? sameTopic.filter((position) => overlaps(position, item))
      : sameTopic.length === 1
        ? sameTopic
        : [];
    for (const position of overlapped) position.speakerDisputed = true;
    uncertainties.push({
      kind: "attribution-correction",
      literalEndorsement: false,
      intendedPosition: null,
      statementId: item.statementIds[0],
      messageId: item.messageId,
      revisionId: item.revisionId,
      at: item.at,
      quote: clip(item.text, 180),
      disputedPositionIds: overlapped.map((position) => position.positionId),
      note: overlapped.length
        ? "The member disputed this attribution. The earlier evidence was kept."
        : "The denial does not identify which position, so none was rewritten.",
    });
  }
  const conflicts = [];
  const contextDependent = [];
  const currentOwn = positions.filter(
    (position) => position.status === "current" && position.role === "own-position",
  );
  const byTopic = new Map();
  for (const position of currentOwn) {
    if (!["support", "oppose"].includes(position.polarity)) continue;
    const group = byTopic.get(position.topicKey) ?? [];
    group.push(position);
    byTopic.set(position.topicKey, group);
  }
  for (const topicPositions of byTopic.values()) {
    for (let leftIndex = 0; leftIndex < topicPositions.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < topicPositions.length; rightIndex += 1) {
        const left = topicPositions[leftIndex];
        const right = topicPositions[rightIndex];
        if (
          !["support", "oppose"].includes(left.polarity) ||
          !["support", "oppose"].includes(right.polarity)
        )
          continue;
        if (left.polarity === right.polarity) continue;
        if (jaccard(left.tokens, right.tokens) < 0.45) continue;
        const pair = {
          topic: left.topic,
          positionIds: [left.positionId, right.positionId].sort(),
          evidence: [evidenceRow(left.items[0]), evidenceRow(right.items[0])],
          note:
            left.qualifier || right.qualifier
              ? "These point in opposite directions under different conditions. Neither erases the other."
              : "These current statements conflict. The newer one does not erase the older one.",
        };
        if (left.qualifier || right.qualifier) contextDependent.push(pair);
        else conflicts.push(pair);
      }
    }
  }
  positions.sort(
    (left, right) =>
      right.independentMessages - left.independentMessages ||
      left.positionId.localeCompare(right.positionId),
  );
  const topics = [...topicItems.entries()]
    .map(([key, grouped]) => ({
      topicKey: key,
      topic: mode(grouped.map((item) => item.topic)),
      independentMessages: new Set(grouped.map((item) => item.messageId)).size,
      statements: grouped.reduce((sum, item) => sum + item.statementIds.length, 0),
      earliest:
        grouped
          .map((item) => item.at)
          .filter(Boolean)
          .sort()[0] ?? null,
      latest:
        grouped
          .map((item) => item.at)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null,
    }))
    .sort(
      (left, right) =>
        right.independentMessages - left.independentMessages ||
        left.topicKey.localeCompare(right.topicKey),
    );
  const coverage = {
    statementsConsidered: visible.length,
    messagesConsidered: new Set(visible.map((row) => row.messageId)).size,
    topicsConsidered: topics.length,
    positionsConsidered: positions.length,
    currentStatements: visible.filter((row) => row.freshness === "current").length,
    notCurrentStatements: visible.filter((row) => row.freshness !== "current").length,
    ledger: maintenance?.ledger ?? "not-installed",
    stale: maintenance?.stale === true,
    durable: maintenance?.ledger === "current",
    updatedAt: maintenance?.updatedAt ?? null,
    changedBecause: maintenance?.changedBecause ?? null,
    extractionReviewCoverage: "unknown",
    sourceArchiveCoverage: "not-measured",
    clustering,
    visibility: "caller-channels",
  };
  const audit = {
    statementIds: visible.map((row) => row.statementId).sort(),
    messageIds: [...new Set(visible.map((row) => row.messageId))].sort(),
  };
  const guidance =
    "Answer only from this profile. Representative text is copied from an extracted statement. Interpretation is separate and is null when the implementation did not add one. Duplicate extractor versions are not extra evidence. A newer statement does not erase an older one. Absence of a statement is not abandonment, unread status, or completeness.";
  const cursorScope = sha256(
    JSON.stringify({
      member: member.id,
      evidence: evidenceDigest(visible),
      view,
      topic,
      positionId,
      statementId,
    }),
  );
  const cursorPayload = decodeCursor(cursor, view, cursorScope);
  const body = {
    scope: "member",
    member,
    view,
    coverage,
    limitations: PROFILE_LIMITATIONS,
    guidance,
    audit,
  };
  if (view === "evidence") {
    const matches = items.filter(
      (item) =>
        (statementId && item.statementIds.includes(statementId)) ||
        positions.some(
          (position) =>
            position.positionId === positionId &&
            position.items.some((candidate) => candidate.messageId === item.messageId),
        ),
    );
    const page = matches.slice(cursorPayload.offset, cursorPayload.offset + PAGE);
    return {
      ...body,
      evidence: page.map(evidenceRow),
      page: pageInfo(view, cursorPayload.offset, page.length, matches.length, cursorScope),
      found: matches.length > 0,
    };
  }
  if (view === "changes") {
    const rows = [
      ...changes.map((change) => ({ section: "changes", ...change })),
      ...conflicts.map((conflict) => ({ section: "conflicts", ...conflict })),
      ...contextDependent.map((item) => ({ section: "contextDependent", ...item })),
    ];
    const page = rows.slice(cursorPayload.offset, cursorPayload.offset + PAGE);
    return {
      ...body,
      rows: page,
      page: pageInfo(view, cursorPayload.offset, page.length, rows.length, cursorScope),
    };
  }
  if (view === "topic") {
    const matched = topics.filter((candidate) => topicMatches(candidate, topic ?? ""));
    if (matched.length !== 1) {
      return {
        ...body,
        scope: matched.length ? "topic-choices" : "topic-unmatched",
        topics: matched.map(topicSummary),
        guidance: matched.length
          ? "More than one visible topic matches. Choose a topic before treating any of them as the member's position."
          : "No considered statement in the channels you can view is organized under that topic. That is not evidence of a position.",
      };
    }
    const selected = matched[0];
    const selectedPositions = positions.filter(
      (position) => position.topicKey === selected.topicKey,
    );
    const page = selectedPositions.slice(cursorPayload.offset, cursorPayload.offset + PAGE);
    return {
      ...body,
      topic: selected.topic,
      positions: page.map((position) => publicPosition(position, PAGE)),
      page: pageInfo(
        view,
        cursorPayload.offset,
        page.length,
        selectedPositions.length,
        cursorScope,
      ),
    };
  }
  const topicPage = topics.slice(cursorPayload.offset, cursorPayload.offset + OVERVIEW_TOPICS);
  return {
    ...body,
    selfDescriptions: selfDescriptions.slice(0, PAGE),
    selfDescriptionCount: selfDescriptions.length,
    topics: topicPage.map((candidate) => {
      const current = positions.filter(
        (position) => position.topicKey === candidate.topicKey && position.status === "current",
      );
      const repeated = current.filter((position) => position.independentMessages > 1);
      // Repetition is not importance. Always reserve space for a one-off claim
      // instead of silently dropping every singleton on a busy topic.
      const singles = current
        .filter((position) => position.independentMessages === 1)
        .sort(
          (a, b) =>
            String(b.representative.at).localeCompare(String(a.representative.at)) ||
            a.positionId.localeCompare(b.positionId),
        );
      const preview = [
        ...repeated.slice(0, singles.length ? OVERVIEW_POSITIONS - 1 : OVERVIEW_POSITIONS),
        ...singles.slice(0, Math.max(1, OVERVIEW_POSITIONS - repeated.length)),
      ].slice(0, OVERVIEW_POSITIONS);
      return {
        ...topicSummary(candidate),
        positions: preview.map((position) => publicPosition(position, 2)),
        positionsConsidered: positions.filter(
          (position) => position.topicKey === candidate.topicKey,
        ).length,
        repeatedPositions: repeated.length,
        singletonPositions: current.length - repeated.length,
        selection:
          "Repeated and one-off evidence preview; not a significance ranking. Page the topic for all positions.",
      };
    }),
    changes: changes.slice(0, PAGE),
    changeCount: changes.length,
    conflicts: conflicts.slice(0, PAGE),
    conflictCount: conflicts.length,
    contextDependent: contextDependent.slice(0, PAGE),
    contextDependentCount: contextDependent.length,
    uncertainties: uncertainties.slice(0, PAGE),
    uncertaintyCount: uncertainties.length,
    uncertaintyKinds: Object.fromEntries(
      [
        ...uncertainties.reduce(
          (map, item) => map.set(item.kind, (map.get(item.kind) ?? 0) + 1),
          new Map(),
        ),
      ].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
    ),
    page: pageInfo(view, cursorPayload.offset, topicPage.length, topics.length, cursorScope),
  };
}

function topicMatches(candidate, query) {
  const folded = query.trim().toLocaleLowerCase("en-US");
  if (!folded) return false;
  if (
    candidate.topic.toLocaleLowerCase("en-US") === folded ||
    candidate.topicKey === topicKey(query)
  )
    return true;
  const queryTokens = tokens(query);
  if (!queryTokens.length) return false;
  const label = new Set(tokens(candidate.topic));
  const key = new Set(candidate.topicKey.split("-").filter(Boolean));
  return queryTokens.every((token) => label.has(token) || key.has(token));
}

function topicSummary(candidate) {
  return {
    topic: candidate.topic,
    topicKey: candidate.topicKey,
    independentMessages: candidate.independentMessages,
    statements: candidate.statements,
    earliest: candidate.earliest,
    latest: candidate.latest,
  };
}

function pageInfo(view, offset, returned, total, scope) {
  const next = offset + returned < total ? offset + returned : null;
  return {
    offset,
    returned,
    total,
    nextCursor: next == null ? null : encodeCursor({ view, offset: next, scope }),
  };
}

export function presentProfile(profile) {
  if (!profile || typeof profile !== "object") return profile;
  const { audit: _audit, ...publicProfile } = profile;
  return publicProfile;
}

export function resolveNameCandidates(query, sightings, limit = 8) {
  const folded = query.trim().toLocaleLowerCase("en-US");
  const byId = new Map();
  for (const row of sightings) {
    const entry = byId.get(row.id) ?? [];
    entry.push(row);
    byId.set(row.id, entry);
  }
  const candidates = [];
  for (const [id, rows] of byId) {
    const matched = rows.some((row) => {
      const name = row.name.toLocaleLowerCase("en-US");
      return name === folded || name.includes(folded);
    });
    if (!matched) continue;
    const current = rows
      .slice()
      .sort((left, right) => Date.parse(left.seenAt) - Date.parse(right.seenAt))
      .at(-1);
    candidates.push({
      id,
      name: current?.name ?? null,
      matchedNames: [...new Set(rows.map((row) => row.name))].sort(),
    });
  }
  candidates.sort((left, right) => left.id.localeCompare(right.id));
  if (candidates.length === 1) return { scope: "resolved", member: candidates[0] };
  if (!candidates.length) return { scope: "unmatched", members: [] };
  return {
    scope: "ambiguous",
    members: candidates.slice(0, limit),
    truncated: candidates.length > limit,
  };
}
