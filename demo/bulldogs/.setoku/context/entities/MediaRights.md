---
name: MediaRights
table: media.rights_deal
summary: Broadcast / media-rights contracts — the club's single biggest revenue line (~$90M/yr). One row per rights package per season (regional/RSN, national, streaming, radio). Annual fees in DOLLARS, NOT per-game.
keywords: [media, media rights, broadcast, tv, television, rsn, regional sports network, national, streaming, radio, rights fee, biggest revenue, broadcast revenue, broadcasting, broadcaster, network]
links: [media_rights_revenue, total_revenue]
---

## Semantics

The Bulldogs' broadcast and media-rights deals. This is the **largest single revenue line** for
the club. Money is in **dollars**.

- One row **per rights package per season** (`season_yr`). `annual_value` is the **annual** fee
  for that package — it is **not** per-game and must never be multiplied by games or attendance.
- `rights_type` ∈ {`regional` (the RSN — the bulk), `national`, `streaming`, `radio`}.
- `rightsholder` is the broadcaster/platform; `status` is `active` (current season) or `expired`
  (past seasons). `start_dt`/`end_dt` bound the contract year.
- A season totals **~$80–100M** across its packages, with the regional/RSN deal the largest.

See [[media_rights_revenue]] for the canonical sum, and [[total_revenue]] for how it rolls into
total club revenue.
