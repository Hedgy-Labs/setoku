// SPDX-License-Identifier: Apache-2.0
//
// Deterministic synthetic-data generator for the Setoku sports demo.
// Fictional franchise: the "Riverside Stags" — NOT based on any real team.
//
// Runs the schema (schema.sql) then fills every table with believable,
// internally-consistent rows. Seeded PRNG → identical output every run for a
// given SEED, so demos are reproducible.
//
//   DATABASE_URL=postgres://...  bun generate.ts
//
// Scale knobs (env, all optional):
//   SEED                 PRNG seed (default 1337)
//   SEASON_YEAR          season year (default 2026)
//   AS_OF                "today" — games before are completed, after upcoming (default <year>-06-22)
//   SEATS_PER_GAME       ticket rows per game (default 6000; set 38000 for a full MLB house)
//   N_FANS               unique fans (default 60000)
//   CONCESSIONS_PER_GAME concession transactions per *completed* game (default 1200)
//   STAFF_PER_GAME       gameday shifts per game (default 450)
//   N_MERCH              merchandise SKUs (default 400)
//   N_CAMPAIGNS          marketing spend lines (default 600)

import pgPkg from "pg";
const { Client } = pgPkg;
import fs from "node:fs";
import path from "node:path";

// ── config ────────────────────────────────────────────────────────────────
const DB_URL =
  process.env.DATABASE_URL ||
  process.env.SETOKU_DATABASE_URL ||
  "postgres://postgres:demo@127.0.0.1:5432/stags";
const SEED = Number(process.env.SEED ?? 1337);
const SEASON_YEAR = Number(process.env.SEASON_YEAR ?? 2026);
const AS_OF = new Date(process.env.AS_OF ?? `${SEASON_YEAR}-06-22T12:00:00Z`);
const N_GAMES = 81;
const SEATS_PER_GAME = Number(process.env.SEATS_PER_GAME ?? 6000);
const N_FANS = Number(process.env.N_FANS ?? 60000);
const CONCESSIONS_PER_GAME = Number(process.env.CONCESSIONS_PER_GAME ?? 1200);
const STAFF_PER_GAME = Number(process.env.STAFF_PER_GAME ?? 450);
const N_MERCH = Number(process.env.N_MERCH ?? 400);
const N_CAMPAIGNS = Number(process.env.N_CAMPAIGNS ?? 600);
const CAPACITY = 38000;

// ── seeded PRNG (mulberry32) ────────────────────────────────────────────────
function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
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
const cents = (dollars: number) => Math.round(dollars * 100);
const gauss = (mean: number, sd: number) => {
  // Box–Muller, clamped enough for synthetic data
  const u = 1 - rand();
  const v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const dayMs = 86400000;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * dayMs);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

