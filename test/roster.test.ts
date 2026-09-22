// SPDX-License-Identifier: Apache-2.0
//
// The roster is what a client reads about this box BEFORE it calls any tool —
// the MCP `instructions` and the entry-point tool descriptions.
//
// The bug it exists to fix: a box whose lake is Monarch + Gmail presented a tool
// surface that only ever said "business context", "biz.*", "Slack archive", so a
// client concluded the connector was a work-analytics tool and answered "I don't
// have access to your personal finances" — about data sitting in the lake — with
// no tool call at all. `list_sources` knew better, but only in its return value.
//
// So these tests assert the property that actually failed: a personal-finance
// box must SAY personal finance, in the strings a client reads for free.
//
// Then it failed a second way, which the budget tests below pin. Saying it is
// not enough when the host TRUNCATES it: a campsh tool description rendered as
// "software development activity: issues, pull reque…" and the reader concluded
// there was no email on the box — while a Gmail lake sat behind it — and sent
// the user off to connect the Gmail connector instead. Every domain has to fit
// inside the preview, or the ones past the cut may as well not be written.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { spawnGateway, waitHealthy, connect, call as gwCall, FIXTURES } from "./lib/gateway";
import { startFakeLake, type FakeLake } from "./lib/fakelake";
import { KnowledgeStore } from "../plugin/gateway/lib/store";

import {
  FAMILY_DOMAIN,
  connectedFamilies,
  rosterFrom,
  rosterKeywords,
  rosterLine,
  rosterTitle,
  serverInstructions,
  type BoxRoster,
} from "../plugin/gateway/lib/roster";
import { BEAT_LIVE_MS, LAKE_SOURCES, familyOf } from "../plugin/gateway/lib/sources";

