---
name: sponsorship_revenue
summary: Booked sponsorship revenue — sum of contracted deal value (dollars) by season, excluding proposed deals — plus how far below rate card inventory sells.
keywords: [sponsorship revenue, partnership revenue, sponsor sales, contracted, deals, booked, corporate partners, by season, rate card, discount, below rate card, realization]
links: [SponsorshipDeal, total_revenue]
---

## Definition

Sponsorship is sold as **contracted deals** (not per-game inventory). Booked revenue =
`SUM(sponsorship.deal.contract_value)` (already **dollars**) for closed deals —
`status IN ('signed','active','expired')`; **exclude `'proposed'`** (not yet closed).

## Canonical SQL

```sql
SELECT d.season_yr,
       count(*)               AS deals,
       SUM(d.contract_value)  AS booked_dollars
FROM sponsorship.deal d
WHERE d.status IN ('signed','active','expired')
GROUP BY d.season_yr
ORDER BY d.season_yr;
```

To break a deal into its sold assets (LED, static, digital, activation, radio, promo
nights), use `sponsorship.deal_asset.allocated_value` (what the asset sold for) vs
`rate_card` (its list price).

## How far below rate card we sell (discount / realization)

`allocated_value` is the sold price; `rate_card` is the list. Discount per asset =
`1 - allocated_value / rate_card`. Aggregate at the dollar level (not the average of
per-row ratios), and compare like with like — both columns are per-asset list vs sold.

```sql
SELECT
  SUM(rate_card)                                   AS rate_card_dollars,
  SUM(allocated_value)                             AS sold_dollars,
  1 - SUM(allocated_value) / NULLIF(SUM(rate_card),0) AS avg_discount_off_rate_card
FROM sponsorship.deal_asset da
JOIN sponsorship.deal d USING (deal_id)
WHERE d.status IN ('signed','active','expired');
```

(Closed deals only — `signed`/`active`/`expired`, never `proposed`.)

Expect sold value to sit a bit **below** rate card (a single-digit-to-~25% discount),
never above it.
