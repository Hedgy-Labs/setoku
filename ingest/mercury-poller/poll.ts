#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * Mercury Bank → Setoku ingest bridge (pull-based).
 *
 * Mercury exposes a read-only REST API but no push stream you can self-create
 * (webhooks exist but must be registered in the dashboard and only notify — see
 * README), so we poll, exactly like the Render bridge. Each tick we:
 *   1. snapshot every account's balances  → POST /ingest/mercury/accounts
 *      (deposit accounts from /accounts AND the IO credit card from /credit —
 *      /accounts returns checking/savings only, so the card account is discovered
 *      separately or its per-swipe charges never get fetched)
 *   2. re-fetch a rolling window of transactions → POST /ingest/mercury/transactions
 *      (credit-card swipes come back from the same /account/:id/transactions path
 *      as kind="creditCardTransaction", once we know the credit account's id)
 *
 * Why re-fetch a window instead of only-new (the Render approach): a Mercury
 * transaction is MUTABLE — it moves pending → sent/posted and posted_at fills in
 * later. Append-only would freeze the first observation. So we re-emit recent
 * transactions every tick and the lake table is a ReplacingMergeTree keyed by id
 * (newest observation wins). The first run backfills a longer window.
 *
 * ⚠ Data minimization: account numbers are redacted to the last 4 digits before
 * anything leaves this process; the full PAN is never sent to the lake.
 *
 * Env:
 *   MERCURY_API_TOKEN     "secret-token:mercury_…" (read-only)        [required]
 *   MERCURY_VECTOR_URL    default http://vector:8080  (base; paths appended)
 *   MERCURY_POLL_INTERVAL_MS  default 300000 (5 min — banking isn't sub-minute)
 *   MERCURY_WINDOW_DAYS   steady-state lookback, default 35 (covers settlement)
 *   MERCURY_BACKFILL_DAYS first-run lookback, default 730
 *   MERCURY_STATE_DIR     default /state
 */
import fs from "node:fs";
import path from "node:path";

const API = "https://api.mercury.com/api/v1";
const TOKEN = required("MERCURY_API_TOKEN");
const VECTOR_BASE = (process.env.MERCURY_VECTOR_URL ?? "http://vector:8080").replace(/\/+$/, "");
const INTERVAL = Number(process.env.MERCURY_POLL_INTERVAL_MS ?? 300_000);
const WINDOW_DAYS = Number(process.env.MERCURY_WINDOW_DAYS ?? 35);
const BACKFILL_DAYS = Number(process.env.MERCURY_BACKFILL_DAYS ?? 730);
const STATE_DIR = process.env.MERCURY_STATE_DIR ?? "/state";
const STATE_FILE = path.join(STATE_DIR, "mercury-poller.json");
const PAGE = 500;

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`mercury-poller: ${name} is required`);
    process.exit(1);
  }
  return v;
}

interface MercuryAccount {
  id: string;
  name?: string;
  legalBusinessName?: string;
  kind?: string;
  type?: string;
  status?: string;
  accountNumber?: string;
  routingNumber?: string;
  availableBalance?: number;
  currentBalance?: number;
  createdAt?: string;
  [k: string]: unknown;
}
interface MercuryTxn {
  id: string;
  accountId?: string;
  amount?: number;
  status?: string;
  kind?: string;
  counterpartyName?: string;
  counterpartyId?: string;
  mercuryCategory?: string | null;
  generalLedgerCodeName?: string | null;
  note?: string | null;
  bankDescription?: string | null;
  externalMemo?: string | null;
  createdAt?: string;
  postedAt?: string | null;
  estimatedDeliveryDate?: string | null;
  dashboardLink?: string;
  [k: string]: unknown;
}
interface State {
  // Account ids that have had their one-time deep backfill. Tracked PER ACCOUNT
  // (not a single global flag) so an account discovered later — e.g. the credit
  // card, which /accounts never returned — still gets the full backfill instead
  // of only the steady-state window. Absent/legacy state ⇒ everything re-backfills
  // once (idempotent: the txn table is a ReplacingMergeTree keyed by id).
  backfilledAccounts?: string[];
}

function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveState(s: State): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s));
}

