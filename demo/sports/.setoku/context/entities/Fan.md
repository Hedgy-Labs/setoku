---
name: Fan
table: public.fans
summary: A unique fan in the CRM, keyed by email. Demographics plus the payment method on file.
keywords: [fan, fans, customer, crm, email, demographics, favorite player, payment, has children, employer]
---

## Semantics

One row per unique fan, identified by `email` (UNIQUE).

- `payment_brand` + `payment_last4` only — never a full card number.
- `has_children` and `favorite_player` are CRM/marketing attributes (favorite_player can be NULL).
- `employer` may be NULL.

## Joins

`fan_id` is referenced by `tickets.buyer_fan_id` and `concessions.fan_id`.
A fan's concession purchases tie back via card payments (`concessions.fan_id`), so you can connect
food & beverage spend to a known fan when they paid by a recognized card.
