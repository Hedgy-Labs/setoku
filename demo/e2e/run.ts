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
//   bun run demo/e2e/run.ts                 # both instances
//   bun run demo/e2e/run.ts realistic       # one instance
//
// Requires: `claude` CLI logged into a Claude subscription (run `claude` once to
// auth). The runner strips ANTHROPIC_API_KEY so it can ONLY use the subscription.
// Override the targets with env DEMO_MCP_REALISTIC / DEMO_MCP_LITE.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGETS: Record<string, string> = {
  realistic:
    process.env.DEMO_MCP_REALISTIC ??
    "https://realistic.51-81-222-176.sslip.io/mcp/28e53fdf11bd086f665064beea5f7d0f6c59292183af96d8",
  lite:
    process.env.DEMO_MCP_LITE ??
    "https://demo.51-81-222-176.sslip.io/mcp/c1ca64c9825bb0da86e08da8225c1498620c245575e48298",
};

type Check = { primary: RegExp; note: string; mustNot?: RegExp };
type Q = { ask: string; checks: Check[] };

// The realistic, multi-system dataset — the answers that require curated knowledge.
const REALISTIC: Q[] = [
  {
    ask: "How many unique fans do we have in total? Give me the number.",
    checks: [
      { primary: /\b9[78][,. ]?\d{3}\b|\b9[78]\s?(k|thousand)\b|~\s?9[78]/i, note: "deduped ~98k (not the ~129k raw CRM rows)", mustNot: /\b12[89][,. ]?\d{3}\b/ },
    ],
  },
  {
    ask: "What is our season-ticket-holder renewal rate?",
    checks: [{ primary: /\b8[0-9](\.\d+)?\s?%|\b8[0-9]\s?percent|0\.8[0-9]\b/i, note: "renewal ~85% across seasons" }],
  },
  {
    ask: "What was our total ticket revenue in the most recent completed season?",
    checks: [{ primary: /\$?\s?4[0-4][\d,. ]*\s?(million|m\b)|\$?4[0-4][,. ]?\d{3}[,. ]?\d{3}/i, note: "~$42–43M (cents handled, not $4B or $4k)" }],
  },
  {
    ask: "What is our total merchandise revenue?",
    checks: [{ primary: /fanatics|online[- ]?(only|store)|in[- ]?venue|partial|incomplete|not (the )?(full|complete|total)/i, note: "flags merch is online-only (Fanatics gap), not a wrong total" }],
  },
  {
    ask: "What's our food & beverage per-cap (per-attendee spend)?",
    checks: [{ primary: /\$?\s?(1[5-9]|2[0-4])(\.\d+)?\b/i, note: "per-cap ~$15–24 (POS dollars ÷ attendance)" }],
  },
];

// The clean, single-schema dataset — the crisp happy-path answers.
const LITE: Q[] = [
  {
    ask: "What was our ticket revenue this season?",
    checks: [{ primary: /\$?\s?2[5-7][\d,. ]*\s?(million|m\b)|\$?2[5-7][,. ]?\d{3}[,. ]?\d{3}/i, note: "~$26M" }],
  },
  {
    ask: "Do promo nights sell better than regular games?",
    checks: [{ primary: /promo/i, note: "discusses promo nights" }, { primary: /\b(yes|higher|better|more|fill|outsell)\b/i, note: "promo nights sell more" }],
  },
  {
    ask: "When you calculate ticket revenue, are comp tickets included?",
    checks: [{ primary: /comp/i, note: "knows about comps" }, { primary: /exclud|not includ|free|zero|\$0/i, note: "comps excluded (free)" }],
  },
];

const SUITES: Record<string, Q[]> = { realistic: REALISTIC, lite: LITE };

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
  const which = process.argv[2];
  const suites = which ? [which] : ["realistic", "lite"];
  let total = 0, passed = 0;
  const fails: string[] = [];

  for (const suite of suites) {
    const qs = SUITES[suite];
    if (!qs) { console.error(`unknown suite "${suite}" (realistic|lite)`); process.exit(2); }
    console.log(`\n══════ suite: ${suite}  (${TARGETS[suite].replace(/\/mcp\/.*/, "/mcp/****")}) ══════`);
    for (const q of qs) {
      total++;
      process.stdout.write(`• ${q.ask}\n`);
      let answer = "", ok = false, detail = "";
      for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
        try {
          answer = askClaude(q.ask, TARGETS[suite]);
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
      else { fails.push(`[${suite}] ${q.ask} — ${detail}`); console.log(`  ✗ ${detail}\n    got: ${answer.replace(/\s+/g, " ").slice(0, 220)}`); }
    }
  }

  console.log(`\n════════ ${passed}/${total} passed ════════`);
  if (fails.length) { console.log(fails.map((f) => "  ✗ " + f).join("\n")); process.exit(1); }
}

main();
