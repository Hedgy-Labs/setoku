# Gotchas

- All money columns are integer **cents** — divide by 100 for dollars (every `_cents` column).
- **Comp tickets are free**: `ticket_type = 'comp'` has `sold_price_cents = 0`. Exclude comps from ticket revenue and from average-ticket-price.
- A seat is only **revenue** when `status IN ('sold','scanned')`. `listed` and `hold` are unsold inventory — never count them as sales.
- On a completed game, `status = 'sold'` (not `scanned`) means the ticket sold but the fan never entered — a **no-show**. `scanned` ⇒ actually attended.
- **Concessions exist only for completed games** — sales happen at the game. An upcoming game having zero concession rows is correct, not missing data.
- **Staffing**: `clock_in`/`clock_out` are NULL for `upcoming` shifts. Use clocked hours for actual labor cost; scheduled times for planned cost. They differ (early/late punches).
- `concessions.fan_id` is **NULL for cash** sales and unmatched cards — don't assume every transaction maps to a fan.
- `hr_employees`: salaried staff have `salary_cents` (hourly NULL); gameday/1099 staff have `hourly_rate_cents` (salary NULL). Never sum the two columns together as one payroll number without converting.
- Front-office employees are **not** in `staffing`; only the `Gameday Staff` department appears there.
- `marketing_spend` has no attribution to ticket/merch sales — don't infer revenue causation from spend.
- Every seat in the manifest is a row (sold or not), so `COUNT(*)` over `tickets` is the **capacity sold + unsold**, not sales.
