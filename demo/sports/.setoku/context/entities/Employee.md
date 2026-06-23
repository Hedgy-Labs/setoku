---
name: Employee
table: public.hr_employees
summary: One employee — front office (salaried W2) or gameday workforce (hourly W2 / 1099). Comp, reporting line, tenure.
keywords: [employee, hr, staff, payroll, salary, hourly, 1099, w2, manager, department, headcount, bonus, vacation]
---

## Semantics

One row per employee.

- **worker_type**: `W2` or `1099`.
- `salary_cents` is set for salaried staff (hourly is NULL); `hourly_rate_cents` is set for hourly/gameday staff (salary is NULL). A given employee has one or the other.
- `bonus_cents`, `vacation_days` apply to front-office staff; gameday/1099 are mostly 0.
- `department` includes Executive, Ticketing, Sponsorship, Marketing, Operations, Finance, Retail, People, and **Gameday Staff** (the hourly event workforce).
- `manager_id` → `hr_employees.employee_id` (self-reference) builds the org chart.
- `end_date` is NULL for current employees; non-null = departed.

## Joins

`employee_id` is referenced by `staffing.employee_id` (gameday pool). Front-office staff are not in `staffing`.
