---
name: Team
table: ticketing.team
summary: The league dimension — the 29 opponents the Bonita Bulldogs face (30 teams total). Maps the 3-letter opponent_cd used on events to a full team name and city.
keywords: [team, teams, opponent, opponents, league, who did we play, rivals, matchup, opponent code, schedule]
---

## Semantics

`ticketing.team` is a small lookup of the **29 opponents** in the Bulldogs' 30-team league.
`ticketing.event.opponent_cd` is a 3-letter code; join here for the human name/city.

- `team_cd` (PK) — the 3-letter code stored on events (e.g. `CVC`).
- `team_name` — full club name (e.g. "Chula Vista Charros"). `city` — the opponent's city.
- The Bulldogs themselves are **not** in this table (it's the opponent list; every event is a
  home game vs one of these teams).
- Each **season** features **~22 of the 29** opponents (not every team visits every year), so a
  per-season "distinct opponents" count is ~21–22, not 29.

Example — games played per opponent in a season:

```sql
SELECT t.team_name, count(*) AS home_games
FROM ticketing.event e
JOIN ticketing.team t ON t.team_cd = e.opponent_cd
WHERE e.season_yr = 2025
GROUP BY t.team_name
ORDER BY home_games DESC;
```
