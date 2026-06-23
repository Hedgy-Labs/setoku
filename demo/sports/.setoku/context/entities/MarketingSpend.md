---
name: MarketingSpend
table: public.marketing_spend
summary: One marketing campaign spend line, by channel, with delivery analytics (reach, impressions, CPM, CPC).
keywords: [marketing, campaign, spend, advertising, channel, social, tv, radio, ooh, seo, cpm, cpc, reach, impressions, roi]
---

## Semantics

One row per campaign spend line.

- **channel**: `social`, `seo`, `aeo_geo` (answer/generative-engine optimization), `ooh` (out-of-home / billboards), `radio`, `tv`.
- **objective**: `awareness`, `ticket_sales`, `merch`, `membership`.
- `spend_cents` is the spend; `reach`, `impressions` are delivery; `cpm_cents` = cost per 1000 impressions; `cpc_cents` = cost per click (NULL for non-clickable channels like OOH/radio/TV).
- `start_date` / `end_date` bound the flight.

## Note

This is a spend/delivery table — there is no attribution join to ticket sales in this dataset
(don't infer revenue causation from it).
