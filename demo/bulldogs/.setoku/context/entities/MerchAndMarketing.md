---
name: MerchAndMarketing
table: merch.online_order
summary: Merch online orders (PARTIAL — team online store only; in-venue/retail is Fanatics, not present) and marketing.ad_spend (per-platform spend, no sales attribution). Dollars.
keywords: [merch, merchandise, store, online order, fanatics, marketing, ad spend, campaign, channel, platform, cpm, roi, jersey, hat]
links: [identity_resolution, total_revenue]
---

## Semantics

Two unrelated systems, both in **dollars**:

- **merch.online_order** — the team's **online** store only. Most merchandise (in-venue +
  retail) is run by a third party (Fanatics) and is **not in this database**. Never report
  this as total merch revenue — it's a partial channel. `email` links to a fan via
  normalized email ([[identity_resolution]]).
- **marketing.ad_spend** — one row per campaign spend line per platform
  (`google|meta|tv|radio|ooh|email`), per `season_yr`. `spend`, `impressions`, `clicks`
  (NULL for non-clickable), `reach`. There is **no attribution** to ticket/merch sales —
  don't infer revenue causation from spend.
