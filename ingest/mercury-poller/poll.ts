#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * Mercury Bank → Setoku ingest bridge (pull-based).
 *
 * Mercury exposes a read-only REST API but no push stream you can self-create
 * (webhooks exist but must be registered in the dashboard and only notify — see
 * README), so we poll, exactly like the Render bridge. Each tick we:
 *   1. snapshot every account's balances  → POST /ingest/mercury/accounts
 *   2. re-fetch a rolling window of transactions → POST /ingest/mercury/transactions
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
  backfilledThrough?: string; // ISO date we've backfilled from; presence ⇒ steady-state
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

async function api<T>(pathAndQuery: string): Promise<T | null> {
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
      console.error(`mercury-poller: GET ${pathAndQuery} → ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
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

const last4 = (n?: string): string => (n ? n.replace(/\D/g, "").slice(-4) : "");
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

async function snapshotAccounts(snapshotTs: string): Promise<MercuryAccount[]> {
  const d = await api<{ accounts: MercuryAccount[] }>(`/accounts`);
  const accounts = d?.accounts ?? [];
  const lines = accounts.map((a) => {
    // redact the PAN everywhere: typed field AND raw, before it leaves the process
    const redacted = { ...a, accountNumber: last4(a.accountNumber) };
    return JSON.stringify({
      snapshot_ts: snapshotTs,
      id: a.id,
      name: a.name ?? "",
      legal_business_name: a.legalBusinessName ?? "",
      kind: a.kind ?? "",
      type: a.type ?? "",
      status: a.status ?? "",
      account_number_last4: last4(a.accountNumber),
      routing_number: a.routingNumber ?? "",
      available_balance: a.availableBalance ?? 0,
      current_balance: a.currentBalance ?? 0,
      created_at: a.createdAt ?? "",
      raw: JSON.stringify(redacted),
    });
  });
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
  const days = st.backfilledThrough ? WINDOW_DAYS : BACKFILL_DAYS;
  const start = isoDate(new Date(Date.now() - days * 86_400_000));

  let total = 0;
  for (const acct of accountIds) {
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
  }
  if (!st.backfilledThrough) saveState({ backfilledThrough: start });
  console.error(`mercury-poller: forwarded ${total} transaction row(s) from ${start} (${st.backfilledThrough ? "window" : "backfill"})`);
}

async function tick(): Promise<void> {
  const now = new Date().toISOString();
  const accounts = await snapshotAccounts(now);
  if (!accounts.length) {
    console.error("mercury-poller: no accounts returned (token scope?)");
    return;
  }
  await pollTransactions(accounts.map((a) => a.id), now);
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
