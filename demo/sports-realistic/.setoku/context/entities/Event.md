---
name: Event
table: ticketing.event
summary: A home game, in the ticketing system. The shared business key (event_no) that pos and hr also reference. Spans 3 seasons.
keywords: [event, game, games, schedule, opponent, attendance, gate, season, promo]
---

## Semantics

One row per home game across seasons 2024–2026 (81 per season). `event_no` is the cross-system
game key — `pos.txn` and `hr.shift` reference it (no FK). `gate_attend` is the turnstile
(scanned) count and is **NULL for upcoming events**. `opponent_cd` is a 3-letter code.
`promo_flg`/`promo_desc` mark giveaway/fireworks nights.

A game is completed when `event_dt < CURRENT_DATE`. Completed games have `pos` sales, clocked
`hr.shift` rows, and a `gate_attend`.
