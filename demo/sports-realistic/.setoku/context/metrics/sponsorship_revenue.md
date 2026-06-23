---
name: sponsorship_revenue
summary: Booked sponsorship revenue — sum of contracted deal value (dollars) by season, excluding proposed (not-yet-closed) deals.
keywords: [sponsorship revenue, partnership revenue, sponsor sales, contracted, deals, booked, corporate partners, by season]
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
nights), use `sponsorship.deal_asset.allocated_value` (the portion of the contract
attributed to each asset); `rate_card` is the list price for comparison.
