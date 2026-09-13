#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * Gmail → Setoku ingest bridge (pull-based, MULTI-ACCOUNT, pluggable auth).
 *
 * Gmail has push (Pub/Sub watch), but a poller wins here for the same reasons the
 * GitHub/Mercury bridges' did: full-history backfill for free, no public endpoint
 * to secure, and the proven pull pattern (ingest/github-poller is the template).
 *
 * ONE poller process serves EVERY connected mailbox (a family box has a couple;
 * a business has many). WHERE the per-mailbox credential comes from is behind a
 * small MailboxAuth seam so a second scheme drops in without touching the fetch,
 * parse, or wiring code:
 *   - scheme #1 (shipping): OAUTH — per-user refresh tokens (scope gmail.readonly),
 *     minted by the "/admin → Connect Gmail" flow (or the CLI helper). Works for
 *     consumer @gmail AND Workspace users. This is the only scheme that spans both.
 *   - scheme #2 (stub): DWD — a Workspace service account with domain-wide
 *     delegation, impersonating each domain user. O(1) admin setup for big orgs;
 *     cannot touch consumer @gmail. Slots into mailboxHandles() later.
 *
 * The refresh tokens are read FRESH EACH TICK from GMAIL_TOKENS_FILE (written by
 * the admin flow) or GMAIL_REFRESH_TOKENS (CLI/dev), so connecting a mailbox takes
 * effect on the next tick with no restart, and the poller idles healthily (still
 * beating) when nothing is connected yet.
 *
 * Per mailbox, each tick fetches what's new and POSTs it to Vector's
 * /ingest/gmail/messages on the internal network:
 *   - first run:  users.messages.list  over q="after:<backfill>"      (deep pull)
 *   - steady:     users.history.list   from the stored historyId       (only new)
 * then users.messages.get?format=full per id → parsed plain-text row.
 *
 * A message is MUTABLE (labels change), so — like github_issues — the lake table
 * is a ReplacingMergeTree keyed by (account, message_id) with ingested_at as the
 * version. Each mailbox's cursor advances to the mailbox historyId captured at
 * TICK START; anything arriving mid-tick is re-observed next tick and dedups.
 *
 * ⚠ Data minimization / safety (decided with the operator):
 *   - SPAM + TRASH are never listed (messages.list excludes them by default) —
 *     also the highest injection-risk text, so this shrinks the attack surface.
 *   - Auth mail (2FA codes, password resets, magic links) is DROPPED before it
 *     lands: zero query value, pure liability. See looksLikeAuthMail().
 *   - Bodies are plain-text only, capped. There is NO raw-payload column.
 *   - Marketing (List-Unsubscribe present) is kept but flagged is_bulk=1 so a
 *     miscategorized receipt is still recoverable; queries default to is_bulk=0.
 *   subject/snippet/body/from_name are UNTRUSTED free text — treat as hostile
 *   downstream (the read/write membrane, I2/I9, is what contains that).
 *
 * Env:
 *   GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET   the shared OAuth client (operator sets
 *                           once). Required for the oauth scheme.
 *   GMAIL_TOKENS_FILE       JSON file of refresh tokens written by the admin flow:
 *                           {"refresh_tokens":[...]} or a bare [...]. Read each
 *                           tick; takes precedence over GMAIL_REFRESH_TOKENS.
 *   GMAIL_REFRESH_TOKENS    comma-separated refresh tokens (CLI/dev fallback;
 *                           GMAIL_REFRESH_TOKEN singular also accepted)
 *   GMAIL_AUTH_MODE         "oauth" (default) | "dwd" (not yet implemented)
 *   GMAIL_VECTOR_URL        default http://vector:8080 (base; paths appended)
 *   GMAIL_POLL_INTERVAL_MS  default 900000 (15 min — email doesn't need faster)
 *   GMAIL_BACKFILL_DAYS     how far back the archive walk goes, default 90.
 *                           Safe to set to years: the walk is CHUNKED and
 *                           CHECKPOINTED, so it survives restarts (see below).
 *   GMAIL_BACKFILL_CHUNK_DAYS  one walk step, default 30. Each step is
 *                           checkpointed, so this bounds work lost to a crash.
 *   GMAIL_BACKFILL_BUDGET_MS   wall-clock spent walking per tick, default
 *                           600000 (10 min). The walk resumes on the next tick.
 *   GMAIL_BACKFILL_QUERY_EXTRA  appended to the ARCHIVE-WALK query only (not to
 *                           steady state), default "". Use it to keep a deep
 *                           backfill cheap, e.g. "-category:promotions
 *                           -category:social" to skip years of marketing mail.
 *   GMAIL_FETCH_CONCURRENCY in-flight messages.get calls, default 4. Gmail's
 *                           per-user ceiling is 250 quota units/sec = 50 gets/s,
 *                           and a get answers in ~160ms, so concurrency c runs at
 *                           roughly c/0.16 req/s — c=8 sits ON the limit, c=4 at
 *                           half of it. Stay under: a 429 costs more than it saves.
 *   GMAIL_RESYNC_DAYS       fallback window when a history cursor has expired,
 *                           default 7 (Gmail keeps history records only ~days)
 *   GMAIL_QUERY_EXTRA       appended to EVERY list query, default
 *                           "-in:chats" (skip Google Chat). Spam/trash always out.
 *   GMAIL_BODY_CAP          plain-text body cap in chars, default 50000
 *   GMAIL_DROP_AUTH         "0" to keep auth/2FA mail (default drops it)
 *   GMAIL_STATE_DIR         default /state
 */
import fs from "node:fs";
import path from "node:path";

const OAUTH = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const AUTH_MODE = process.env.GMAIL_AUTH_MODE ?? "oauth";
const VECTOR_BASE = (process.env.GMAIL_VECTOR_URL ?? "http://vector:8080").replace(/\/+$/, "");
const INTERVAL = Number(process.env.GMAIL_POLL_INTERVAL_MS ?? 900_000);
const BACKFILL_DAYS = Number(process.env.GMAIL_BACKFILL_DAYS ?? 90);
const BACKFILL_CHUNK_DAYS = Math.max(1, Number(process.env.GMAIL_BACKFILL_CHUNK_DAYS ?? 30));
const BACKFILL_BUDGET_MS = Number(process.env.GMAIL_BACKFILL_BUDGET_MS ?? 600_000);
const BACKFILL_QUERY_EXTRA = process.env.GMAIL_BACKFILL_QUERY_EXTRA ?? "";
const CONCURRENCY = Math.max(1, Number(process.env.GMAIL_FETCH_CONCURRENCY ?? 4));
const RESYNC_DAYS = Number(process.env.GMAIL_RESYNC_DAYS ?? 7);
const QUERY_EXTRA = process.env.GMAIL_QUERY_EXTRA ?? "-in:chats";
const BODY_CAP = Number(process.env.GMAIL_BODY_CAP ?? 50_000);
const DROP_AUTH = (process.env.GMAIL_DROP_AUTH ?? "1") !== "0";
const STATE_DIR = process.env.GMAIL_STATE_DIR ?? "/state";
const STATE_FILE = path.join(STATE_DIR, "gmail-poller.json");
const LIST_PAGE = 500; // messages.list maxResults cap
const FLUSH = 200; // messages per Vector POST — bounded memory, like github pages

// Per-mailbox sync cursor, keyed by the credential (MailboxHandle.key), NOT the
// email — so a disconnect+reconnect (new token → new key) does a fresh backfill
// instead of resuming incrementally and skipping mail from the gap.
interface AccountState {
  historyId?: string; // cursor for users.history.list
  backfilled?: boolean; // the archive walk has reached GMAIL_BACKFILL_DAYS
  // Oldest day the archive walk has covered (YYYY-MM-DD). The walk moves
  // BACKWARDS from today and rewrites this after every chunk, so a restart
  // resumes where it stopped instead of re-pulling years of mail. Absent on a
  // mailbox backfilled by an older build — the walk then restarts from today,
  // which re-fetches the recent window once (idempotent: ReplacingMergeTree).
  backfilledTo?: string;
}
type State = Record<string, AccountState>;

function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveState(s: State): void {
  // tmp + rename: a crash mid-write must not corrupt the cursor (a corrupt file
  // reads as {} and would re-backfill every mailbox from scratch)
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, STATE_FILE);
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
// Gmail's q date operators want YYYY/MM/DD
const gmailDate = (daysBack: number): string => isoDate(new Date(Date.now() - daysBack * 86_400_000)).replace(/-/g, "/");
const slashDate = (iso: string): string => iso.replace(/-/g, "/");

/**
 * The archive walk, as a pure function: the next chunk of history to pull, or
 * null when the walk has reached `horizonDays` back and is done.
 *
 * Why walk BACKWARDS in chunks instead of one `after:<horizon>` list: a lifetime
 * mailbox is ~200k messages, and messages.get is one call each — hours of work.
 * One unbounded pull holds every id in memory, saves no cursor until it finishes,
 * and loses the whole run to a single restart. Walking back a chunk at a time
 * lets the caller checkpoint after each one, so a restart costs one chunk.
 *
 * Newest-first is deliberate: the most useful mail lands in the lake in the first
 * minutes, and the archive fills in behind it.
 *
 * Window edges: Gmail's `after:`/`before:` are day-granular, so consecutive
 * windows SHARE their boundary day rather than abut it. That double-pulls one
 * day per chunk — cheap, and it cannot drop a message to an off-by-one, which
 * a gap silently would (ReplacingMergeTree dedups the overlap).
 */
export function nextBackfillWindow(
  now: Date,
  horizonDays: number,
  chunkDays: number,
  backfilledTo?: string,
): { after: string; before: string } | null {
  const day = 86_400_000;
  const horizon = new Date(now.getTime() - horizonDays * day);
  // No cursor yet (fresh mailbox, or state written by a pre-walk build): start
  // at today and walk back. A mailbox the old code already backfilled re-pulls
  // its recent window once — idempotent, and far safer than assuming a window.
  // An UNPARSEABLE cursor falls back to today for the same reason: re-walking
  // costs time, whereas treating it as "done" would silently skip the archive.
  const parsed = backfilledTo ? new Date(`${backfilledTo}T00:00:00Z`) : now;
  const cursor = Number.isNaN(parsed.getTime()) ? now : parsed;
  if (cursor.getTime() <= horizon.getTime()) return null;
  const step = Math.max(1, chunkDays) * day; // a 0-day chunk would never advance
  const start = new Date(Math.max(cursor.getTime() - step, horizon.getTime()));
  return { after: slashDate(isoDate(start)), before: slashDate(isoDate(cursor)) };
}

/** Map over `items` with at most `limit` in flight, preserving input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/* --------------------------------------------------- auth: MailboxAuth seam */
// A handle to one mailbox: mint a Bearer access token on demand, drop it on 401.
// The rest of the poller only ever sees this — never how the token was obtained.
interface MailboxHandle {
  label: string; // short id for logs before the email is known
  key: string; // stable per-credential state key (survives restarts). A reconnect
  // mints a NEW refresh token → new key → fresh backfill, so mail received during a
  // disconnect gap isn't lost (keying by email would resume incrementally and skip it).
  token(): Promise<string>;
  invalidate(): void; // drop the cached access token (called on 401)
}

/* -- scheme #1: OAuth (per-user refresh tokens) -- */
// Access-token cache PER refresh token (each mailbox mints its own short-lived
// access token from its refresh token).
const tokenCache = new Map<string, { access: string; expiresAt: number }>();

async function oauthAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const cached = tokenCache.get(refreshToken);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.access;
  for (let attempt = 0; attempt < 6; attempt++) {
    let r: Response;
    try {
      r = await fetch(OAUTH, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      await Bun.sleep(2 ** attempt * 1000);
      continue;
    }
    if (r.status === 429 || r.status >= 500) {
      await Bun.sleep(2 ** attempt * 1000);
      continue;
    }
    if (!r.ok) {
      // 400/401 = a bad/revoked refresh token — the mailbox owner must reconnect
      throw new Error(`token refresh → ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)} (reconnect in /admin?)`);
    }
    const b = (await r.json()) as { access_token?: string; expires_in?: number };
    if (!b.access_token) throw new Error("token refresh returned no access_token");
    tokenCache.set(refreshToken, { access: b.access_token, expiresAt: Date.now() + (b.expires_in ?? 3600) * 1000 });
    return b.access_token;
  }
  throw new Error("token refresh gave up after retries");
}

// Refresh tokens read FRESH each tick — the UNION of the admin flow's secrets
// file ({accounts:[{refresh_token}]}, plus {refresh_tokens:[…]} / bare […]) AND
// the GMAIL_REFRESH_TOKENS env (CLI/dev), deduped. Union, not file-XOR-env: once
// the admin connects a mailbox the file appears, and an XOR would silently shadow
// every env-seeded mailbox. A corrupt/torn file read falls back to whatever env
// gave us rather than dropping to zero.
function oauthRefreshTokens(): string[] {
  const tokens = new Set<string>();
  for (const t of (process.env.GMAIL_REFRESH_TOKENS ?? process.env.GMAIL_REFRESH_TOKEN ?? "").split(",")) {
    const v = t.trim();
    if (v) tokens.add(v);
  }
  const file = process.env.GMAIL_TOKENS_FILE;
  if (file && fs.existsSync(file)) {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8")) as
        | { accounts?: { refresh_token?: string }[]; refresh_tokens?: unknown[] }
        | unknown[];
      const arr = Array.isArray(j) ? j : (j.accounts?.map((a) => a.refresh_token) ?? j.refresh_tokens ?? []);
      for (const t of arr) {
        const v = String(t ?? "").trim();
        if (v) tokens.add(v);
      }
    } catch {
      /* file present but mid-write/corrupt → keep the env tokens we already have */
    }
  }
  return [...tokens];
}

