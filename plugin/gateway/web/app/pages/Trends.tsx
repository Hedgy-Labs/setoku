// SPDX-License-Identifier: Apache-2.0
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useApi } from "../hooks";
import { Heading, Loading, ErrorMsg } from "../components/Page";
import { densify, unionAxis, compact } from "../series";
import type { SourceSeriesData, SourceSeries } from "../types";

// Stone-only line shades, darkest = highest-volume source (identity never rides
// color alone — legend + direct end-labels + hover carry it). Chrome stays
// monochrome; color belongs to the user's own content, not this surface.
const SHADES = ["#1c1917", "#44403c", "#78716c", "#a8a29e", "#c7c3bf", "#d6d3d1"];
const W = 820;
const H = 320;
const ML = 44;
const MR = 96;
const MT = 16;
const MB = 30;
const IW = W - ML - MR;
const IH = H - MT - MB;

interface Plotted {
  source: string;
  color: string;
  total: number;
  pts: { x: number; y: number; day: string; rows: number }[];
}

export function Trends() {
  const { data, loading, error } = useApi<SourceSeriesData>(() => api.sourceSeries(), []);
  return (
    <>
      <Heading title="Ingestion trends">
        Rows landed per day, by source, over the last 30 days — the real fill rate of your lake.
        A steady line is a healthy passive drain; spikes track real activity.{" "}
        <Link to="/sources" className="text-stone-600 underline underline-offset-2 hover:text-stone-900">
          ← back to Sources
        </Link>
      </Heading>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorMsg>{error}</ErrorMsg>
      ) : data && data.series.length ? (
        <Chart series={data.series} />
      ) : (
        <p className="text-sm text-stone-500">No ingestion in the last 30 days.</p>
      )}
    </>
  );
}

function Chart({ series }: { series: SourceSeries[] }) {
  const [hover, setHover] = useState<number | null>(null);

  const { axis, plotted, yMax, xOf } = useMemo(() => {
    const axis = unionAxis(series);
    const idx = new Map(axis.map((d, i) => [d, i]));
    const xOf = (i: number) => ML + (axis.length < 2 ? 0 : (i * IW) / (axis.length - 1));
    // rank by volume so the darkest shade lands on the biggest source
    const ranked = [...series]
      .map((s) => ({ s, total: s.points.reduce((a, p) => a + p.rows, 0) }))
      .sort((a, b) => b.total - a.total);
    let yMax = 1;
    for (const { s } of ranked) for (const p of s.points) yMax = Math.max(yMax, p.rows);
    const yOf = (v: number) => MT + IH - (v / yMax) * IH;
    const plotted: Plotted[] = ranked.map(({ s, total }, r) => ({
      source: s.source,
      color: SHADES[Math.min(r, SHADES.length - 1)],
      total,
      pts: densify(s.points).map((p) => ({
        x: xOf(idx.get(p.day) ?? 0),
        y: yOf(p.rows),
        day: p.day,
        rows: p.rows,
      })),
    }));
    return { axis, plotted, yMax, xOf };
  }, [series]);

  // Direct-label only the series that carry real volume (>=10% of the biggest) —
  // low-volume lines hug the baseline and their end-labels would collide there;
  // the legend + hover cover them instead.
  const topTotal = plotted[0]?.total ?? 0;
  const labelled = plotted.filter((p) => p.total >= topTotal * 0.1);
  const hoverDay = hover != null ? axis[hover] : null;

  return (
    <div className="card p-4">
      {/* legend */}
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-stone-600">
        {plotted.map((p) => (
          <span key={p.source} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: p.color }} />
            {p.source}
          </span>
        ))}
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height: "auto", overflow: "visible" }}
        role="img"
        aria-label="Daily rows ingested per source over the last 30 days"
        onPointerMove={(e) => {
          const svg = e.currentTarget;
          const r = svg.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          if (axis.length < 2) return setHover(0);
          let i = Math.round(((px - ML) / IW) * (axis.length - 1));
          i = Math.max(0, Math.min(axis.length - 1, i));
          setHover(i);
        }}
        onPointerLeave={() => setHover(null)}
      >
        {/* y gridlines + labels */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const y = MT + IH - f * IH;
          return (
            <g key={f}>
              <line x1={ML} y1={y} x2={ML + IW} y2={y} stroke="#e7e5e4" strokeWidth={1} />
              <text x={ML - 8} y={y + 3.5} textAnchor="end" fontSize={10.5} fill="#a8a29e">
                {compact(Math.round(yMax * f))}
              </text>
            </g>
          );
        })}
        {/* x labels (every ~5th day) */}
        {axis.map((d, i) =>
          (i % 5 === 0 && i <= axis.length - 3) || i === axis.length - 1 ? (
            <text key={d} x={xOf(i)} y={H - 12} textAnchor="middle" fontSize={10.5} fill="#a8a29e">
              {d.slice(5)}
            </text>
          ) : null,
        )}
        {/* crosshair */}
        {hover != null && (
          <line
            x1={xOf(hover)}
            y1={MT}
            x2={xOf(hover)}
            y2={MT + IH}
            stroke="#a8a29e"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        )}
        {/* series lines */}
        {plotted.map((p) => (
          <path
            key={p.source}
            d={p.pts.map((pt, i) => `${i ? "L" : "M"}${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`).join(" ")}
            fill="none"
            stroke={p.color}
            strokeWidth={1.75}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {/* hover dots */}
        {hover != null &&
          plotted.map((p) => {
            const pt = p.pts.find((q) => q.day === hoverDay);
            return pt ? (
              <circle key={p.source} cx={pt.x} cy={pt.y} r={3} fill={p.color} stroke="#fff" strokeWidth={1.5} />
            ) : null;
          })}
        {/* direct end-labels for the top series */}
        {labelled.map((p) => {
          const pt = p.pts[p.pts.length - 1];
          return pt ? (
            <text key={p.source} x={pt.x + 7} y={pt.y + 3.5} fontSize={11} fontWeight={600} fill={p.color}>
              {p.source.length > 16 ? p.source.slice(0, 15) + "…" : p.source}
            </text>
          ) : null;
        })}
      </svg>

      {/* hover readout (a table row below, so it never overlaps the plot) */}
      <div className="mt-2 min-h-[2.25rem] rounded-md bg-stone-50 px-3 py-2 text-xs">
        {hoverDay ? (
          <>
            <span className="mr-3 font-semibold text-stone-700">{hoverDay}</span>
            {plotted.map((p) => {
              const pt = p.pts.find((q) => q.day === hoverDay);
              if (!pt) return null;
              return (
                <span key={p.source} className="mr-3 inline-flex items-center gap-1.5 text-stone-600">
                  <span className="inline-block h-2 w-2 rounded-sm" style={{ background: p.color }} />
                  {p.source}: <span className="font-medium tabular-nums text-stone-800">{pt.rows.toLocaleString("en-US")}</span>
                </span>
              );
            })}
          </>
        ) : (
          <span className="text-stone-400">Hover the chart for per-day counts.</span>
        )}
      </div>
    </div>
  );
}
