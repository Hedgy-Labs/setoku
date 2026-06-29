---
name: total_revenue
summary: Total club revenue per season — media rights + ticketing + F&B + sponsorship + merch, combined across systems with correct units (ticketing is cents, the rest dollars). Lands ~$180–200M/season.
keywords: [total revenue, total income, all revenue, how much money do we make, annual revenue, club revenue, top line, combined revenue, revenue by source]
links: [media_rights_revenue, ticket_revenue, fnb_per_cap, sponsorship_revenue, MerchAndMarketing, MediaRights]
---

## Definition

Total revenue combines every revenue line, each from its own system and in its own unit — so the
**cents-vs-dollars** conversion and the per-system exclusions all matter:

- **media** — `media.rights_deal.annual_value` (dollars). The biggest line — see [[media_rights_revenue]].
- **tickets** — `price_paid_cents`/100 for `SD`/`SC`, ex comps & test accounts — see [[ticket_revenue]].
- **F&B** — `pos.txn.total` (dollars, tax incl.) — see [[fnb_per_cap]].
- **sponsorship** — `contract_value` for closed deals (dollars) — see [[sponsorship_revenue]].
- **merch** — `merch.online_order` (dollars); the team **online store only** (Fanatics/in-venue is
  not in the data), so it's a small **partial** line — see [[gotchas]].

A completed season lands **~$180–200M** total, of which media rights are ~$90M (roughly half).
(The in-progress 2026 season's F&B is partial — only completed games have `pos` rows.)

## Canonical SQL

```sql
WITH rev AS (
  SELECT e.season_yr, SUM(st.price_paid_cents)/100.0 AS dollars       -- tickets (cents → dollars)
  FROM ticketing.seat_txn st
  JOIN ticketing.event e ON e.event_no = st.event_no
  LEFT JOIN ticketing.account a ON a.acct_id = st.acct_id
  WHERE st.status_cd IN ('SD','SC') AND st.price_paid_cents IS NOT NULL
    AND COALESCE(a.acct_type_cd,'') <> 'COMP'
    AND COALESCE(a.acct_email,'') NOT ILIKE '%@bonita.test'
  GROUP BY e.season_yr
  UNION ALL
  SELECT e.season_yr, SUM(t.total)                                    -- F&B (dollars)
  FROM pos.txn t JOIN ticketing.event e ON e.event_no = t.event_no GROUP BY e.season_yr
  UNION ALL
  SELECT season_yr, SUM(contract_value)                              -- sponsorship (dollars, closed)
  FROM sponsorship.deal WHERE status IN ('signed','active','expired') GROUP BY season_yr
  UNION ALL
  SELECT EXTRACT(YEAR FROM order_ts)::int, SUM(unit_price * qty)      -- merch (dollars, partial)
  FROM merch.online_order GROUP BY 1
  UNION ALL
  SELECT season_yr, SUM(annual_value)                                -- media rights (dollars)
  FROM media.rights_deal GROUP BY season_yr
)
SELECT season_yr, SUM(dollars) AS total_revenue_dollars
FROM rev
WHERE season_yr IN (SELECT DISTINCT season_yr FROM ticketing.event)  -- drop merch's stray off-season tail
GROUP BY season_yr
ORDER BY season_yr;
```

Add a `source` label to each `SELECT` (and `GROUP BY season_yr, source`) to break the total down by
revenue line.
