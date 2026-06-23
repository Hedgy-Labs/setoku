---
name: gameday_labor_cost
summary: Actual gameday labor cost — clocked hours × pay_rate (dollars) from hr.shift, for completed games. Includes both team and vendor staff.
keywords: [labor cost, gameday labor, staffing cost, payroll gameday, hours worked, wages, shifts, vendor staff]
---

## Definition

From `hr.shift`: actual hours = `actual_out - actual_in`; cost = hours × `pay_rate`
(**dollars**). Completed games only (clock fields are NULL otherwise). This covers **both**
team and vendor staff — every shift carries a `pay_rate`, even when `worker_id` is NULL
(vendor-staffed). So labor cost comes from `hr.shift`, NOT from `hr.worker` (which omits
vendor staff entirely).

## Canonical SQL

```sql
SELECT e.season_yr,
       s.staffed_by,
       SUM(s.pay_rate * EXTRACT(EPOCH FROM (s.actual_out - s.actual_in)) / 3600.0) AS labor_cost_dollars
FROM hr.shift s
JOIN ticketing.event e ON e.event_no = s.event_no
WHERE s.actual_in IS NOT NULL AND s.actual_out IS NOT NULL
GROUP BY e.season_yr, s.staffed_by
ORDER BY e.season_yr, s.staffed_by;
```

Drop `s.staffed_by` from `SELECT`/`GROUP BY` for total gameday labor per season.
