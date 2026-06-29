// SPDX-License-Identifier: Apache-2.0
import { useMemo, useState } from "react";
import type { SubjectGroup } from "../types";

/* A second view of the link graph: one node per SUBJECT, edges = links between
 * members' docs mapped up to their subjects. Pure SVG, no graph lib, no random —
 * positions are seeded deterministically (a type/label-ordered circle) then
 * relaxed with a fixed force pass, so re-renders don't jitter. */

// Stone-only palette (hex, so Tailwind's purge can't drop dynamic fills). The
// type axis is encoded in GRAYSCALE; muted red is reserved for the orphan ring.
const STONE = {
  edge: "#d6d3d1", // stone-300
  edgeHi: "#78716c", // stone-500
  label: "#44403c", // stone-700
  ring: "#ffffff",
  orphan: "#f87171", // red-400 — the one permitted non-stone, for the "problem" state
};

// type → { color, radius }. overview is the largest hub; gotchas the lightest/smallest.
const TYPE_STYLE: Record<string, { color: string; r: number }> = {
  overview: { color: "#1c1917", r: 20 }, // stone-900
  entity: { color: "#44403c", r: 13 }, // stone-700
  metric: { color: "#78716c", r: 11 }, // stone-500
  query: { color: "#a8a29e", r: 10 }, // stone-400
  gotcha: { color: "#d6d3d1", r: 9 }, // stone-300
};
const DEFAULT_STYLE = { color: "#78716c", r: 11 };
const TYPE_RANK: Record<string, number> = { overview: 0, entity: 1, metric: 2, query: 3, gotcha: 4 };
const LEGEND: { type: string; label: string }[] = [
  { type: "overview", label: "overview" },
  { type: "entity", label: "entity" },
  { type: "metric", label: "metric" },
  { type: "query", label: "query" },
  { type: "gotcha", label: "gotcha" },
];

const W = 1000;
const H = 600;

interface Node {
  key: string;
  label: string;
  type: string;
  degree: number;
  x: number;
  y: number;
}
interface Edge {
  a: number;
  b: number;
}

// Only disconnected entity/metric/query docs are "orphans" — a standalone gotcha
// or the overview hub is expected to sit alone, so they never get the red ring
// (this matches the health bar's `orphans` lint, which exempts both).
const ORPHAN_RINGED = new Set(["entity", "metric", "query"]);

function isOrphanNode(node: Node): boolean {
  return node.degree === 0 && ORPHAN_RINGED.has(node.type);
}

function styleFor(type: string) {
  return TYPE_STYLE[type] ?? DEFAULT_STYLE;
}

/** Strip markdown emphasis (**bold**, `code`, leading #) and collapse whitespace
 *  so standalone-gotcha labels (raw markdown claims) read cleanly. */