// ── content pools (all fictional) ───────────────────────────────────────────
const OPPONENTS = [
  "Capital City Crows", "Lakeside Otters", "Granite Bay Miners",
  "Harbor City Anchors", "Summit Pioneers", "Delta Catfish",
  "Ironwood Lumberjacks", "Coral Coast Tarpons", "Prairie Wind Bisons",
  "Copper Canyon Scorpions", "Maple Ridge Foxes", "Bayou City Pelicans",
  "Frost Valley Yetis", "Sandstone Coyotes",
];
// fictional Stags roster used for "favorite player"
const PLAYERS = [
  "Dom Alvarez", "Tyrese Booker", "J. Marsh", "Ravi Chandra", "Cole Whitman",
  "Mateo Rios", "Shawn Kelleher", "Andre Boudreau", "Kenji Tanaka", "Luis Ferreira",
  "Brock Hutchins", "Eli Sandoval", "Marcus Vance", "Pavel Novak", "Deshawn Pope",
  "Owen Castellano", "Hideo Yamamoto", "Grant Maddox", "Ferdy Ortiz", "Beau Larkin",
];
const FIRST = [
  "James","Mary","Robert","Patricia","John","Jennifer","Michael","Linda","David","Elizabeth",
  "William","Barbara","Richard","Susan","Joseph","Jessica","Thomas","Sarah","Chris","Karen",
  "Daniel","Nancy","Matthew","Lisa","Anthony","Margaret","Mark","Betty","Donald","Sandra",
  "Steven","Ashley","Paul","Kimberly","Andrew","Emily","Joshua","Donna","Kenneth","Michelle",
  "Kevin","Carol","Brian","Amanda","George","Melissa","Edward","Deborah","Ronald","Stephanie",
  "Aisha","Diego","Wei","Priya","Omar","Sofia","Hyun","Fatima","Mateo","Yuki",
];
const LAST = [
  "Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez",
  "Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin",
  "Lee","Perez","Thompson","White","Harris","Sanchez","Clark","Ramirez","Lewis","Robinson",
  "Walker","Young","Allen","King","Wright","Scott","Torres","Nguyen","Hill","Flores",
  "Okafor","Petrov","Nakamura","Kowalski","Ahmed","Silva","Cohen","Murphy","Reyes","Brooks",
];
const CITIES = [
  ["Riverside","OH","45011"],["Fairview","OH","43615"],["Oakdale","IN","46060"],
  ["Lakewood","OH","44107"],["Springfield","IL","62701"],["Madison","WI","53703"],
  ["Clinton","IA","52732"],["Georgetown","KY","40324"],["Salem","OH","44460"],
  ["Ashland","OH","44805"],["Brookfield","WI","53005"],["Carmel","IN","46032"],
];
const EMPLOYERS = [
  "Northstar Logistics","Beacon Health","Meridian Bank","Cohen & Park LLP","Atlas Manufacturing",
  "Brightline Schools","Cedar Valley Hospital","Vertex Software","Riverstone Realty","Union Pacific",
  "Greenfield Foods","Pioneer Insurance","Summit Auto Group","Lakeshore University","self-employed",
  "retired","City of Riverside","Apex Construction","Harborview Media","Quorum Consulting",
];
const PAY_BRANDS = ["visa","visa","visa","mastercard","mastercard","amex","discover","paypal"];
const SECTIONS: [string, number][] = [
  // [section, base price $]
  ["Dugout Box", 120], ["Field Level", 75], ["Club Level", 95],
  ["Lower Reserved", 45], ["Infield Box", 60], ["Upper Reserved", 28],
  ["Bleachers", 22], ["Pavilion", 30], ["Right Field Porch", 35],
];
const TICKET_STAFF = [
  "rprice@stags.example","mlopez@stags.example","tgreen@stags.example",
  "kshah@stags.example","dcarter@stags.example","system-dynamic-pricing",
];
const SPONSORS = [
  "Northstar Logistics","Meridian Bank","Greenfield Foods","Apex Construction",
  "Pioneer Insurance","Summit Auto Group","Vertex Software","Beacon Health",
  "Cedar Valley Hospital","Harborview Media","Union Pacific","Brightline Schools",
];
const SPONSOR_STAFF = ["agraves@stags.example","mfowler@stags.example","jdelgado@stags.example"];
const MERCH_VENDORS = ["FanThread Apparel","Diamond Headwear","Keystone Sporting Goods","Cooperstown Collectibles","Little Sluggers Co."];
const FB_ITEMS: [string, string, number, number][] = [
  // [name, category, price$, cost$]
  ["Classic Hot Dog","food",6.5,1.4],["Loaded Bratwurst","food",9.0,2.6],
  ["Nachos Grande","food",11.0,2.9],["Garlic Fries","food",8.5,1.8],
  ["Cheeseburger","food",12.0,3.4],["Soft Pretzel","food",7.0,1.1],
  ["Personal Pizza","food",10.5,2.7],["Chicken Tenders","food",12.5,3.6],
  ["Bottled Water","beverage",4.5,0.4],["Fountain Soda","beverage",5.5,0.5],
  ["Iced Coffee","beverage",6.0,0.9],["Lemonade","beverage",5.5,0.6],
  ["Draft Beer","alcohol",12.0,2.2],["Craft IPA","alcohol",14.0,3.0],
  ["Hard Seltzer","alcohol",13.0,2.4],["House Margarita","alcohol",15.0,3.1],
  ["Soft Serve Helmet","dessert",9.5,1.6],["Funnel Cake","dessert",10.0,2.0],
  ["Cotton Candy","dessert",6.0,0.7],["Churros","dessert",8.0,1.4],
];
const FB_STANDS = [
  "Section 112 Grill","Bullpen Bar","Center Field Marketplace","Home Plate Deli",
  "Right Field Cantina","Upper Concourse Stand","Family Pavilion Kiosk","Craft Beer Garden",
  "Dugout Sweets","Third Base Taqueria",
];
const STAFF_ROLES = ["usher","concessions","security","cleaning","ticketing","grounds","guest_services"];
const MK_CHANNELS = ["social","seo","aeo_geo","ooh","radio","tv"];
const MK_OBJECTIVES = ["awareness","ticket_sales","merch","membership"];

