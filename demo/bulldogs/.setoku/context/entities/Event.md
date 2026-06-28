---
name: Event
table: ticketing.event
summary: A home game, in the ticketing system. The shared business key (event_no) that pos, hr, and ops also reference. Spans 3 seasons. Has a start time (first_pitch) and optional promotional pricing.
keywords: [event, game, games, schedule, opponent, attendance, gate, season, promo, start time, first pitch, day night, promotional pricing]
links: [Team, SeatTxn, PosTransaction, GamedayIncident]
---

## Semantics

One row per home game across seasons 2024–2026 (81 per season). `event_no` is the cross-system
game key — `pos.txn`, `hr.shift`, and `ops.incident` reference it (no FK). `gate_attend` is the
turnstile (scanned) count and is **NULL for upcoming events**.

- **`event_dt`** is the game **date**; **`first_pitch`** is the scheduled **start time**
  (timestamptz). `day_night` ∈ {`day`,`night`} (day games skew weekend afternoons).
- **`opponent_cd`** is a 3-letter code → join `ticketing.team` for the opponent name/city.
  ~22 of the 29 league opponents appear in any given season.
- **`promo_flg`/`promo_desc`** mark a giveaway/theme night (bobblehead, fireworks) — this is
  **not** a price cut.
- **`price_promo_cd`** (NULL = standard) is a ticket-**price** promotion — e.g. `WKND_FAMILY`,
  `GROUP_SAVER`, `STUDENT_NIGHT`, `THEME_NIGHT`, `TWILIGHT`. When set, `price_paid_cents` on that
  game's seats is already discounted (mostly weekend games). See [[gotchas]].
- **`fnb_promo_cd`** (NULL = standard) is a concession-**price** promotion — e.g. `DOLLAR_DOG`,
  `FIVE_DOLLAR_BEER`, `HAPPY_HOUR`, `FAMILY_MEAL_DEAL`. `pos.txn_item.unit_price` is already
  discounted for that game (cost unchanged → thinner margin).

A game is completed when `event_dt < CURRENT_DATE`. Completed games have `pos` sales, clocked
`hr.shift` rows, `ops.incident` rows, and a `gate_attend`.
