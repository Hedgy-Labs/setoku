---
name: Concession
table: public.concessions
summary: A food & beverage sale at a ballpark stand during a game. Has list vs cost price, payment method, and an optional fan tie.
keywords: [concession, concessions, food, beverage, fb, f&b, stand, hot dog, beer, alcohol, sales, payment, margin]
---

## Semantics

One row per concession sales transaction. **Only completed games have concession rows** — sales
happen at the game.

- **category**: `food`, `beverage`, `alcohol`, `dessert`.
- `unit_price_cents` (list) vs `unit_cost_cents` (cost) × `quantity` → gross margin.
- **payment_method**: `card`, `cash`, `mobile`.
- `fan_id` ties the sale to a known fan when paid by a recognized card/mobile; it is **NULL for cash**
  and for unmatched cards.
- `stand_location` is the physical stand within the ballpark.

## Joins

`game_id` → `games.game_id`. `fan_id` → `fans.fan_id` (nullable).
