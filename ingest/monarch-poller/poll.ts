#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * Monarch Money → Setoku ingest bridge (pull-based).
 *
 * Monarch has NO official data API and no push stream. Access is the same
 * private GraphQL endpoint the web app uses (api.monarchmoney.com/graphql),
 * authenticated with a session token minted by an interactive login. So, like
 * the Mercury and Render bridges, we poll. Each tick we fetch:
 *   1. every account + balance snapshot   → POST /ingest/monarch/accounts
 *   2. daily net-worth history (aggregate) → POST /ingest/monarch/networth
 *   3. a rolling window of transactions    → POST /ingest/monarch/transactions
 *   4. monthly budget vs. actual by category → POST /ingest/monarch/budgets
 *
 * Why re-fetch windows instead of only-new: Monarch objects are MUTABLE. A
 * transaction is recategorized, a merchant renamed, a pending charge posts, a
 * day's net worth is revised when an institution back-fills. Append-only would
 * freeze the first observation. So transactions/networth/budgets land in
 * ReplacingMergeTree tables keyed by their natural id with `ingested_at` as the
 * version (newest observation wins). Accounts are an append-only balance
 * time-series (one row per account per tick), same as mercury_accounts.
 *
 * ⚠ Data minimization: `mask` (last-4 of the account) is kept; no full account
 * number is exposed by this API. Free-text (merchant, notes, category) is
 * untrusted user input — treat as such downstream.
 *
 * ⚠ Unofficial & fragile: Monarch moved the API host (monarchmoney.com →
 * monarch.com) in 2026 and can change the schema without notice. MONARCH_API_BASE
 * is overridable so we can repoint without a code change.
 *
 * Auth (one of):
 *   MONARCH_SESSION_ID + MONARCH_CSRFTOKEN   browser session cookies    [preferred]
 *   MONARCH_TOKEN                            "Token <t>" (best-effort fallback)
 * Monarch walls off automated password logins (CAPTCHA / version gate), so the
 * working path is to lift session_id + csrftoken from a logged-in browser — see
 * deploy/set-monarch-cookie.sh and the README.
 *
 * Env:
 *   MONARCH_API_BASE          default https://api.monarchmoney.com
 *   MONARCH_VECTOR_URL        default http://vector:8080  (base; paths appended)
 *   MONARCH_POLL_INTERVAL_MS  default 3600000 (1h — personal finance is daily)
 *   MONARCH_TXN_WINDOW_DAYS   steady-state txn lookback, default 45
 *   MONARCH_TXN_BACKFILL_DAYS first-run txn lookback, default 1095 (3y)
 *   MONARCH_NW_WINDOW_DAYS    steady-state net-worth lookback, default 60
 *   MONARCH_NW_BACKFILL_DAYS  first-run net-worth lookback, default 1825 (5y)
 *   MONARCH_BUDGET_WINDOW_MONTHS   steady-state budget lookback, default 2
 *   MONARCH_BUDGET_BACKFILL_MONTHS first-run budget lookback, default 18
 *   MONARCH_STATE_DIR         default /state
 */
import fs from "node:fs";
import path from "node:path";

