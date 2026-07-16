// SPDX-License-Identifier: Apache-2.0
/**
 * Tool-friction miner — the "reflections" loop, sourced from behavior.
 *
 * The HN "designing APIs for agents" thread (item 48894874) splits on whether
 * you should ASK an agent what confused it: self-report is plausible but
 * ungrounded (what/rgbrgb/benswerd), and only grounded when there's a
 * behavioral anchor — tried X, failed, tried Y, worked (simonw/kolinko). Our
 * audit log already records that anchor for every `run_query` (purpose + sql +
 * ok + error, in append order), so we can extract the friction WITHOUT asking
 * the model to introspect, and without a self-report tool the operator would
 * have to babysit.
 *
 * This is deterministic and model-free (I8): it reads the audit log, clusters
 * failures by cause (the SAME classifier the live hint uses, lib/queryhint.ts),
 * and detects per-session fail→retry→success recovery. A cause with a LOW
 * recovery rate is where agents get stuck — the priority for a better error
 * hint, a schema rename, or a new curated metric.
 */
import { classifyQueryError } from "./queryhint";
import type { AuditRow } from "./store";

export interface FrictionEvent {
  ts: string;
  user: string;
  ok: boolean;
  error: string;
  sql: string;
  purpose: string;
}

export interface FrictionExample {
  purpose: string;
  error: string;
  sql: string;
}

export interface BucketStat {
  code: string;
  /** failures in this bucket */
  count: number;
  /** failures followed by a same-session success */
  recovered: number;
  /** count − recovered: agents that stayed blocked */
  stuck: number;
  recoveryRate: number;
  examples: FrictionExample[];
}

export interface FrictionResult {
  totalCalls: number;
  totalFailures: number;
  failureRate: number;
  recoveredFailures: number;
  /** recovered / totalFailures */
  recoveryRate: number;
  windowMinutes: number;
  users: number;
  /** sorted by `stuck` desc (most-unresolved friction first) */
  buckets: BucketStat[];
  /** most common `purpose` among failures — a missing-metric / hard-question
   *  signal (an intent agents keep failing to express in SQL) */
  topFailingIntents: { purpose: string; count: number }[];
}

export interface MineOptions {
  /** consecutive same-user calls within this gap count as one session; a
   *  larger gap is a session boundary and stops recovery look-ahead */
  windowMinutes?: number;
  /** examples kept per bucket */
  exampleLimit?: number;
}

