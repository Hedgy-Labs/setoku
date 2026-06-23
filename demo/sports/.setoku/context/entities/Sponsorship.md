---
name: Sponsorship
table: public.sponsorships
summary: A sellable piece of sponsorship inventory for a game — signage, digital, or activation. Sold, held, or available.
keywords: [sponsorship, sponsor, signage, led, advertising, inventory, partnership, corporate, rate card, sold]
---

## Semantics

One row per sellable piece of sponsorship inventory, per game.

- **inventory_type**: `led_signage`, `static_signage`, `digital`, `event_activation`.
- **location**: `outfield`, `infield`, `behind_home_plate`, `concourse`, `digital`.
- **status**: `available` (unsold), `held` (reserved, not closed), `sold`.
- `rate_card_cents` is the list price; `sold_price_cents` (NULL unless sold) is what the sponsor actually paid — typically below rate card.
- `sponsor_name` is NULL until held/sold; `sold_by` is the partnerships rep.

## Joins

`game_id` → `games.game_id`.
