---
name: ticket_revenue
summary: Ticket revenue — sum of sold price for sold/scanned tickets, excluding free comps. Stored in cents.
keywords: [ticket revenue, ticket sales, gate, revenue, tickets sold, income]
---

## Definition

Sum of `sold_price_cents` for tickets that actually sold (`status IN ('sold','scanned')`),
excluding `comp` (free) tickets. Divide by 100 for dollars.

## Canonical SQL

```sql
SELECT SUM(sold_price_cents) / 100.0 AS ticket_revenue_dollars
FROM tickets
WHERE status IN ('sold', 'scanned')
  AND ticket_type <> 'comp';
```

By game, join `games` and `GROUP BY game_id, game_date, opponent`.