function trunc(s: string, n: number): string {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

function gapMinutes(aTs: string, bTs: string): number {
  return Math.abs(new Date(bTs).getTime() - new Date(aTs).getTime()) / 60000;
}

/** Parse run_query audit rows into typed events (oldest-first order preserved).
 *  Rows whose payload won't parse are skipped — a corrupt row must not abort a
 *  report over months of good data. */
export function parseRunQueryEvents(rows: AuditRow[]): FrictionEvent[] {
  const events: FrictionEvent[] = [];
  for (const r of rows) {
    if (r.tool !== "run_query") continue;
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    events.push({
      ts: r.ts,
      user: r.user ?? "(unknown)",
      ok: p.ok === true,
      error: typeof p.error === "string" ? p.error : "",
      sql: typeof p.sql === "string" ? p.sql : "",
      purpose: typeof p.purpose === "string" ? p.purpose : "",
    });
  }
  return events;
}

export function mineFriction(
  rows: AuditRow[],
  opts: MineOptions = {},
): FrictionResult {
  const windowMinutes = opts.windowMinutes ?? 15;
  const exampleLimit = opts.exampleLimit ?? 3;
  const events = parseRunQueryEvents(rows);

  // Per-user timelines (already oldest-first from auditForTool), so recovery
  // look-ahead sees each identity's own retries in order.
  const byUser = new Map<string, FrictionEvent[]>();
  for (const e of events) {
    const list = byUser.get(e.user) ?? [];
    list.push(e);
    byUser.set(e.user, list);
  }

  interface Bucket {
    count: number;
    recovered: number;
    examples: FrictionExample[];
  }
  const buckets = new Map<string, Bucket>();
  const intents = new Map<string, { purpose: string; count: number }>();
  let totalFailures = 0;
  let recoveredFailures = 0;

  for (const list of byUser.values()) {
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.ok) continue;
      totalFailures++;

      // recovery: a later same-session success before a gap > window
      let recovered = false;
      for (let j = i + 1; j < list.length; j++) {
        if (gapMinutes(list[j - 1].ts, list[j].ts) > windowMinutes) break;
        if (list[j].ok) {
          recovered = true;
          break;
        }
      }
      if (recovered) recoveredFailures++;

      const code = classifyQueryError(e.error);
      const b = buckets.get(code) ?? { count: 0, recovered: 0, examples: [] };
      b.count++;
      if (recovered) b.recovered++;
      if (b.examples.length < exampleLimit) {
        b.examples.push({
          purpose: trunc(e.purpose, 160),
          error: trunc(e.error, 200),
          sql: trunc(e.sql, 200),
        });
      }
      buckets.set(code, b);

      if (e.purpose.trim()) {
        const key = e.purpose.trim().toLowerCase();
        const rec = intents.get(key) ?? { purpose: e.purpose.trim(), count: 0 };
        rec.count++;
        intents.set(key, rec);
      }
    }
  }

  const bucketStats: BucketStat[] = [...buckets.entries()]
    .map(([code, b]) => ({
      code,
      count: b.count,
      recovered: b.recovered,
      stuck: b.count - b.recovered,
      recoveryRate: b.count ? b.recovered / b.count : 0,
      examples: b.examples,
    }))
    // most-unresolved first; ties broken by raw volume
    .sort((a, b) => b.stuck - a.stuck || b.count - a.count);

  const topFailingIntents = [...intents.values()]
    .filter((x) => x.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    totalCalls: events.length,
    totalFailures,
    failureRate: events.length ? totalFailures / events.length : 0,
    recoveredFailures,
    recoveryRate: totalFailures ? recoveredFailures / totalFailures : 0,
    windowMinutes,
    users: byUser.size,
    buckets: bucketStats,
    topFailingIntents,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/** One-line, human-readable gloss per bucket for the report header column. */
const BUCKET_LABEL: Record<string, string> = {
  table_unavailable: "table not found / not granted",
  unknown_column: "unknown column",
  unknown_function: "unknown function",
  type_mismatch: "type mismatch",
  correlated_subquery: "correlated subquery (unsupported)",
  syntax: "SQL syntax (often a Postgres-ism)",
  mirror_required: "table not yet mirrored (rollout artifact)",
  timeout: "statement timeout",
  memory: "memory cap",
  pg_retired: "used the retired Postgres path",
  curator_lake_denied: "curator session tried to read the lake",
  read_only: "tried a write on a read-only conn",
  multi_statement: "multiple statements in one call",
  format_clause: "included a FORMAT clause",
  other: "unclassified",
};

export function renderFriction(
  r: FrictionResult,
  opts: { showSql?: boolean } = {},
): string {
  const showSql = opts.showSql ?? true;
  const lines: string[] = [];
  lines.push("# run_query friction report\n");
  lines.push(
    "Grounded in the audit log — no model, no self-report. A cause with a LOW " +
      "recovery rate is where agents stay blocked: fix it with a better error " +
      "hint (lib/queryhint.ts), a schema rename, or a new curated metric.\n",
  );

  lines.push("## Overall");
  lines.push(`- run_query calls: **${r.totalCalls}** across **${r.users}** identities`);
  lines.push(
    `- failures: **${r.totalFailures}** (${pct(r.failureRate)} of calls)`,
  );
  lines.push(
    `- recovered in-session (≤${r.windowMinutes}m): **${r.recoveredFailures}** (${pct(r.recoveryRate)} of failures) — the rest stayed blocked`,
  );
  lines.push("");

  if (!r.buckets.length) {
    lines.push("_No run_query failures in the audit log. Nothing to mine._");
    return lines.join("\n");
  }

  lines.push("## Failure causes (most-unresolved first)");
  lines.push(`| cause | fails | recovered | stuck | recovery |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  for (const b of r.buckets) {
    const label = BUCKET_LABEL[b.code] ?? b.code;
    lines.push(
      `| \`${b.code}\` — ${label} | ${b.count} | ${b.recovered} | **${b.stuck}** | ${pct(b.recoveryRate)} |`,
    );
  }
  lines.push("");

  lines.push("## Examples");
  for (const b of r.buckets) {
    if (!b.examples.length) continue;
    lines.push(`### \`${b.code}\` (${b.count} fails, ${b.stuck} stuck)`);
    for (const ex of b.examples) {
      if (ex.purpose) lines.push(`- purpose: ${ex.purpose}`);
      lines.push(`  - error: ${ex.error || "(none recorded)"}`);
      if (showSql && ex.sql) lines.push(`  - sql: \`${ex.sql}\``);
    }
    lines.push("");
  }

  if (r.topFailingIntents.length) {
    lines.push("## Intents that keep failing (candidate missing metrics)");
    lines.push(
      "Stated `purpose` on repeated failed queries — an intent agents can’t reliably turn into SQL is often a metric worth curating.\n",
    );
    for (const it of r.topFailingIntents)
      lines.push(`- ${it.count}× — ${it.purpose}`);
    lines.push("");
  }

  return lines.join("\n");
}