const BASE = (process.env.MONARCH_API_BASE ?? "https://api.monarchmoney.com").replace(/\/+$/, "");
const GQL = `${BASE}/graphql`;
// Auth: prefer browser-cookie auth (session_id + csrftoken) — Monarch's login
// endpoint blocks automated password logins (CAPTCHA / "please update"), so the
// working path is to lift a session from a logged-in browser. Token auth is kept
// as a fallback for environments where a Token can still be minted.
const SESSION_ID = process.env.MONARCH_SESSION_ID ?? "";
const CSRFTOKEN = process.env.MONARCH_CSRFTOKEN ?? "";
const TOKEN = process.env.MONARCH_TOKEN ?? "";
const COOKIE_MODE = Boolean(SESSION_ID && CSRFTOKEN);
if (!COOKIE_MODE && !TOKEN) {
  console.error("monarch-poller: set MONARCH_SESSION_ID + MONARCH_CSRFTOKEN (cookie auth) or MONARCH_TOKEN");
  process.exit(1);
}
const VECTOR_BASE = (process.env.MONARCH_VECTOR_URL ?? "http://vector:8080").replace(/\/+$/, "");
const INTERVAL = Number(process.env.MONARCH_POLL_INTERVAL_MS ?? 3_600_000);
const TXN_WINDOW_DAYS = Number(process.env.MONARCH_TXN_WINDOW_DAYS ?? 45);
const TXN_BACKFILL_DAYS = Number(process.env.MONARCH_TXN_BACKFILL_DAYS ?? 1095);
const NW_WINDOW_DAYS = Number(process.env.MONARCH_NW_WINDOW_DAYS ?? 60);
const NW_BACKFILL_DAYS = Number(process.env.MONARCH_NW_BACKFILL_DAYS ?? 1825);
const BUDGET_WINDOW_MONTHS = Number(process.env.MONARCH_BUDGET_WINDOW_MONTHS ?? 2);
const BUDGET_BACKFILL_MONTHS = Number(process.env.MONARCH_BUDGET_BACKFILL_MONTHS ?? 18);
const STATE_DIR = process.env.MONARCH_STATE_DIR ?? "/state";
const STATE_FILE = path.join(STATE_DIR, "monarch-poller.json");
const TXN_PAGE = 100;
// Force an institution sync (the UI's "refresh" button) at the start of each tick,
// then wait for it to finish, so we read fresh balances/transactions rather than
// whatever Monarch last synced on its own. Toggle with MONARCH_FORCE_REFRESH=0.
// Reads are cheap and run every tick; the force-refresh (an institution sync —
// the thing banks rate-limit) fires at most ONCE per day, at REFRESH_HOUR in
// Pacific time. So the loop keeps data current from Monarch's own syncs and
// guarantees one fresh pull a day without hammering the banks.
const FORCE_REFRESH = (process.env.MONARCH_FORCE_REFRESH ?? "1") !== "0";
const REFRESH_HOUR = Number(process.env.MONARCH_REFRESH_HOUR ?? 13); // 1pm, America/Los_Angeles
const REFRESH_TIMEOUT_MS = Number(process.env.MONARCH_REFRESH_TIMEOUT_MS ?? 240_000);
const REFRESH_POLL_MS = Number(process.env.MONARCH_REFRESH_POLL_MS ?? 15_000);
// Loop forever (default) vs. run one tick and exit (MONARCH_RUN_ONCE=1). A
// one-shot always force-refreshes; the loop gates it to REFRESH_HOUR Pacific.
const RUN_ONCE = process.env.MONARCH_RUN_ONCE === "1";
// Align ticks to the top of each hour (vs. a drifting fixed-interval sleep) so
// the daily refresh lands at REFRESH_HOUR:00 (~1pm PT) instead of a phase that
// depends on when the poller last started. Set MONARCH_ALIGN_TO_HOUR=0 for a
// plain INTERVAL loop.
const ALIGN_TO_HOUR = (process.env.MONARCH_ALIGN_TO_HOUR ?? "1") !== "0";
// Minimal client identity matching the confirmed-working monarchmoney-cli.
// NB: do NOT send monarch-client-version — an (old) version header trips
// Monarch's "please update to the latest version" gate. Just a browser UA.
const USER_AGENT =
  process.env.MONARCH_USER_AGENT ??
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`monarch-poller: ${name} is required`);
    process.exit(1);
  }
  return v;
}

interface State {
  backfilled?: boolean; // once true, we've done the deep first-run pull; use steady windows
  lastRefreshDate?: string; // YYYY-MM-DD (Pacific) of the last forced institution refresh
}

