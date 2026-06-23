-- SPDX-License-Identifier: Apache-2.0
-- Setoku demo dataset — a fictional professional baseball franchise, the
-- "Riverside Stags" (NOT based on any real team). Synthetic data only.
--
-- Eight subject areas requested by the demo brief, tied together by a shared
-- `games` dimension (an 81 home-game season). Money is stored as INTEGER CENTS
-- throughout (a deliberate gotcha the curated knowledge documents) — divide by
-- 100 for dollars.
--
-- Loaded by generate.ts. Safe to re-run: it DROPs and recreates everything.
-- Tables are created parent-first so the foreign keys resolve.

DROP TABLE IF EXISTS tickets CASCADE;
DROP TABLE IF EXISTS concessions CASCADE;
DROP TABLE IF EXISTS sponsorships CASCADE;
DROP TABLE IF EXISTS staffing CASCADE;
DROP TABLE IF EXISTS marketing_spend CASCADE;
DROP TABLE IF EXISTS merchandise CASCADE;
DROP TABLE IF EXISTS fans CASCADE;
DROP TABLE IF EXISTS hr_employees CASCADE;
DROP TABLE IF EXISTS games CASCADE;

-- ── games ────────────────────────────────────────────────────────────────────
-- The season's 81 home games. The shared dimension every event table joins to.
CREATE TABLE games (
  game_id      INTEGER PRIMARY KEY,
  season       INTEGER NOT NULL,
  game_date    DATE    NOT NULL,
  opponent     TEXT    NOT NULL,
  day_night    TEXT    NOT NULL,             -- 'day' | 'night'
  is_weekend   BOOLEAN NOT NULL,
  is_promo     BOOLEAN NOT NULL,             -- giveaway/fireworks night (drives demand)
  promo_name   TEXT,                         -- NULL unless is_promo
  paid_attendance INTEGER NOT NULL           -- denormalized roll-up for convenience
);

-- ── 2/ CRM / fans ────────────────────────────────────────────────────────────
-- One row per unique fan, keyed by email. Demographics + the payment method on
-- file (brand + last four only — never a full PAN).
CREATE TABLE fans (
  fan_id          BIGINT PRIMARY KEY,
  email           TEXT UNIQUE NOT NULL,
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  phone           TEXT,
  street          TEXT,
  city            TEXT,
  state           TEXT,
  postal_code     TEXT,
  payment_brand   TEXT,                      -- visa|mastercard|amex|discover|paypal
  payment_last4   TEXT,
  employer        TEXT,
  has_children    BOOLEAN,
  favorite_player TEXT,
  created_at      TIMESTAMPTZ NOT NULL
);

-- ── 7/ internal HR ───────────────────────────────────────────────────────────
-- One row per employee (front-office + gameday workforce). W2 vs 1099, comp,
-- reporting line, tenure. Defined before `staffing`, which references it.
CREATE TABLE hr_employees (
  employee_id     INTEGER PRIMARY KEY,
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  email           TEXT UNIQUE NOT NULL,
  street          TEXT,
  city            TEXT,
  state           TEXT,
  postal_code     TEXT,
  worker_type     TEXT NOT NULL,             -- W2|1099
  salary_cents    INTEGER,                   -- NULL for hourly/1099
  hourly_rate_cents INTEGER,                 -- NULL for salaried
  bonus_cents     INTEGER NOT NULL DEFAULT 0,
  vacation_days   INTEGER NOT NULL DEFAULT 0,
  department      TEXT NOT NULL,             -- e.g. Ticketing, Operations, Marketing, Finance
  title           TEXT NOT NULL,
  manager_id      INTEGER REFERENCES hr_employees(employee_id),
  start_date      DATE NOT NULL,
  end_date        DATE                       -- NULL if still employed
);

-- ── 1/ ticketing ─────────────────────────────────────────────────────────────
-- One row per seat per game. ticket_type, lifecycle status, group buys, the fan
-- who bought it, and the listed/sold price plus who last repriced it.
CREATE TABLE tickets (
  ticket_id        BIGINT PRIMARY KEY,
  game_id          INTEGER NOT NULL REFERENCES games(game_id),
  section          TEXT    NOT NULL,
  seat_row         TEXT    NOT NULL,
  seat             INTEGER NOT NULL,
  ticket_type      TEXT    NOT NULL,         -- premium|single|group|corporate|comp|season
  status           TEXT    NOT NULL,         -- hold|listed|sold|scanned
  group_id         BIGINT,                   -- non-null when bought as part of a group
  buyer_fan_id     BIGINT REFERENCES fans(fan_id),
  listed_price_cents INTEGER NOT NULL,
  sold_price_cents INTEGER,                  -- NULL until sold/scanned (or for comps)
  price_updated_by TEXT,                     -- staff member who last set the price
  updated_at       TIMESTAMPTZ NOT NULL
);

