---
name: revenue
summary: Recognized revenue — paid orders only; refunded orders excluded entirely.
keywords: [sales, income, money, earned]
---

## Definition

Sum of orders.total_cents where status = 'paid', divided by 100 for dollars. Refunded orders are excluded entirely (not netted).

## Canonical SQL

```sql
SELECT SUM(total_cents)/100.0 AS revenue_dollars
FROM orders
WHERE status = 'paid';
```

## Sources

- src/billing/reports.ts:14