// Current hour (0-23) and date (YYYY-MM-DD) in America/Los_Angeles — used to fire
// the daily force-refresh at market close (1pm PT = 4pm ET) regardless of DST.
function pacificNow(): { hour: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const g = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  let hh = Number(g("hour"));
  if (hh === 24) hh = 0; // some ICU builds emit "24" at midnight
  return { hour: hh, date: `${g("year")}-${g("month")}-${g("day")}` };
}

// ms until the next HH:00:05 — top of the hour, +5s to dodge boundary races — so
// hourly ticks land on the clock and the daily refresh fires right at 1:00pm PT.
function msToNextHourTick(): number {
  const now = Date.now();
  const d = new Date(now);
  d.setMinutes(0, 5, 0);
  let next = d.getTime();
  if (next <= now) next += 3_600_000;
  return next - now;
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

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
const daysAgo = (n: number): string => isoDate(new Date(Date.now() - n * 86_400_000));
// first day of the month N months before today (UTC), YYYY-MM-DD
function monthStart(monthsBack: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
  return isoDate(d);
}
// last day of the month N months ahead of today (UTC)
function monthEnd(monthsAhead: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsAhead + 1, 0));
  return isoDate(d);
}

function authHeaders(): Record<string, string> {
  const base: Record<string, string> = {
    "Client-Platform": "web",
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
  if (COOKIE_MODE) {
    // Match the browser/web client the community libraries use for cookie auth.
    return {
      ...base,
      Cookie: `session_id=${SESSION_ID}; csrftoken=${CSRFTOKEN}`,
      "X-Csrftoken": CSRFTOKEN,
      "monarch-client": "web",
      "monarch-client-version": process.env.MONARCH_CLIENT_VERSION ?? "2025.05",
      Origin: "https://app.monarch.com",
      Referer: "https://app.monarch.com/",
    };
  }
  return { ...base, Authorization: `Token ${TOKEN}` };
}

async function gql<T>(operationName: string, query: string, variables: Record<string, unknown> = {}): Promise<T | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    let r: Response;
    try {
      r = await fetch(GQL, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ operationName, query, variables }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (e) {
      await Bun.sleep(2 ** attempt * 1000);
      continue;
    }
    if (r.status === 429 || r.status >= 500) {
      await Bun.sleep(Number(r.headers.get("retry-after") ?? 2 ** attempt) * 1000);
      continue;
    }
    if (r.status === 401 || r.status === 403) {
      console.error(`monarch-poller: ${operationName} → ${r.status} (session expired/rejected? re-run deploy/set-monarch-cookie.sh with fresh cookies)`);
      return null;
    }
    if (!r.ok) {
      console.error(`monarch-poller: ${operationName} → ${r.status} ${(await r.text().catch(() => "")).slice(0, 300)}`);
      return null;
    }
    const body = (await r.json()) as { data?: T; errors?: unknown };
    if (body.errors) {
      console.error(`monarch-poller: ${operationName} GraphQL errors: ${JSON.stringify(body.errors).slice(0, 400)}`);
      return null;
    }
    return body.data ?? null;
  }
  console.error(`monarch-poller: ${operationName} gave up after retries`);
  return null;
}

