---
name: Staffing
table: public.staffing
summary: One gameday shift for one worker. Scheduled vs actual clock in/out, hourly wage, and whether the game has happened.
keywords: [staffing, staff, shift, gameday, labor, hours, clock in, clock out, wage, ushers, security, schedule]
---

## Semantics

One row per gameday shift per worker.

- **status**: `completed` (game happened — `clock_in`/`clock_out` are populated) or `upcoming`
  (scheduled only — clock fields are NULL).
- `hourly_wage_cents` is the pay rate for that shift.
- **role**: usher, concessions, security, cleaning, ticketing, grounds, guest_services.
- Actual hours come from `clock_out - clock_in`; scheduled hours from `scheduled_end - scheduled_start`.
  They differ (early/late punches) — use the clock fields for actual labor cost.

## Joins

`game_id` → `games.game_id`. `employee_id` → `hr_employees.employee_id` (the gameday workforce).
