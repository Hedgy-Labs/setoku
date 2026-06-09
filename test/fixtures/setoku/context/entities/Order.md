---
name: Order
table: public.orders
summary: A customer purchase; the grain of revenue.
keywords: [purchase, sale, checkout, revenue]
---

## Semantics

status: 'pending' (not yet charged), 'paid' (charged), 'refunded' (charged then reversed). Amounts are integer cents in total_cents.

## Joins

customer_id → customers.id. One order : many order_items.

## Sources

- src/billing/charge.ts:88