// Build the list of mailbox handles for this tick. The one place the auth scheme
// is chosen — DWD (scheme #2) becomes another branch returning handles whose
// token() mints an impersonated service-account JWT.
function mailboxHandles(): MailboxHandle[] {
  if (AUTH_MODE === "dwd") {
    // scheme #2 seam: a Workspace service account impersonating each domain user.
    // Enumerate users (explicit list or Directory API) and return one handle each,
    // token() = signed JWT (sub: user) → access_token. Not implemented yet.
    throw new Error("gmail-poller: GMAIL_AUTH_MODE=dwd not implemented yet (scheme #2)");
  }
  const clientId = process.env.GMAIL_CLIENT_ID ?? "";
  const clientSecret = process.env.GMAIL_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) {
    console.error("gmail-poller: GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET not set — set the OAuth client, then connect mailboxes in /admin");
    return [];
  }
  return oauthRefreshTokens().map((rt) => ({
    label: `…${rt.slice(-6)}`,
    // hash (not the raw token) as the state key — no secret in the state file
    key: `oauth:${String(Bun.hash(rt))}`,
    token: () => oauthAccessToken(clientId, clientSecret, rt),
    invalidate: () => tokenCache.delete(rt),
  }));
}

/* ------------------------------------------------------------------- fetch */
/**
 * GET a Gmail API path for one mailbox (via its handle). Throws on failure after
 * retries (a failed fetch must NOT advance the cursor). `notFoundOk` returns null
 * on 404 — used to detect an expired history cursor. A 401 drops the cached access
 * token and retries (a fresh one is minted).
 */
