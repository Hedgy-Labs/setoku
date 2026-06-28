---
name: overview
summary: Bonita Bulldogs — REAL-WORLD shape. The club's data lives across several disconnected vendor systems (one Postgres schema each), with no shared keys, mixed money units, 3 seasons of history, and real mess (duplicate CRM contacts, dirty emails, refunds, resale, vendor staff, partial merch). Media rights are the single biggest revenue line.
keywords: [overview, what data, source systems, schemas, vendors, ticketing, crm, sponsorship, pos, concessions, merch, hr, marketing, ops, incidents, media, broadcast, how is data organized, where does X live]
links: [Event, SeatTxn, MediaRights, total_revenue, media_rights_revenue, ticket_revenue, fnb_per_cap, sponsorship_revenue, identity_resolution, unique_fans]
---

# Bonita Bulldogs — how the data actually lives

This is the **realistic** model of a pro-baseball club's business data. It is NOT one
tidy database — it's the **separate vendor systems** a real team runs, each landed in
its own Postgres **schema**, with its own IDs and naming. There are **no foreign keys
between systems**; tying a person or a game across them takes real work (see
[[identity_resolution]]).

The Bulldogs play in a 30-team league; each season they face **~22 of the 29 opponents**
(`ticketing.team` is the league dimension; `ticketing.event.opponent_cd` joins to it).

Three seasons of history: 2024, 2025, 2026 (2026 is in progress — games after ~June are upcoming).

## Source systems (schemas)

| Schema | Vendor-style system | Holds | Money unit |
|---|---|---|---|
| `ticketing` | ticketing platform (Archtics/Tickets.com-style) | teams, events, accounts, the seat manifest & sales ledger | **cents** |
| `crm` | Salesforce-style CRM | marketing contact database (duplicates; messy `cs_notes`) | — |
| `sponsorship` | KORE-style | corporate partners, contracted deals, deal assets | **dollars** |
| `pos` | concessions point-of-sale | food & beverage transactions + line items | **dollars** |
| `merch` | team online store feed | online merch orders only (**partial** — see below) | **dollars** |
| `hr` | Workday/ADP-style | workers, comp, gameday shifts | **dollars** |
| `marketing` | ad-platform exports | spend & delivery by platform | **dollars** |
| `ops` | incident-management system | gameday incident log (cleanups, ejections, medical, …) | — |
| `media` | broadcast/media-rights contracts | annual rights fees (RSN, national, streaming, radio) | **dollars** |

The shared business key across systems is `event_no` (in `ticketing.event`, also used by
`pos.txn`, `hr.shift`, and `ops.incident`) and, for people, a **normalized email** (there is
no shared person ID — see [[identity_resolution]]).

**Revenue lines:** `media` rights are the **largest** (~$90M/yr), then ticketing
([[ticket_revenue]]), F&B ([[fnb_per_cap]]), sponsorship ([[sponsorship_revenue]]), and merch
(partial). Total annual revenue lands ~$180–200M — see [[total_revenue]] and
[[media_rights_revenue]].

## Load-bearing caveats (read these before answering)

- **Money units differ BY SYSTEM.** `ticketing` is in integer **cents** (`*_cents`
  columns); every other system is in **dollars** (NUMERIC). Never add across them without
  converting. See [[gotchas]].
- **CRM contacts are not unique per person** — duplicates are common, emails are dirty
  (mixed case, stray spaces, `+tags`). Dedupe by normalized email before counting fans.
- **Linking a person across systems is fuzzy** (email normalization). `pos.loyalty_id`
  is only ~15% populated, so most concession sales can't be tied to a fan.
- **Merch coverage is partial.** `merch.online_order` is only the team's *online* store;
  most merch (in-venue + retail) is run by a third party (Fanatics) and is **not here**.
- **Gameday staff are largely vendor-employed** — `hr.shift.worker_id` is NULL for them
  and they're absent from `hr.worker`, so headcount undercounts the gameday workforce.
- **Test/internal records exist** and must be excluded (`crm.contact.is_test__c`,
  ticketing accounts on `@bonita.test`).
- **Media rights are not per-game.** `media.rights_deal` is one row per rights package per
  season (annual fee, dollars) — never multiply by games or attendance. See [[media_rights_revenue]].
- **Promotional pricing is real.** Some events carry `price_promo_cd` (discounted tickets) or
  `fnb_promo_cd` (e.g. Dollar Dog / $5 beer) — paid price already reflects them. See [[gotchas]].
- **`ops.incident` is operational, not financial.** Counts/severity of gameday incidents;
  completed games only; no money.

Key business metrics with the right SQL: see [[ticket_revenue]], [[season_renewal_rate]],
[[fnb_per_cap]], [[sponsorship_revenue]], [[gameday_labor_cost]], [[unique_fans]],
[[media_rights_revenue]], [[total_revenue]].
