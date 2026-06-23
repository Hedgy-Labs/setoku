---
name: gameday_labor_cost
summary: Actual gameday labor cost — hourly wage times clocked hours, for completed shifts.
keywords: [labor cost, gameday labor, staffing cost, payroll gameday, hours worked, wages, overtime]
---

## Definition

For **completed** shifts, actual hours = `clock_out - clock_in`; cost = hourly wage × hours.
Use the clock fields (not the schedule) for actual cost.

## Canonical SQL

```sql
SELECT
  SUM(hourly_wage_cents
      * EXTRACT(EPOCH FROM (clock_out - clock_in)) / 3600.0) / 100.0
    AS gameday_labor_cost_dollars
FROM staffing
WHERE status = 'completed';
```

For scheduled (upcoming) cost, use `scheduled_end - scheduled_start` and `status = 'upcoming'`.