-- ── 3/ sponsorship ───────────────────────────────────────────────────────────
-- One row per sellable piece of sponsorship inventory, per game.
CREATE TABLE sponsorships (
  sponsorship_id  BIGINT PRIMARY KEY,
  game_id         INTEGER NOT NULL REFERENCES games(game_id),
  inventory_type  TEXT NOT NULL,             -- led_signage|static_signage|digital|event_activation
  location        TEXT NOT NULL,             -- outfield|infield|behind_home_plate|concourse|digital
  status          TEXT NOT NULL,             -- available|held|sold
  sponsor_name    TEXT,                      -- NULL until sold
  rate_card_cents INTEGER NOT NULL,          -- list price
  sold_price_cents INTEGER,                  -- NULL unless sold
  sold_by         TEXT
);

-- ── 4/ merchandise ───────────────────────────────────────────────────────────
-- Catalog of retail SKUs (the team store). list vs purchase (cost) price, where
-- it sells, the vendor, and on-hand quantity.
CREATE TABLE merchandise (
  sku                 TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  description         TEXT,
  category            TEXT NOT NULL,         -- jersey|hat|tee|memorabilia|kids|accessory
  size                TEXT,
  color               TEXT,
  list_price_cents    INTEGER NOT NULL,
  purchase_price_cents INTEGER NOT NULL,     -- unit cost
  is_bundle           BOOLEAN NOT NULL,
  channel             TEXT NOT NULL,         -- digital|brick_mortar|both
  vendor              TEXT NOT NULL,
  quantity_available  INTEGER NOT NULL
);

-- ── 5/ food & beverage ───────────────────────────────────────────────────────
-- Concession sales transactions. Stand/location within the ballpark, the item,
-- list vs cost price, and (when paid by a card we recognize) a tie back to a fan.
CREATE TABLE concessions (
  concession_id    BIGINT PRIMARY KEY,
  game_id          INTEGER NOT NULL REFERENCES games(game_id),
  stand_location   TEXT NOT NULL,            -- e.g. 'Section 112 Grill', 'Bullpen Bar'
  item_name        TEXT NOT NULL,
  category         TEXT NOT NULL,            -- food|beverage|alcohol|dessert
  unit_price_cents INTEGER NOT NULL,
  unit_cost_cents  INTEGER NOT NULL,
  quantity         INTEGER NOT NULL,
  payment_method   TEXT NOT NULL,            -- card|cash|mobile
  fan_id           BIGINT REFERENCES fans(fan_id),  -- NULL for cash / unmatched
  sold_at          TIMESTAMPTZ NOT NULL
);

-- ── 6/ staffing ──────────────────────────────────────────────────────────────
-- One row per gameday shift per worker. Scheduled vs actual clock in/out, the
-- hourly wage, and whether the event has happened yet.
CREATE TABLE staffing (
  shift_id        BIGINT PRIMARY KEY,
  game_id         INTEGER NOT NULL REFERENCES games(game_id),
  employee_id     INTEGER REFERENCES hr_employees(employee_id),
  employee_name   TEXT NOT NULL,
  role            TEXT NOT NULL,             -- usher|concessions|security|cleaning|ticketing|grounds
  scheduled_start TIMESTAMPTZ NOT NULL,
  scheduled_end   TIMESTAMPTZ NOT NULL,
  clock_in        TIMESTAMPTZ,               -- NULL for upcoming games
  clock_out       TIMESTAMPTZ,
  hourly_wage_cents INTEGER NOT NULL,
  status          TEXT NOT NULL              -- completed|upcoming
);

-- ── 8/ marketing ─────────────────────────────────────────────────────────────
-- One row per campaign spend line. Channel, spend, and delivery analytics.
CREATE TABLE marketing_spend (
  campaign_id     BIGINT PRIMARY KEY,
  campaign_name   TEXT NOT NULL,
  channel         TEXT NOT NULL,             -- social|seo|aeo_geo|ooh|radio|tv
  objective       TEXT NOT NULL,             -- awareness|ticket_sales|merch|membership
  spend_cents     BIGINT NOT NULL,
  reach           BIGINT NOT NULL,
  impressions     BIGINT NOT NULL,
  cpm_cents       INTEGER NOT NULL,          -- cost per 1000 impressions
  cpc_cents       INTEGER,                   -- cost per click (NULL for non-clickable like OOH/radio)
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL
);

-- ── indexes for snappy demo queries ──────────────────────────────────────────
CREATE INDEX idx_tickets_game        ON tickets(game_id);
CREATE INDEX idx_tickets_status      ON tickets(status);
CREATE INDEX idx_tickets_type        ON tickets(ticket_type);
CREATE INDEX idx_tickets_buyer       ON tickets(buyer_fan_id);
CREATE INDEX idx_concessions_game    ON concessions(game_id);
CREATE INDEX idx_concessions_fan     ON concessions(fan_id);
CREATE INDEX idx_sponsorships_game   ON sponsorships(game_id);
CREATE INDEX idx_sponsorships_status ON sponsorships(status);
CREATE INDEX idx_staffing_game       ON staffing(game_id);
CREATE INDEX idx_staffing_emp        ON staffing(employee_id);
CREATE INDEX idx_fans_email          ON fans(email);
CREATE INDEX idx_hr_dept             ON hr_employees(department);
