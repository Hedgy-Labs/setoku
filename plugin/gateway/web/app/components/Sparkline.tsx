// SPDX-License-Identifier: Apache-2.0
import { densify, compact } from "../series";
import type { SourceSeriesPoint } from "../types";

// A compact daily-ingestion sparkline — stone only, per the gateway-chrome
// convention (color belongs to the user's content, not the chrome). Bars, not a
// line, so a gap-day reads honestly as a drop to zero. Pure inline SVG, no deps.
const W = 168;
const H = 34;
const GAP = 1;

export function Sparkline({ points }: { points: SourceSeriesPoint[] }) {
  const days = densify(points);
  if (days.length < 2) return <span className="text-stone-400">not enough history</span>;

  const max = Math.max(1, ...days.map((d) => d.rows));
  const bw = (W - GAP * (days.length - 1)) / days.length;
  const total = days.reduce((a, d) => a + d.rows, 0);
  const avg = Math.round(total / days.length);
  const last = days.length - 1;

  return (
    <span className="inline-flex items-center gap-2.5">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label={`Daily ingestion, last ${days.length} days, ~${compact(avg)} per day`}
        className="shrink-0"
      >
        {days.map((d, i) => {
          const h = d.rows === 0 ? 0.75 : Math.max(1, (d.rows / max) * (H - 2));
          return (
            <rect
              key={d.day}
              x={i * (bw + GAP)}
              y={H - h}
              width={bw}
              height={h}
              rx={bw > 2 ? 1 : 0}
              // most-recent day stone-600, the rest stone-300; zero-days barely there
              fill={i === last ? "#57534e" : d.rows === 0 ? "#e7e5e4" : "#d6d3d1"}
            >
              <title>{`${d.day}: ${d.rows.toLocaleString("en-US")} rows`}</title>
            </rect>
          );
        })}
      </svg>
      <span className="whitespace-nowrap text-xs text-stone-500">~{compact(avg)}/day</span>
    </span>
  );
}
