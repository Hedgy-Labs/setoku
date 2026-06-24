// SPDX-License-Identifier: Apache-2.0
//
// Synthetic-data generator for the Setoku Bonita Bulldogs sports demo — modeled
// the way real pro-sports data actually lands: several
// disconnected vendor systems (one Postgres schema each), no cross-system keys,
// mixed money units, 3 seasons of depth, and deliberate real-world mess —
// duplicate CRM contacts, dirty emails, refunds/exchanges, secondary-market
// resale, test accounts, vendor-employed gameday staff, partial merch coverage.
//
// The mess is the point: it forces the curated knowledge (identity resolution,
// code maps, exclusions, unit/coverage caveats) to do real work — that's what a
// client like a real MLB team would actually experience.
//
//   DATABASE_URL=postgres://...  bun generate.ts
//
// Scale knobs (env): SEED, SEASONS (csv), AS_OF, SEATS_PER_GAME (26000),
//   POS_TXN_RATE (0.6), N_PEOPLE (120000), N_MERCH_ORDERS (30000),
//   STAFF_PER_GAME (350), N_PARTNERS (70).

import pgPkg from "pg";
const { Client } = pgPkg;
import fs from "node:fs";
import path from "node:path";

// ── config ────────────────────────────────────────────────────────────────
const DB_URL =
  process.env.DATABASE_URL || process.env.SETOKU_DATABASE_URL ||
  "postgres://postgres:demo@127.0.0.1:5432/bulldogs";
// `??` only catches null/undefined, so an exported-but-empty env (SEED=, etc.)
// would become Number("") = 0 → zero rows / Invalid Date. Treat empty as default.
const numEnv = (k: string, d: number): number => {
  const v = process.env[k];
  return v == null || v.trim() === "" ? d : Number(v);
};
const SEED = numEnv("SEED", 4242);
const SEASONS = (process.env.SEASONS?.trim() || "2024,2025,2026").split(",").map((s) => Number(s.trim()));
const AS_OF = new Date(process.env.AS_OF?.trim() || `${SEASONS[SEASONS.length - 1]}-06-22T12:00:00Z`);
const GAMES_PER_SEASON = 81;
// Seat manifest size per game. Sized so attendance lands at a realistic mid-market
// MLB gate (~20k/game) and total club revenue lands ~$180–200M/season once media
// rights (~$90M) are included. See the total_revenue knowledge doc.
const SEATS_PER_GAME = numEnv("SEATS_PER_GAME", 26000);
// POS volume is attendance-driven (≈ this share of scanned fans transact), so
// per-cap (F&B revenue ÷ attendance) lands in a realistic ~$15–20 range.
const POS_TXN_RATE = numEnv("POS_TXN_RATE", 0.6);
const N_PEOPLE = numEnv("N_PEOPLE", 120000);
const N_MERCH_ORDERS = numEnv("N_MERCH_ORDERS", 30000);
const STAFF_PER_GAME = numEnv("STAFF_PER_GAME", 350);
const N_PARTNERS = numEnv("N_PARTNERS", 70);
const CAPACITY = 38000;

