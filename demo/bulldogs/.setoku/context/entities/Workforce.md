---
name: Workforce
table: hr.worker
summary: HR workers (employee vs contingent), their comp (hr.comp), and gameday shifts (hr.shift). Gameday staff are largely VENDOR-employed and absent from hr.worker. Dollars.
keywords: [employee, hr, worker, staff, payroll, salary, hourly, comp, shift, gameday labor, vendor, headcount, manager, department, workers, employees, personnel, crew]
links: [gameday_labor_cost, Event]
---

## Semantics

Three tables, money in **dollars**:

- **hr.worker** — `worker_type`: `employee` (front office) or `contingent` (gameday). `mgr_worker_id` builds the org chart; `term_dt` NULL = current. **Gameday roles staffed by a vendor are NOT here.**
- **hr.comp** — current comp per worker. `comp_type='salary'` → `annual_amt` (hourly NULL); `'hourly'` → `hourly_rate` (annual NULL). Don't add the two columns.
- **hr.shift** — one row per gameday shift. `staffed_by`: `team` (has `worker_id`) or `vendor` (`worker_id` NULL). Every shift has a `pay_rate` and clock in/out (NULL for upcoming). Use this for gameday labor cost — see [[gameday_labor_cost]].

Because the gameday workforce is mostly vendor-staffed, `hr.worker` headcount **undercounts** total people working games.