const HARD_RETRIES = 6; // 5xx / auth — a real fault, fail reasonably fast
const RATE_RETRIES = 25; // throttling is EXPECTED under concurrency, not a fault;
// each wait is short (see rateBackoffMs), so a generous budget costs little and
// keeps a busy minute from failing a chunk.

// Throttling is invisible once the backoff absorbs it: the poller just goes
// quietly slow, and "the backfill is taking 13 hours" gives you nothing to act
// on. Count it and report it per chunk, so the logs say whether to turn
// GMAIL_FETCH_CONCURRENCY down (throttled) or leave it alone (just a lot of mail).
let throttleHits = 0;
let throttleMs = 0;
function takeThrottleStats(): string {
  if (!throttleHits) return "";
  const s = ` · throttled ${throttleHits}× (${(throttleMs / 1000).toFixed(0)}s waiting)`;
  throttleHits = 0;
  throttleMs = 0;
  return s;
}

/**
 * Backoff for one retry, in ms. Exponential, capped at 5 min, honouring
 * Retry-After when the server sent one.
 *
 * FULL JITTER is the load-bearing part, not the curve. GMAIL_FETCH_CONCURRENCY
 * calls are in flight at once; a deterministic `2 ** attempt * 1000` makes every
 * throttled call sleep the SAME duration and retry in lockstep — the same
 * thundering herd that produced the 429 — so they re-throttle each other until
 * the shared retry budget is gone. Spreading the wakeups fixes it.
 */
