---
name: SeatTxn
table: ticketing.seat_txn
summary: The seat manifest + sales ledger — one row per seat per game. Status codes, price-level codes, season plans, resale flags. Money in CENTS.
keywords: [seat, ticket, tickets, manifest, sold, scanned, refund, exchange, resale, price level, plan, season ticket, sell-through, scan time, scan in, gate time, arrival]
links: [TicketingAccount, Event, ticket_revenue, season_renewal_rate]
---

## Semantics

One row per seat per game. Ticketing money is **cents**.

- **status_cd**: `HD` hold · `LS` listed · `SD` sold · `SC` scanned (attended) · `RF` refunded · `XCH` exchanged. Revenue = `SD`+`SC` only; exclude `RF`/`XCH`; `LS`/`HD` are unsold.
- **pl_cd**: price-level CODE `PL1`…`PL6` (tiers ≈ $22/$30/$45/$60/$95/$130 list). It is **not** a dollar amount — use `price_list_cents` for the list price and `price_paid_cents` for what was paid.
- **plan_cd**: `FULL`/`HALF` = season-ticket plan (the holder is an STH for that season); NULL = single game. Drives renewals ([[season_renewal_rate]]).
- **is_resale_flg** / **orig_acct_id**: secondary-market resale — `acct_id` is the current holder/attendee, `orig_acct_id` the original buyer.
- **scan_ts**: gate scan-in time — set **only** when `status_cd='SC'` (NULL otherwise). Fans
  stream in from ~90 min before `ticketing.event.first_pitch` to shortly after. Use it for gate-flow
  / arrival-pattern questions; it's the per-seat complement to the game's `gate_attend` count.
- **promotional pricing**: when the seat's event has a `price_promo_cd`, `price_paid_cents` already
  reflects the discount; `price_list_cents` stays the undiscounted list. See [[gotchas]].
- `acct_id` → `ticketing.account` (NULL for unsold). `event_no` → `ticketing.event`.

See [[ticket_revenue]] and [[gotchas]].
