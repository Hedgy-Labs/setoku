---
name: overview
summary: Riverside Stags — a professional baseball club. This database holds the business side of an 81 home-game season — ticketing, fans (CRM), sponsorship, merchandise, food & beverage, gameday staffing, internal HR, and marketing spend.
keywords: [stags, baseball, ballpark, season, business, overview, what data, tables, sports team]
---

# Riverside Stags — business data

The **Riverside Stags** are a (fictional) professional baseball club. This is the
**business** database behind one 81 home-game season — not play-by-play stats, but
the money and operations side of running the franchise.

Everything ties back to the **`games`** table (the season's 81 home games). The eight
subject areas:

1. **Ticketing** (`tickets`) — one row per seat per game: type, lifecycle status, price, buyer.
2. **Fans / CRM** (`fans`) — one row per unique fan, keyed by email.
3. **Sponsorship** (`sponsorships`) — sellable signage/digital/activation inventory per game.
4. **Merchandise** (`merchandise`) — the team-store catalog (SKUs, cost vs list, stock).
5. **Food & Beverage** (`concessions`) — concession sales transactions per game.
6. **Staffing** (`staffing`) — one row per gameday shift per worker.
7. **Internal HR** (`hr_employees`) — front-office + gameday workforce, comp, reporting line.
8. **Marketing** (`marketing_spend`) — one row per campaign spend line, with delivery analytics.

## Conventions that apply everywhere

- **All money is stored as integer cents.** Divide by 100 for dollars. Columns end in `_cents`.
- **Join on `game_id`** to bring ticketing / concessions / sponsorship / staffing onto the season calendar.
- A game is **completed** if its `game_date` is in the past; otherwise **upcoming** (this drives
  ticket status, concession sales existence, and staffing clock-in/out — see the gotchas).
