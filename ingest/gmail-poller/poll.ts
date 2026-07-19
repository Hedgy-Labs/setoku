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
 *   GMAIL_BACKFILL_DAYS     first-run lookback, default 90
 *   GMAIL_RESYNC_DAYS       fallback window when a history cursor has expired,
 *                           default 7 (Gmail keeps history records only ~days)
 *   GMAIL_QUERY_EXTRA       appended to the backfill/resync query, default
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
const RESYNC_DAYS = Number(process.env.GMAIL_RESYNC_DAYS ?? 7);
const QUERY_EXTRA = process.env.GMAIL_QUERY_EXTRA ?? "-in:chats";
const BODY_CAP = Number(process.env.GMAIL_BODY_CAP ?? 50_000);
const DROP_AUTH = (process.env.GMAIL_DROP_AUTH ?? "1") !== "0";
const STATE_DIR = process.env.GMAIL_STATE_DIR ?? "/state";
const STATE_FILE = path.join(STATE_DIR, "gmail-poller.json");
const LIST_PAGE = 500; // messages.list maxResults cap
const FLUSH = 200; // messages per Vector POST — bounded memory, like github pages

// Per-mailbox sync cursor, keyed by the account email in one state file.
interface AccountState {
  historyId?: string; // cursor for users.history.list
  backfilled?: boolean;
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

/* --------------------------------------------------- auth: MailboxAuth seam */
// A handle to one mailbox: mint a Bearer access token on demand, drop it on 401.
// The rest of the poller only ever sees this — never how the token was obtained.
interface MailboxHandle {
  label: string; // short id for logs before the email is known
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

// Refresh tokens read FRESH each tick. The admin flow's secrets file is
// authoritative when present (accepting the {accounts:[{refresh_token}]} it
// writes, plus {refresh_tokens:[…]} and a bare […] for the CLI); when the file
// doesn't exist yet, fall back to the GMAIL_REFRESH_TOKENS env (CLI/dev path).
function oauthRefreshTokens(): string[] {
  const file = process.env.GMAIL_TOKENS_FILE;
  if (file && fs.existsSync(file)) {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8")) as
        | { accounts?: { refresh_token?: string }[]; refresh_tokens?: unknown[] }
        | unknown[];
      const arr = Array.isArray(j) ? j : (j.accounts?.map((a) => a.refresh_token) ?? j.refresh_tokens ?? []);
      return arr.map(String).map((t) => t.trim()).filter(Boolean);
    } catch {
      return []; // file present but corrupt → no mailboxes (don't silently use stale env)
    }
  }
  return (process.env.GMAIL_REFRESH_TOKENS ?? process.env.GMAIL_REFRESH_TOKEN ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
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
async function api<T>(h: MailboxHandle, pathAndQuery: string, notFoundOk = false): Promise<T | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const token = await h.token();
    const r = await fetch(`${API}${pathAndQuery}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (notFoundOk && r.status === 404) return null;
    if (r.status === 401) {
      h.invalidate(); // force a fresh access token, then retry
      continue;
    }
    // 429 rate / 403 usageLimits / 5xx → back off (respect Retry-After if sent)
    if (r.status === 429 || r.status === 403 || r.status >= 500) {
      const retryAfter = Number(r.headers.get("retry-after") ?? 0) * 1000;
      await Bun.sleep(Math.min(Math.max(retryAfter, 2 ** attempt * 1000), 5 * 60_000));
      continue;
    }
    if (!r.ok) throw new Error(`GET ${pathAndQuery} → ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
    return (await r.json()) as T;
  }
  throw new Error(`GET ${pathAndQuery} gave up after retries`);
}

/* ------------------------------------------------------------- liveness */
// One beat for the whole poller (all mailboxes), after each tick AND on a fast
// re-beat timer — keeps liveness inside the gateway's 10-minute window even though
// the poll interval (15 min) is longer. The poller beats even with zero mailboxes
// connected (it's healthy, just waiting), so /admin shows it up, not stale.
const BEAT_MS = 4 * 60_000;
let lastTickOk = false;
let lastBeatDetail = "";

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

function parseAddressList(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
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
    to_emails: JSON.stringify(parseAddressList(header(h, "To"))),
    subject: trunc(subject, 1000),
    snippet: msg.snippet ?? "",
    body: trunc(extractBody(msg.payload), BODY_CAP),
    labels: JSON.stringify(msg.labelIds ?? []),
    has_attachments: hasAttachment(msg.payload) ? 1 : 0,
    is_bulk: header(h, "List-Unsubscribe") ? 1 : 0,
    ingested_at: ingestedAt,
  });
}

