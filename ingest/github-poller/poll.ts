#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * GitHub → Setoku ingest bridge (pull-based).
 *
 * GitHub has webhooks, but a poller wins here for the same reasons Mercury's
 * did: full history backfill for free, no public endpoint to secure, and the
 * proven pull-bridge pattern (ingest/mercury-poller is the template). Each tick,
 * per configured repo, we fetch what changed since the last cursor:
 *   1. issues + PRs (one endpoint — GitHub treats PRs as issues) → /ingest/github/issues
 *   2. PR-specific fields (merge state, branches, draft)          → /ingest/github/pulls
 *   3. commits on the default branch                              → /ingest/github/commits
 *   4. issue comments + PR review comments                        → /ingest/github/comments
 *
 * Issues/PRs/comments are MUTABLE (open → closed/merged, bodies edited), so —
 * like Mercury transactions — the lake tables are ReplacingMergeTree keyed by
 * (repo, number|sha|id) with ingested_at as the version: we re-emit anything
 * updated since the cursor and the newest observation wins. Cursors overlap by
 * a few minutes on purpose; the ReplacingMergeTree absorbs the duplicates.
 *
 * Durability model: each page is pushed to Vector as soon as it's fetched
 * (bounded memory, no giant POST), and a resource's cursor only advances on a
 * fully-clean pass — a fetch/push failure throws, the cursor stays, and the
 * next tick re-covers the window (duplicates dedup in the lake). If an asc
 * walk is truncated by the page cap, the cursor advances only to the last
 * updated_at actually seen, so a huge backfill converges across ticks instead
 * of silently skipping the tail.
 *
 * The `pulls` list endpoint has no `since` param (verified against the official
 * docs, 2026-07), so we walk it sorted by updated desc and stop at the cursor.
 * `merge_commit_sha` is not in the list response — deliberately not a column.
 *
 * Env:
 *   GITHUB_TOKEN            fine-grained PAT, read-only (Contents, Issues,
 *                           Pull requests, Metadata)                  [required]
 *   GITHUB_REPOS            comma-separated owner/repo list           [required]
 *   GITHUB_VECTOR_URL       default http://vector:8080 (base; paths appended)
 *   GITHUB_POLL_INTERVAL_MS default 300000 (5 min — plenty for repo activity)
 *   GITHUB_BACKFILL_DAYS    first-run commit lookback, default 730
 *                           (issues/PRs/comments always backfill in full)
 *   GITHUB_STATE_DIR        default /state
 */
import fs from "node:fs";
import path from "node:path";

const API = "https://api.github.com";
const TOKEN = required("GITHUB_TOKEN");
const REPOS = required("GITHUB_REPOS")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);
const VECTOR_BASE = (process.env.GITHUB_VECTOR_URL ?? "http://vector:8080").replace(/\/+$/, "");
const INTERVAL = Number(process.env.GITHUB_POLL_INTERVAL_MS ?? 300_000);
const BACKFILL_DAYS = Number(process.env.GITHUB_BACKFILL_DAYS ?? 730);
const STATE_DIR = process.env.GITHUB_STATE_DIR ?? "/state";
const STATE_FILE = path.join(STATE_DIR, "github-poller.json");
const PAGE = 100; // per_page max (GitHub docs)
const MAX_PAGES = 400; // 40k items per resource per tick — a huge backfill resumes next tick
const OVERLAP_MS = 10 * 60_000; // cursor overlap; ReplacingMergeTree dedups
const BODY_CAP = 50_000; // chars — issue/comment bodies are untrusted free text

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`github-poller: ${name} is required`);
    process.exit(1);
  }
  return v;
}

if (REPOS.some((r) => !/^[\w.-]+\/[\w.-]+$/.test(r))) {
  console.error(`github-poller: GITHUB_REPOS entries must be owner/repo (got: ${REPOS.join(", ")})`);
  process.exit(1);
}

interface RepoCursors {
  issuesSince?: string;
  pullsSince?: string;
  commitsSince?: string;
  commentsSince?: string;
}
type State = Record<string, RepoCursors>;

function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveState(s: State): void {
  // tmp + rename: a crash mid-write must not corrupt the cursor file — a
  // corrupt file reads as {} and would re-backfill every repo from scratch
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, STATE_FILE);
}

