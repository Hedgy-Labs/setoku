---
name: Ticket
table: public.tickets
summary: One seat for one game. Has a ticket_type, a lifecycle status, an optional group, the buyer, and listed vs sold price.
keywords: [ticket, tickets, seat, sold, scanned, listed, hold, season ticket, comp, group, price, buyer, sell-through]
---

## Semantics

One row per seat per game.

- **ticket_type**: `season`, `single`, `group`, `premium`, `corporate`, `comp` (free).
- **status** (lifecycle): `hold` → `listed` → `sold` → `scanned`.
  - `scanned` = the fan actually entered (only possible for completed games).
  - `sold` on a completed game = sold but never scanned (a no-show).
  - `listed`/`hold` = unsold inventory.
- **comp** tickets are free: `sold_price_cents = 0`. Exclude them from revenue.
- **group_id** is non-null when the seat was bought as part of a group/corporate block (seats sharing a `group_id` were one sale).
- **listed_price_cents** vs **sold_price_cents**: dynamic pricing means the sold price often differs from the listed price. `sold_price_cents` is NULL until sold.
- **price_updated_by** is the staff member (or `system-dynamic-pricing`) who last set the price.

## Joins

`game_id` → `games.game_id`. `buyer_fan_id` → `fans.fan_id` (NULL for unsold seats).
