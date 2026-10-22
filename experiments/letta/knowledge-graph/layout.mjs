// Deterministic, dependency-free layout for the bounded browser view.
export function layoutGraph(nodes, edges, width = 1000, height = 560) {
  const points = new Map();
  const sizes = {
    candidate: [178, 66],
    topic: [112, 38],
    person: [96, 82],
    claim: [132, 78],
    message: [120, 64],
  };
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  ordered.forEach((node, index) => {
    const angle = index * 2.399963229728653;
    const radius = Math.sqrt((index + 0.5) / Math.max(1, nodes.length));
    const [w, h] = sizes[node.type] ?? [120, 64];
    points.set(node.id, {
      x: width / 2 + Math.cos(angle) * radius * width * 0.37,
      y: height / 2 + Math.sin(angle) * radius * height * 0.35,
      w,
      h,
    });
  });
  // ponytail: O(n²) collision relaxation is bounded by the UI's 100-node page; use a spatial index/worker before increasing that ceiling.
  for (let step = 0; step < 220; step++) {
    const forces = new Map(ordered.map((node) => [node.id, { x: 0, y: 0 }]));
    for (let a = 0; a < ordered.length; a++) {
      const p = points.get(ordered[a].id),
        f = forces.get(ordered[a].id);
      f.x += (width / 2 - p.x) * 0.006;
      f.y += (height / 2 - p.y) * 0.006;
      for (let b = a + 1; b < ordered.length; b++) {
        const q = points.get(ordered[b].id),
          g = forces.get(ordered[b].id);
        const dx = p.x - q.x || 0.01,
          dy = p.y - q.y || 0.01;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const repulsion = 620 / (distance * distance);
        const pushX = (dx / distance) * repulsion,
          pushY = (dy / distance) * repulsion;
        f.x += pushX;
        f.y += pushY;
        g.x -= pushX;
        g.y -= pushY;
        const overlapX = (p.w + q.w) / 2 + 14 - Math.abs(dx),
          overlapY = (p.h + q.h) / 2 + 12 - Math.abs(dy);
        if (overlapX > 0 && overlapY > 0) {
          if (overlapX < overlapY) {
            const push = Math.sign(dx) * overlapX * 0.24;
            f.x += push;
            g.x -= push;
          } else {
            const push = Math.sign(dy) * overlapY * 0.24;
            f.y += push;
            g.y -= push;
          }
        }
      }
    }
    for (const edge of edges) {
      const p = points.get(edge.from),
        q = points.get(edge.to);
      if (!p || !q) continue;
      const dx = q.x - p.x,
        dy = q.y - p.y,
        distance = Math.max(1, Math.hypot(dx, dy));
      const pull = Math.max(-1, Math.min(4, (distance - 155) * 0.012));
      const f = forces.get(edge.from),
        g = forces.get(edge.to);
      f.x += (dx / distance) * pull;
      f.y += (dy / distance) * pull;
      g.x -= (dx / distance) * pull;
      g.y -= (dy / distance) * pull;
    }
    for (const node of ordered) {
      const p = points.get(node.id),
        f = forces.get(node.id);
      p.x = Math.max(
        p.w / 2 + 18,
        Math.min(width - p.w / 2 - 18, p.x + Math.max(-7, Math.min(7, f.x))),
      );
      p.y = Math.max(
        p.h / 2 + 16,
        Math.min(height - p.h / 2 - 16, p.y + Math.max(-7, Math.min(7, f.y))),
      );
    }
  }
  // Finish without spring forces so highly connected records cannot pull labels back over one another.
  for (let step = 0; step < 240; step++) {
    let moved = false;
    for (let a = 0; a < ordered.length; a++)
      for (let b = a + 1; b < ordered.length; b++) {
        const p = points.get(ordered[a].id),
          q = points.get(ordered[b].id);
        const dx = p.x - q.x || 0.01,
          dy = p.y - q.y || 0.01;
        const ox = (p.w + q.w) / 2 + 12 - Math.abs(dx),
          oy = (p.h + q.h) / 2 + 10 - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        if (ox < oy) {
          const push = Math.sign(dx) * (ox / 2 + 0.1);
          p.x += push;
          q.x -= push;
        } else {
          const push = Math.sign(dy) * (oy / 2 + 0.1);
          p.y += push;
          q.y -= push;
        }
        for (const point of [p, q]) {
          point.x = Math.max(point.w / 2 + 18, Math.min(width - point.w / 2 - 18, point.x));
          point.y = Math.max(point.h / 2 + 16, Math.min(height - point.h / 2 - 16, point.y));
        }
      }
    if (!moved) break;
  }
  if (points.size > 1) {
    const values = [...points.values()];
    const xs = values.map((point) => point.x),
      ys = values.map((point) => point.y);
    const minX = Math.min(...xs),
      maxX = Math.max(...xs),
      minY = Math.min(...ys),
      maxY = Math.max(...ys);
    const scale = Math.max(
      1,
      Math.min(
        (width - Math.max(...values.map((point) => point.w)) - 40) / Math.max(1, maxX - minX),
        (height - Math.max(...values.map((point) => point.h)) - 40) / Math.max(1, maxY - minY),
      ),
    );
    for (const point of values) {
      point.x = width / 2 + (point.x - (minX + maxX) / 2) * scale;
      point.y = height / 2 + (point.y - (minY + maxY) / 2) * scale;
    }
  }
  return points;
}
