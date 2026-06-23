-- SPDX-License-Identifier: Apache-2.0
-- Setoku demo — REALISTIC variant. Same fictional club (the "Riverside Stags"),
-- but modeled the way a real pro-sports org's data actually lands: NOT one tidy
-- schema, but several disconnected vendor systems, each in its own Postgres
-- schema, with its own naming, its own ID space, mixed money units, multi-season
-- depth, and real-world mess (duplicate CRM contacts, dirty emails, refunds,
-- exchanges, secondary-market resale, test accounts, vendor-employed staff,
-- partial merch coverage). There are deliberately NO cross-system foreign keys —
-- tying a person across systems is a fuzzy identity-resolution problem, which is
-- exactly the tribal knowledge the curated context encodes.
--
-- Money units differ BY SYSTEM (this is real and a deliberate gotcha):
--   ticketing → integer CENTS      pos/sponsorship/hr/merch/marketing → NUMERIC dollars
--
-- Loaded by generate.ts. Safe to re-run: drops and recreates every schema.

DROP SCHEMA IF EXISTS ticketing  CASCADE;
DROP SCHEMA IF EXISTS crm         CASCADE;
DROP SCHEMA IF EXISTS sponsorship CASCADE;
DROP SCHEMA IF EXISTS pos         CASCADE;
DROP SCHEMA IF EXISTS merch       CASCADE;
DROP SCHEMA IF EXISTS hr          CASCADE;
DROP SCHEMA IF EXISTS marketing   CASCADE;

CREATE SCHEMA ticketing;
CREATE SCHEMA crm;
CREATE SCHEMA sponsorship;
CREATE SCHEMA pos;
CREATE SCHEMA merch;
CREATE SCHEMA hr;
CREATE SCHEMA marketing;

-- ════════════════════════════════════════════════════════════════════════════
-- ticketing  — ticketing system export (Archtics/Tickets.com-flavored: codes,
--              cryptic names, money in CENTS). The system of record for seats.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE ticketing.event (
  event_no     INTEGER PRIMARY KEY,
  season_yr    INTEGER NOT NULL,
  event_dt     DATE    NOT NULL,
  opponent_cd  TEXT    NOT NULL,        -- 3-letter opponent code
  day_night    TEXT    NOT NULL,
  promo_flg    BOOLEAN NOT NULL,
  promo_desc   TEXT,
  gate_attend  INTEGER                  -- turnstile (scanned) count; NULL for future events
);

CREATE TABLE ticketing.account (
  acct_id      BIGINT PRIMARY KEY,
  acct_email   TEXT,                    -- dirty: mixed case, stray spaces, +tags, some NULL
  acct_fname   TEXT,
  acct_lname   TEXT,
  acct_type_cd TEXT NOT NULL,           -- STH | SINGLE | GROUP | PREMIUM | CORP | COMP
  phone        TEXT,
  addr1        TEXT,
  city         TEXT,
  st           TEXT,
  zip          TEXT,
  create_dt    DATE
);

-- The manifest + sales ledger. One row per seat per event.
CREATE TABLE ticketing.seat_txn (
  txn_id          BIGINT PRIMARY KEY,
  event_no        INTEGER NOT NULL,
  acct_id         BIGINT,              -- buyer (NULL for unsold inventory)
  sec             TEXT NOT NULL,
  seat_row        TEXT NOT NULL,
  seat            INTEGER NOT NULL,
  pl_cd           TEXT NOT NULL,       -- price-level code PL1..PL6 (see knowledge: maps to tiers)
  plan_cd         TEXT,                -- FULL | HALF | PK20 | NULL (single game)
  price_list_cents INTEGER NOT NULL,
  price_paid_cents INTEGER,            -- NULL until sold; 0 for comps
  status_cd       TEXT NOT NULL,       -- HD hold | LS listed | SD sold | SC scanned | RF refunded | XCH exchanged
  is_resale_flg   BOOLEAN NOT NULL DEFAULT false,  -- resold on secondary market
  orig_acct_id    BIGINT,             -- original buyer when resold (attendee != orig buyer)
  upd_dt          TIMESTAMPTZ NOT NULL,
  upd_by          TEXT
);
CREATE INDEX ix_seat_event  ON ticketing.seat_txn(event_no);
CREATE INDEX ix_seat_acct   ON ticketing.seat_txn(acct_id);
CREATE INDEX ix_seat_status ON ticketing.seat_txn(status_cd);

