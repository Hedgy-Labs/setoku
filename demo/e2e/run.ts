// SPDX-License-Identifier: Apache-2.0
//
// End-to-end demo tests that run against the LIVE box, driving the REAL Claude
// via the Claude **Max subscription** (the `claude` CLI in print mode) — NO API
// keys. This mirrors how a prospect actually uses Setoku: Claude is the inference
// layer, Setoku ships tools, and the right answer depends on the curated
// knowledge steering the query.
//
// Each golden question is asked through Claude with ONLY the box's Setoku MCP
// connector available; we assert the answer reflects the curated knowledge
// (dedupe, cents-vs-dollars, comps excluded, renewal across seasons, the merch
// coverage caveat, …) rather than a naive guess.
//
//   bun run demo/e2e/run.ts
//
// Requires: `claude` CLI logged into a Claude subscription (run `claude` once to
// auth). The runner strips ANTHROPIC_API_KEY so it can ONLY use the subscription.
// Override the target with env DEMO_MCP_URL.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MCP_URL = process.env.DEMO_MCP_URL ?? "https://demo.setoku.com/mcp/55e767ea376aa3783cfb4653e2bf81772876b9b5c36339d9";

type Check = { primary: RegExp; note: string; mustNot?: RegExp };
type Q = { ask: string; checks: Check[] };

