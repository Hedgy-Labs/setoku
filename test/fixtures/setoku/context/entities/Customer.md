---
name: Customer
table: public.customers
summary: A shopper account; soft-deleted via deleted_at.
keywords: [shopper, account, user, buyer]
---

## Semantics

One row per shopper. `deleted_at IS NOT NULL` means the account is soft-deleted and must be excluded from counts.

## Joins

orders.customer_id → customers.id

## Sources

- src/models/customer.ts:12
