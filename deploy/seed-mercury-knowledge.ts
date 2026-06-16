// SPDX-License-Identifier: Apache-2.0
// One-off: seed curated finance/Mercury context into the deployed box store so
// the analyst knows the Mercury bank data lives in the lake (ClickHouse) and how
// to query it. Without this, find_context returns nothing for spend/finance
// questions and the agent wrongly concludes Setoku has no finance data.
//
// Run inside the server container:
//   docker cp deploy/seed-mercury-knowledge.ts setoku-server-1:/app/seed.ts
//   docker exec setoku-server-1 bun /app/seed.ts
import { KnowledgeStore } from "./gateway/lib/store";

const store = new KnowledgeStore(process.env.SETOKU_DB_PATH ?? "/data/knowledge.db");
const USER = "deploy-curated-context";

type Seed = {
  type: "overview" | "entity" | "metric" | "gotcha";
  name: string;
  meta?: Record<string, unknown>;
  body: string;
};

const FINANCE_KEYWORDS = [
  "spend", "spending", "cost", "costs", "expense", "expenses", "vendor", "vendors",
  "payroll", "burn", "burnrate", "runway", "cash", "finance", "finances", "financial",
  "mercury", "bank", "banking", "budget", "outflow", "outgoing", "payment", "payments",
  "infrastructure", "infra", "invoice", "bill", "bills", "wire", "ach", "card",
];

const docs: Seed[] = [
  {
    type: "overview",
    name: "company-finances-and-spend",
    meta: {
      summary:
        "Where company finances live: spend, costs, vendor/payroll/infra payments, cash & runway are in the Mercury bank data in the lake (ClickHouse), NOT the product Postgres.",
      keywords: FINANCE_KEYWORDS,
    },
    body: `Company finances — bank balances, spend, vendor/payroll/infra/card payments — live in the **Mercury** bank data in the Setoku **lake** (ClickHouse), NOT in the product Postgres database.

Query the lake with run_query using dialect: "clickhouse". Tables:
- setoku.mercury_transactions — every bank transaction (spend and income)
- setoku.mercury_accounts — account balance snapshots over time

The product Postgres holds only product/funnel data (companies, pairings, campaigns, intros, billing/revenue state). It has NO payroll, vendor, infra, or card spend — those are only in Mercury. For any "spend / finance / runway / vendor / how much did we pay" question, query the Mercury lake tables above.`,
  },
  {
    type: "entity",
    name: "mercury_transactions",
    meta: {
      table: "mercury_transactions",
      dialect: "clickhouse",
      summary: "Bank transactions (spend & income): vendor payments, card charges, transfers, fees.",
      keywords: FINANCE_KEYWORDS,
    },
    body: `Mercury bank transactions, in the lake (ClickHouse). Query with run_query dialect: "clickhouse" against setoku.mercury_transactions.

Key columns:
- id — transaction id
- account_id — owning Mercury account
- amount (Float64) — SIGNED: negative = money OUT (spend), positive = money IN
- status — pending / sent / failed / cancelled
- kind — externalTransfer, internalTransfer, card, fee, …
- counterparty_name — the vendor/payee (free text)
- mercury_category — Mercury's auto-category (may be empty)
- created_at, posted_at — created vs settled time

⚠ It is a ReplacingMergeTree: query with FINAL so in-flight updates aren't double-counted, e.g. FROM setoku.mercury_transactions FINAL. Spend = -sum(amount) over rows where amount < 0 AND kind != 'internalTransfer' — internal transfers move money between your OWN Mercury accounts and are not spend (counting them inflated last-30d spend by ~29% in a real check).`,
  },
  {
    type: "entity",
    name: "mercury_accounts",
    meta: {
      table: "mercury_accounts",
      dialect: "clickhouse",
      summary: "Bank account balances over time — cash on hand and runway.",
      keywords: ["cash", "balance", "balances", "runway", "account", "accounts", "bank", "funds", "mercury", "finance"],
    },
    body: `Mercury account balance snapshots (a time series; one row per account per poll), in the lake (ClickHouse). Query with run_query dialect: "clickhouse" against setoku.mercury_accounts.

Columns: snapshot_ts, id, name, kind (checking/savings), available_balance, current_balance (USD).

Current balance per account:
  SELECT id, name, argMax(current_balance, snapshot_ts) AS balance
  FROM setoku.mercury_accounts GROUP BY id, name
Total cash on hand = sum of that. Trend current_balance over snapshot_ts for runway.`,
  },
  {
    type: "metric",
    name: "spend_last_30d",
    meta: {
      dialect: "clickhouse",
      summary: "Total outgoing spend over the last 30 days, from Mercury (the lake).",
      keywords: FINANCE_KEYWORDS,
    },
    body: `Total outgoing spend over the last 30 days, from Mercury (the lake). Outflows are negative amount. Canonical SQL (run_query dialect: "clickhouse"):

SELECT round(-sum(amount), 2) AS spend_usd
FROM setoku.mercury_transactions FINAL
WHERE amount < 0
  AND status != 'failed'
  AND kind != 'internalTransfer'   -- exclude money moved between your OWN accounts; it isn't spend
  AND created_at >= now() - INTERVAL 30 DAY

⚠ Gotcha: omitting the kind != 'internalTransfer' filter counts inter-account transfers as spend (verified: it inflated a real last-30d figure by ~29%). For a breakdown, add: , coalesce(nullif(mercury_category,''), counterparty_name) AS category ... GROUP BY category ORDER BY spend_usd DESC. (One nuance to confirm with a human: a payment to your Mercury credit card is a real outflow here, but if you also ingest card-level charges elsewhere, don't count both.)`,
  },
  {
    type: "gotcha",
    name: "finance-and-spend-live-in-mercury-lake",
    body: `Finance/spend/vendor/payroll/runway data is in **Mercury**, in the Setoku lake (ClickHouse) — NOT the product Postgres. For any such question, query setoku.mercury_transactions / setoku.mercury_accounts via run_query with dialect: "clickhouse" (amount is signed; negative = spend). NOTE the two tables use different engines: mercury_transactions is a ReplacingMergeTree — use FINAL. mercury_accounts is a plain MergeTree — do NOT use FINAL (it errors with ILLEGAL_FINAL); use argMax(current_balance, snapshot_ts) for the latest balance per account.

Do NOT answer that Setoku has no finance data, and do NOT suggest connecting external tools (Ramp, Brex, QuickBooks, or Claude's own Mercury connector) — the Mercury data is already here in the lake.

(Applies to: spend, costs, expenses, vendors, payroll, burn rate, runway, cash, budget, infrastructure/infra costs, card charges, wires, invoices.)`,
  },
];

let n = 0;
for (const d of docs) {
  store.upsertDoc({ type: d.type, name: d.name, meta: d.meta ?? {}, body: d.body }, USER);
  n++;
}
store.audit(USER, "seed_context", { batch: "mercury-finance", docs: n });
console.log(`seeded ${n} finance/Mercury docs`);
console.log(
  "store now: " +
    JSON.stringify(
      store
        .listDocs()
        .reduce<Record<string, number>>((a, d) => ((a[d.type] = (a[d.type] ?? 0) + 1), a), {}),
    ),
);