// Golden questions whose right answer requires the curated knowledge.
const QUESTIONS: Q[] = [
  {
    ask: "How many unique fans do we have in total? Give me the number.",
    checks: [
      // primary already requires the ~98k deduped figure; don't ban mentioning
      // the ~129k raw count — a correct answer explains the dedup with both.
      { primary: /\b9[78][,. ]?\d{3}\b|\b9[78]\s?(k|thousand)\b|~\s?9[78]/i, note: "deduped ~98k (not the ~129k raw CRM rows)" },
    ],
  },
  {
    ask: "What is our season-ticket-holder renewal rate?",
    checks: [{ primary: /\b8[0-9](\.\d+)?\s?%|\b8[0-9]\s?percent|0\.8[0-9]\b/i, note: "renewal ~85% across seasons" }],
  },
  {
    ask: "What was our total ticket revenue in the most recent completed season?",
    checks: [{ primary: /\$?\s?6[5-9](\.\d+)?\s?(million|m\b)|\$?6[5-9][,. ]?\d{3}[,. ]?\d{3}/i, note: "~$67M (cents handled, not $6.7B or $670k)" }],
  },
  {
    ask: "What is our total merchandise revenue?",
    checks: [{ primary: /fanatics|online[- ]?(only|store)|in[- ]?venue|partial|incomplete|not (the )?(full|complete|total)/i, note: "flags merch is online-only (Fanatics gap), not a wrong total" }],
  },
  {
    ask: "What's our food & beverage per-cap (per-attendee spend)?",
    // require a $ or a decimal so it can't match leading digits of "19,000" attendance
    checks: [{ primary: /\$\s?(1[5-9]|2[0-4])(\.\d+)?\b|\b(1[5-9]|2[0-4])\.\d{1,2}\b/i, note: "per-cap ~$15–24 (POS dollars ÷ attendance)" }],
  },
  // --- regression guards for the gaps the adversarial probe found ---
  {
    ask: "How far below rate card are we selling our sponsorship inventory?",
    checks: [{ primary: /\b1[0-9](\.\d+)?\s?%|below rate card|discount/i, note: "answers it (~16% below rate card) — was unanswerable when allocated_value > rate_card" }],
  },
  {
    ask: "What was our total game-day revenue last completed season — ticket sales plus food & beverage as one number?",
    // primary requires the ~$93M figure, which a $9B cents-error answer can't
    // match — so no need to ban "billion" (a correct answer may name the trap).
    checks: [{ primary: /\$?\s?9[0-5](\.\d+)?\s?(million|m\b)|\$?9[0-5][,. ]?\d{3}[,. ]?\d{3}/i, note: "~$93M (cents+dollars converted, not $9B)" }],
  },
  {
    ask: "What was our parking revenue last season?",
    checks: [{ primary: /(no|not|isn'?t|can'?t|don'?t have|unavailable).{0,40}(data|table|available|present|parking|that)/i, note: "refuses missing data (parking isn't modeled) instead of hallucinating" }],
  },
  {
    ask: "How much do we make from media / broadcast rights per season?",
    checks: [{ primary: /\$?\s?(8[5-9]|9[0-9])(\.\d+)?\s?(million|m\b)|\$?\s?(8[5-9]|9[0-9])[,. ]?\d{3}[,. ]?\d{3}/i, note: "~$86–95M/season from media.rights_deal (the biggest line)" }],
  },
  {
    ask: "What's our total annual revenue, across every source?",
    checks: [{ primary: /\$?\s?(18[0-9]|19[0-9]|20[0-5])(\.\d+)?\s?(million|m\b)|\$?\s?(18[0-9]|19[0-9]|20[0-5])[,. ]?\d{3}[,. ]?\d{3}/i, note: "~$180–200M (media + tickets + F&B + sponsorship + merch, units reconciled)" }],
  },
  {
    ask: "Which marketing channel drove the most ticket sales last season?",
    checks: [{ primary: /no attribution|can'?t|cannot|correlation|not.{0,20}(attribut|link|causa)|no.{0,20}(link|connection)/i, note: "refuses to claim attribution it doesn't have" }],
  },
];

function askClaude(prompt: string, mcpUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), "setoku-e2e-"));
  const cfg = join(dir, "mcp.json");
  writeFileSync(cfg, JSON.stringify({ mcpServers: { setoku: { type: "http", url: mcpUrl } } }));
  // Subscription only: strip any API key so the CLI must use the logged-in account.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const sys =
    "You are answering a business question using ONLY the Setoku MCP tools. " +
    "Call find_context first, prefer canonical metric SQL, then answer concisely with the number and one sentence of method.";
  const proc = Bun.spawnSync(
    [
      "claude", "-p", prompt,
      "--append-system-prompt", sys,
      "--mcp-config", cfg,
      "--strict-mcp-config",
      "--allowedTools",
      "mcp__setoku__find_context", "mcp__setoku__get_metric", "mcp__setoku__run_query",
      "mcp__setoku__list_entities", "mcp__setoku__describe_entity", "mcp__setoku__get_schema",
      "mcp__setoku__list_sources",
      "--max-turns", "14",
    ],
    { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  rmSync(dir, { recursive: true, force: true });
  const out = proc.stdout.toString().trim();
  if (!out) throw new Error("empty claude output: " + proc.stderr.toString().slice(0, 400));
  return out;
}

async function main() {
  let passed = 0;
  const fails: string[] = [];
  console.log(`\n══════ ${QUESTIONS.length} questions  (${MCP_URL.replace(/\/mcp\/.*/, "/mcp/****")}) ══════`);
  for (const q of QUESTIONS) {
    process.stdout.write(`• ${q.ask}\n`);
    let answer = "", ok = false, detail = "";
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
      try {
        answer = askClaude(q.ask, MCP_URL);
      } catch (e) {
        detail = `error: ${(e as Error).message}`;
        continue;
      }
      const a = answer.replace(/\s+/g, " ");
      const failed = q.checks.filter((c) => !c.primary.test(a) || (c.mustNot && c.mustNot.test(a)));
      ok = failed.length === 0;
      detail = ok ? "" : "missing: " + failed.map((c) => c.note).join("; ");
    }
    if (ok) { passed++; console.log(`  ✓ ${answer.replace(/\s+/g, " ").slice(0, 160)}`); }
    else { fails.push(`${q.ask} — ${detail}`); console.log(`  ✗ ${detail}\n    got: ${answer.replace(/\s+/g, " ").slice(0, 220)}`); }
  }
  console.log(`\n════════ ${passed}/${QUESTIONS.length} passed ════════`);
  if (fails.length) { console.log(fails.map((f) => "  ✗ " + f).join("\n")); process.exit(1); }
}

main();