const NOW = Date.parse("2026-08-21T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const ANALYST = { canWrite: false, denyLakeRead: false };

/** A campsh-shaped box: Monarch + Gmail flowing, GitHub with history, and the
 *  never-connected tables bootstrap creates for every other source. */
const campshTables = () => [
  { table: "monarch_transactions", source: "Monarch · transactions", rows: 8_400, last: iso(3_600_000), beat: iso(60_000) },
  { table: "monarch_net_worth", source: "Monarch · net worth", rows: 900, last: iso(3_600_000), beat: iso(60_000) },
  { table: "gmail_messages", source: "Gmail", rows: 4_800, last: iso(7_200_000), beat: iso(120_000) },
  { table: "github_issues", source: "GitHub · issues", rows: 310, last: iso(86_400_000), beat: null },
  { table: "logs_vercel", source: "Vercel", rows: 0, last: null, beat: null },
  { table: "slack_messages", source: "Slack", rows: 0, last: null, beat: null },
  { table: "ingest_raw", source: "Unrouted (raw)", rows: 12, last: iso(1_000), beat: null },
];

const campshRoster = (over: Partial<BoxRoster> = {}): BoxRoster => ({
  ...rosterFrom(
    {
      mirror: { tables: [] },
      lake: { configured: true, ok: true, tables: campshTables() },
      knowledge: { docs: 6, byType: {} },
    },
    "campsh",
    NOW,
  ),
  ...over,
});

describe("connectedFamilies", () => {
  test("a family with rows is connected even when its poller is not beating", () => {
    // GitHub history stays queryable after the poller stops. Liveness is about
    // the pipeline; the roster is about what you can ask questions of.
    expect(connectedFamilies(campshTables(), NOW)).toContain("GitHub");
  });

  test("a beating connector counts before its first row lands", () => {
    const tables = [{ table: "monarch_budgets", source: "Monarch · budgets", rows: 0, last: null, beat: iso(60_000) }];
    expect(connectedFamilies(tables, NOW)).toEqual(["Monarch"]);
  });

  test("tables that exist but were never connected are excluded", () => {
    // Bootstrap creates every lake table up front, so existence proves nothing —
    // listing Vercel here would promise data the box does not have.
    const families = connectedFamilies(campshTables(), NOW);
    expect(families).not.toContain("Vercel");
    expect(families).not.toContain("Slack");
  });

  test("a stale beat with no rows does not count", () => {
    const tables = [{ table: "logs_render", source: "Render", rows: 0, last: null, beat: iso(BEAT_LIVE_MS * 2) }];
    expect(connectedFamilies(tables, NOW)).toEqual([]);
  });

  test("plumbing is not a domain", () => {
    expect(connectedFamilies(campshTables(), NOW)).not.toContain("Unrouted (raw)");
  });
});

describe("rosterLine", () => {
  test("names the DOMAIN, not the vendor — the words the user's question uses", () => {
    // "Monarch" answers nothing for someone asking about their mortgage.
    const line = rosterLine(campshRoster())!;
    expect(line).toContain("personal finance");
    expect(line).toContain("personal email");
    expect(line).not.toContain("Vercel");
  });

  test("omits the box name — it already prefixes every tool name", () => {
    // The connector installs as `<box>-setoku`, and this line repeats across
    // four tool descriptions; the name is carried once, in the instructions.
    expect(rosterLine(campshRoster())).not.toContain("campsh");
  });

  test("mentions the biz.* mirror only when one is running", () => {
    expect(rosterLine(campshRoster())).not.toContain("biz.*");
    const mirrored = campshRoster({ mirrored: 12 });
    expect(rosterLine(mirrored)).toContain("biz.*");
  });

  test("says nothing rather than promising an empty box", () => {
    expect(rosterLine(campshRoster({ families: [], mirrored: 0 }))).toBeNull();
    expect(rosterLine(null)).toBeNull();
  });
});

/** A hedgy-shaped box: every family at once, plus a 64-table mirror. The worst
 *  case for the head budget — if the list fits here it fits anywhere. */
const crowdedRoster = (): BoxRoster => ({
  box: "hedgy",
  families: ["Vercel", "Render", "Slack", "First-party events", "Mercury", "GitHub"],
  mirrored: 64,
  docs: 40,
});

/** What a truncating host actually shows. The observed cut on claude.ai. */
const PREVIEW = 90;
/** The head is everything up to the detail hand-off. */
const headOf = (line: string) => line.slice(0, line.indexOf(". In detail:") + 1);

describe("rosterLine fits the preview (the truncation bug)", () => {
  test("every connected domain is inside the first 90 characters", () => {
    // THE regression. The old line spent 190 chars on GitHub prose and email
    // never appeared before the cut, so the reader offered to connect Gmail.
    const preview = rosterLine(campshRoster())!.slice(0, PREVIEW);
    expect(preview).toContain("email");
    expect(preview).toContain("finance");
    expect(preview).toContain("code");
  });

  test("the head survives even on a box with every source connected", () => {
    const line = rosterLine(crowdedRoster())!;
    expect(headOf(line).length).toBeLessThanOrEqual(PREVIEW);
    for (const short of ["web logs", "server logs", "chat", "analytics", "banking", "code"]) {
      expect(line.slice(0, PREVIEW)).toContain(short);
    }
    expect(line.slice(0, PREVIEW)).toContain("biz.*");
  });

  test("vendors ride the head when there is room — they stop 'shall I connect Gmail?'", () => {
    expect(headOf(rosterLine(campshRoster())!)).toContain("Gmail");
  });

  test("vendors are dropped, not truncated, when the head would overrun", () => {
    // The tail still carries them, so the head can spend its budget on domains.
    const head = headOf(rosterLine(crowdedRoster())!);
    expect(head).not.toContain("Vercel");
    expect(head.length).toBeLessThanOrEqual(PREVIEW);
  });

  test("an impossible head counts the rest instead of being cut mid-family", () => {
    // A head cut mid-word reads as "that's all there is" — the failure mode.
    const many = { box: "x", families: Array.from({ length: 30 }, (_, i) => `Family${i}`), mirrored: 0, docs: 0 };
    const head = headOf(rosterLine(many)!);
    expect(head.length).toBeLessThanOrEqual(PREVIEW);
    expect(head).toContain("more (list_sources)");
  });

  test("the full phrases still follow, for a client with room", () => {
    const line = rosterLine(campshRoster())!;
    expect(line).toContain("personal email: senders, subjects, bodies");
  });
});

describe("rosterKeywords (the retrieval tail)", () => {
  test("names the vendors — the anchors a tool search actually matches", () => {
    // The screenshot's first failure was retrieval: "google drive search files"
    // matched the K-1 question and Setoku's tools never surfaced at all.
    const tail = rosterKeywords(campshRoster())!;
    expect(tail).toContain("Gmail");
    expect(tail).toContain("Monarch Money");
  });

  test("carries the words a question uses, not the words we use", () => {
    expect(rosterKeywords(campshRoster())!).toContain("inbox");
  });

  test("every family gets an anchor before any family gets a second one", () => {
    // Round-robin: a budget cut must not cost the last family everything.
    const tail = rosterKeywords(crowdedRoster())!;
    for (const vendor of ["Vercel", "Render", "Slack", "Mercury", "GitHub"]) {
      expect(tail).toContain(vendor);
    }
  });

  test("no duplicates, and bounded", () => {
    const tail = rosterKeywords(crowdedRoster())!;
    const words = tail.replace("Also matches: ", "").replace(/\.$/, "").split(", ");
    expect(new Set(words).size).toBe(words.length);
    expect(tail.length).toBeLessThan(320);
  });

  test("says nothing about an empty box", () => {
    expect(rosterKeywords(campshRoster({ families: [], mirrored: 0 }))).toBeNull();
    expect(rosterKeywords(null)).toBeNull();
  });
});

describe("rosterTitle", () => {
  test("a picker showing only titles still says what the box holds", () => {
    // Order follows the probe (LAKE_SOURCES order in production), so assert the
    // contents, not the sequence.
    const title = rosterTitle(campshRoster())!;
    expect(title.split(", ").sort()).toEqual(["code", "email", "finance"]);
  });

  test("bounded, and marks what it dropped", () => {
    const title = rosterTitle(crowdedRoster())!;
    expect(title.length).toBeLessThanOrEqual(60);
    if (title.endsWith("\u2026")) expect(title.length).toBeGreaterThan(20);
  });

  test("nothing connected, nothing claimed", () => {
    expect(rosterTitle(campshRoster({ families: [], mirrored: 0 }))).toBeNull();
    expect(rosterTitle(null)).toBeNull();
  });
});

describe("serverInstructions", () => {
  test("the regression: a personal-finance box says so before any tool call", () => {
    const out = serverInstructions(campshRoster(), ANALYST);
    expect(out).toContain("personal finance");
    expect(out).toContain("personal email");
  });

  test("names the vendor behind each domain", () => {
    // Without this a client offers to CONNECT Gmail for a box that has polled
    // Gmail for months — it can see "personal email" but not that it's the same
    // thing as the Gmail connector sitting next to it in the picker.
    const out = serverInstructions(campshRoster(), ANALYST);
    expect(out).toContain("(via Gmail)");
    expect(out).toContain("(via Monarch Money)");
  });

  test("leads the source list with the compact head", () => {
    // Instructions get truncated too, by hosts we haven't seen yet.
    expect(serverInstructions(campshRoster(), ANALYST)).toMatch(
      /Connected right now — .*email \(Gmail\).*:\n- /,
    );
  });

  test("carries the box name once", () => {
    expect(serverInstructions(campshRoster(), ANALYST)).toContain("campsh");
  });

  test("does not let the connector's name imply its subject", () => {
    expect(serverInstructions(campshRoster(), ANALYST)).toContain("Do not assume from the connector's name");
  });

  test("forbids the answer that caused this — 'we don't have that', unchecked", () => {
    expect(serverInstructions(campshRoster(), ANALYST)).toContain("list_sources");
    expect(serverInstructions(campshRoster(), ANALYST)).toMatch(/never tell the user Setoku doesn't have data/i);
  });

  test("an empty knowledge store is flagged as thin CONTEXT, not missing data", () => {
    const out = serverInstructions(campshRoster({ docs: 0 }), ANALYST);
    expect(out).toMatch(/says nothing about\s+what data exists/);
  });

  test("a box with nothing flowing points at list_sources instead of guessing", () => {
    const out = serverInstructions(campshRoster({ families: [], mirrored: 0 }), ANALYST);
    expect(out).toContain("No source is flowing");
    expect(out).toContain("list_sources");
  });

  test("a curator session is told it cannot read the lake (the membrane)", () => {
    const out = serverInstructions(campshRoster(), { canWrite: true, denyLakeRead: true });
    expect(out).toContain("CURATOR session");
    expect(out).not.toContain("report_correction");
  });

  test("an analyst session is pointed at report_correction, not upsert_context", () => {
    const out = serverInstructions(campshRoster(), ANALYST);
    expect(out).toContain("report_correction");
    expect(out).not.toContain("upsert_context");
  });

  test("degrades to source-agnostic text when the probe is cold", () => {
    // A cold or broken lake must never fail an MCP request; it just gets the
    // generic description back.
    const out = serverInstructions(null, ANALYST);
    expect(out).toContain("Setoku is the governed query path");
    expect(out).not.toContain("Connected right now");
  });
});

describe("FAMILY_DOMAIN covers the catalog", () => {
  test("every source family has a plain-language entry", () => {
    // Drift guard: a new connector whose family lands here with no entry would
    // silently fall back to its vendor label, reintroducing the original bug for
    // that source. Adding a table to an EXISTING family needs nothing.
    const missing = [...new Set(LAKE_SOURCES.map((s) => familyOf(s.source)))]
      .filter((f) => f !== "Unrouted (raw)" && f !== "Postgres mirror")
      .filter((f) => !FAMILY_DOMAIN[f]);
    expect(missing).toEqual([]);
  });

  test("phrases describe the data, never just repeat the vendor", () => {
    for (const [family, d] of Object.entries(FAMILY_DOMAIN)) {
      expect(d.long.toLowerCase()).not.toBe(family.toLowerCase());
      expect(d.long.length).toBeGreaterThan(family.length);
    }
  });

  test("every short is short enough to survive a head with six siblings", () => {
    // A `short` that runs long doesn't just cost itself — it pushes every
    // family after it out of the preview.
    for (const [family, d] of Object.entries(FAMILY_DOMAIN)) {
      expect(d.short.length).toBeLessThanOrEqual(12);
      expect(d.short.toLowerCase()).not.toBe((d.vendor ?? "").toLowerCase());
      expect(d.short.length, `${family} short`).toBeLessThan(d.long.length);
    }
  });
});

/* ------------------------- end-to-end over real MCP ------------------------ */

// The unit tests above pin the strings. This block pins that they actually
// REACH a client — through the initialize response and tools/list, off a live
// lake probe — because every layer in between (the cached probe, the deny
// scoping, the per-request buildServer) is where this could silently become a
// no-op again.
describe("the roster reaches an MCP client", () => {
  const PORT = 38779;
  const BASE = `http://127.0.0.1:${PORT}`;
  let tmpRepo: string;
  let proc: Subprocess;
  let lake: FakeLake;

  // A Monarch + Gmail box: those two tables hold rows, every other lake table
  // exists (bootstrap creates them all) but is empty.
  const WITH_ROWS = ["monarch_transactions", "monarch_accounts", "gmail_messages"];

  beforeAll(async () => {
    lake = startFakeLake((sql) => {
      if (sql.includes("GROUP BY connector")) return { columns: ["connector", "beat"], rows: [] };
      if (sql.includes("target_table AS target")) return { columns: ["target", "source", "as_of"], rows: [] };
      if (sql.includes("count() AS rows")) {
        const hit = WITH_ROWS.some((t) => sql.includes(`FROM setoku.${t}`));
        return { columns: ["rows", "last"], rows: [{ rows: hit ? 500 : 0, last: "2026-08-21 00:00:00" }] };
      }
      return { rows: [{ ok: 1 }] };
    });

    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-roster-"));
    fs.cpSync(path.join(FIXTURES, "setoku"), path.join(tmpRepo, ".setoku"), { recursive: true });
    {
      const s = new KnowledgeStore(path.join(tmpRepo, "knowledge.db"));
      // Dana is denied Monarch — her tool descriptions must not advertise it.
      s.setSourceDenies("dana@co.test", ["monarch"], "admin@co.test");
      s.db.close();
    }
    proc = spawnGateway({
      SETOKU_PROJECT_DIR: tmpRepo,
      SETOKU_DB_PATH: path.join(tmpRepo, "knowledge.db"),
      SETOKU_LAKE_URL: lake.url,
      SETOKU_HTTP_PORT: String(PORT),
      SETOKU_NAME: "campsh",
      SETOKU_TOKENS: "tok-ann=ann@co.test,tok-dana=dana@co.test",
    });
    await waitHealthy(BASE);
  }, 30_000);

  afterAll(() => {
    proc?.kill();
    lake?.stop();
    if (tmpRepo) fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  const describeOf = async (client: Awaited<ReturnType<typeof connect>>, name: string) => {
    const { tools } = await client.listTools();
    return tools.find((t) => t.name === name)?.description ?? "";
  };

  test("initialize carries what the box holds, and the box's name", async () => {
    const client = await connect(BASE, "tok-ann");
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("personal finance");
    expect(instructions).toContain("personal email");
    expect(instructions).toContain("campsh");
    await client.close();
  });

  test("tools/list alone answers 'is this connector about my finances?'", async () => {
    // THE regression. A client that reads the tool list and nothing else must
    // come away knowing this box holds personal finance data.
    const client = await connect(BASE, "tok-ann");
    for (const tool of ["find_context", "list_sources", "get_schema", "run_query"]) {
      expect(await describeOf(client, tool)).toContain("personal finance");
    }
    await client.close();
  });

  test("and a client that reads only the first 90 chars comes away with all of it", async () => {
    // The truncation bug, end to end: the preview a host renders has to carry
    // every domain, on every entry point, not just the one that sorted first.
    const client = await connect(BASE, "tok-ann");
    for (const tool of ["find_context", "list_sources", "get_schema", "run_query"]) {
      const preview = (await describeOf(client, tool)).slice(0, PREVIEW);
      expect(preview, `${tool} preview`).toContain("email");
      expect(preview, `${tool} preview`).toContain("finance");
    }
    await client.close();
  });

  test("descriptions carry the vendor anchors a tool search matches on", async () => {
    const client = await connect(BASE, "tok-ann");
    const d = await describeOf(client, "find_context");
    expect(d).toContain("Gmail");
    expect(d).toContain("inbox"); // the word the user's question uses
    await client.close();
  });

  test("titles say it too, for a picker that shows no description", async () => {
    const client = await connect(BASE, "tok-ann");
    const { tools } = await client.listTools();
    const title = tools.find((t) => t.name === "find_context")?.title ?? "";
    expect(title).toContain("email");
    expect(title).toContain("finance");
    await client.close();
  });

  test("a never-connected source is not advertised", async () => {
    const client = await connect(BASE, "tok-ann");
    const d = await describeOf(client, "find_context");
    expect(d).not.toContain("team chat archive"); // Slack: table exists, no rows
    expect(d).not.toContain("web hosting logs"); // Vercel: same
    await client.close();
  });

  test("a denied family is absent from that identity's descriptions (I9)", async () => {
    const client = await connect(BASE, "tok-dana");
    const d = await describeOf(client, "find_context");
    expect(d).not.toContain("personal finance");
    expect(d).not.toContain("Monarch"); // nor through the retrieval tail
    expect(d).toContain("personal email"); // Gmail is not denied
    expect(client.getInstructions() ?? "").not.toContain("personal finance");
    await client.close();
  });

  test("find_context that retrieves nothing still names the sources", async () => {
    // The empty-store path: "no curated knowledge" must not read as "no data".
    const client = await connect(BASE, "tok-ann");
    const res = await gwCall(client, "find_context", { question: "what did we spend on the mortgage" });
    expect(res.text).toContain("personal finance");
    expect(res.text).toContain("list_sources");
    await client.close();
  });
});
