// SPDX-License-Identifier: Apache-2.0
// Display helpers ported from the old server renderer (lib/approval.ts) — these
// run client-side now that the API returns raw freshness data.

export type StatusColor = "green" | "yellow" | "red";

/** Parse a lake timestamp ("2026-06-12 19:25:52.036", UTC) to epoch ms. */
export function lakeTsToMs(s: string | null | undefined): number | null {
  if (!s) return null;
  let t = s.includes("T") ? s : s.replace(" ", "T");
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(t)) t += "Z";
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

/** Compact "3m ago" / "2h ago" / "5d ago" from a lake timestamp. */
export function relTime(s: string | null | undefined): string {
  const ms = lakeTsToMs(s);
  if (ms == null) return "";
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Freshness → status: green if data within 24h, yellow if stale/empty. */
export function freshness(rows: number | null, last: string | null): { color: StatusColor; label: string } {
  if (!rows || !last) return { color: "yellow", label: "no data" };
  const ms = lakeTsToMs(last);
  if (ms != null && Date.now() - ms < 24 * 60 * 60 * 1000) return { color: "green", label: "flowing" };
  return { color: "yellow", label: "stale" };
}

/** Audit payload (a JSON string) → a compact "k=v · k=v" summary. */
export function auditSummary(payload: string): string {
  try {
    const p = JSON.parse(payload) as Record<string, unknown>;
    return Object.entries(p)
      .filter(([, v]) => v !== null && v !== "")
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" · ");
  } catch {
    return payload;
  }
}