export function backoffMs(attempt: number, retryAfterMs = 0, rand: number = Math.random()): number {
  const exp = Math.min(2 ** Math.min(attempt, 10) * 1000, 5 * 60_000);
  return Math.min(Math.max(retryAfterMs, Math.round(exp * (0.5 + rand * 0.5))), 5 * 60_000);
}

/**
 * Backoff for a 429, which is a DIFFERENT problem from a fault and needs a
 * different curve.
 *
 * Gmail's limit is a per-USER-per-SECOND quota: the bucket refills every second,
 * so the correct response to "too fast" is to wait about a second, not to double
 * away from it. Running the fault backoff here measured 2.2 msg/s with 241
 * throttles and 1404s of cumulative sleep per 925-message chunk — the waits, not
 * the quota, were the bottleneck: workers hit 8s/16s/32s sleeps over a budget
 * that had already refilled.
 *
 * So: a short base, a low ceiling, and full jitter (still essential — it is what
 * keeps concurrent workers from retrying in lockstep). This also self-paces the
 * fleet: the more often a worker is throttled, the longer it waits, which is a
 * closed loop that finds the server's actual limit without us configuring it.
 */
export function rateBackoffMs(attempt: number, retryAfterMs = 0, rand: number = Math.random()): number {
  const CEIL = 5_000;
  const exp = Math.min(250 * 2 ** Math.min(attempt, 8), CEIL);
  // Retry-After is authoritative even when it exceeds the ceiling — the server
  // is telling us exactly how long its bucket needs.
  return Math.max(retryAfterMs, Math.round(exp * (0.5 + rand * 0.5)));
}