async function api<T>(pathAndQuery: string, opts?: { quietStatuses?: number[] }): Promise<T | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${API}${pathAndQuery}`, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (r.status === 429 || r.status >= 500) {
      await Bun.sleep(Number(r.headers.get("retry-after") ?? 2 ** attempt) * 1000);
      continue;
    }
    if (!r.ok) {
      // Some endpoints are legitimately absent for a given account (e.g. /credit on
      // a business with no IO card / no credit scope) — the caller marks those
      // statuses quiet so we don't log a false-alarm error every poll interval.
      if (!opts?.quietStatuses?.includes(r.status)) {
        console.error(`mercury-poller: GET ${pathAndQuery} → ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
      }
      return null;
    }
    return (await r.json()) as T;
  }
  console.error(`mercury-poller: GET ${pathAndQuery} gave up after retries`);
  return null;
}

async function pushToVector(suffix: string, lines: string[]): Promise<void> {
  if (!lines.length) return;
  const r = await fetch(`${VECTOR_BASE}/ingest/mercury/${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: lines.join("\n") + "\n",
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`vector ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
}

/**
 * Liveness beat → Vector (routed to setoku.ingest_heartbeats) — sent only after
 * a clean tick, so a revoked token never reads as alive. Best-effort: a lost
 * beat just reads as quiet until the next tick.
 */
async function beat(detail: string): Promise<void> {
  try {
    const r = await fetch(`${VECTOR_BASE}/ingest/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: JSON.stringify({ connector: "mercury-poller", detail }) + "\n",
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    console.error(`mercury-poller: heartbeat failed: ${e}`);
  }
}

const last4 = (n?: string): string => (n ? n.replace(/\D/g, "").slice(-4) : "");
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

// One "accounts" ingest record. Deposit and credit paths share this so the row
// shape — and, load-bearingly, the PAN redaction — can never drift between them.
// The raw blob is redacted HERE (accountNumber → last4) so the file's guarantee
// ("the full PAN is never sent to the lake") holds on every account path.
function accountLine(
  snapshotTs: string,
  a: MercuryAccount | MercuryCreditAccount,
  over: { name: string; legalBusinessName: string; kind: string; type: string; routingNumber: string },
): string {
  const l4 = last4((a as MercuryAccount).accountNumber);
  const redacted = { ...a, accountNumber: l4 || undefined };
  return JSON.stringify({
    snapshot_ts: snapshotTs,
    id: a.id,
    name: over.name,
    legal_business_name: over.legalBusinessName,
    kind: over.kind,
    type: over.type,
    status: a.status ?? "",
    account_number_last4: l4,
    routing_number: over.routingNumber,
    available_balance: a.availableBalance ?? 0,
    current_balance: a.currentBalance ?? 0,
    created_at: a.createdAt ?? "",
    raw: JSON.stringify(redacted),
  });
}

async function snapshotAccounts(snapshotTs: string): Promise<MercuryAccount[]> {
  const d = await api<{ accounts: MercuryAccount[] }>(`/accounts`);
  const accounts = d?.accounts ?? [];
  const lines = accounts.map((a) =>
    accountLine(snapshotTs, a, {
      name: a.name ?? "",
      legalBusinessName: a.legalBusinessName ?? "",
      kind: a.kind ?? "",
      type: a.type ?? "",
      routingNumber: a.routingNumber ?? "",
    }),
  );
  await pushToVector("accounts", lines);
  return accounts;
}

interface MercuryCreditAccount {
  id: string;
  name?: string;
  status?: string;
  availableBalance?: number;
  currentBalance?: number;
  createdAt?: string;
  [k: string]: unknown;
}

// The IO credit card is NOT in /accounts (deposit accounts only). It lives under
// /credit and its individual charges come back from the same
// /account/:id/transactions path as kind="creditCardTransaction". Returns [] when
// the business has no card or the token lacks scope — 403/404 there is expected,
// not an error, so it's quiet: safe (and silent) for non-credit deploys.
async function snapshotCreditAccounts(snapshotTs: string): Promise<MercuryCreditAccount[]> {
  const d = await api<{ accounts: MercuryCreditAccount[] }>(`/credit`, { quietStatuses: [403, 404] });
  const accounts = d?.accounts ?? [];
  const lines = accounts.map((a) =>
    accountLine(snapshotTs, a, {
      name: a.name ?? "Mercury IO Credit Card",
      legalBusinessName: "",
      kind: "creditCard",
      type: "credit",
      routingNumber: "",
    }),
  );
  await pushToVector("accounts", lines);
  return accounts;
}

async function fetchTxns(accountId: string, start: string): Promise<MercuryTxn[]> {
  const out: MercuryTxn[] = [];
  for (let offset = 0; offset < 100_000; offset += PAGE) {
    const d = await api<{ total?: number; transactions?: MercuryTxn[] }>(
      `/account/${accountId}/transactions?limit=${PAGE}&offset=${offset}&start=${start}`,
    );
    const page = d?.transactions ?? [];
    out.push(...page);
    if (page.length < PAGE) break; // last page
  }
  return out;
}

async function pollTransactions(accountIds: string[], ingestedAt: string): Promise<void> {
  const st = loadState();
  const done = new Set(st.backfilledAccounts ?? []);

  let total = 0;
  let backfilled = false;
  for (const acct of accountIds) {
    // A never-seen account (first run, or the newly discovered credit card) gets
    // the deep backfill; accounts already backfilled get the rolling window.
    const firstTime = !done.has(acct);
    const start = isoDate(new Date(Date.now() - (firstTime ? BACKFILL_DAYS : WINDOW_DAYS) * 86_400_000));
    const txns = await fetchTxns(acct, start);
    const lines = txns.map((t) =>
      JSON.stringify({
        id: t.id,
        account_id: t.accountId ?? acct,
        amount: t.amount ?? 0,
        status: t.status ?? "",
        kind: t.kind ?? "",
        counterparty_name: t.counterpartyName ?? "",
        counterparty_id: t.counterpartyId ?? "",
        mercury_category: t.mercuryCategory ?? "",
        gl_code: t.generalLedgerCodeName ?? "",
        note: t.note ?? "",
        bank_description: t.bankDescription ?? "",
        external_memo: t.externalMemo ?? "",
        created_at: t.createdAt ?? "",
        posted_at: t.postedAt ?? null,
        estimated_delivery: t.estimatedDeliveryDate ?? null,
        dashboard_link: t.dashboardLink ?? "",
        raw: JSON.stringify(t),
        ingested_at: ingestedAt,
      }),
    );
    await pushToVector("transactions", lines);
    total += lines.length;
    if (firstTime) {
      done.add(acct);
      backfilled = true;
    }
  }
  if (backfilled) saveState({ backfilledAccounts: [...done] });
  console.error(`mercury-poller: forwarded ${total} transaction row(s) across ${accountIds.length} account(s)${backfilled ? " (incl. backfill)" : ""}`);
}

async function tick(): Promise<void> {
  const now = new Date().toISOString();
  // Deposit and credit discovery are independent — run them concurrently. Credit
  // is best-effort: a /credit failure must never stall deposit ingestion, so it's
  // isolated and degrades to [] rather than aborting the tick before pollTransactions.
  const [deposit, credit] = await Promise.all([
    snapshotAccounts(now),
    snapshotCreditAccounts(now).catch((e) => {
      console.error(`mercury-poller: credit-account discovery failed (continuing): ${e}`);
      return [] as MercuryCreditAccount[];
    }),
  ]);
  // Deposit accounts are the primary feed; an empty list is the token-scope smell
  // the old guard caught — keep warning on it specifically, not on the merged set.
  if (!deposit.length) console.error("mercury-poller: no deposit accounts returned (token scope?)");
  const ids = [...deposit.map((a) => a.id), ...credit.map((a) => a.id)];
  if (!ids.length) return;
  await pollTransactions(ids, now);
  await beat(`${ids.length} account(s)`);
}

async function main(): Promise<void> {
  console.error(
    `mercury-poller: polling every ${INTERVAL}ms → ${VECTOR_BASE}/ingest/mercury/* ` +
      `(window ${WINDOW_DAYS}d, backfill ${BACKFILL_DAYS}d)`,
  );
  for (;;) {
    try {
      await tick();
    } catch (e) {
      console.error(`mercury-poller: tick failed: ${e}`);
    }
    await Bun.sleep(INTERVAL);
  }
}

if (import.meta.main) void main();