async function pushToVector(suffix: string, lines: string[]): Promise<void> {
  if (!lines.length) return;
  const r = await fetch(`${VECTOR_BASE}/ingest/monarch/${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: lines.join("\n") + "\n",
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`vector ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
}

// ---------------------------------------------------------------- accounts
const Q_ACCOUNTS = `query GetAccounts {
  accounts { ...AccountFields __typename }
}
fragment AccountFields on Account {
  id displayName syncDisabled deactivatedAt isHidden isAsset mask
  createdAt updatedAt displayLastUpdatedAt currentBalance displayBalance
  includeInNetWorth includeBalanceInNetWorth isManual transactionsCount holdingsCount
  type { name display __typename }
  subtype { name display __typename }
  institution { id name __typename }
  __typename
}`;

interface MonarchAccount {
  id: string;
  displayName?: string;
  isAsset?: boolean;
  isHidden?: boolean;
  isManual?: boolean;
  mask?: string;
  currentBalance?: number;
  displayBalance?: number;
  includeInNetWorth?: boolean;
  includeBalanceInNetWorth?: boolean;
  createdAt?: string;
  updatedAt?: string;
  transactionsCount?: number;
  holdingsCount?: number;
  type?: { name?: string; display?: string };
  subtype?: { name?: string; display?: string };
  institution?: { id?: string; name?: string };
  [k: string]: unknown;
}

async function snapshotAccounts(snapshotTs: string): Promise<MonarchAccount[]> {
  const d = await gql<{ accounts: MonarchAccount[] }>("GetAccounts", Q_ACCOUNTS);
  const accounts = d?.accounts ?? [];
  const lines = accounts.map((a) =>
    JSON.stringify({
      snapshot_ts: snapshotTs,
      id: a.id,
      display_name: a.displayName ?? "",
      type: a.type?.name ?? "",
      type_display: a.type?.display ?? "",
      subtype: a.subtype?.name ?? "",
      institution: a.institution?.name ?? "",
      mask: a.mask ?? "",
      is_asset: a.isAsset ? 1 : 0,
      is_manual: a.isManual ? 1 : 0,
      is_hidden: a.isHidden ? 1 : 0,
      include_in_net_worth: a.includeInNetWorth ?? a.includeBalanceInNetWorth ? 1 : 0,
      current_balance: a.currentBalance ?? 0,
      display_balance: a.displayBalance ?? 0,
      transactions_count: a.transactionsCount ?? 0,
      created_at: a.createdAt ?? "",
      updated_at: a.updatedAt ?? "",
      raw: JSON.stringify(a),
    }),
  );
  await pushToVector("accounts", lines);
  console.error(`monarch-poller: snapshotted ${lines.length} account(s)`);
  return accounts;
}

// ---------------------------------------------------------------- holdings
const Q_HOLDINGS = `query Web_GetHoldings($input: PortfolioInput) {
  portfolio(input: $input) {
    aggregateHoldings {
      edges {
        node {
          id quantity basis totalValue securityPriceChangeDollars securityPriceChangePercent lastSyncedAt
          holdings { id isManual __typename }
          security { id name ticker type typeDisplay currentPrice closingPrice __typename }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`;

interface HoldingNode {
  quantity?: number;
  basis?: number;
  totalValue?: number;
  securityPriceChangeDollars?: number;
  securityPriceChangePercent?: number;
  holdings?: { isManual?: boolean }[];
  security?: { id?: string; name?: string; ticker?: string; type?: string; typeDisplay?: string; currentPrice?: number; closingPrice?: number };
}

// Snapshot the portfolio breakdown (per security) for every investment account.
// Append-only time series, like accounts: latest snapshot = current portfolio.
async function snapshotHoldings(accounts: MonarchAccount[], snapshotTs: string): Promise<void> {
  const brokerage = accounts.filter((a) => (a.holdingsCount ?? 0) > 0);
  if (!brokerage.length) return;
  const today = isoDate(new Date());
  let total = 0;
  for (const acct of brokerage) {
    const d = await gql<{ portfolio: { aggregateHoldings: { edges: { node: HoldingNode }[] } } }>(
      "Web_GetHoldings",
      Q_HOLDINGS,
      { input: { accountIds: [acct.id], startDate: today, endDate: today, includeHiddenHoldings: true } },
    );
    const edges = d?.portfolio?.aggregateHoldings?.edges ?? [];
    const lines = edges.map((e) => {
      const n = e.node;
      const s = n.security ?? {};
      const basis = n.basis ?? 0;
      const value = n.totalValue ?? 0;
      return JSON.stringify({
        snapshot_ts: snapshotTs,
        account_id: acct.id,
        account_name: acct.displayName ?? "",
        security_id: s.id ?? "",
        ticker: s.ticker ?? "",
        name: s.name ?? "",
        type: s.type ?? "",
        type_display: s.typeDisplay ?? "",
        quantity: n.quantity ?? 0,
        value,
        basis,
        gain: value - basis,
        price: s.closingPrice ?? s.currentPrice ?? 0,
        day_change_dollars: n.securityPriceChangeDollars ?? 0,
        day_change_pct: n.securityPriceChangePercent ?? 0,
        is_manual: n.holdings?.[0]?.isManual ? 1 : 0,
        raw: JSON.stringify(n),
      });
    });
    await pushToVector("holdings", lines);
    total += lines.length;
  }
  console.error(`monarch-poller: snapshotted ${total} holding(s) across ${brokerage.length} investment account(s)`);
}

// ---------------------------------------------------------------- net worth
const Q_NETWORTH = `query GetAggregateSnapshots($filters: AggregateSnapshotFilters) {
  aggregateSnapshots(filters: $filters) { date balance __typename }
}`;

async function pollNetWorth(days: number, ingestedAt: string): Promise<void> {
  const start = daysAgo(days);
  const d = await gql<{ aggregateSnapshots: { date: string; balance: number }[] }>("GetAggregateSnapshots", Q_NETWORTH, {
    filters: { startDate: start, endDate: null, accountType: null },
  });
  const snaps = d?.aggregateSnapshots ?? [];
  const lines = snaps.map((s) =>
    JSON.stringify({ date: s.date, balance: s.balance ?? 0, ingested_at: ingestedAt }),
  );
  await pushToVector("networth", lines);
  console.error(`monarch-poller: forwarded ${lines.length} daily net-worth point(s) from ${start}`);
}

// ---------------------------------------------------------------- transactions
const Q_TXNS = `query GetTransactionsList($offset: Int, $limit: Int, $filters: TransactionFilterInput, $orderBy: TransactionOrdering) {
  allTransactions(filters: $filters) {
    totalCount
    results(offset: $offset, limit: $limit, orderBy: $orderBy) { id ...TransactionOverviewFields __typename }
    __typename
  }
}
fragment TransactionOverviewFields on Transaction {
  id amount pending date hideFromReports plaidName notes isRecurring reviewStatus needsReview
  isSplitTransaction createdAt updatedAt
  category { id name __typename }
  merchant { name id __typename }
  account { id displayName __typename }
  tags { id name __typename }
  __typename
}`;

interface MonarchTxn {
  id: string;
  amount?: number;
  pending?: boolean;
  date?: string;
  hideFromReports?: boolean;
  plaidName?: string;
  notes?: string;
  isRecurring?: boolean;
  isSplitTransaction?: boolean;
  needsReview?: boolean;
  createdAt?: string;
  updatedAt?: string;
  category?: { id?: string; name?: string };
  merchant?: { id?: string; name?: string };
  account?: { id?: string; displayName?: string };
  tags?: { name?: string }[];
  [k: string]: unknown;
}

async function pollTransactions(startDate: string, mode: string, ingestedAt: string): Promise<void> {
  const endDate = isoDate(new Date());
  let offset = 0;
  let total = 0;
  for (;;) {
    const d = await gql<{ allTransactions: { totalCount: number; results: MonarchTxn[] } }>("GetTransactionsList", Q_TXNS, {
      offset,
      limit: TXN_PAGE,
      orderBy: "date",
      filters: { search: "", categories: [], accounts: [], tags: [], startDate, endDate },
    });
    const page = d?.allTransactions?.results ?? [];
    if (!page.length) break;
    const lines = page.map((t) =>
      JSON.stringify({
        id: t.id,
        account_id: t.account?.id ?? "",
        account_name: t.account?.displayName ?? "",
        amount: t.amount ?? 0,
        date: t.date ?? "",
        pending: t.pending ? 1 : 0,
        category_id: t.category?.id ?? "",
        category: t.category?.name ?? "",
        merchant: t.merchant?.name ?? "",
        merchant_id: t.merchant?.id ?? "",
        plaid_name: t.plaidName ?? "",
        notes: t.notes ?? "",
        tags: (t.tags ?? []).map((x) => x.name ?? "").filter(Boolean).join(","),
        is_recurring: t.isRecurring ? 1 : 0,
        is_split: t.isSplitTransaction ? 1 : 0,
        needs_review: t.needsReview ? 1 : 0,
        hide_from_reports: t.hideFromReports ? 1 : 0,
        created_at: t.createdAt ?? "",
        updated_at: t.updatedAt ?? "",
        raw: JSON.stringify(t),
        ingested_at: ingestedAt,
      }),
    );
    await pushToVector("transactions", lines);
    total += lines.length;
    offset += page.length;
    const totalCount = d?.allTransactions?.totalCount ?? 0;
    if (offset >= totalCount || page.length < TXN_PAGE) break;
  }
  console.error(`monarch-poller: forwarded ${total} transaction row(s) from ${startDate} (${mode})`);
}

// ---------------------------------------------------------------- budgets
const Q_BUDGETS = `query Common_GetJointPlanningData($startDate: Date!, $endDate: Date!) {
  budgetData(startMonth: $startDate, endMonth: $endDate) {
    monthlyAmountsByCategory {
      category { id __typename }
      monthlyAmounts { month plannedCashFlowAmount actualAmount remainingAmount __typename }
      __typename
    }
    __typename
  }
  categoryGroups {
    id name type
    categories { id name __typename }
    __typename
  }
}`;

interface BudgetData {
  budgetData?: {
    monthlyAmountsByCategory?: {
      category?: { id?: string };
      monthlyAmounts?: { month?: string; plannedCashFlowAmount?: number; actualAmount?: number; remainingAmount?: number }[];
    }[];
  };
  categoryGroups?: { id?: string; name?: string; type?: string; categories?: { id?: string; name?: string }[] }[];
}

async function pollBudgets(monthsBack: number, mode: string, ingestedAt: string): Promise<void> {
  const startDate = monthStart(monthsBack);
  const endDate = monthEnd(1);
  const d = await gql<BudgetData>("Common_GetJointPlanningData", Q_BUDGETS, { startDate, endDate });
  if (!d) return;
  // catId -> {name, group, groupType}
  const cat = new Map<string, { name: string; group: string; groupType: string }>();
  for (const g of d.categoryGroups ?? []) {
    for (const c of g.categories ?? []) {
      if (c.id) cat.set(c.id, { name: c.name ?? "", group: g.name ?? "", groupType: g.type ?? "" });
    }
  }
  const lines: string[] = [];
  for (const mc of d.budgetData?.monthlyAmountsByCategory ?? []) {
    const cid = mc.category?.id ?? "";
    const meta = cat.get(cid);
    for (const m of mc.monthlyAmounts ?? []) {
      // skip empty forward-looking months with no plan and no actual
      const planned = m.plannedCashFlowAmount ?? 0;
      const actual = m.actualAmount ?? 0;
      if (planned === 0 && actual === 0) continue;
      lines.push(
        JSON.stringify({
          month: m.month ?? "",
          category_id: cid,
          category: meta?.name ?? "",
          category_group: meta?.group ?? "",
          group_type: meta?.groupType ?? "",
          planned_amount: planned,
          actual_amount: actual,
          remaining_amount: m.remainingAmount ?? 0,
          ingested_at: ingestedAt,
        }),
      );
    }
  }
  await pushToVector("budgets", lines);
  console.error(`monarch-poller: forwarded ${lines.length} budget row(s) from ${startDate} (${mode})`);
}

// ---------------------------------------------------------------- force refresh
const Q_ACCOUNT_IDS = `query GetAccountIds { accounts { id __typename } }`;
const Q_FORCE_REFRESH = `mutation Common_ForceRefreshAccountsMutation($input: ForceRefreshAccountsInput!) {
  forceRefreshAccounts(input: $input) { success __typename }
}`;
const Q_SYNC_STATUS = `query ForceRefreshAccountsQuery { accounts { id hasSyncInProgress __typename } }`;

// Kick an institution sync for all accounts and wait until none report
// hasSyncInProgress (or we hit the timeout). Best-effort: never throws.
async function forceRefresh(): Promise<void> {
  const d = await gql<{ accounts: { id: string }[] }>("GetAccountIds", Q_ACCOUNT_IDS);
  const ids = (d?.accounts ?? []).map((a) => a.id);
  if (!ids.length) return;
  const r = await gql<{ forceRefreshAccounts: { success: boolean } }>(
    "Common_ForceRefreshAccountsMutation",
    Q_FORCE_REFRESH,
    { input: { accountIds: ids } },
  );
  if (!r?.forceRefreshAccounts?.success) {
    console.error("monarch-poller: force-refresh not accepted; reading last-synced data");
    return;
  }
  console.error(`monarch-poller: requested refresh of ${ids.length} account(s), waiting for sync…`);
  const deadline = Date.now() + REFRESH_TIMEOUT_MS;
  for (;;) {
    await Bun.sleep(REFRESH_POLL_MS);
    const s = await gql<{ accounts: { id: string; hasSyncInProgress: boolean }[] }>("ForceRefreshAccountsQuery", Q_SYNC_STATUS);
    const accts = s?.accounts ?? [];
    const pending = accts.filter((a) => a.hasSyncInProgress).length;
    if (!pending) {
      console.error("monarch-poller: sync complete");
      return;
    }
    if (Date.now() >= deadline) {
      console.error(`monarch-poller: refresh wait timed out with ${pending} account(s) still syncing; reading anyway`);
      return;
    }
  }
}

// ---------------------------------------------------------------- loop
async function tick(): Promise<void> {
  const now = new Date().toISOString();
  const st = loadState();
  const first = !st.backfilled;

  // Force-refresh at most once/day: on a one-shot run always; in the loop, on the
  // first tick at or after REFRESH_HOUR Pacific each day (robust to a missed tick).
  if (FORCE_REFRESH) {
    if (RUN_ONCE) {
      await forceRefresh();
    } else {
      const { hour, date } = pacificNow();
      if (hour >= REFRESH_HOUR && st.lastRefreshDate !== date) {
        await forceRefresh();
        st.lastRefreshDate = date;
        saveState(st);
      }
    }
  }

  const accounts = await snapshotAccounts(now);
  await snapshotHoldings(accounts, now);
  await pollNetWorth(first ? NW_BACKFILL_DAYS : NW_WINDOW_DAYS, now);
  await pollTransactions(first ? daysAgo(TXN_BACKFILL_DAYS) : daysAgo(TXN_WINDOW_DAYS), first ? "backfill" : "window", now);
  await pollBudgets(first ? BUDGET_BACKFILL_MONTHS : BUDGET_WINDOW_MONTHS, first ? "backfill" : "window", now);

  if (first) {
    st.backfilled = true;
    saveState(st);
  }
}

async function main(): Promise<void> {
  if (RUN_ONCE) {
    console.error(`monarch-poller: single run → ${VECTOR_BASE}/ingest/monarch/* (${GQL})`);
    try {
      await tick();
    } catch (e) {
      console.error(`monarch-poller: tick failed: ${e}`);
      process.exit(1);
    }
    console.error("monarch-poller: done");
    return;
  }
  console.error(
    `monarch-poller: polling ${GQL} every ${INTERVAL}ms → ${VECTOR_BASE}/ingest/monarch/* ` +
      `(txn window ${TXN_WINDOW_DAYS}d/backfill ${TXN_BACKFILL_DAYS}d)`,
  );
  for (;;) {
    try {
      await tick();
    } catch (e) {
      console.error(`monarch-poller: tick failed: ${e}`);
    }
    await Bun.sleep(ALIGN_TO_HOUR ? msToNextHourTick() : INTERVAL);
  }
}

if (import.meta.main) void main();
