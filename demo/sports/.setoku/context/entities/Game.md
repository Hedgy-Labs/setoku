---
name: Game
table: public.games
summary: One of the season's 81 home games. The shared dimension every event table joins to.
keywords: [game, games, home game, schedule, opponent, attendance, promo, fixture, event]
---

## Semantics

81 home games for the season. `paid_attendance` is a denormalized roll-up of paid tickets.
`is_promo` flags giveaway/fireworks nights (they drive demand); `promo_name` is NULL otherwise.
`day_night` is 'day' or 'night'.

A game is **completed** when `game_date < CURRENT_DATE`, otherwise **upcoming**. Completed games
have concession sales and clocked staffing shifts; upcoming games do not.

## Joins

`game_id` is referenced by `tickets`, `sponsorships`, `concessions`, and `staffing`.
