// SPDX-License-Identifier: Apache-2.0
//
// ADVERSARIAL probe — not pass/fail. Asks the hard questions most likely to
// expose gaps where Setoku gives a wrong or weak answer on the Bulldogs
// multi-system data (mixed units, identity resolution, missing data, no-
// attribution guardrails, vendor-staff undercount, retrieval misses). Prints the
// FULL answer for each so a human can judge correctness.
//
//   bun run demo/e2e/probe.ts            # the Bulldogs multi-system instance

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MCP_URL = process.env.DEMO_MCP_URL ?? "https://demo.setoku.com/mcp/55e767ea376aa3783cfb4653e2bf81772876b9b5c36339d9";

// Each probe notes the TRAP — the gap it's hunting for.
const PROBES: { ask: string; trap: string }[] = [
  { ask: "What was our total game-day revenue last completed season — combine ticket sales and food & beverage into one number?", trap: "MIXED UNITS: ticketing is cents, POS is dollars. Wrong conversion → off by ~100x." },
  { ask: "Who are our top 10 fans by total spend across tickets and concessions?", trap: "IDENTITY: POS loyalty_id only ~15% populated — most F&B can't tie to a fan. Should caveat, not fabricate a clean ranking." },
  { ask: "What's our total merchandise revenue across all channels?", trap: "COVERAGE: merch is online-only (Fanatics not in data) AND find_context mis-routed this to ticket_revenue earlier." },
  { ask: "Which marketing channel drove the most ticket sales last season?", trap: "NO ATTRIBUTION: marketing.ad_spend has no link to sales. Should refuse to claim causation, not invent it." },
  { ask: "What was our parking and merchandising-retail revenue last season?", trap: "MISSING DATA: parking isn't modeled, retail merch is Fanatics (absent). Should say not available, not hallucinate." },
  { ask: "What's our total annual revenue, and how much of it is media rights?", trap: "CROSS-SYSTEM + UNITS: must combine ticketing (cents) + F&B + sponsorship + merch + media (dollars) → ~$180–200M, media ~$90M. Easy to drop the media line or botch cents." },
  { ask: "How many gameday incidents did we log last season, and which type was most common?", trap: "NEW SYSTEM: ops.incident, completed games only; cleanup should top the list. Don't conflate with hr or pos." },
  { ask: "What's our total gameday staff headcount per game?", trap: "VENDOR UNDERCOUNT: hr.worker omits vendor staff; must count hr.shift, not hr.worker." },
  { ask: "How many tickets were resold on the secondary market, and who actually attended vs originally bought them?", trap: "RESALE: needs is_resale_flg + orig_acct_id vs acct_id semantics." },
  { ask: "What's our net ticket revenue after refunds and exchanges?", trap: "STATUS: RF excluded; XCH replacement is a separate row — easy to double-count or net wrong." },
  { ask: "How much below rate card are we selling our sponsorship inventory?", trap: "needs deal_asset.allocated_value vs rate_card; dollars." },
  { ask: "What's the average ticket price?", trap: "Must exclude comps ($0) and refunds; cents → dollars." },
];

function ask(prompt: string, mcpUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), "setoku-probe-"));
  const cfg = join(dir, "mcp.json");
  writeFileSync(cfg, JSON.stringify({ mcpServers: { setoku: { type: "http", url: mcpUrl } } }));
  const env = { ...process.env }; delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
  const proc = Bun.spawnSync(
    ["claude", "-p", prompt,
      "--append-system-prompt", "Answer using ONLY the Setoku MCP tools. Call find_context first. If the data can't answer the question, say so plainly instead of guessing.",
      "--mcp-config", cfg, "--strict-mcp-config",
      "--allowedTools", "mcp__setoku__find_context", "mcp__setoku__get_metric", "mcp__setoku__run_query", "mcp__setoku__list_entities", "mcp__setoku__describe_entity", "mcp__setoku__get_schema", "mcp__setoku__list_sources",
      "--max-turns", "16"],
    { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  rmSync(dir, { recursive: true, force: true });
  return proc.stdout.toString().trim() || ("(empty) " + proc.stderr.toString().slice(0, 300));
}

for (const [i, p] of PROBES.entries()) {
  console.log(`\n━━━━━━ PROBE ${i + 1}/${PROBES.length} ━━━━━━`);
  console.log(`Q: ${p.ask}`);
  console.log(`TRAP: ${p.trap}`);
  console.log(`A: ${ask(p.ask, MCP_URL)}`);
}