/** Throws on failure (after retries) — a failed fetch must NOT advance cursors. */
async function api<T>(pathAndQuery: string): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${API}${pathAndQuery}`, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "setoku-github-poller",
      },
      signal: AbortSignal.timeout(30_000),
    });
    // Primary rate limit: 403/429 with x-ratelimit-remaining: 0 → sleep to reset.
    // Secondary limits send retry-after. Cap the nap so a bad clock can't hang us.
    if (r.status === 429 || r.status === 403 || r.status >= 500) {
      const reset = Number(r.headers.get("x-ratelimit-reset") ?? 0) * 1000 - Date.now();
      const retryAfter = Number(r.headers.get("retry-after") ?? 0) * 1000;
      const wait = Math.min(Math.max(reset, retryAfter, 2 ** attempt * 1000), 15 * 60_000);
      if (r.status === 403 && r.headers.get("x-ratelimit-remaining") !== "0" && !retryAfter) {
        // a real 403 (bad token scope), not a rate limit — don't spin on it
        throw new Error(`GET ${pathAndQuery} → 403 ${(await r.text().catch(() => "")).slice(0, 200)}`);
      }
      await Bun.sleep(wait);
      continue;
    }
    if (!r.ok) {
      throw new Error(`GET ${pathAndQuery} → ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
    }
    return (await r.json()) as T;
  }
  throw new Error(`GET ${pathAndQuery} gave up after retries`);
}

/**
 * Stream a list endpoint page by page (bounded memory — the caller pushes each
 * page before the next is fetched). `stop` short-circuits an updated-desc walk.
 * Yields at most MAX_PAGES pages; the caller detects truncation via `truncated`.
 */
async function* pages<T>(base: string, stop?: (item: T) => boolean): AsyncGenerator<T[]> {
  const sep = base.includes("?") ? "&" : "?";
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await api<T[]>(`${base}${sep}per_page=${PAGE}&page=${page}`);
    if (!items.length) return;
    const kept = stop ? items.slice(0, items.findIndex(stop) === -1 ? items.length : items.findIndex(stop)) : items;
    if (kept.length) yield kept;
    if (kept.length < items.length || items.length < PAGE) return;
  }
}

/**
 * Liveness beat → Vector (routed to setoku.ingest_heartbeats) — the Sources
 * page reads "flowing" from this, so a quiet repo isn't a false "stale".
 * Beats fire after each successful tick AND on a fast re-beat timer gated on
 * the last completed tick having succeeded — so liveness stays inside the
 * 10-minute window even when the poll interval is longer, while a dead token
 * (failing ticks) still goes dark. Best-effort: a lost beat just reads as
 * quiet until the next one.
 */
const BEAT_MS = 4 * 60_000; // < the gateway's 10-minute liveness window
let lastTickOk = false;
let lastBeatDetail = "";

