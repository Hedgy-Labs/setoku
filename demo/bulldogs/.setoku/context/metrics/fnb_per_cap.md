---
name: fnb_per_cap
summary: Food & beverage per-cap — concession revenue (POS, in dollars) divided by paid/scanned attendance, per game. Completed games only.
keywords: [per cap, per capita, concession revenue, food and beverage, fnb, f&b, pos, spend per fan, beverage]
links: [PosTransaction, Event, total_revenue]
---

## Definition

POS revenue is `pos.txn.total` (already **dollars**, tax included). Per-cap for a game =
that game's F&B revenue ÷ `ticketing.event.gate_attend` (turnstile/scanned count). Only
completed games have POS rows and a non-null `gate_attend`.

## Canonical SQL

```sql
SELECT e.event_no, e.event_dt, e.season_yr, e.gate_attend,
       SUM(t.total)                         AS fnb_revenue_dollars,
       SUM(t.total) / NULLIF(e.gate_attend,0) AS per_cap_dollars
FROM pos.txn t
JOIN ticketing.event e ON e.event_no = t.event_no
GROUP BY e.event_no, e.event_dt, e.season_yr, e.gate_attend
ORDER BY per_cap_dollars DESC;
```

Use `SUM(t.subtotal)` instead of `t.total` if you want F&B revenue **excluding tax**.
Margin needs the line items: `SUM((i.unit_price - i.unit_cost) * i.qty)` from `pos.txn_item`.
