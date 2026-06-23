---
name: concession_revenue
summary: Food & beverage revenue and gross margin from concession sales (completed games only). Stored in cents.
keywords: [concession revenue, food and beverage, fb sales, fb revenue, margin, per cap, per capita spend]
---

## Definition

Revenue = `SUM(unit_price_cents * quantity)`. Gross margin = `SUM((unit_price_cents - unit_cost_cents) * quantity)`.
Only completed games have concession rows.

## Canonical SQL

```sql
SELECT
  SUM(unit_price_cents * quantity) / 100.0                      AS fb_revenue_dollars,
  SUM((unit_price_cents - unit_cost_cents) * quantity) / 100.0  AS fb_gross_margin_dollars
FROM concessions;
```

**Per-cap** (per-attendee F&B spend) = F&B revenue for a game ÷ that game's `paid_attendance`.
