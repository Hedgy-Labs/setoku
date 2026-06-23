---
name: sponsorship_sold_value
summary: Sold sponsorship value — sum of sold_price for sold inventory; compare to rate card for discount depth.
keywords: [sponsorship revenue, sponsor sales, partnership revenue, rate card, sold value, discount, sell-through sponsorship]
---

## Definition

Sold value = `SUM(sold_price_cents)` where `status = 'sold'`. Rate-card value of the same rows uses
`rate_card_cents`; the ratio shows discount depth.

## Canonical SQL

```sql
SELECT
  SUM(sold_price_cents) / 100.0  AS sold_value_dollars,
  SUM(rate_card_cents)  / 100.0  AS rate_card_of_sold_dollars,
  SUM(sold_price_cents)::numeric / NULLIF(SUM(rate_card_cents), 0) AS realized_pct
FROM sponsorships
WHERE status = 'sold';
```