-- ════════════════════════════════════════════════════════════════════════════
-- crm  — Salesforce-flavored. Marketing's contact DB. DUPLICATES and dirty
--        emails by design; `is_test__c` flags internal/test records.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE crm.contact (
  sfid          TEXT PRIMARY KEY,      -- '003...' Salesforce id
  email         TEXT,                  -- NOT unique: same person appears multiple times
  first_name    TEXT,
  last_name     TEXT,
  mailing_city  TEXT,
  mailing_state TEXT,
  do_not_email  BOOLEAN NOT NULL DEFAULT false,
  lead_source   TEXT,                  -- often NULL
  is_test__c    BOOLEAN NOT NULL DEFAULT false,
  created_date  TIMESTAMPTZ NOT NULL
);
CREATE INDEX ix_contact_email ON crm.contact((lower(email)));

-- ════════════════════════════════════════════════════════════════════════════
-- sponsorship  — KORE-flavored. CONTRACTED deals (multi-year), not per-game
--                inventory. Money in dollars (NUMERIC).
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE sponsorship.partner (
  partner_id    INTEGER PRIMARY KEY,
  partner_name  TEXT NOT NULL,
  industry      TEXT,
  account_owner TEXT
);
CREATE TABLE sponsorship.deal (
  deal_id        INTEGER PRIMARY KEY,
  partner_id     INTEGER NOT NULL REFERENCES sponsorship.partner(partner_id),
  season_yr      INTEGER NOT NULL,
  status         TEXT NOT NULL,        -- proposed | signed | active | expired
  contract_value NUMERIC(12,2) NOT NULL,
  start_dt       DATE NOT NULL,
  end_dt         DATE NOT NULL
);
CREATE TABLE sponsorship.deal_asset (
  asset_id        BIGINT PRIMARY KEY,
  deal_id         INTEGER NOT NULL REFERENCES sponsorship.deal(deal_id),
  asset_type      TEXT NOT NULL,       -- led | static | digital | activation | radio | promo_night
  location        TEXT,
  units           INTEGER NOT NULL,
  rate_card       NUMERIC(12,2) NOT NULL,
  allocated_value NUMERIC(12,2) NOT NULL  -- portion of contract_value attributed to this asset
);
CREATE INDEX ix_deal_partner ON sponsorship.deal(partner_id);
CREATE INDEX ix_deal_season  ON sponsorship.deal(season_yr);
CREATE INDEX ix_asset_deal   ON sponsorship.deal_asset(deal_id);

-- ════════════════════════════════════════════════════════════════════════════
-- pos  — concessions point-of-sale vendor export. HIGH volume. Money in dollars.
--        loyalty_id rarely populated → most sales can't be tied to a fan.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE pos.stand (
  stand_id      INTEGER PRIMARY KEY,
  stand_name    TEXT NOT NULL,
  location_zone TEXT NOT NULL
);
CREATE TABLE pos.txn (
  txn_id      BIGINT PRIMARY KEY,
  event_no    INTEGER NOT NULL,        -- matches ticketing.event.event_no (no FK across systems)
  stand_id    INTEGER NOT NULL REFERENCES pos.stand(stand_id),
  ts          TIMESTAMPTZ NOT NULL,
  tender_type TEXT NOT NULL,           -- CARD | CASH | MOBILE
  loyalty_id  TEXT,                    -- app/loyalty id; ~15% populated, sometimes = ticketing acct_id
  subtotal    NUMERIC(10,2) NOT NULL,
  tax         NUMERIC(10,2) NOT NULL,
  total       NUMERIC(10,2) NOT NULL
);
CREATE TABLE pos.txn_item (
  item_id    BIGINT PRIMARY KEY,
  txn_id     BIGINT NOT NULL REFERENCES pos.txn(txn_id),
  item_name  TEXT NOT NULL,
  category   TEXT NOT NULL,            -- food | beverage | alcohol | dessert
  qty        INTEGER NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL,
  unit_cost  NUMERIC(10,2) NOT NULL
);
CREATE INDEX ix_postxn_event ON pos.txn(event_no);
CREATE INDEX ix_positem_txn  ON pos.txn_item(txn_id);

