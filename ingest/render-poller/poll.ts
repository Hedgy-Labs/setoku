#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * Render Logs → Setoku ingest bridge (pull-based).
 *
 * Render has no public API to CREATE a log stream (dashboard-only), but its
 * Logs query API (GET /v1/logs) IS available with an API key. So instead of a
 * pushed stream we poll the configured services and POST each new entry to the
 * internal Vector receiver as /ingest/render — same pipeline a pushed stream
 * would land in (render_parse → setoku.logs_render).
 *
 * State (last timestamp + the log ids seen at that exact timestamp) persists to
 * /state so a restart neither loses nor double-ingests across the boundary.
 *
 * Env:
 *   RENDER_API_KEY        rnd_… (logs:read)                      [required]
 *   RENDER_OWNER_ID       tea-… workspace id                     [required]
 *   RENDER_SERVICE_IDS    srv-…,srv-…  comma-separated           [required]
 *   RENDER_VECTOR_URL     default http://vector:8080/ingest/render
 *   RENDER_POLL_INTERVAL_MS  default 60000
 *   RENDER_STATE_DIR      default /state
 */
import fs from "node:fs";
import path from "node:path";

const API = "https://api.render.com/v1";
const KEY = required("RENDER_API_KEY");
const OWNER = required("RENDER_OWNER_ID");
const SERVICE_IDS = required("RENDER_SERVICE_IDS")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const VECTOR_URL =
  process.env.RENDER_VECTOR_URL ?? "http://vector:8080/ingest/render";
const INTERVAL = Number(process.env.RENDER_POLL_INTERVAL_MS ?? 60_000);
const STATE_DIR = process.env.RENDER_STATE_DIR ?? "/state";
const STATE_FILE = path.join(STATE_DIR, "render-poller.json");

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`render-poller: ${name} is required`);
    process.exit(1);
  }
  return v;
}

interface RenderLog {
  id: string;
  message: string;
  timestamp: string;
  labels?: { name: string; value: string }[];
}
interface State {
  lastTs: string;
  boundaryIds: string[];
}

function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    // first run: start from 5 minutes ago
    return { lastTs: new Date(Date.now() - 5 * 60_000).toISOString(), boundaryIds: [] };
  }
}
function saveState(s: State): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s));
}

/** id → friendly service name, fetched once (falls back to the id). */
const names = new Map<string, string>();
async function loadServiceNames(): Promise<void> {
  try {
    const r = await fetch(`${API}/services?limit=100`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    if (!r.ok) return;
    for (const s of (await r.json()) as { service: { id: string; name: string } }[]) {
      names.set(s.service.id, s.service.name);
    }
  } catch {
    /* names are cosmetic */
  }
}

function labelMap(labels?: { name: string; value: string }[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const l of labels ?? []) m[l.name] = l.value;
  return m;
}

// Fetch failures this tick — the liveness beat is withheld when any service's
// log query failed, so a revoked key never reads as alive. Reset each tick.
let fetchErrors = 0;

/** Page forward through /v1/logs for one service over [start, end]. */
async function fetchLogs(service: string, start: string, end: string): Promise<RenderLog[]> {
  const out: RenderLog[] = [];
  let cursor = start;
  for (let page = 0; page < 50; page++) {
    const u = new URL(`${API}/logs`);
    u.searchParams.set("ownerId", OWNER);
    u.searchParams.append("resource", service);
    u.searchParams.set("startTime", cursor);
    u.searchParams.set("endTime", end);
    u.searchParams.set("limit", "100");
    u.searchParams.set("direction", "forward");
    const r = await fetch(u, { headers: { authorization: `Bearer ${KEY}` } });
    if (r.status === 429) {
      await Bun.sleep(Number(r.headers.get("retry-after") ?? 5) * 1000);
      continue;
    }
    if (!r.ok) {
      console.error(`render-poller: logs ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
      fetchErrors++;
      break;
    }
    const d = (await r.json()) as { logs?: RenderLog[]; hasMore?: boolean; nextStartTime?: string };
    out.push(...(d.logs ?? []));
    if (!d.hasMore || !d.nextStartTime || d.nextStartTime === cursor) break;
    cursor = d.nextStartTime;
  }
  return out;
}

async function pushToVector(lines: string[]): Promise<void> {
  if (!lines.length) return;
  const r = await fetch(VECTOR_URL, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: lines.join("\n") + "\n",
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`vector ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
}

/**
 * Liveness beat → Vector (routed to setoku.ingest_heartbeats) — sent only after
 * a tick whose log queries all succeeded, so a revoked key never reads as alive.
 * Best-effort: a lost beat just reads as quiet until the next tick.
 */
async function beat(detail: string): Promise<void> {
  try {
    const r = await fetch(VECTOR_URL.replace(/\/ingest\/.*$/, "/ingest/heartbeat"), {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: JSON.stringify({ connector: "render-poller", detail }) + "\n",
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    console.error(`render-poller: heartbeat failed: ${e}`);
  }
}

async function tick(): Promise<void> {
  const st = loadState();
  const seen = new Set(st.boundaryIds);
  const end = new Date().toISOString();

  fetchErrors = 0;
  const all: RenderLog[] = [];
  for (const svc of SERVICE_IDS) all.push(...(await fetchLogs(svc, st.lastTs, end)));
  if (!fetchErrors) await beat(`${SERVICE_IDS.length} service(s)`);
  if (!all.length) return;

  // forward only entries we haven't already sent (boundary dedup by id)
  const fresh = all.filter((l) => !seen.has(l.id));
  const lines = fresh.map((l) => {
    const lm = labelMap(l.labels);
    return JSON.stringify({
      timestamp: l.timestamp,
      service: names.get(lm.resource ?? "") ?? lm.resource ?? "render",
      instance: lm.instance ?? "",
      level: lm.level ?? "info",
      type: lm.type ?? "",
      message: l.message ?? "",
      render_id: l.id,
    });
  });
  await pushToVector(lines);

  // advance the watermark; remember ids at the new boundary timestamp so the
  // next poll (which re-includes startTime) doesn't resend them
  const maxTs = all.reduce((m, l) => (l.timestamp > m ? l.timestamp : m), st.lastTs);
  const boundaryIds = all.filter((l) => l.timestamp === maxTs).map((l) => l.id);
  saveState({ lastTs: maxTs, boundaryIds });
  if (fresh.length) console.error(`render-poller: forwarded ${fresh.length} log(s); watermark ${maxTs}`);
}

async function main(): Promise<void> {
  await loadServiceNames();
  console.error(
    `render-poller: polling ${SERVICE_IDS.length} service(s) every ${INTERVAL}ms → ${VECTOR_URL}`,
  );
  for (;;) {
    try {
      await tick();
    } catch (e) {
      console.error(`render-poller: tick failed: ${e}`);
    }
    await Bun.sleep(INTERVAL);
  }
}

if (import.meta.main) void main();
