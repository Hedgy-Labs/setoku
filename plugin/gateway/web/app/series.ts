// SPDX-License-Identifier: Apache-2.0
// Helpers for the Sources ingestion sparklines + trends chart. The server sends
// SPARSE daily points (zero-days omitted); these fill the gaps so a quiet weekend
// reads as a dip to zero, not a missing sample.
import type { SourceSeries, SourceSeriesPoint } from "./types";

const DAY_MS = 86_400_000;
const toUTC = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const fromUTC = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Enumerate every YYYY-MM-DD from `first` to `last` inclusive. */
export function dayAxis(first: string, last: string): string[] {
  const out: string[] = [];
  const end = toUTC(last);
  for (let t = toUTC(first); t <= end; t += DAY_MS) out.push(fromUTC(t));
  return out;
}

/** Fill a sparse series to one point per day across its own [min, max] range. */
export function densify(points: SourceSeriesPoint[]): SourceSeriesPoint[] {
  if (points.length === 0) return [];
  const by = new Map(points.map((p) => [p.day, p.rows]));
  return dayAxis(points[0].day, points[points.length - 1].day).map((day) => ({
    day,
    rows: by.get(day) ?? 0,
  }));
}

/** The union [min, max] day across many series, for a shared x-axis. */
export function unionAxis(series: SourceSeries[]): string[] {
  let min = "", max = "";
  for (const s of series) {
    for (const p of s.points) {
      if (!min || p.day < min) min = p.day;
      if (!max || p.day > max) max = p.day;
    }
  }
  return min ? dayAxis(min, max) : [];
}

/** Compact number for axis/labels: 46231 → "46k", 1985 → "2.0k", 12 → "12". */
export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