-- ════════════════════════════════════════════════════════════════════════════
-- merch  — PARTIAL. Most team merch is run by a third party (Fanatics) and is
--          NOT in this database; this is only the team's own online store feed.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE merch.online_order (
  order_id   BIGINT PRIMARY KEY,
  order_ts   TIMESTAMPTZ NOT NULL,
  email      TEXT,
  sku        TEXT NOT NULL,
  item_name  TEXT NOT NULL,
  qty        INTEGER NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL,
  channel    TEXT NOT NULL            -- always 'online' here (in-venue/retail is Fanatics, not present)
);

-- ════════════════════════════════════════════════════════════════════════════
-- hr  — Workday/ADP-flavored. Money in dollars. Gameday workforce is largely
--       VENDOR-employed → many shifts have no HR worker row.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE hr.worker (
  worker_id     INTEGER PRIMARY KEY,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  worker_type   TEXT NOT NULL,         -- employee | contingent
  flsa          TEXT,                  -- exempt | non-exempt
  dept          TEXT NOT NULL,
  job_title     TEXT NOT NULL,
  mgr_worker_id INTEGER REFERENCES hr.worker(worker_id),
  hire_dt       DATE NOT NULL,
  term_dt       DATE
);
CREATE TABLE hr.comp (
  comp_id      BIGINT PRIMARY KEY,
  worker_id    INTEGER NOT NULL REFERENCES hr.worker(worker_id),
  comp_type    TEXT NOT NULL,          -- salary | hourly
  annual_amt   NUMERIC(12,2),          -- set for salary
  hourly_rate  NUMERIC(8,2),           -- set for hourly
  effective_dt DATE NOT NULL
);
CREATE TABLE hr.shift (
  shift_id   BIGINT PRIMARY KEY,
  event_no   INTEGER NOT NULL,
  worker_id  INTEGER REFERENCES hr.worker(worker_id),  -- NULL for vendor-staffed roles
  role       TEXT NOT NULL,
  sched_in   TIMESTAMPTZ NOT NULL,
  sched_out  TIMESTAMPTZ NOT NULL,
  actual_in  TIMESTAMPTZ,
  actual_out TIMESTAMPTZ,
  pay_rate   NUMERIC(8,2) NOT NULL,
  staffed_by TEXT NOT NULL             -- team | vendor
);
CREATE INDEX ix_comp_worker ON hr.comp(worker_id);
CREATE INDEX ix_shift_event ON hr.shift(event_no);

-- ════════════════════════════════════════════════════════════════════════════
-- marketing  — per-platform ad exports. Money in dollars. No attribution to sales.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE marketing.ad_spend (
  row_id      BIGINT PRIMARY KEY,
  platform    TEXT NOT NULL,           -- google | meta | tv | radio | ooh | email
  campaign    TEXT NOT NULL,
  objective   TEXT NOT NULL,
  season_yr   INTEGER NOT NULL,
  spend       NUMERIC(12,2) NOT NULL,
  impressions BIGINT NOT NULL,
  clicks      BIGINT,                  -- NULL for non-clickable platforms
  reach       BIGINT,
  start_dt    DATE NOT NULL,
  end_dt      DATE NOT NULL
);
CREATE INDEX ix_adspend_season ON marketing.ad_spend(season_yr);
