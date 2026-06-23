---
name: ticket_revenue
summary: Ticket revenue from the ticketing system — sum of price_paid for SOLD/SCANNED seats (in cents), excluding refunds, exchanges, comps, and test accounts.
keywords: [ticket revenue, ticket sales, gate revenue, tickets sold, income, by season]
---

## Definition

Sum of `price_paid_cents` for seats that really sold — `status_cd IN ('SD','SC')` — divided
by 100 for dollars. Exclude refunds (`RF`), exchanges (`XCH`), unsold (`LS`/`HD`), comps,
and test accounts. Ticketing money is in **cents**.

## Canonical SQL

```sql
SELECT e.season_yr,
       SUM(st.price_paid_cents) / 100.0 AS ticket_revenue_dollars
FROM ticketing.seat_txn st
JOIN ticketing.event   e ON e.event_no = st.event_no
LEFT JOIN ticketing.account a ON a.acct_id = st.acct_id
WHERE st.status_cd IN ('SD','SC')
  AND st.price_paid_cents IS NOT NULL
  AND COALESCE(a.acct_type_cd,'') <> 'COMP'
  AND COALESCE(a.acct_email,'') NOT ILIKE '%@stags.test'
GROUP BY e.season_yr
ORDER BY e.season_yr;
```

Drop the `GROUP BY` for an all-time total; add `e.event_no` to go per game.