// ── batched inserter ────────────────────────────────────────────────────────
class Loader {
  private rows: unknown[][] = [];
  constructor(
    private client: pgPkg.Client,
    private table: string,
    private cols: string[],
    private batch = 500,
  ) {}
  async push(row: unknown[]) {
    this.rows.push(row);
    if (this.rows.length >= this.batch) await this.flush();
  }
  async flush() {
    if (!this.rows.length) return;
    const n = this.cols.length;
    const params: unknown[] = [];
    const tuples = this.rows.map((r, i) => {
      const ph = r.map((_, j) => `$${i * n + j + 1}`);
      params.push(...r);
      return `(${ph.join(",")})`;
    });
    await this.client.query(
      `INSERT INTO ${this.table} (${this.cols.join(",")}) VALUES ${tuples.join(",")}`,
      params,
    );
    this.rows = [];
  }
}

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  console.log(`→ connected; seeding (SEED=${SEED}, season=${SEASON_YEAR}, seats/game=${SEATS_PER_GAME})`);

  const schema = fs.readFileSync(path.join(import.meta.dir, "schema.sql"), "utf8");
  await client.query(schema);
  console.log("→ schema applied");

  // ── games ────────────────────────────────────────────────────────────────
  // 81 home games, Apr 1 → late Sep, roughly every other day in homestands.
  const seasonStart = new Date(`${SEASON_YEAR}-04-01T18:00:00Z`);
  type Game = { id: number; date: Date; demand: number; completed: boolean; attendance: number };
  const games: Game[] = [];
  const gameLoader = new Loader(client, "games",
    ["game_id","season","game_date","opponent","day_night","is_weekend","is_promo","promo_name","paid_attendance"]);
  let cursor = 0;
  for (let g = 1; g <= N_GAMES; g++) {
    // advance 1–3 days between games; bunch into homestands
    cursor += g === 1 ? 0 : pick([1, 1, 2, 2, 3]);
    const date = addDays(seasonStart, cursor);
    const dow = date.getUTCDay();
    const isWeekend = dow === 0 || dow === 5 || dow === 6;
    const isPromo = chance(0.22);
    const opp = pick(OPPONENTS);
    const dayNight = isWeekend && chance(0.5) ? "day" : "night";
    // demand 0..1 from weekend/promo/opponent draw + noise
    let demand = 0.55 + (isWeekend ? 0.18 : 0) + (isPromo ? 0.16 : 0) + gauss(0, 0.08);
    demand = Math.max(0.3, Math.min(0.99, demand));
    const completed = date.getTime() < AS_OF.getTime();
    const attendance = Math.round(CAPACITY * demand);
    const promoName = isPromo
      ? pick(["Bobblehead Night","Fireworks Friday","Cap Giveaway","Kids Run the Bases","Jersey Giveaway","Dollar Dog Night","Throwback Night","Fan Appreciation"])
      : null;
    games.push({ id: g, date, demand, completed, attendance });
    await gameLoader.push([g, SEASON_YEAR, ymd(date), opp, dayNight, isWeekend, isPromo, promoName, attendance]);
  }
  await gameLoader.flush();
  console.log(`✓ games: ${games.length}`);

  // ── fans ───────────────────────────────────────────────────────────────────
  const fanLoader = new Loader(client, "fans",
    ["fan_id","email","first_name","last_name","phone","street","city","state","postal_code",
     "payment_brand","payment_last4","employer","has_children","favorite_player","created_at"]);
  const usedEmail = new Set<string>();
  for (let f = 1; f <= N_FANS; f++) {
    const first = pick(FIRST), last = pick(LAST);
    let email = `${first.toLowerCase()}.${last.toLowerCase()}${ri(1, 9999)}@example.com`;
    while (usedEmail.has(email)) email = `${first.toLowerCase()}.${last.toLowerCase()}${ri(1, 99999)}@example.com`;
    usedEmail.add(email);
    const [city, state, zip] = pick(CITIES);
    const created = addDays(new Date(`${SEASON_YEAR - 4}-01-01T00:00:00Z`), ri(0, 365 * 4 + 150));
    await fanLoader.push([
      f, email, first, last,
      `${ri(200, 989)}-${ri(200, 989)}-${ri(1000, 9999)}`,
      `${ri(100, 9999)} ${pick(["Oak","Maple","Main","Elm","Cedar","Park","Lake","Pine","Hill","River"])} ${pick(["St","Ave","Rd","Ln","Dr","Ct"])}`,
      city, state, zip,
      pick(PAY_BRANDS), String(ri(0, 9999)).padStart(4, "0"),
      chance(0.7) ? pick(EMPLOYERS) : null,
      chance(0.45), chance(0.85) ? pick(PLAYERS) : null,
      created,
    ]);
  }
  await fanLoader.flush();
  console.log(`✓ fans: ${N_FANS}`);

  // ── hr_employees (front office + gameday workforce) ─────────────────────────
  const empLoader = new Loader(client, "hr_employees",
    ["employee_id","first_name","last_name","email","street","city","state","postal_code",
     "worker_type","salary_cents","hourly_rate_cents","bonus_cents","vacation_days","department",
     "title","manager_id","start_date","end_date"]);
  type GdEmp = { id: number; name: string; hourly: number };
  const gameday: GdEmp[] = [];
  let empId = 0;
  const emailFor = (f: string, l: string, id: number) => `${f.toLowerCase()}.${l.toLowerCase()}${id}@stags.example`;

  // leadership chain so manager_id resolves (each references a prior id)
  const FRONT = [
    ["President / GM", "Executive", 285000, 60000, null],
    ["VP, Ticketing", "Ticketing", 175000, 30000, 1],
    ["VP, Corporate Partnerships", "Sponsorship", 178000, 32000, 1],
    ["VP, Marketing", "Marketing", 168000, 28000, 1],
    ["VP, Operations", "Operations", 165000, 26000, 1],
    ["CFO", "Finance", 210000, 40000, 1],
    ["Director, Ticket Sales", "Ticketing", 118000, 18000, 2],
    ["Director, Concessions", "Operations", 112000, 15000, 5],
    ["Director, Merchandise", "Retail", 108000, 14000, 5],
    ["Director, Brand", "Marketing", 121000, 16000, 4],
    ["Controller", "Finance", 135000, 18000, 6],
    ["HR Director", "People", 128000, 16000, 1],
  ] as const;
  for (const [title, dept, salary, bonus, mgr] of FRONT) {
    empId++;
    const first = pick(FIRST), last = pick(LAST);
    const [city, state, zip] = pick(CITIES);
    const start = addDays(new Date(`${SEASON_YEAR - 9}-01-01T00:00:00Z`), ri(0, 365 * 7));
    await empLoader.push([
      empId, first, last, emailFor(first, last, empId),
      `${ri(100, 9999)} ${pick(["Oak","Maple","Main","Elm"])} St`, city, state, zip,
      "W2", cents(salary), null, cents(bonus), ri(15, 25), dept, title, mgr, ymd(start), null,
    ]);
  }
  // salaried individual contributors across departments
  const IC_TITLES: [string, string, number][] = [
    ["Account Executive, Group Sales","Ticketing",62000],
    ["Account Executive, Premium","Ticketing",68000],
    ["Partnership Manager","Sponsorship",74000],
    ["Marketing Coordinator","Marketing",54000],
    ["Social Media Manager","Marketing",61000],
    ["Operations Coordinator","Operations",52000],
    ["Retail Buyer","Retail",58000],
    ["Staff Accountant","Finance",66000],
    ["Data Analyst","Finance",78000],
    ["Guest Services Manager","Operations",57000],
  ];
  for (let i = 0; i < 48; i++) {
    empId++;
    const [title, dept, base] = pick(IC_TITLES);
    const first = pick(FIRST), last = pick(LAST);
    const [city, state, zip] = pick(CITIES);
    const start = addDays(new Date(`${SEASON_YEAR - 6}-01-01T00:00:00Z`), ri(0, 365 * 5));
    const ended = chance(0.08);
    await empLoader.push([
      empId, first, last, emailFor(first, last, empId),
      `${ri(100, 9999)} ${pick(["Oak","Maple","Main","Elm"])} St`, city, state, zip,
      "W2", cents(Math.round(base * (0.9 + rand() * 0.3))), null,
      cents(ri(2000, 9000)), ri(10, 20), dept,
      title, pick([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), ymd(start),
      ended ? ymd(addDays(start, ri(400, 1500))) : null,
    ]);
  }
  // gameday hourly / 1099 workforce — referenced by staffing
  const GD_ROLES: [string, number][] = [
    ["Usher", 16], ["Concessions Attendant", 17], ["Security Officer", 22],
    ["Cleaning Crew", 16], ["Ticket Scanner", 17], ["Grounds Crew", 21], ["Guest Services Rep", 18],
  ];
  for (let i = 0; i < 700; i++) {
    empId++;
    const [title, wage] = pick(GD_ROLES);
    const first = pick(FIRST), last = pick(LAST);
    const [city, state, zip] = pick(CITIES);
    const worker = chance(0.25) ? "1099" : "W2";
    const hourly = cents(wage + rand() * 5);
    const start = addDays(new Date(`${SEASON_YEAR - 3}-02-01T00:00:00Z`), ri(0, 365 * 3));
    await empLoader.push([
      empId, first, last, emailFor(first, last, empId),
      `${ri(100, 9999)} ${pick(["Oak","Maple","Main","Elm"])} St`, city, state, zip,
      worker, null, hourly, 0, worker === "W2" ? ri(0, 5) : 0, "Gameday Staff",
      title, pick([5, 8]), ymd(start), chance(0.12) ? ymd(addDays(start, ri(200, 900))) : null,
    ]);
    gameday.push({ id: empId, name: `${first} ${last}`, hourly });
  }
  await empLoader.flush();
  console.log(`✓ hr_employees: ${empId} (gameday pool ${gameday.length})`);

  // ── tickets ─────────────────────────────────────────────────────────────────
  let ticketId = 0;
  let groupSeq = 0;
  const ticketLoader = new Loader(client, "tickets",
    ["ticket_id","game_id","section","seat_row","seat","ticket_type","status","group_id",
     "buyer_fan_id","listed_price_cents","sold_price_cents","price_updated_by","updated_at"], 400);
  for (const game of games) {
    const sellThrough = game.demand; // fraction of seats that end up sold
    // a handful of group/corporate clusters per game
    let activeGroup: { id: number; left: number } | null = null;
    for (let s = 0; s < SEATS_PER_GAME; s++) {
      const [section, basePrice] = pick(SECTIONS);
      const row = String.fromCharCode(65 + ri(0, 25)) + (chance(0.3) ? String(ri(1, 3)) : "");
      const seatNo = ri(1, 30);
      // ticket type mix
      let ttype: string;
      const r = rand();
      if (r < 0.24) ttype = "season";
      else if (r < 0.30) ttype = "comp";
      else if (r < 0.40) ttype = "corporate";
      else if (r < 0.55) ttype = "group";
      else if (r < 0.66) ttype = "premium";
      else ttype = "single";

      // group / corporate seats cluster under a shared group_id
      let groupId: number | null = null;
      if (ttype === "group" || ttype === "corporate") {
        if (!activeGroup || activeGroup.left <= 0) {
          groupSeq++;
          activeGroup = { id: groupSeq, left: ri(4, 20) };
        }
        groupId = activeGroup.id;
        activeGroup.left--;
      }

      const listed = cents(basePrice * (0.85 + rand() * 0.6) * (game.demand > 0.8 ? 1.15 : 1));
      // decide sold vs unsold
      const isSeason = ttype === "season";
      const isComp = ttype === "comp";
      const sold = isSeason || isComp || rand() < sellThrough;

      let status: string, soldPrice: number | null, buyer: number | null, updatedBy: string | null;
      if (sold) {
        buyer = ri(1, N_FANS);
        soldPrice = isComp ? 0 : Math.round(listed * (0.9 + rand() * 0.5));
        updatedBy = pick(TICKET_STAFF);
        if (game.completed) status = chance(0.92) ? "scanned" : "sold"; // no-shows stay 'sold'
        else status = "sold";
      } else {
        buyer = null;
        soldPrice = null;
        updatedBy = chance(0.5) ? pick(TICKET_STAFF) : null;
        status = chance(0.65) ? "listed" : "hold";
      }
      const updatedAt = game.completed
        ? addDays(game.date, -ri(0, 40))
        : addDays(AS_OF, -ri(0, 20));
      ticketId++;
      await ticketLoader.push([
        ticketId, game.id, section, row, seatNo, ttype, status, groupId,
        buyer, listed, soldPrice, updatedBy, updatedAt,
      ]);
    }
  }
  await ticketLoader.flush();
  console.log(`✓ tickets: ${ticketId}`);

  // ── sponsorships ────────────────────────────────────────────────────────────
  let sponsorshipId = 0;
  const sponLoader = new Loader(client, "sponsorships",
    ["sponsorship_id","game_id","inventory_type","location","status","sponsor_name",
     "rate_card_cents","sold_price_cents","sold_by"]);
  const INV: [string, string, number][] = [
    ["led_signage","outfield",4500],["led_signage","behind_home_plate",6500],
    ["static_signage","outfield",2500],["static_signage","infield",3000],
    ["digital","digital",3500],["event_activation","concourse",5000],
    ["led_signage","infield",4000],["static_signage","concourse",1800],
  ];
  for (const game of games) {
    const perGame = ri(45, 70);
    for (let i = 0; i < perGame; i++) {
      sponsorshipId++;
      const [type, loc, rate] = pick(INV);
      const rateCard = cents(rate * (0.8 + rand() * 0.6));
      // premium games + premium locations sell better
      const sellP = 0.6 + (game.demand > 0.8 ? 0.15 : 0) + (loc === "behind_home_plate" ? 0.1 : 0);
      let status: string, sponsor: string | null, soldPrice: number | null, soldBy: string | null;
      if (rand() < sellP) {
        status = "sold"; sponsor = pick(SPONSORS);
        soldPrice = Math.round(rateCard * (0.82 + rand() * 0.35)); soldBy = pick(SPONSOR_STAFF);
      } else if (chance(0.4)) {
        status = "held"; sponsor = pick(SPONSORS); soldPrice = null; soldBy = pick(SPONSOR_STAFF);
      } else {
        status = "available"; sponsor = null; soldPrice = null; soldBy = null;
      }
      await sponLoader.push([sponsorshipId, game.id, type, loc, status, sponsor, rateCard, soldPrice, soldBy]);
    }
  }
  await sponLoader.flush();
  console.log(`✓ sponsorships: ${sponsorshipId}`);

  // ── merchandise ─────────────────────────────────────────────────────────────
  const merchLoader = new Loader(client, "merchandise",
    ["sku","name","description","category","size","color","list_price_cents","purchase_price_cents",
     "is_bundle","channel","vendor","quantity_available"]);
  const MCATS: [string, number, string[], string[]][] = [
    ["jersey", 130, ["S","M","L","XL","XXL"], ["home white","road gray","alternate green","throwback"]],
    ["hat", 35, ["adj","S/M","L/XL"], ["green","white","black","camo"]],
    ["tee", 32, ["S","M","L","XL","XXL"], ["green","gray","navy","white"]],
    ["memorabilia", 90, [null as unknown as string], ["n/a"]],
    ["kids", 28, ["2T","4T","YS","YM","YL"], ["green","white"]],
    ["accessory", 22, [null as unknown as string], ["green","mixed"]],
  ];
  for (let i = 1; i <= N_MERCH; i++) {
    const [cat, base, sizes, colors] = pick(MCATS);
    const list = cents(base * (0.6 + rand() * 1.2));
    const bundle = chance(0.12);
    const sku = `STG-${cat.slice(0, 3).toUpperCase()}-${String(i).padStart(4, "0")}`;
    const name = `${pick(["Stags","Riverside","Home","Replica","Authentic","Classic","Retro"])} ${cat[0].toUpperCase() + cat.slice(1)}`;
    await merchLoader.push([
      sku, name, `${name} — official team merchandise`, cat, pick(sizes), pick(colors),
      list, Math.round(list * (0.32 + rand() * 0.18)), bundle,
      pick(["digital","brick_mortar","both","both"]), pick(MERCH_VENDORS), ri(0, 800),
    ]);
  }
  await merchLoader.flush();
  console.log(`✓ merchandise: ${N_MERCH}`);

  // ── concessions (completed games only) ──────────────────────────────────────
  let concessionId = 0;
  const concLoader = new Loader(client, "concessions",
    ["concession_id","game_id","stand_location","item_name","category","unit_price_cents",
     "unit_cost_cents","quantity","payment_method","fan_id","sold_at"], 500);
  for (const game of games) {
    if (!game.completed) continue;
    const txns = Math.round(CONCESSIONS_PER_GAME * (0.7 + game.demand * 0.6));
    for (let i = 0; i < txns; i++) {
      concessionId++;
      const [item, cat, price, cost] = pick(FB_ITEMS);
      const pay = pick(["card","card","cash","mobile","mobile"]);
      const fanId = pay !== "cash" && chance(0.55) ? ri(1, N_FANS) : null;
      const soldAt = new Date(game.date.getTime() + ri(-30, 180) * 60000);
      await concLoader.push([
        concessionId, game.id, pick(FB_STANDS), item, cat,
        cents(price), cents(cost), ri(1, 4), pay, fanId, soldAt,
      ]);
    }
  }
  await concLoader.flush();
  console.log(`✓ concessions: ${concessionId}`);

  // ── staffing ────────────────────────────────────────────────────────────────
  let shiftId = 0;
  const staffLoader = new Loader(client, "staffing",
    ["shift_id","game_id","employee_id","employee_name","role","scheduled_start","scheduled_end",
     "clock_in","clock_out","hourly_wage_cents","status"], 500);
  for (const game of games) {
    const shifts = STAFF_PER_GAME + ri(-30, 30);
    for (let i = 0; i < shifts; i++) {
      shiftId++;
      const emp = pick(gameday);
      const schedStart = new Date(game.date.getTime() - ri(90, 150) * 60000);
      const schedEnd = new Date(game.date.getTime() + ri(180, 240) * 60000);
      let clockIn: Date | null = null, clockOut: Date | null = null, status: string;
      if (game.completed) {
        status = "completed";
        clockIn = new Date(schedStart.getTime() + ri(-10, 20) * 60000);
        clockOut = new Date(schedEnd.getTime() + ri(-20, 40) * 60000);
      } else {
        status = "upcoming";
      }
      await staffLoader.push([
        shiftId, game.id, emp.id, emp.name, pick(STAFF_ROLES),
        schedStart, schedEnd, clockIn, clockOut, emp.hourly, status,
      ]);
    }
  }
  await staffLoader.flush();
  console.log(`✓ staffing: ${shiftId}`);

  // ── marketing_spend ──────────────────────────────────────────────────────────
  const mkLoader = new Loader(client, "marketing_spend",
    ["campaign_id","campaign_name","channel","objective","spend_cents","reach","impressions",
     "cpm_cents","cpc_cents","start_date","end_date"]);
  for (let i = 1; i <= N_CAMPAIGNS; i++) {
    const channel = pick(MK_CHANNELS);
    const objective = pick(MK_OBJECTIVES);
    const spendCents = cents(ri(500, 45000)); // $500 – $45k
    // delivery economics vary by channel
    const cpmDollars = channel === "tv" ? 18 + rand() * 22
      : channel === "ooh" ? 6 + rand() * 8
      : channel === "radio" ? 8 + rand() * 7
      : channel === "social" ? 7 + rand() * 9
      : channel === "seo" ? 3 + rand() * 4
      : 5 + rand() * 6; // aeo_geo
    const impressions = Math.max(1000, Math.round((spendCents / cents(cpmDollars)) * 1000));
    const reach = Math.round(impressions * (0.35 + rand() * 0.4));
    const clickable = channel === "social" || channel === "seo" || channel === "aeo_geo";
    const cpcCents = clickable ? cents(0.4 + rand() * 2.2) : null;
    const start = addDays(new Date(`${SEASON_YEAR}-01-15T00:00:00Z`), ri(0, 250));
    const end = addDays(start, ri(7, 45));
    const name = `${objective.replace("_", " ")} — ${channel.toUpperCase()} ${ymd(start).slice(0, 7)}`;
    await mkLoader.push([
      i, name, channel, objective, spendCents, reach, impressions,
      cents(cpmDollars), cpcCents, ymd(start), ymd(end),
    ]);
  }
  await mkLoader.flush();
  console.log(`✓ marketing_spend: ${N_CAMPAIGNS}`);

  // ── summary ─────────────────────────────────────────────────────────────────
  const counts = await client.query(`
    SELECT
      (SELECT count(*) FROM games) games,
      (SELECT count(*) FROM tickets) tickets,
      (SELECT count(*) FROM fans) fans,
      (SELECT count(*) FROM sponsorships) sponsorships,
      (SELECT count(*) FROM merchandise) merchandise,
      (SELECT count(*) FROM concessions) concessions,
      (SELECT count(*) FROM staffing) staffing,
      (SELECT count(*) FROM hr_employees) hr_employees,
      (SELECT count(*) FROM marketing_spend) marketing_spend
  `);
  await client.query("ANALYZE");
  console.log("✓ done —", counts.rows[0]);
  await client.end();
}

main().catch((e) => {
  console.error("generate failed:", e);
  process.exit(1);
});
