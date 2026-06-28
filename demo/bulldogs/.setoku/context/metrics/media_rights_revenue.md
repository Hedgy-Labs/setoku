---
name: media_rights_revenue
summary: Media / broadcast rights revenue — sum of media.rights_deal.annual_value (dollars) by season. The club's single biggest revenue line, ~$80–100M/season. Annual fees, NOT per-game.
keywords: [media rights, broadcast revenue, tv revenue, rights fees, rsn, regional sports network, national, streaming, radio, biggest revenue line, how much from tv]
links: [MediaRights, total_revenue]
---

## Definition

Media-rights revenue = `SUM(media.rights_deal.annual_value)` (already **dollars**) grouped by
`season_yr`. Each row is one rights **package** for one season (regional/RSN, national, streaming,
radio), so the annual fee is the value itself — **never** multiply by games or attendance.

This is the **largest single revenue line** for the club: a season totals **~$80–100M**, with the
regional/RSN package the biggest slice.

## Canonical SQL

```sql
SELECT season_yr,
       SUM(annual_value)                                   AS media_rights_dollars,
       SUM(annual_value) FILTER (WHERE rights_type='regional') AS regional_dollars
FROM media.rights_deal
GROUP BY season_yr
ORDER BY season_yr;
```

Break out by package with `GROUP BY season_yr, rights_type`. Use `status = 'active'` to restrict
to the current season's live contracts (past seasons are `expired`). See [[total_revenue]] for how
this rolls into total club revenue.
