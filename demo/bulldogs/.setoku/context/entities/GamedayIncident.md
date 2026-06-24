---
name: GamedayIncident
table: ops.incident
summary: Gameday incident log from the operations/security system — cleanups, fan ejections, medical calls, lost & found, missing items/children, security breaches, weather delays. One row per incident, completed games only. No money.
keywords: [incident, incidents, gameday ops, operations, security, ejection, fan ejection, missing child, lost child, lost and found, missing item, security breach, medical, cleanup, weather delay, safety]
---

## Semantics

Operational log of things that happened during a game — staffed by the ops/security team. There
is **no money** here; it's about counts, types, severity, and resolution time.

- `event_no` → `ticketing.event` (no FK). **Completed games only** (an upcoming game has none).
- `incident_type` ∈ {`cleanup`, `lost_and_found`, `fan_ejection`, `medical`, `missing_item`,
  `weather_delay`, `security_breach`, `missing_child`}. `cleanup`/`lost_and_found` are common and
  benign; `security_breach`/`missing_child` are rare and high-severity.
- `severity` ∈ {`low`, `medium`, `high`}. `status` ∈ {`open`, `resolved`}; `resolved_ts` is NULL
  while open (a small share stay open, mostly for recent games).
- `reported_ts` clusters around `ticketing.event.first_pitch`. `zone` is where it happened;
  `reported_by` is the role that logged it; `notes` is short, messy free text.

Example — incident mix and avg resolution time for a season:

```sql
SELECT i.incident_type,
       count(*) AS n,
       round(avg(EXTRACT(EPOCH FROM (i.resolved_ts - i.reported_ts))/60.0)) AS avg_minutes_to_resolve
FROM ops.incident i
JOIN ticketing.event e ON e.event_no = i.event_no
WHERE e.season_yr = 2025
GROUP BY i.incident_type
ORDER BY n DESC;
```