function cleanLabel(s: string): string {
  return String(s ?? "")
    .replace(/`+/g, "")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/^\s*#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s: string, n = 16): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Build nodes + undirected edges, then run a deterministic force layout. */
function buildGraph(subjects: SubjectGroup[]): { nodes: Node[]; edges: Edge[]; adj: number[][] } {
  // name → owning subject key (a member name lives in exactly one subject).
  const nameToKey = new Map<string, string>();
  for (const s of subjects) for (const m of s.members) nameToKey.set(m.name, s.key);

  // nodes ordered by type then label — the seed order, so the circle is stable.
  const ordered = [...subjects].sort(
    (a, b) =>
      (TYPE_RANK[a.primaryType] ?? 9) - (TYPE_RANK[b.primaryType] ?? 9) ||
      a.label.localeCompare(b.label),
  );
  const indexOf = new Map<string, number>();
  ordered.forEach((s, i) => indexOf.set(s.key, i));

  // dedupe undirected edges, drop self-edges
  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (const s of subjects) {
    const ai = indexOf.get(s.key)!;
    for (const m of s.members) {
      for (const link of m.links) {
        const tk = nameToKey.get(link);
        if (!tk || tk === s.key) continue;
        const bi = indexOf.get(tk)!;
        const lo = Math.min(ai, bi);
        const hi = Math.max(ai, bi);
        const id = `${lo}:${hi}`;
        if (seen.has(id)) continue;
        seen.add(id);
        edges.push({ a: lo, b: hi });
      }
    }
  }

  const n = ordered.length;
  const adj: number[][] = ordered.map(() => []);
  for (const e of edges) {
    adj[e.a].push(e.b);
    adj[e.b].push(e.a);
  }

  // seed: evenly on a circle, ordered above (deterministic; no Math.random).
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) * 0.42;
  const pos = ordered.map((_, i) => {
    const a = n === 1 ? 0 : (i / n) * Math.PI * 2;
    return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
  });

  // Fruchterman-Reingold-ish relaxation, fixed iterations + cooling.
  const k = Math.sqrt((W * H) / Math.max(n, 1)) * 0.85; // ideal edge length
  let temp = W * 0.08;
  const ITERS = 260;
  for (let it = 0; it < ITERS; it++) {
    const disp = pos.map(() => ({ x: 0, y: 0 }));
    // Coulomb repulsion between every pair
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        const d = Math.hypot(dx, dy) || 0.01;
        const f = (k * k) / d;
        const ux = dx / d;
        const uy = dy / d;
        disp[i].x += ux * f;
        disp[i].y += uy * f;
        disp[j].x -= ux * f;
        disp[j].y -= uy * f;
      }
    }
    // spring attraction along edges
    for (const e of edges) {
      const dx = pos[e.a].x - pos[e.b].x;
      const dy = pos[e.a].y - pos[e.b].y;
      const d = Math.hypot(dx, dy) || 0.01;
      const f = (d * d) / k;
      const ux = dx / d;
      const uy = dy / d;
      disp[e.a].x -= ux * f;
      disp[e.a].y -= uy * f;
      disp[e.b].x += ux * f;
      disp[e.b].y += uy * f;
    }
    // mild centering so orphans don't drift off-canvas
    for (let i = 0; i < n; i++) {
      disp[i].x += (cx - pos[i].x) * 0.012;
      disp[i].y += (cy - pos[i].y) * 0.012;
    }
    // apply, capped by temperature
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(disp[i].x, disp[i].y) || 0.01;
      const lim = Math.min(d, temp);
      pos[i].x += (disp[i].x / d) * lim;
      pos[i].y += (disp[i].y / d) * lim;
    }
    temp *= 0.97;
  }

  // fit the relaxed cloud into the viewBox with padding for node radius + labels.
  const pad = 56;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pos) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;

  const nodes: Node[] = ordered.map((s, i) => ({
    key: s.key,
    label: cleanLabel(s.label),
    type: s.primaryType,
    degree: adj[i].length,
    x: (pos[i].x - minX) * scale + offX,
    y: (pos[i].y - minY) * scale + offY,
  }));
  return { nodes, edges, adj };
}

export function KnowledgeGraph({
  subjects,
  onOpen,
}: {
  subjects: SubjectGroup[];
  onOpen: (key: string) => void;
}) {
  const { nodes, edges, adj } = useMemo(() => buildGraph(subjects), [subjects]);
  const [hover, setHover] = useState<number | null>(null);

  // hover highlight: the node, its edges, and its direct neighbours stay lit.
  const lit = useMemo(() => {
    if (hover === null) return null;
    const set = new Set<number>([hover, ...adj[hover]]);
    return set;
  }, [hover, adj]);

  if (!nodes.length)
    return <div className="card p-6 text-center text-sm text-stone-500">No subjects to graph.</div>;

  const hovered = hover !== null ? nodes[hover] : null;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-stone-500">
        {LEGEND.map((l) => {
          const st = styleFor(l.type);
          return (
            <span key={l.type} className="inline-flex items-center gap-1.5">
              <svg width="14" height="14" aria-hidden>
                <circle cx="7" cy="7" r={Math.min(st.r, 6)} fill={st.color} />
              </svg>
              {l.label}
            </span>
          );
        })}
        <span className="inline-flex items-center gap-1.5">
          <svg width="14" height="14" aria-hidden>
            <circle cx="7" cy="7" r="5" fill="#e7e5e4" stroke={STONE.orphan} strokeWidth="2" />
          </svg>
          orphan
        </span>
      </div>

      <div className="card relative overflow-hidden bg-white" style={{ height: 600 }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Knowledge link graph"
        >
          {/* edges under nodes */}
          {edges.map((e, i) => {
            const on = lit ? lit.has(e.a) && lit.has(e.b) : false;
            const dim = lit && !on;
            return (
              <line
                key={i}
                x1={nodes[e.a].x}
                y1={nodes[e.a].y}
                x2={nodes[e.b].x}
                y2={nodes[e.b].y}
                stroke={on ? STONE.edgeHi : STONE.edge}
                strokeWidth={on ? 1.75 : 1}
                opacity={dim ? 0.12 : 1}
              />
            );
          })}

          {/* nodes */}
          {nodes.map((node, i) => {
            const st = styleFor(node.type);
            const isOrphan = isOrphanNode(node);
            const isHover = hover === i;
            const dim = lit ? !lit.has(i) : false;
            // hub nodes (high degree) get a small size bump
            const r = st.r + Math.min(node.degree, 6) * 0.7;
            return (
              <g
                key={node.key}
                transform={`translate(${node.x},${node.y})`}
                opacity={dim ? 0.22 : 1}
                style={{ cursor: "pointer" }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                onClick={() => onOpen(node.key)}
              >
                <circle
                  r={r}
                  fill={st.color}
                  stroke={isOrphan ? STONE.orphan : STONE.ring}
                  strokeWidth={isOrphan ? 2.5 : isHover ? 2.5 : 1.5}
                />
                {(isHover || nodes.length <= 45) && (
                  <text
                    y={r + 12}
                    textAnchor="middle"
                    fontSize={isHover ? 12 : 10}
                    fontWeight={isHover ? 600 : 500}
                    fill={STONE.label}
                  >
                    {truncate(node.label)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {/* hover tooltip: label + type + degree */}
        {hovered && (
          <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-stone-200 bg-white/95 px-2.5 py-1.5 text-xs shadow-sm">
            <div className="font-medium text-stone-800">{hovered.label}</div>
            <div className="text-stone-500">
              {hovered.type} · {hovered.degree} link{hovered.degree === 1 ? "" : "s"}
              {isOrphanNode(hovered) ? " · orphan" : ""}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
