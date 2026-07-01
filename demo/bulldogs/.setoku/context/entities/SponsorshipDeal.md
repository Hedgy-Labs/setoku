---
name: SponsorshipDeal
table: sponsorship.deal
summary: A contracted sponsorship deal (KORE-style) — partner × season, with a contract value (dollars) and assets. Multi-year. Exclude 'proposed' from booked revenue.
keywords: [sponsorship, sponsor, deal, partnership, contract, partner, asset, led, signage, activation, rate card, booked, brands, advertisers, partners, backers, commercial]
links: [sponsorship_revenue, total_revenue]
---

## Semantics

Sponsorship is sold as **contracted deals**, not per-game inventory. Money in **dollars**.

- `sponsorship.deal` — one row per partner per season. `status`: `proposed` (not closed — exclude from booked) · `signed` · `active` · `expired`. `contract_value` is the booked dollars.
- `sponsorship.partner` — the company (`partner_id`, name, industry, account_owner).
- `sponsorship.deal_asset` — what the deal includes (`asset_type`: led/static/digital/activation/radio/promo_night), `rate_card` (list) vs `allocated_value` (portion of the contract attributed to that asset); `units` is the count delivered.

See [[sponsorship_revenue]].