async function beat(detail: string): Promise<void> {
  try {
    const r = await fetch(`${VECTOR_BASE}/ingest/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: JSON.stringify({ connector: "github-poller", detail }) + "\n",
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    console.error(`github-poller: heartbeat failed: ${e}`);
  }
}

async function pushToVector(suffix: string, lines: string[]): Promise<void> {
  if (!lines.length) return;
  const r = await fetch(`${VECTOR_BASE}/ingest/github/${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: lines.join("\n") + "\n",
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`vector ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
}

const trunc = (s: unknown, cap = BODY_CAP): string => {
  const str = typeof s === "string" ? s : "";
  return str.length > cap ? str.slice(0, cap) + "\n…[truncated]" : str;
};
const login = (u: unknown): string => (u as { login?: string } | null)?.login ?? "";
const names = (arr: unknown): string =>
  JSON.stringify(((arr as { name?: string; login?: string }[]) ?? []).map((x) => x.name ?? x.login ?? ""));
// number from ".../issues/123" or ".../pulls/123"
const numFromUrl = (u: unknown): number => Number(String(u ?? "").match(/\/(\d+)$/)?.[1] ?? 0);
// GitHub timestamps have no millis ("…:00Z"); keep cursors in the same shape so
// lexicographic compares against API values are exact at second boundaries.
const isoSeconds = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
// raw catch-all (convention: every lake source keeps the observed JSON so a
// mapping bug is repairable) — with free-text fields capped, same as the columns
const rawOf = (item: Record<string, unknown>, ...capFields: string[]): string => {
  const copy: Record<string, unknown> = { ...item };
  for (const f of capFields) if (typeof copy[f] === "string") copy[f] = trunc(copy[f]);
  return JSON.stringify(copy);
};

/* eslint-disable @typescript-eslint/no-explicit-any -- GitHub payloads are wide; we pick fields defensively */

/**
 * Each poll fn returns the cursor to store for its resource: `next` after a
 * clean full walk, or — when an asc walk hit the page cap — the last
 * updated_at it actually processed, so the remainder is picked up next tick.
 */
async function pollIssues(repo: string, since: string | undefined, next: string, ingestedAt: string): Promise<{ n: number; cursor: string }> {
  const q = `/repos/${repo}/issues?state=all&sort=updated&direction=asc${since ? `&since=${since}` : ""}`;
  let n = 0;
  let last = "";
  for await (const page of pages<any>(q)) {
    const lines = page.map((i) =>
      JSON.stringify({
        repo,
        id: i.id ?? 0,
        number: i.number ?? 0,
        is_pr: i.pull_request ? 1 : 0,
        title: trunc(i.title, 1000),
        body: trunc(i.body),
        state: i.state ?? "",
        state_reason: i.state_reason ?? "",
        author: login(i.user),
        labels: names(i.labels),
        assignees: names(i.assignees),
        milestone: i.milestone?.title ?? "",
        comments_count: i.comments ?? 0,
        created_at: i.created_at ?? "",
        updated_at: i.updated_at ?? "",
        closed_at: i.closed_at ?? null,
        html_url: i.html_url ?? "",
        raw: rawOf(i, "body"),
        ingested_at: ingestedAt,
      }),
    );
    await pushToVector("issues", lines);
    n += lines.length;
    last = page[page.length - 1]?.updated_at ?? last;
  }
  // full walk = fewer than the cap's worth of items → safe to jump to `next`;
  // capped walk → resume from the last item actually landed
  return { n, cursor: n < MAX_PAGES * PAGE ? next : last || next };
}

async function pollPulls(repo: string, since: string | undefined, next: string, ingestedAt: string): Promise<{ n: number; cursor: string }> {
  // no `since` param on this endpoint — walk updated-desc and stop at the cursor.
  // A capped desc walk must NOT advance the cursor (the tail near the cursor was
  // never reached); rare — pulls are bounded by the repo's PR count.
  const stop = since ? (p: any) => (p.updated_at ?? "") < since : undefined;
  let n = 0;
  for await (const page of pages<any>(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc`, stop)) {
    const lines = page.map((p) =>
      JSON.stringify({
        repo,
        id: p.id ?? 0,
        number: p.number ?? 0,
        title: trunc(p.title, 1000),
        state: p.state ?? "",
        draft: p.draft ? 1 : 0,
        author: login(p.user),
        base_ref: p.base?.ref ?? "",
        head_ref: p.head?.ref ?? "",
        created_at: p.created_at ?? "",
        updated_at: p.updated_at ?? "",
        closed_at: p.closed_at ?? null,
        merged_at: p.merged_at ?? null,
        html_url: p.html_url ?? "",
        raw: rawOf(p, "body"),
        ingested_at: ingestedAt,
      }),
    );
    await pushToVector("pulls", lines);
    n += lines.length;
  }
  return { n, cursor: n < MAX_PAGES * PAGE ? next : since ?? next };
}

async function pollCommits(repo: string, since: string, next: string, ingestedAt: string): Promise<{ n: number; cursor: string }> {
  // NB: `since` filters by COMMITTER date — a rebase/merge that lands old-dated
  // commits on the default branch after the cursor passed will miss them (their
  // PR still lands in github_pulls). Documented in 052_github_commits.sql.
  let n = 0;
  for await (const page of pages<any>(`/repos/${repo}/commits?since=${since}`)) {
    const lines = page.map((c) =>
      JSON.stringify({
        repo,
        sha: c.sha ?? "",
        author_login: login(c.author),
        author_name: c.commit?.author?.name ?? "",
        author_email: c.commit?.author?.email ?? "",
        message: trunc(c.commit?.message),
        committed_at: c.commit?.committer?.date ?? c.commit?.author?.date ?? "",
        html_url: c.html_url ?? "",
        raw: rawOf(c),
        ingested_at: ingestedAt,
      }),
    );
    await pushToVector("commits", lines);
    n += lines.length;
  }
  // commits list is newest-first: a capped walk covered the head, not the tail
  // near the cursor — keep the old cursor so the gap is retried
  return { n, cursor: n < MAX_PAGES * PAGE ? next : since };
}

async function pollComments(repo: string, since: string | undefined, next: string, ingestedAt: string): Promise<{ n: number; cursor: string }> {
  const sinceQ = since ? `&since=${since}` : "";
  let n = 0;
  let cursor = next;
  for (const [kind, ep] of [
    ["issue", "issues"],
    ["review", "pulls"],
  ] as const) {
    let kn = 0;
    let last = "";
    for await (const page of pages<any>(`/repos/${repo}/${ep}/comments?sort=updated&direction=asc${sinceQ}`)) {
      const lines = page.map((c) =>
        JSON.stringify({
          repo,
          comment_type: kind,
          id: c.id ?? 0,
          number: numFromUrl(c.issue_url ?? c.pull_request_url),
          author: login(c.user),
          body: trunc(c.body),
          path: c.path ?? "", // review comments only — the file commented on
          created_at: c.created_at ?? "",
          updated_at: c.updated_at ?? "",
          html_url: c.html_url ?? "",
          raw: rawOf(c, "body"),
          ingested_at: ingestedAt,
        }),
      );
      await pushToVector("comments", lines);
      kn += lines.length;
      last = page[page.length - 1]?.updated_at ?? last;
    }
    n += kn;
    // one shared cursor for both comment kinds: take the most conservative
    if (kn >= MAX_PAGES * PAGE && last && last < cursor) cursor = last;
  }
  return { n, cursor };
}

async function tick(): Promise<void> {
  const st = loadState();
  const now = Date.now();
  const ingestedAt = new Date(now).toISOString();
  // next cursor: this tick's start minus overlap — anything updated mid-fetch
  // is re-observed next tick; the ReplacingMergeTree absorbs the re-emits
  const next = isoSeconds(now - OVERLAP_MS);
  let okRepos = 0;
  let items = 0;

  for (const repo of REPOS) {
    const cur = st[repo] ?? {};
    const firstRunCommitsSince = isoSeconds(now - BACKFILL_DAYS * 86_400_000);
    try {
      const issues = await pollIssues(repo, cur.issuesSince, next, ingestedAt);
      const pulls = await pollPulls(repo, cur.pullsSince, next, ingestedAt);
      const commits = await pollCommits(repo, cur.commitsSince ?? firstRunCommitsSince, next, ingestedAt);
      const comments = await pollComments(repo, cur.commentsSince, next, ingestedAt);
      st[repo] = {
        issuesSince: issues.cursor,
        pullsSince: pulls.cursor,
        commitsSince: commits.cursor,
        commentsSince: comments.cursor,
      };
      saveState(st); // per-repo: one repo failing doesn't reset the others
      okRepos++;
      items += issues.n + pulls.n + commits.n + comments.n;
      console.error(
        `github-poller: ${repo} → ${issues.n} issue(s), ${pulls.n} pull(s), ${commits.n} commit(s), ${comments.n} comment(s)${cur.issuesSince ? "" : " (backfill)"}`,
      );
    } catch (e) {
      // fetch or push failed mid-walk: cursors stay put, the whole window is
      // re-covered next tick (already-pushed pages dedup in the lake)
      console.error(`github-poller: ${repo} tick failed (cursor kept): ${e}`);
    }
  }
  lastTickOk = okRepos > 0;
  if (lastTickOk) {
    lastBeatDetail = `${okRepos}/${REPOS.length} repo(s) ok · ${items} item(s)`;
    await beat(lastBeatDetail);
  }
}

async function main(): Promise<void> {
  console.error(
    `github-poller: polling ${REPOS.length} repo(s) every ${INTERVAL}ms → ${VECTOR_BASE}/ingest/github/* ` +
      `(commit backfill ${BACKFILL_DAYS}d)`,
  );
  setInterval(() => {
    if (lastTickOk) void beat(lastBeatDetail);
  }, BEAT_MS);
  for (;;) {
    try {
      await tick();
    } catch (e) {
      lastTickOk = false;
      console.error(`github-poller: tick failed: ${e}`);
    }
    await Bun.sleep(INTERVAL);
  }
}

if (import.meta.main) void main();