// Fetch each id (format=full) for one mailbox, parse, and flush to Vector in
// bounded batches. Returns rows actually landed (dropped auth mail not counted).
async function fetchAndPush(h: MailboxHandle, ids: string[], account: string, ingestedAt: string): Promise<number> {
  let landed = 0;
  let batch: string[] = [];
  for (const id of ids) {
    const msg = await api<GmailMessage>(h, `/messages/${id}?format=full`);
    if (!msg) continue;
    const line = toLine(msg, account, ingestedAt);
    if (!line) continue;
    batch.push(line);
    landed++;
    if (batch.length >= FLUSH) {
      await pushToVector(batch);
      batch = [];
    }
  }
  await pushToVector(batch);
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
// Sync ONE mailbox. Mutates `state[account]`; throws on any hard failure so the
// caller can keep this mailbox's old cursor and move on to the next.
async function pollMailbox(h: MailboxHandle, state: State, ingestedAt: string): Promise<{ account: string; landed: number; mode: string }> {
  // Identity + current historyId, captured at START so the cursor we store never
  // runs ahead of what we've processed.
  const profile = await api<{ emailAddress?: string; historyId?: string }>(h, "/profile");
  const account = profile?.emailAddress ?? "unknown";
  const startHistoryId = profile?.historyId ?? state[account]?.historyId;
  const st: AccountState = state[account] ?? {};

  let landed = 0;
  let mode: string;

  if (!st.backfilled || !st.historyId) {
    const query = `after:${gmailDate(BACKFILL_DAYS)} ${QUERY_EXTRA}`.trim();
    const ids = await listIds(h, query);
    console.error(`gmail-poller: ${account} backfill "${query}" → ${ids.length} message(s)`);
    landed = await fetchAndPush(h, ids, account, ingestedAt);
    mode = "backfill";
  } else {
    let ids = await listHistoryIds(h, st.historyId);
    if (ids === null) {
      const query = `after:${gmailDate(RESYNC_DAYS)} ${QUERY_EXTRA}`.trim();
      console.error(`gmail-poller: ${account} history cursor expired; resync "${query}"`);
      ids = await listIds(h, query);
      mode = "resync";
    } else {
      mode = "incremental";
    }
    landed = await fetchAndPush(h, ids, account, ingestedAt);
    console.error(`gmail-poller: ${account} ${mode} → ${ids.length} new id(s), ${landed} landed`);
  }

  if (startHistoryId) st.historyId = startHistoryId;
  st.backfilled = true;
  state[account] = st;
  return { account, landed, mode };
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
  let okAccounts = 0;
  let totalLanded = 0;
  const parts: string[] = [];

  for (const h of handles) {
    try {
      const r = await pollMailbox(h, state, ingestedAt);
      saveState(state); // persist per-mailbox: one failing doesn't lose the others' cursors
      okAccounts++;
      totalLanded += r.landed;
      parts.push(`${r.account}:${r.landed}`);
    } catch (e) {
      // fetch/token failure for this mailbox: its cursor stays put, re-covered next tick
      console.error(`gmail-poller: mailbox ${h.label} failed (cursor kept): ${e}`);
    }
  }

  lastTickOk = okAccounts > 0;
  if (lastTickOk) {
    lastBeatDetail = `${okAccounts}/${handles.length} mailbox(es) · ${totalLanded} msg${parts.length ? ` (${parts.join(", ")})` : ""}`;
    await beat(lastBeatDetail);
  }
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
    await Bun.sleep(INTERVAL);
  }
}

if (import.meta.main) void main();