async function api<T>(h: MailboxHandle, pathAndQuery: string, notFoundOk = false): Promise<T | null> {
  // Two budgets: being throttled is not the same event as the API being broken,
  // and sharing one counter let a burst of 429s exhaust the retries meant for
  // real faults (which is exactly how a whole backfill chunk used to die).
  let hard = 0;
  let throttled = 0;
  for (;;) {
    const token = await h.token();
    const r = await fetch(`${API}${pathAndQuery}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (notFoundOk && r.status === 404) return null;
    if (r.status === 401) {
      h.invalidate(); // force a fresh access token, then retry
      if (++hard > HARD_RETRIES) break;
      continue;
    }
    // 429 rate / 5xx → back off (respect Retry-After if sent)
    if (r.status === 429 || r.status >= 500) {
      const retryAfter = Number(r.headers.get("retry-after") ?? 0) * 1000;
      const rate = r.status === 429;
      const n = rate ? throttled++ : hard++;
      if ((rate ? throttled : hard) > (rate ? RATE_RETRIES : HARD_RETRIES)) break;
      const wait = rate ? rateBackoffMs(n, retryAfter) : backoffMs(n, retryAfter);
      if (rate) {
        throttleHits++;
        throttleMs += wait;
      }
      await Bun.sleep(wait);
      continue;
    }
    // 403 is ambiguous on Gmail: a rate limit (retryable) vs a permission/scope
    // error (permanent). Retry ONLY the rate-limit flavor — a permanent 403 must
    // fail fast, or it burns every backoff (up to 5 min each) and, since tick()
    // polls mailboxes sequentially, stalls every OTHER mailbox behind it.
    if (r.status === 403) {
      const body = await r.text().catch(() => "");
      if (/rateLimitExceeded|userRateLimitExceeded|rate limit|Too Many Requests/i.test(body)) {
        if (throttled++ > RATE_RETRIES) break;
        const wait = rateBackoffMs(throttled - 1);
        throttleHits++;
        throttleMs += wait;
        await Bun.sleep(wait);
        continue;
      }
      throw new Error(`GET ${pathAndQuery} → 403 (permission/scope?) ${body.slice(0, 200)}`);
    }
    if (!r.ok) throw new Error(`GET ${pathAndQuery} → ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
    return (await r.json()) as T;
  }
  throw new Error(`GET ${pathAndQuery} gave up after retries (${hard} fault, ${throttled} throttled)`);
}

/* ------------------------------------------------------------- liveness */
// One beat for the whole poller (all mailboxes), after each tick AND on a fast
// re-beat timer — keeps liveness inside the gateway's 10-minute window even though
// the poll interval (15 min) is longer. The poller beats even with zero mailboxes
// connected (it's healthy, just waiting), so /admin shows it up, not stale.
const BEAT_MS = 4 * 60_000;
const CATCHUP_MS = 30_000; // tick cadence while an archive walk is outstanding
let lastTickOk = false;
let lastBeatDetail = "";
let backfillPending = false;

async function beat(detail: string): Promise<void> {
  try {
    const r = await fetch(`${VECTOR_BASE}/ingest/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: JSON.stringify({ connector: "gmail-poller", detail }) + "\n",
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    console.error(`gmail-poller: heartbeat failed: ${e}`);
  }
}

async function pushToVector(lines: string[]): Promise<void> {
  if (!lines.length) return;
  const r = await fetch(`${VECTOR_BASE}/ingest/gmail/messages`, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: lines.join("\n") + "\n",
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`vector ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
}

/* --------------------------------------------------------- MIME parsing */
const trunc = (s: string, cap: number): string => (s.length > cap ? s.slice(0, cap) + "\n…[truncated]" : s);

const b64urlDecode = (data: string): string => {
  try {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
};

// Strip HTML to rough plain text (fallback when a message has no text/plain part).
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface MimePart {
  mimeType?: string;
  filename?: string;
  headers?: { name?: string; value?: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: MimePart[];
}

// Prefer text/plain anywhere in the tree; else the first text/html, stripped.
function extractBody(payload: MimePart | undefined): string {
  if (!payload) return "";
  const find = (p: MimePart, mime: string): string | null => {
    if (p.mimeType === mime && p.body?.data) return b64urlDecode(p.body.data);
    for (const c of p.parts ?? []) {
      const hit = find(c, mime);
      if (hit != null) return hit;
    }
    return null;
  };
  const plain = find(payload, "text/plain");
  if (plain != null) return plain;
  const html = find(payload, "text/html");
  if (html != null) return htmlToText(html);
  if (payload.body?.data) return b64urlDecode(payload.body.data); // non-multipart
  return "";
}

function hasAttachment(payload: MimePart | undefined): boolean {
  if (!payload) return false;
  const walk = (p: MimePart): boolean => {
    if (p.filename && p.body?.attachmentId) return true; // named + fetched separately = real attachment
    return (p.parts ?? []).some(walk);
  };
  return walk(payload);
}

const header = (headers: { name?: string; value?: string }[] | undefined, name: string): string =>
  headers?.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? "";

// "Display Name <addr@host>" → {name, email}; bare "addr@host" → {name:"", email}
function parseAddress(raw: string): { name: string; email: string } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { name: "", email: raw.trim().toLowerCase() };
}

// Split an address-list header on commas that are NOT inside a quoted display
// name or an <angle-addr> — a naive split on every comma turns
// `"Doe, John" <j@x>, jane@y` into a bogus recipient `"doe`.
function splitAddressList(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  let inAngle = false;
  for (const ch of raw) {
    if (ch === '"' && !inAngle) inQuote = !inQuote;
    else if (ch === "<" && !inQuote) inAngle = true;
    else if (ch === ">" && !inQuote) inAngle = false;
    if (ch === "," && !inQuote && !inAngle) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function parseAddressList(raw: string): string[] {
  if (!raw) return [];
  return splitAddressList(raw)
    .map((s) => parseAddress(s).email)
    .filter(Boolean);
}

// Auth / one-time-code / password mail: high liability, no analytical value.
// Erring toward dropping is intentional (agreed with the operator).
const AUTH_SUBJECT = /verification code|verify your|one[- ]time (code|passcode|password)|security code|reset your password|password reset|sign[- ]in code|log[- ]?in code|otp|two[- ]factor|magic link|confirm your (email|account)/i;
const AUTH_SENDER = /^(no-?reply|do-?not-?reply|security|verify|verification|accounts?|auth|otp)@/i;
function looksLikeAuthMail(fromEmail: string, subject: string): boolean {
  if (AUTH_SUBJECT.test(subject)) return true;
  // a locked-down sender AND a code-ish subject (narrower, to avoid nuking real mail)
  if (AUTH_SENDER.test(fromEmail) && /(code|verify|password|sign[- ]?in|otp)/i.test(subject)) return true;
  return false;
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string; // epoch ms as string
  payload?: MimePart;
}

// Parse a full message into a lake row (JSON line), or null if it's dropped.
function toLine(msg: GmailMessage, account: string, ingestedAt: string): string | null {
  const labels = msg.labelIds ?? [];
  // Enforce the spam/trash exclusion HERE, for every path. messages.list (backfill)
  // excludes SPAM/TRASH by default, but the steady-state history.list path reports
  // newly-arrived mail REGARDLESS of label — so without this, new spam (the highest
  // injection-risk text) would land in the lake on every tick past the first
  // backfill, breaking the safety property the schema/README promise.
  if (labels.includes("SPAM") || labels.includes("TRASH")) return null;
  const h = msg.payload?.headers;
  const from = parseAddress(header(h, "From"));
  const subject = header(h, "Subject");
  if (DROP_AUTH && looksLikeAuthMail(from.email, subject)) return null;
  const receivedMs = Number(msg.internalDate ?? 0);
  return JSON.stringify({
    account,
    message_id: msg.id ?? "",
    thread_id: msg.threadId ?? "",
    received_at: new Date(receivedMs || Date.now()).toISOString(),
    from_email: from.email,
    from_name: trunc(from.name, 1000),
    // cap recipients like every other free-text field — a mass-To message would
    // otherwise serialize an unbounded string into the row.
    to_emails: JSON.stringify(parseAddressList(header(h, "To")).slice(0, 100)),
    subject: trunc(subject, 1000),
    snippet: msg.snippet ?? "",
    body: trunc(extractBody(msg.payload), BODY_CAP),
    labels: JSON.stringify(labels),
    has_attachments: hasAttachment(msg.payload) ? 1 : 0,
    is_bulk: header(h, "List-Unsubscribe") ? 1 : 0,
    ingested_at: ingestedAt,
  });
}

// Fetch each id (format=full) for one mailbox, parse, and flush to Vector in
// bounded batches. Returns rows actually landed (dropped auth mail not counted).
async function fetchAndPush(h: MailboxHandle, ids: string[], account: string, ingestedAt: string): Promise<number> {
  let landed = 0;
  // Fetch a FLUSH-sized slice with CONCURRENCY calls in flight, then push it.
  // Slicing (rather than one mapLimit over every id) keeps peak memory at one
  // batch no matter how many ids a walk chunk returned, exactly as the
  // one-at-a-time version did — the archive walk can hand this tens of
  // thousands of ids.
  for (let i = 0; i < ids.length; i += FLUSH) {
    const lines = await mapLimit(ids.slice(i, i + FLUSH), CONCURRENCY, async (id) => {
      // notFoundOk: a message listed by history.list can be deleted/expunged before
      // we fetch it — a 404 must SKIP it, not throw (a throw aborts the whole tick,
      // the cursor never advances, and every later tick re-404s the same id until the
      // history window ages out — days of a stalled mailbox from one deletion).
      const msg = await api<GmailMessage>(h, `/messages/${id}?format=full`, /* notFoundOk */ true);
      return msg ? toLine(msg, account, ingestedAt) : null;
    });
    const batch = lines.filter((l): l is string => l !== null);
    landed += batch.length;
    await pushToVector(batch);
  }
  return landed;
}

// All message ids matching a query (spam/trash excluded by default).
async function listIds(h: MailboxHandle, query: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ q: query, maxResults: String(LIST_PAGE) });
    if (pageToken) q.set("pageToken", pageToken);
    const d = await api<{ messages?: { id: string }[]; nextPageToken?: string }>(h, `/messages?${q}`);
    for (const m of d?.messages ?? []) ids.push(m.id);
    pageToken = d?.nextPageToken;
  } while (pageToken);
  return ids;
}

// New message ids since a history cursor. Returns null if the cursor has expired
// (Gmail 404s a too-old startHistoryId) so the caller can fall back to a resync.
async function listHistoryIds(h: MailboxHandle, startHistoryId: string): Promise<string[] | null> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded" });
    if (pageToken) q.set("pageToken", pageToken);
    const d = await api<{ history?: { messagesAdded?: { message: { id: string } }[] }[]; nextPageToken?: string }>(
      h,
      `/history?${q}`,
      /* notFoundOk */ true,
    );
    if (d === null) return null; // expired cursor
    for (const x of d.history ?? []) for (const a of x.messagesAdded ?? []) ids.add(a.message.id);
    pageToken = d.nextPageToken;
  } while (pageToken);
  return [...ids];
}

/* ---------------------------------------------------------------- loop */
// Sync ONE mailbox. Mutates `state[h.key]`; throws on any hard failure so the
// caller can keep this mailbox's old cursor and move on to the next.
async function pollMailbox(
  h: MailboxHandle,
  state: State,
  ingestedAt: string,
): Promise<{ account: string; landed: number; mode: string; walking: boolean }> {
  // Identity + current historyId, captured at START so the cursor we store never
  // runs ahead of what we've processed.
  const profile = await api<{ emailAddress?: string; historyId?: string }>(h, "/profile");
  const account = profile?.emailAddress ?? "unknown";
  // State keyed by the credential (h.key), NOT the email: a reconnect mints a new
  // token → new key → this reads as a first run → fresh backfill (no gap-mail lost).
  const startHistoryId = profile?.historyId ?? state[h.key]?.historyId;
  const st: AccountState = state[h.key] ?? {};

  let landed = 0;
  const modes: string[] = [];

  /* -- 1. steady state: what has arrived since the cursor -- */
  // Runs on EVERY tick, including while the archive walk below is still working
  // backwards through years of mail. New mail must never queue behind a
  // multi-hour backfill. A mailbox with no cursor yet skips this: the walk's
  // first chunk starts at today, so its recent mail lands in this same tick.
  if (st.historyId) {
    let ids = await listHistoryIds(h, st.historyId);
    let mode = "incremental";
    if (ids === null) {
      const query = `after:${gmailDate(RESYNC_DAYS)} ${QUERY_EXTRA}`.trim();
      console.error(`gmail-poller: ${account} history cursor expired; resync "${query}"`);
      ids = await listIds(h, query);
      mode = "resync";
    }
    const n = await fetchAndPush(h, ids, account, ingestedAt);
    landed += n;
    modes.push(mode);
    console.error(`gmail-poller: ${account} ${mode} → ${ids.length} new id(s), ${n} landed`);
  }

  // Advance the cursor BEFORE the walk: steady state is done, and the walk that
  // follows can run for the rest of the tick's budget. A crash in there must not
  // cost us this cursor (the walk keeps its own, below).
  if (startHistoryId) st.historyId = startHistoryId;
  state[h.key] = st;
  saveState(state);

  /* -- 2. archive walk: backwards to GMAIL_BACKFILL_DAYS, a chunk at a time -- */
  // Checkpointed after every chunk and bounded by this tick's budget, so a
  // horizon of years is safe: the walk simply resumes next tick, and a restart
  // costs one chunk instead of the whole run.
  const deadline = Date.now() + BACKFILL_BUDGET_MS;
  let chunks = 0;
  for (;;) {
    const w = nextBackfillWindow(new Date(), BACKFILL_DAYS, BACKFILL_CHUNK_DAYS, st.backfilledTo);
    if (!w) break; // reached the horizon — nothing older is wanted
    const query = `after:${w.after} before:${w.before} ${QUERY_EXTRA} ${BACKFILL_QUERY_EXTRA}`.replace(/\s+/g, " ").trim();
    const ids = await listIds(h, query);
    const t0 = Date.now();
    const n = await fetchAndPush(h, ids, account, ingestedAt);
    const secs = (Date.now() - t0) / 1000;
    landed += n;
    chunks++;
    const rate = secs > 0 ? (ids.length / secs).toFixed(1) : "–";
    console.error(
      `gmail-poller: ${account} backfill ${w.after}..${w.before} → ${ids.length} message(s), ${n} landed in ${secs.toFixed(0)}s (${rate}/s)${takeThrottleStats()}`,
    );
    st.backfilledTo = w.after.replace(/\//g, "-");
    state[h.key] = st;
    saveState(state); // checkpoint: a restart resumes HERE, not back at today
    if (Date.now() >= deadline) break;
  }
  if (chunks) modes.push(`backfill×${chunks}`);

  // `backfilled` is DERIVED from the checkpoint, never latched: widening
  // GMAIL_BACKFILL_DAYS on a mailbox an earlier build had already marked done
  // must put it back into "still walking", or the poller would idle out the full
  // poll interval between chunks and take days to pull an archive.
  st.backfilled = nextBackfillWindow(new Date(), BACKFILL_DAYS, BACKFILL_CHUNK_DAYS, st.backfilledTo) === null;
  state[h.key] = st;
  return { account, landed, mode: modes.join("+") || "idle", walking: !st.backfilled };
}

async function tick(): Promise<void> {
  const ingestedAt = new Date().toISOString();
  const handles = mailboxHandles();

  // Idle-but-healthy: no mailboxes connected yet → beat and wait (don't fail).
  if (!handles.length) {
    lastTickOk = true;
    lastBeatDetail = "0 mailboxes connected — connect one in /admin";
    await beat(lastBeatDetail);
    return;
  }

  const state = loadState();
  // Prune cursor entries for mailboxes no longer connected — a disconnect+reconnect
  // mints a new key, so stale keys would otherwise accumulate in the state file
  // forever. Keyed off the CONFIGURED handles (not getProfile success), so a
  // transiently-failing mailbox keeps its cursor.
  const liveKeys = new Set(handles.map((h) => h.key));
  let pruned = false;
  for (const k of Object.keys(state))
    if (!liveKeys.has(k)) {
      delete state[k];
      pruned = true;
    }
  if (pruned) saveState(state);

  let okAccounts = 0;
  let totalLanded = 0;
  let walking = 0;
  const parts: string[] = [];

  for (const h of handles) {
    try {
      const r = await pollMailbox(h, state, ingestedAt);
      saveState(state); // persist per-mailbox: one failing doesn't lose the others' cursors
      okAccounts++;
      totalLanded += r.landed;
      if (r.walking) walking++;
      parts.push(`${r.account}:${r.landed}`);
    } catch (e) {
      // fetch/token failure for this mailbox: its cursor stays put, re-covered next
      // tick. An archive walk keeps every chunk it checkpointed before the failure.
      console.error(`gmail-poller: mailbox ${h.label} failed (cursor kept): ${e}`);
      // A mailbox that threw may still owe us history; keep the fast cadence so it
      // retries soon rather than idling out the full poll interval.
      if (!state[h.key]?.backfilled) walking++;
    }
  }

  lastTickOk = okAccounts > 0;
  if (lastTickOk) {
    const still = walking ? ` · ${walking} backfilling` : "";
    lastBeatDetail = `${okAccounts}/${handles.length} mailbox(es) · ${totalLanded} msg${parts.length ? ` (${parts.join(", ")})` : ""}${still}`;
    await beat(lastBeatDetail);
  }
  backfillPending = walking > 0;
}

async function main(): Promise<void> {
  console.error(`gmail-poller: auth=${AUTH_MODE}, polling every ${INTERVAL}ms → ${VECTOR_BASE}/ingest/gmail/messages (backfill ${BACKFILL_DAYS}d)`);
  setInterval(() => {
    if (lastTickOk) void beat(lastBeatDetail);
  }, BEAT_MS);
  for (;;) {
    try {
      await tick();
    } catch (e) {
      lastTickOk = false;
      console.error(`gmail-poller: tick failed: ${e}`);
    }
    // An outstanding archive walk gets back-to-back ticks (it already spent its
    // per-tick budget, so this is a pause, not a busy loop): at the 15-minute
    // steady cadence a multi-year horizon would take days of wall clock. Once
    // the walk reaches the horizon this settles to INTERVAL forever.
    await Bun.sleep(backfillPending ? Math.min(INTERVAL, CATCHUP_MS) : INTERVAL);
  }
}

if (import.meta.main) void main();
