# First-party structured events (task 3.5)

The high-grade ore. Platform request logs tell you *that* something happened;
your application telling Setoku `pairing_created` is worth a thousand log
lines. POST deliberate business events to the lake; they land in
`setoku.app_events`, durable and queryable on insert.

## Contract

`POST https://setoku.<domain>/ingest/events` with
`Authorization: Bearer <SETOKU_INGEST_TOKEN>`, body = one JSON object per line
(NDJSON; a single object works too):

| field | type | required | meaning |
|---|---|---|---|
| `event_name` | string | yes | snake_case verb-phrase, e.g. `order_placed`. Events without it are kept but flagged `_invalid`. |
| `ts` | string | yes, for retry dedupe | RFC3339 event time. Without it the lake stamps *receive* time — which differs per retry attempt, so **retried ts-less events become duplicates**. The snippet below always sends it. |
| `actor` | string | recommended | who/what caused it: user id, job name, system. |
| `properties` | object | optional | the payload; queried with `JSONExtract*()`. |
| `event_id` | string | optional | idempotency key. If absent, a content hash is derived. Supply your own if two genuinely distinct events could share name+ts+payload. |

Delivery is at-least-once friendly **when the payload carries `ts`**: the
table is a `ReplacingMergeTree` keyed on `(event_name, ts, event_id)`, so
send-with-retry is the *correct* client behavior, not a hazard — the retry
collapses into the original row.

## Client snippet (~20 lines, no SDK)

```ts
const SETOKU_URL = process.env.SETOKU_EVENTS_URL!; // https://setoku.example.com/ingest/events
const SETOKU_TOKEN = process.env.SETOKU_INGEST_TOKEN!;

export async function track(
  event_name: string,
  actor: string,
  properties: Record<string, unknown> = {},
) {
  const body = JSON.stringify({
    event_name,
    actor,
    properties,
    ts: new Date().toISOString(),
    event_id: crypto.randomUUID(),
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(SETOKU_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${SETOKU_TOKEN}`, "content-type": "application/json" },
        body,
      });
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
  }
  console.warn(`setoku track failed: ${event_name}`); // never break the request path over telemetry
}
```

Usage: `track("order_placed", userId, { order_id, total_cents })` — fire and
forget (`void track(...)` or queue it); analytics must never block or crash the
caller.

## Querying

```sql
-- events per day (exact even before parts merge)
SELECT toDate(ts) AS d, event_name, count(DISTINCT event_id) AS n
FROM setoku.app_events
GROUP BY d, event_name
ORDER BY d DESC, n DESC
```