// ── seeded PRNG ─────────────────────────────────────────────────────────────
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rnd = mulberry32(SEED);
const rand = () => rnd();
const ri = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const chance = (p: number) => rand() < p;
const round2 = (n: number) => Math.round(n * 100) / 100;
const dayMs = 86400000;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * dayMs);
const addMin = (d: Date, n: number) => new Date(d.getTime() + n * 60000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

// ── pools (fictional) ───────────────────────────────────────────────────────
// The 29 league opponents (the Bonita Bulldogs make 30 teams). [full name, city, 3-letter code].
const TEAMS: [string, string, string][] = [
  ["San Clemente Breakers","San Clemente","SCB"], ["Lake Forest Flames","Lake Forest","LFF"],
  ["Mission Viejo Monarchs","Mission Viejo","MVM"], ["Laguna Hills Hawks","Laguna Hills","LHH"],
  ["Aliso Viejo Aviators","Aliso Viejo","AVA"], ["Yorba Linda Mustangs","Yorba Linda","YLM"],
  ["Rancho Santa Margarita Rancheros","Rancho Santa Margarita","RSM"], ["San Juan Capistrano Bells","San Juan Capistrano","SJC"],
  ["Dana Point Anchors","Dana Point","DPA"], ["Ladera Ranch Longhorns","Ladera Ranch","LRL"],
  ["Santee Scorpions","Santee","STS"], ["El Cajon Rattlers","El Cajon","ECR"],
  ["Vista Vaqueros","Vista","VVQ"], ["San Marcos Sagebrush","San Marcos","SMS"],
  ["Escondido Chaparrals","Escondido","ESC"], ["Ramona Wranglers","Ramona","RMW"],
  ["Poway Prospectors","Poway","PWP"], ["Chula Vista Charros","Chula Vista","CVC"],
  ["Lemon Grove Squeeze","Lemon Grove","LGS"], ["Spring Valley Surge","Spring Valley","SVS"],
  ["Lakeside Longhorns","Lakeside","LKL"], ["National City Navigators","National City","NCN"],
  ["Fallbrook Avocados","Fallbrook","FBA"], ["Oceanside Tides","Oceanside","OCT"],
  ["Carlsbad Breeze","Carlsbad","CBB"], ["Encinitas Crestline","Encinitas","ENC"],
  ["La Mesa Lightning","La Mesa","LML"], ["Cypress Stingers","Cypress","CYS"],
  ["Tustin Tillers","Tustin","TUT"],
];
const OPP_CODES = TEAMS.map((t) => t[2]);
const FIRST = ["James","Mary","Robert","Patricia","John","Jennifer","Michael","Linda","David","Elizabeth","William","Barbara","Richard","Susan","Joseph","Jessica","Thomas","Sarah","Chris","Karen","Daniel","Nancy","Matthew","Lisa","Anthony","Margaret","Mark","Betty","Donald","Sandra","Steven","Ashley","Paul","Kimberly","Andrew","Emily","Joshua","Donna","Kenneth","Michelle","Aisha","Diego","Wei","Priya","Omar","Sofia","Hyun","Fatima","Mateo","Yuki"];
const LAST = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin","Lee","Perez","Thompson","White","Harris","Sanchez","Clark","Ramirez","Lewis","Robinson","Walker","Young","Allen","King","Wright","Scott","Torres","Nguyen","Hill","Flores","Okafor","Petrov","Nakamura","Kowalski","Ahmed","Silva","Cohen","Murphy","Reyes","Brooks"];
// Fan home cities — San Diego county / South Orange County, around Bonita.
const CITIES = [["Bonita","CA","91902"],["Chula Vista","CA","91910"],["National City","CA","91950"],["La Mesa","CA","91942"],["El Cajon","CA","92020"],["Spring Valley","CA","91977"],["Imperial Beach","CA","91932"],["Lemon Grove","CA","91945"],["Coronado","CA","92118"],["San Diego","CA","92113"],["Santee","CA","92071"],["Eastlake","CA","91915"]];
// price-level code → list price ($) tier (documented in knowledge)
const PL: Record<string, number> = { PL1: 22, PL2: 30, PL3: 45, PL4: 60, PL5: 95, PL6: 130 };
const PL_CODES = Object.keys(PL);
const TKT_STAFF = ["rprice","mlopez","tgreen","kshah","dcarter","DYN_PRICE","DYN_PRICE"];
const LEAD_SRC = ["Web","Box Office","Group Sales","Promo Night","Email Signup","App", null, null];
const PARTNER_INDUSTRIES = ["Bank","Insurance","Auto","Healthcare","QSR","Telecom","Energy","Retail","Logistics","Beverage","Construction","Media"];
const ASSET_TYPES: [string, string, number][] = [
  ["led","outfield",45000],["led","behind_home_plate",90000],["static","infield",18000],
  ["static","concourse",9000],["digital","app",30000],["activation","concourse",55000],
  ["radio","broadcast",40000],["promo_night","stadium",70000],
];
const FB_ITEMS: [string, string, number, number][] = [
  ["Classic Hot Dog","food",6.5,1.4],["Loaded Bratwurst","food",9,2.6],["Nachos Grande","food",11,2.9],["Garlic Fries","food",8.5,1.8],["Cheeseburger","food",12,3.4],["Soft Pretzel","food",7,1.1],["Personal Pizza","food",10.5,2.7],["Chicken Tenders","food",12.5,3.6],["Bottled Water","beverage",4.5,0.4],["Fountain Soda","beverage",5.5,0.5],["Iced Coffee","beverage",6,0.9],["Lemonade","beverage",5.5,0.6],["Draft Beer","alcohol",12,2.2],["Craft IPA","alcohol",14,3],["Hard Seltzer","alcohol",13,2.4],["House Margarita","alcohol",15,3.1],["Soft Serve Helmet","dessert",9.5,1.6],["Funnel Cake","dessert",10,2],["Cotton Candy","dessert",6,0.7],["Churros","dessert",8,1.4],
];
const MK_PLATFORMS = ["google","meta","tv","radio","ooh","email"];
const MK_OBJ = ["awareness","ticket_sales","membership","merch"];

// Ticket-PRICE promotions: code → fractional discount off the normal paid price.
// Weighted toward weekend games. (Distinct from promo_flg giveaway/theme nights.)
const PRICE_PROMO: Record<string, number> = {
  WKND_FAMILY: 0.15,   // weekend family 4-pack pricing
  GROUP_SAVER: 0.20,   // group-night discount
  STUDENT_NIGHT: 0.25, // student/college night
  THEME_NIGHT: 0.10,   // theme-night bundle (small discount)
  TWILIGHT: 0.18,      // weeknight twilight pricing
};
// Concession-PRICE promotions: code → which items get repriced (handled in POS).
const FNB_PROMO = ["DOLLAR_DOG","FIVE_DOLLAR_BEER","FAMILY_MEAL_DEAL","HAPPY_HOUR"];

// Gameday incident types → [relative weight, severity bias]. cleanup/lost+found are
// common and benign; security_breach/missing_child are rare and high-severity.
const INCIDENT_TYPES: [string, number, string][] = [
  ["cleanup", 34, "low"], ["lost_and_found", 20, "low"], ["fan_ejection", 14, "medium"],
  ["medical", 12, "medium"], ["missing_item", 9, "low"], ["weather_delay", 4, "medium"],
  ["security_breach", 4, "high"], ["missing_child", 3, "high"],
];
const INCIDENT_ZONES = ["Gate A","Gate C","Field Level","Club Level","Upper Concourse","Bleachers","RF Porch","Parking Lot 4","Family Pavilion","Concourse 200","Restroom 114","Team Store"];
const INCIDENT_REPORTERS = ["Security Lead","Guest Services","Ops Supervisor","Usher","EMT","Cleaning Crew","Gate Supervisor"];
// short, deliberately messy incident descriptions (no real PII)
const INCIDENT_NOTES: Record<string, string[]> = {
  cleanup: ["spill sec 112 aisle, mopped", "broken glass near gate c cleaned up", "restroom 114 out of order, maint notified", "trash overflow upper concourse"],
  lost_and_found: ["found phone at guest svcs, logged", "lost car keys turned in", "wallet found row F, no id claimed yet", "kids jacket left at family pavilion"],
  fan_ejection: ["intoxicated fan removed sec 205, no police", "2 fans ejected for fighting bleachers", "ejected guest using abusive language to staff"],
  medical: ["fan fainted heat, EMT treated on site refused transport", "minor slip on stairs, ice pack", "allergic reaction, epipen administered, transported"],
  missing_item: ["report stolen bag lot 4, filed", "guest says jersey taken from seat", "missing stroller, located at gate"],
  weather_delay: ["rain delay 22 min, tarp on", "lightning in area, fans held on concourse"],
  security_breach: ["fan jumped rail onto warning track, detained", "unauthorized person in tunnel, escorted out", "gate b breach during rush, secured"],
  missing_child: ["child separated from parent sec 130, reunited 12 min", "lost child at team store, found w/ usher", "missing minor paged, located concourse"],
};

// CS-note fragments (assembled into messy free text). All fictional.
const CS_ISSUE = ["called about a double charge on her cc", "emailed re lost tickets for the fireworks game", "complained seats were wet from sprinklers", "upset about parking price hike", "asked for refund, game rained out", "phone issue scanning mobile ticket at gate", "wanted to move seats away from loud section", "billing dispute on the half plan", "no-show for group outing, wants credit"];
const CS_PREF = ["prefers aisle seats", "wants nut-free section info, allergy", "only emails, do NOT call", "asks for rep maria every time", "likes the bullpen bar", "season holder since forever, vip treat", "brings kids, wants family pavilion", "veteran, appreciates the salute night", "wheelchair access needed", "wants paper tickets not mobile"];
const CS_OUTCOME = ["resolved, comped 2 tix", "escalated to supervisor", "issued partial refund", "left vm no callback", "happy now", "still annoyed tbh", "followed up, all good", "promised callback nxt wk", ""];

// dirty an email the way real exports are dirty
function dirtyEmail(canon: string): string {
  let e = canon;
  if (chance(0.08)) { const [u, d] = e.split("@"); e = `${u}+${pick(["mlb","tix","app","promo"])}@${d}`; }
  const r = rand();
  if (r < 0.22) e = e.toUpperCase();
  else if (r < 0.42) e = e.charAt(0).toUpperCase() + e.slice(1);
  if (chance(0.10)) e = e + " ";
  if (chance(0.05)) e = " " + e;
  return e;
}

// concession promotional pricing: given an event's fnb_promo_cd, return the
// possibly-discounted unit price for an item. Standard price when no promo applies.
function fnbPromoPrice(promo: string | null, name: string, cat: string, base: number): number {
  if (!promo) return base;
  if (promo === "DOLLAR_DOG") {
    if (name.includes("Hot Dog")) return 1;
    if (name.includes("Bratwurst")) return 2;
  }
  if (promo === "FIVE_DOLLAR_BEER" && cat === "alcohol" &&
      (name.includes("Beer") || name.includes("IPA") || name.includes("Seltzer"))) return 5;
  if (promo === "HAPPY_HOUR" && cat === "alcohol") return round2(base * 0.7);
  if (promo === "FAMILY_MEAL_DEAL" && cat === "food") return round2(base * 0.8);
  return base;
}

// ── batched inserter (handles schema-qualified tables) ──────────────────────
class Loader {
  private rows: unknown[][] = [];
  constructor(private client: pgPkg.Client, private table: string, private cols: string[], private batch = 500) {}
  async push(row: unknown[]) { this.rows.push(row); if (this.rows.length >= this.batch) await this.flush(); }
  async flush() {
    if (!this.rows.length) return;
    const n = this.cols.length; const params: unknown[] = [];
    const tuples = this.rows.map((r, i) => { params.push(...r); return `(${r.map((_, j) => `$${i * n + j + 1}`).join(",")})`; });
    await this.client.query(`INSERT INTO ${this.table} (${this.cols.join(",")}) VALUES ${tuples.join(",")}`, params);
    this.rows = [];
  }
}

type Person = { email: string; fname: string; lname: string; city: string; st: string; zip: string };

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  console.log(`→ connected; seeding (SEED=${SEED}, seasons=${SEASONS.join("/")}, seats/game=${SEATS_PER_GAME})`);
  await client.query(fs.readFileSync(path.join(import.meta.dir, "schema.sql"), "utf8"));
  console.log("→ schema applied (9 vendor schemas)");

  // ── ticketing.team (league dimension — the 29 opponents) ──────────────────
  const teamL = new Loader(client, "ticketing.team", ["team_cd","team_name","city"]);
  for (const [name, city, code] of TEAMS) await teamL.push([code, name, city]);
  await teamL.flush();
  console.log(`✓ ticketing.team: ${TEAMS.length} opponents`);

  // ── people pool (canonical identities behind every system) ────────────────
  const people: Person[] = [];
  const usedEmail = new Set<string>();
  for (let i = 0; i < N_PEOPLE; i++) {
    const fname = pick(FIRST), lname = pick(LAST);
    let email = `${fname.toLowerCase()}.${lname.toLowerCase()}${ri(1, 99999)}@example.com`;
    while (usedEmail.has(email)) email = `${fname.toLowerCase()}.${lname.toLowerCase()}${ri(1, 999999)}@example.com`;
    usedEmail.add(email);
    const [city, st, zip] = pick(CITIES);
    people.push({ email, fname, lname, city, st, zip });
  }
  console.log(`✓ people pool: ${people.length}`);

  // ── ticketing.event (3 seasons) ───────────────────────────────────────────
  // first_pitch carries the start TIME; pricePromo/priceDisc and fnbPromo carry the
  // promotional-pricing state so the seat ledger and POS apply the discounts.
  type Ev = { no: number; season: number; date: Date; firstPitch: Date; demand: number;
              completed: boolean; pricePromo: string | null; priceDisc: number; fnbPromo: string | null };
  const events: Ev[] = [];
  const evLoader = new Loader(client, "ticketing.event",
    ["event_no","season_yr","event_dt","first_pitch","opponent_cd","day_night","promo_flg","promo_desc","price_promo_cd","fnb_promo_cd","gate_attend"]);
  const PRICE_PROMO_CODES = Object.keys(PRICE_PROMO);
  const WEEKEND_PROMOS = ["WKND_FAMILY","GROUP_SAVER","STUDENT_NIGHT","THEME_NIGHT"];
  let evNo = 0;
  for (const season of SEASONS) {
    const start = new Date(`${season}-04-01T18:00:00Z`);
    // ~22 of the 29 opponents appear in a given season (not every team visits every year).
    const seasonOpps = [...OPP_CODES].sort(() => rand() - 0.5).slice(0, 22);
    let cursor = 0;
    for (let g = 0; g < GAMES_PER_SEASON; g++) {
      cursor += g === 0 ? 0 : pick([1, 1, 2, 2, 3]);
      const date = addDays(start, cursor);
      const dow = date.getUTCDay();
      const weekend = dow === 0 || dow === 5 || dow === 6;
      const promo = chance(0.22);
      const dayGame = weekend && chance(0.5);
      // start TIME: day games ~1:10pm, night games ~7:10pm (local), small jitter. We
      // model time-of-day as a UTC offset from the event date midpoint (18:00Z).
      const firstPitch = dayGame ? addMin(date, -ri(280, 320)) : addMin(date, ri(0, 50));
      // ticket-price promotion: common on weekends, occasional on weeknights.
      const pricePromo = weekend ? (chance(0.5) ? pick(WEEKEND_PROMOS) : null)
                                 : (chance(0.12) ? "TWILIGHT" : null);
      const priceDisc = pricePromo ? PRICE_PROMO[pricePromo] : 0;
      // concession-price promotion (independent of the ticket promo).
      const fnbPromo = chance(0.18) ? pick(FNB_PROMO) : null;
      // promo pricing nudges demand up a little (cheaper seats → more sell-through).
      let demand = 0.55 + (weekend ? 0.18 : 0) + (promo ? 0.16 : 0) + priceDisc * 0.4 + (rand() - 0.5) * 0.18;
      demand = Math.max(0.3, Math.min(0.99, demand));
      const completed = date.getTime() < AS_OF.getTime();
      evNo++;
      events.push({ no: evNo, season, date, firstPitch, demand, completed, pricePromo, priceDisc, fnbPromo });
      await evLoader.push([evNo, season, ymd(date), firstPitch.toISOString(), pick(seasonOpps), dayGame ? "day" : "night",
        promo, promo ? pick(["Bobblehead Night","Fireworks Friday","Cap Giveaway","Kids Day","Jersey Giveaway","Dollar Dog Night","Throwback Night","Fan Appreciation"]) : null,
        pricePromo, fnbPromo,
        null]);  // gate_attend backfilled from the actual scanned-seat count once the manifest is built
    }
  }
  await evLoader.flush();
  console.log(`✓ ticketing.event: ${events.length}`);

  // ── ticketing.account ─────────────────────────────────────────────────────
  // ~72% of people hold a ticketing account. acct_id is the ticketing ID space.
  const acctLoader = new Loader(client, "ticketing.account",
    ["acct_id","acct_email","acct_fname","acct_lname","acct_type_cd","phone","addr1","city","st","zip","create_dt"]);
  const buyerAccts: number[] = [];        // general single/group/etc buyers
  const sthPool: number[] = [];           // STH-capable accounts (subset)
  const acctPerson = new Map<number, number>();  // acct_id -> person idx (for cross-system linkage)
  let acctId = 0;
  for (let pid = 0; pid < people.length; pid++) {
    if (!chance(0.72)) continue;
    acctId++;
    const p = people[pid];
    acctPerson.set(acctId, pid);
    // ~1% test/internal accounts (knowledge: exclude)
    const isTest = chance(0.01);
    const typeRoll = rand();
    const type = isTest ? "COMP" : typeRoll < 0.10 ? "STH" : typeRoll < 0.16 ? "CORP" : typeRoll < 0.22 ? "PREMIUM" : typeRoll < 0.40 ? "GROUP" : typeRoll < 0.45 ? "COMP" : "SINGLE";
    if (type === "STH") sthPool.push(acctId); else buyerAccts.push(acctId);
    const email = isTest ? `${p.fname.toLowerCase()}.${p.lname.toLowerCase()}@bonita.test`
      : chance(0.04) ? null : dirtyEmail(p.email);
    const fname = isTest ? pick(["VOID","TEST","DupCheck"]) : p.fname;
    await acctLoader.push([acctId, email, fname, p.lname, type,
      chance(0.85) ? `${ri(200,989)}-${ri(200,989)}-${ri(1000,9999)}` : null,
      `${ri(100,9999)} ${pick(["Oak","Maple","Main","Elm","Cedar","Park"])} ${pick(["St","Ave","Rd","Ln"])}`,
      p.city, p.st, p.zip,
      ymd(addDays(new Date(`${SEASONS[0]-5}-01-01T00:00:00Z`), ri(0, 365*7)))]);
  }
  await acctLoader.flush();
  console.log(`✓ ticketing.account: ${acctId} (STH pool ${sthPool.length}, buyers ${buyerAccts.length})`);

  // STH membership per season w/ renewal chain (~82% renew) → renewal cohorts.
  const sthBySeason = new Map<number, number[]>();
  let prev: number[] = [];
  for (let s = 0; s < SEASONS.length; s++) {
    const target = Math.min(sthPool.length, 3800 + s * 250);
    const renewed = prev.filter(() => chance(0.82));
    const set = new Set(renewed);
    while (set.size < target) set.add(pick(sthPool));
    const arr = [...set];
    sthBySeason.set(SEASONS[s], arr);
    prev = arr;
  }
  const sthPlan = new Map<string, string>(); // `${season}:${acct}` -> FULL|HALF
  for (const season of SEASONS) for (const a of sthBySeason.get(season)!) sthPlan.set(`${season}:${a}`, chance(0.7) ? "FULL" : "HALF");

  // ── ticketing.seat_txn (the manifest + ledger) ────────────────────────────
  const seatLoader = new Loader(client, "ticketing.seat_txn",
    ["txn_id","event_no","acct_id","sec","seat_row","seat","pl_cd","plan_cd","price_list_cents","price_paid_cents","status_cd","is_resale_flg","orig_acct_id","scan_ts","upd_dt","upd_by"], 400);
  let txnId = 0;
  const scanned = new Map<number, number>();   // scanned-seat count per event → becomes gate_attend
  for (const ev of events) {
    const sth = sthBySeason.get(ev.season)!;
    let sthCursor = ri(0, Math.max(0, sth.length - 1));
    for (let s = 0; s < SEATS_PER_GAME; s++) {
      // weight toward cheaper tiers (realistic house mix → avg paid ~$45, not ~$78)
      const pr = rand();
      const plCd = pr < 0.25 ? "PL1" : pr < 0.5 ? "PL2" : pr < 0.7 ? "PL3" : pr < 0.85 ? "PL4" : pr < 0.95 ? "PL5" : "PL6";
      const listCents = Math.round(PL[plCd] * (0.85 + rand() * 0.6) * (ev.demand > 0.8 ? 1.15 : 1) * 100);
      const sec = pick(["Dugout Box","Field Level","Club Level","Lower Res","Infield Box","Upper Res","Bleachers","Pavilion","RF Porch"]);
      const seatRow = String.fromCharCode(65 + ri(0, 25));
      const seatNo = ri(1, 30);
      const r = rand();
      // ~22% of manifest is season-plan (STH); rest is single/group/comp/etc.
      let acct: number | null, planCd: string | null, type: string;
      if (r < 0.22 && sth.length) { acct = sth[sthCursor % sth.length]; sthCursor += ri(1, 3); planCd = sthPlan.get(`${ev.season}:${acct}`) ?? "FULL"; type = "season"; }
      else if (r < 0.27) { acct = pick(buyerAccts); planCd = null; type = "comp"; }
      else { acct = null; planCd = null; type = "single"; }

      let status: string, paid: number | null, buyer: number | null, resale = false, orig: number | null = null;
      const isComp = type === "comp";
      const isSeason = type === "season";
      const sold = isSeason || isComp || rand() < ev.demand;
      if (sold) {
        buyer = acct ?? pick(buyerAccts);
        // promotional pricing: discount the paid price for promo-priced events
        // (season-plan seats are pre-priced by the plan, so they're exempt). The
        // list price (price_list_cents) is unchanged — the promo shows as paid<list.
        const promoMult = isSeason ? 1 : 1 - ev.priceDisc;
        paid = isComp ? 0 : Math.round(listCents * (0.74 + rand() * 0.38) * promoMult);
        // secondary-market resale on a minority of non-season sold seats
        if (!isSeason && !isComp && chance(0.05)) { resale = true; orig = pick(buyerAccts); }
        if (ev.completed) {
          const rr = rand();
          status = rr < 0.045 ? "RF" : rr < 0.075 ? "XCH" : rr < 0.90 ? "SC" : "SD";
        } else status = chance(0.03) ? "RF" : "SD";
      } else { buyer = null; paid = null; status = chance(0.65) ? "LS" : "HD"; }

      // scan-in time: only scanned (attended) seats get one — fans stream in from
      // ~90 min before first pitch to ~40 min after. NULL for everything else.
      const scanTs = status === "SC" ? addMin(ev.firstPitch, ri(-90, 40)) : null;
      if (status === "SC") scanned.set(ev.no, (scanned.get(ev.no) ?? 0) + 1);
      txnId++;
      await seatLoader.push([txnId, ev.no, buyer, sec, seatRow, seatNo, plCd, planCd, listCents, paid, status,
        resale, orig, scanTs,
        ev.completed ? addDays(ev.date, -ri(0, 60)) : addDays(AS_OF, -ri(0, 25)),
        pick(TKT_STAFF)]);
    }
  }
  await seatLoader.flush();
  console.log(`✓ ticketing.seat_txn: ${txnId}`);

  // Backfill gate_attend = actual scanned-seat count (keeps attendance consistent
  // with the manifest, so per-cap and sell-through are internally correct).
  for (const ev of events) {
    if (!ev.completed) continue;
    await client.query("UPDATE ticketing.event SET gate_attend = $1 WHERE event_no = $2", [scanned.get(ev.no) ?? 0, ev.no]);
  }
  console.log("✓ gate_attend backfilled from scanned seats");

  // ── crm.contact (dupes, dirty email, test rows, nulls) ─────────────────────
  const crmLoader = new Loader(client, "crm.contact",
    ["sfid","email","first_name","last_name","mailing_city","mailing_state","do_not_email","lead_source","cs_notes","is_test__c","created_date"]);
  // a messy, lowercase-ish service note assembled from fragments (mostly NULL).
  const csNote = () => {
    if (!chance(0.12)) return null;
    const parts = [pick(CS_ISSUE)];
    if (chance(0.7)) parts.push(pick(CS_PREF));
    const out = pick(CS_OUTCOME); if (out) parts.push(out);
    let s = parts.join(chance(0.5) ? ". " : "; ");
    if (chance(0.4)) s = s.charAt(0).toUpperCase() + s.slice(1); // inconsistent casing
    return s;
  };
  let sf = 0;
  const sfid = () => `003${String(++sf).padStart(12, "0")}`;
  let crmCount = 0;
  for (let pid = 0; pid < people.length; pid++) {
    if (!chance(0.86)) continue; // most (not all) people are in CRM
    const p = people[pid];
    const created = addDays(new Date(`${SEASONS[0]-4}-01-01T00:00:00Z`), ri(0, 365 * 6));
    const mk = (extraDirty = false) => {
      crmCount++;
      let email = chance(0.05) ? null : dirtyEmail(p.email);
      if (extraDirty && email) email = email.trim().toUpperCase();
      return crmLoader.push([sfid(), email, p.fname, p.lname,
        chance(0.12) ? null : p.city, chance(0.12) ? null : p.st,
        chance(0.18), pick(LEAD_SRC), csNote(), chance(0.012), created]);
    };
    await mk();
    if (chance(0.20)) await mk(true); // duplicate contact (same person, 2nd sfid)
    if (chance(0.05)) await mk();     // occasional triple
  }
  await crmLoader.flush();
  console.log(`✓ crm.contact: ${crmCount} (for ${people.length} people — note the duplication)`);

  // ── sponsorship (contracted deals across seasons) ─────────────────────────
  const partnerL = new Loader(client, "sponsorship.partner", ["partner_id","partner_name","industry","account_owner"]);
  const partners: number[] = [];
  for (let i = 1; i <= N_PARTNERS; i++) {
    partners.push(i);
    await partnerL.push([i, `${pick(["Northstar","Meridian","Apex","Pioneer","Summit","Vertex","Beacon","Cedar","Harbor","Riverbend","Bright","Quorum","Granite","Stonegate","Copper"])} ${pick(["Logistics","Bank","Auto Group","Insurance","Software","Health","Media","Foods","Energy","Partners"])}`,
      pick(PARTNER_INDUSTRIES), pick(["agraves","mfowler","jdelgado","sboone"])]);
  }
  await partnerL.flush();
  const dealL = new Loader(client, "sponsorship.deal", ["deal_id","partner_id","season_yr","status","contract_value","start_dt","end_dt"]);
  const assetL = new Loader(client, "sponsorship.deal_asset", ["asset_id","deal_id","asset_type","location","units","rate_card","allocated_value"]);
  let dealId = 0, assetId = 0;
  for (const partner of partners) {
    // each partner active a contiguous run of seasons (multi-year deals)
    for (const season of SEASONS) {
      const active = chance(0.72);
      if (!active) continue;
      dealId++;
      const completedSeason = season < SEASONS[SEASONS.length - 1] || AS_OF.getTime() > new Date(`${season}-04-01`).getTime();
      const status = season < SEASONS[SEASONS.length - 1] ? "expired" : chance(0.85) ? "active" : chance(0.5) ? "signed" : "proposed";
      // Build the assets FIRST so the relationship is coherent: rate_card is the
      // asset's list price; allocated_value is what it actually sold for = a
      // discount off rate card (so "how far below rate card" is answerable). The
      // deal's contract_value is the sum of its sold asset values.
      const nAssets = ri(3, 8);
      const built: { type: string; loc: string; units: number; rateCard: number; allocated: number }[] = [];
      for (let a = 0; a < nAssets; a++) {
        const [type, loc, base] = pick(ASSET_TYPES);
        const rateCard = round2(base * (0.85 + rand() * 0.3));      // list price for this asset/season
        const allocated = round2(rateCard * (0.72 + rand() * 0.25)); // sold at 72–97% of rate card
        built.push({ type, loc, units: ri(1, 81), rateCard, allocated });
      }
      const contract = round2(built.reduce((s, b) => s + b.allocated, 0));
      await dealL.push([dealId, partner, season, status, contract, ymd(new Date(`${season}-01-15`)), ymd(new Date(`${season}-11-30`))]);
      await dealL.flush(); // ensure the deal row exists before its assets (FK) — deals are few
      for (const b of built) {
        assetId++;
        await assetL.push([assetId, dealId, b.type, b.loc, b.units, b.rateCard, b.allocated]);
      }
    }
  }
  await dealL.flush(); await assetL.flush();
  console.log(`✓ sponsorship: ${partners.length} partners, ${dealId} deals, ${assetId} assets`);

  // ── pos (concessions; completed events only; loyalty rarely populated) ─────
  const standL = new Loader(client, "pos.stand", ["stand_id","stand_name","location_zone"]);
  const stands: number[] = [];
  const STANDS = ["Sec 112 Grill","Bullpen Bar","CF Marketplace","Home Plate Deli","RF Cantina","Upper Concourse","Family Pavilion","Craft Beer Garden","Dugout Sweets","3B Taqueria"];
  for (let i = 0; i < STANDS.length; i++) { stands.push(i + 1); await standL.push([i + 1, STANDS[i], pick(["lower","upper","outfield","club"])]); }
  await standL.flush();
  const knownAccts = [...acctPerson.keys()];
  const posL = new Loader(client, "pos.txn", ["txn_id","event_no","stand_id","ts","tender_type","loyalty_id","subtotal","tax","total"], 500);
  const itemL = new Loader(client, "pos.txn_item", ["item_id","txn_id","item_name","category","qty","unit_price","unit_cost"], 500);
  let posId = 0, itemId = 0;
  for (const ev of events) {
    if (!ev.completed) continue;
    // attendance-driven: ~POS_TXN_RATE of scanned fans make a purchase → realistic per-cap
    const attend = scanned.get(ev.no) ?? 0;
    // spread per-cap across games: promo/high-demand games run hotter
    const txns = Math.round(attend * POS_TXN_RATE * (0.75 + ev.demand * 0.2 + rand() * 0.4));
    const evItems: unknown[][] = [];   // buffer this event's items; insert after its txns are flushed (FK)
    for (let i = 0; i < txns; i++) {
      posId++;
      const tender = pick(["CARD","CARD","CASH","MOBILE","MOBILE"]);
      // loyalty_id ~15% present; when present, usually (not always) a real ticketing acct
      const loyalty = tender !== "CASH" && chance(0.15)
        ? (chance(0.7) ? String(pick(knownAccts)) : `APP${ri(100000, 999999)}`) : null;
      const nItems = ri(1, 3); let subtotal = 0;
      const items: [string, string, number, number, number][] = [];
      for (let k = 0; k < nItems; k++) {
        const [name, cat, basePrice, cost] = pick(FB_ITEMS);
        // concession promotional pricing for promo-priced events (cost unchanged →
        // margin compresses; documented in the fnb_promo knowledge).
        const price = fnbPromoPrice(ev.fnbPromo, name, cat, basePrice);
        const qty = ri(1, 2);
        subtotal += price * qty;
        items.push([name, cat, qty, round2(price), cost]);
      }
      const tax = round2(subtotal * 0.07);
      await posL.push([posId, ev.no, pick(stands), addMin(ev.firstPitch, ri(-30, 180)), tender, loyalty, round2(subtotal), tax, round2(subtotal + tax)]);
      for (const [name, cat, qty, price, cost] of items) { itemId++; evItems.push([itemId, posId, name, cat, qty, price, cost]); }
    }
    await posL.flush();                       // this event's txns are now in the DB
    for (const it of evItems) await itemL.push(it);
  }
  await itemL.flush();
  console.log(`✓ pos: ${posId} txns, ${itemId} items`);

  // ── merch (partial — team online store only) ──────────────────────────────
  const merchL = new Loader(client, "merch.online_order", ["order_id","order_ts","email","sku","item_name","qty","unit_price","channel"]);
  const MERCH = [["jersey","Replica Jersey",120],["hat","Fitted Cap",38],["tee","Graphic Tee",32],["memorabilia","Signed Baseball",90],["kids","Youth Jersey",65],["accessory","Logo Tumbler",24]];
  for (let i = 1; i <= N_MERCH_ORDERS; i++) {
    const [cat, name, base] = MERCH[Math.floor(rand() * MERCH.length)] as [string, string, number];
    const pid = ri(0, people.length - 1);
    await merchL.push([i, addDays(new Date(`${SEASONS[0]}-03-01T00:00:00Z`), ri(0, 365 * SEASONS.length)),
      chance(0.03) ? null : dirtyEmail(people[pid].email),
      `BUL-${cat.slice(0,3).toUpperCase()}-${String(ri(1,400)).padStart(4,"0")}`, name, ri(1, 3), round2(Number(base) * (0.7 + rand() * 0.8)), "online"]);
  }
  await merchL.flush();
  console.log(`✓ merch.online_order: ${N_MERCH_ORDERS} (team online store only — in-venue/retail is Fanatics, not present)`);

  // ── hr (workers, comp, shifts; gameday largely vendor) ────────────────────
  const workerL = new Loader(client, "hr.worker", ["worker_id","first_name","last_name","worker_type","flsa","dept","job_title","mgr_worker_id","hire_dt","term_dt"]);
  const compL = new Loader(client, "hr.comp", ["comp_id","worker_id","comp_type","annual_amt","hourly_rate","effective_dt"]);
  let wId = 0, compId = 0;
  const gamedayWorkers: { id: number; rate: number }[] = [];
  const EXEC = [["President / GM","Executive",285000,null],["VP Ticketing","Ticketing",175000,1],["VP Partnerships","Sponsorship",178000,1],["VP Marketing","Marketing",168000,1],["VP Operations","Operations",165000,1],["CFO","Finance",210000,1],["Controller","Finance",135000,6],["HR Director","People",128000,1]] as const;
  for (const [title, dept, salary, mgr] of EXEC) {
    wId++; await workerL.push([wId, pick(FIRST), pick(LAST), "employee", "exempt", dept, title, mgr, ymd(addDays(new Date(`${SEASONS[0]-8}-01-01`), ri(0, 365*5))), null]);
    compId++; await compL.push([compId, wId, "salary", round2(salary), null, ymd(new Date(`${SEASONS[SEASONS.length-1]}-01-01`))]);
  }
  for (let i = 0; i < 110; i++) { // salaried ICs
    wId++; const dept = pick(["Ticketing","Sponsorship","Marketing","Operations","Finance","Retail","People"]);
    const ended = chance(0.10);
    const hire = addDays(new Date(`${SEASONS[0]-6}-01-01`), ri(0, 365*5));
    await workerL.push([wId, pick(FIRST), pick(LAST), "employee", chance(0.5) ? "exempt" : "non-exempt", dept, pick(["Account Executive","Coordinator","Manager","Analyst","Specialist"]), pick([2,3,4,5,6]), ymd(hire), ended ? ymd(addDays(hire, ri(400,1500))) : null]);
    compId++; await compL.push([compId, wId, "salary", round2(ri(48000, 95000)), null, ymd(hire)]);
  }
  for (let i = 0; i < 260; i++) { // contingent gameday workers
    wId++; const rate = round2(15 + rand() * 9);
    const hire = addDays(new Date(`${SEASONS[0]-2}-02-01`), ri(0, 365*3));
    await workerL.push([wId, pick(FIRST), pick(LAST), "contingent", "non-exempt", "Gameday", pick(["Usher","Concessions","Security","Cleaning","Ticket Scanner","Grounds"]), pick([5,8]), ymd(hire), chance(0.15) ? ymd(addDays(hire, ri(200,900))) : null]);
    compId++; await compL.push([compId, wId, "hourly", null, rate, ymd(hire)]);
    gamedayWorkers.push({ id: wId, rate });
  }
  await workerL.flush(); await compL.flush();
  console.log(`✓ hr.worker: ${wId}, hr.comp: ${compId} (gameday pool ${gamedayWorkers.length})`);

  const shiftL = new Loader(client, "hr.shift", ["shift_id","event_no","worker_id","role","sched_in","sched_out","actual_in","actual_out","pay_rate","staffed_by"], 500);
  let shiftId = 0;
  for (const ev of events) {
    const n = STAFF_PER_GAME + ri(-30, 30);
    for (let i = 0; i < n; i++) {
      shiftId++;
      // ~55% of gameday roles are vendor-staffed → no HR worker row
      const vendor = chance(0.55);
      const w = vendor ? null : pick(gamedayWorkers);
      const rate = vendor ? round2(15 + rand() * 8) : w!.rate;
      const si = addMin(ev.firstPitch, -ri(90, 150)), so = addMin(ev.firstPitch, ri(180, 240));
      await shiftL.push([shiftId, ev.no, vendor ? null : w!.id, pick(["usher","concessions","security","cleaning","ticketing","grounds","guest_services"]),
        si, so, ev.completed ? addMin(si, ri(-10, 20)) : null, ev.completed ? addMin(so, ri(-20, 40)) : null,
        rate, vendor ? "vendor" : "team"]);
    }
  }
  await shiftL.flush();
  console.log(`✓ hr.shift: ${shiftId}`);

  // ── marketing.ad_spend (per-platform exports) ─────────────────────────────
  const adL = new Loader(client, "marketing.ad_spend", ["row_id","platform","campaign","objective","season_yr","spend","impressions","clicks","reach","start_dt","end_dt"]);
  let adId = 0;
  for (const season of SEASONS) {
    for (let i = 0; i < 300; i++) {
      adId++;
      const platform = pick(MK_PLATFORMS);
      const spend = round2(ri(500, 45000));
      const cpm = platform === "tv" ? 18 + rand()*22 : platform === "ooh" ? 6 + rand()*8 : platform === "radio" ? 8 + rand()*7 : platform === "meta" ? 7 + rand()*9 : platform === "email" ? 1 + rand()*2 : 4 + rand()*5;
      const impressions = Math.max(1000, Math.round(spend / cpm * 1000));
      const clickable = platform === "google" || platform === "meta" || platform === "email";
      const start = addDays(new Date(`${season}-01-15`), ri(0, 250));
      await adL.push([adId, platform, `${pick(MK_OBJ)}_${platform}_${ymd(start).slice(0,7)}`, pick(MK_OBJ), season,
        spend, impressions, clickable ? Math.round(impressions * (0.005 + rand()*0.02)) : null,
        Math.round(impressions * (0.35 + rand()*0.4)), ymd(start), ymd(addDays(start, ri(7, 45)))]);
    }
  }
  await adL.flush();
  console.log(`✓ marketing.ad_spend: ${adId}`);

  // ── ops.incident (gameday incident log; completed events only) ────────────
  const incL = new Loader(client, "ops.incident",
    ["incident_id","event_no","reported_ts","incident_type","severity","zone","status","reported_by","resolved_ts","notes"], 500);
  // weighted incident-type picker
  const incTotal = INCIDENT_TYPES.reduce((s, t) => s + t[1], 0);
  const pickIncident = (): [string, string] => {
    let r = rand() * incTotal;
    for (const [type, w, sev] of INCIDENT_TYPES) { if ((r -= w) < 0) return [type, sev]; }
    return [INCIDENT_TYPES[0][0], INCIDENT_TYPES[0][2]];
  };
  let incId = 0;
  for (const ev of events) {
    if (!ev.completed) continue;
    const attend = scanned.get(ev.no) ?? 0;
    // incident volume scales with crowd: ~1 per 2.5k fans, plus noise
    const n = Math.max(1, Math.round(attend / 2500) + ri(-1, 2));
    for (let i = 0; i < n; i++) {
      incId++;
      const [type, baseSev] = pickIncident();
      // occasionally bump severity for an otherwise-low type
      const severity = chance(0.12) ? (baseSev === "low" ? "medium" : "high") : baseSev;
      const reported = addMin(ev.firstPitch, ri(-45, 210));
      // most incidents resolve same-day; a few stay open (recent games especially)
      const open = chance(0.08);
      const resolved = open ? null : addMin(reported, ri(3, 90));
      await incL.push([incId, ev.no, reported.toISOString(), type, severity, pick(INCIDENT_ZONES),
        open ? "open" : "resolved", pick(INCIDENT_REPORTERS),
        resolved ? resolved.toISOString() : null, pick(INCIDENT_NOTES[type])]);
    }
  }
  await incL.flush();
  console.log(`✓ ops.incident: ${incId}`);

  // ── media.rights_deal (broadcast rights — the club's biggest revenue line) ─
  // Four packages per season summing to ~$80–100M: regional sports network (the
  // bulk), a national-broadcast slice, streaming, and radio. Slight YoY growth.
  const mediaL = new Loader(client, "media.rights_deal",
    ["deal_id","rightsholder","rights_type","season_yr","annual_value","status","start_dt","end_dt"]);
  const MEDIA_PKGS: [string, string, number, number][] = [
    // [rightsholder, rights_type, min$, max$]
    ["Pacific Sports Network", "regional", 48_000_000, 56_000_000],
    ["National Broadcast Co.",  "national", 20_000_000, 26_000_000],
    ["StreamCast+",             "streaming", 7_000_000, 12_000_000],
    ["BulldogsRadio 1180 AM",   "radio",     3_000_000,  5_000_000],
  ];
  let mediaId = 0;
  const lastSeason = SEASONS[SEASONS.length - 1];
  for (const season of SEASONS) {
    const growth = 1 + (season - SEASONS[0]) * 0.04; // ~4% per season
    for (const [holder, type, lo, hi] of MEDIA_PKGS) {
      mediaId++;
      const value = round2((lo + rand() * (hi - lo)) * growth);
      await mediaL.push([mediaId, holder, type, season, value,
        season < lastSeason ? "expired" : "active",
        ymd(new Date(`${season}-01-01`)), ymd(new Date(`${season}-12-31`))]);
    }
  }
  await mediaL.flush();
  console.log(`✓ media.rights_deal: ${mediaId}`);

  await client.query("ANALYZE");
  const c = await client.query(`SELECT
    (SELECT count(*) FROM ticketing.seat_txn) seat_txn,
    (SELECT count(*) FROM ticketing.account) accounts,
    (SELECT count(*) FROM crm.contact) crm_contacts,
    (SELECT count(*) FROM pos.txn) pos_txns,
    (SELECT count(*) FROM pos.txn_item) pos_items,
    (SELECT count(*) FROM sponsorship.deal) deals,
    (SELECT count(*) FROM hr.shift) shifts,
    (SELECT count(*) FROM merch.online_order) merch_orders,
    (SELECT count(*) FROM marketing.ad_spend) ad_rows,
    (SELECT count(*) FROM ops.incident) incidents,
    (SELECT count(*) FROM media.rights_deal) media_deals`);
  console.log("✓ done —", c.rows[0]);
  await client.end();
}

main().catch((e) => { console.error("generate failed:", e); process.exit(1); });
