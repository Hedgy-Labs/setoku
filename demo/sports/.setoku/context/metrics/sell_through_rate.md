---
name: sell_through_rate
summary: Sell-through — share of seats sold (sold or scanned) out of all seats in the manifest, per game or overall.
keywords: [sell-through, sellthrough, fill rate, capacity, percent sold, occupancy, seats sold, paid attendance]
---

## Definition

Sold seats ÷ total seats. A seat counts as sold when `status IN ('sold','scanned')`.
Every seat in the manifest is a row (including unsold `listed`/`hold`), so the denominator is `COUNT(*)`.

## Canonical SQL

```sql
SELECT
  g.game_id, g.game_date, g.opponent,
  COUNT(*) FILTER (WHERE t.status IN ('sold','scanned'))::numeric
    / COUNT(*) AS sell_through
FROM tickets t
JOIN games g USING (game_id)
GROUP BY g.game_id, g.game_date, g.opponent
ORDER BY sell_through DESC;
```
