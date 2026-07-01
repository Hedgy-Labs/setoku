---
name: season_renewal_rate
summary: Season-ticket-holder renewal rate — share of one season's STH accounts that are STH again the next season. Needs the multi-season ticketing data.
keywords: [renewal, retention, season ticket holder, sth, churn, renew, members, membership, year over year, subscriber, subscribers, subscription, resubscribe, retain]
links: [SeatTxn, TicketingAccount, Event]
---

## Definition

An **STH** for a season = an account holding season-plan seats (`plan_cd IN ('FULL','HALF')`)
in that season (season from `ticketing.event.season_yr`). **Renewal rate** from season N to
N+1 = (accounts that are STH in both N and N+1) ÷ (accounts that are STH in N).

## Canonical SQL

```sql
WITH sth AS (
  SELECT DISTINCT e.season_yr, st.acct_id
  FROM ticketing.seat_txn st
  JOIN ticketing.event e ON e.event_no = st.event_no
  WHERE st.plan_cd IN ('FULL','HALF') AND st.acct_id IS NOT NULL
)
SELECT prev.season_yr            AS from_season,
       prev.season_yr + 1        AS to_season,
       count(*)                  AS sth_prev,
       count(cur.acct_id)        AS renewed,
       count(cur.acct_id)::numeric / count(*) AS renewal_rate
FROM sth prev
LEFT JOIN sth cur
  ON cur.acct_id = prev.acct_id AND cur.season_yr = prev.season_yr + 1
GROUP BY prev.season_yr
ORDER BY prev.season_yr;
```

The earliest season has no prior year to renew from, so it won't appear as a `from_season`
only if a later season exists — interpret each row as "renewal INTO `to_season`."
