// SPDX-License-Identifier: Apache-2.0
//
// KNOWLEDGE LINT — executes the canonical SQL embedded in metric/query docs
// against the LIVE database (through the gateway's run_query tool) and flags
// docs whose SQL errors, returns nothing, or returns absurd values. Model-free
// (I8): it just runs the SQL the agent would run and sanity-checks the numbers.
//
// This is the check that would have caught the sponsorship gap automatically:
// the doc's SQL was valid but the data made `1 - allocated/rate_card` negative
// (selling "above" rate card) — an out-of-range ratio the heuristics flag.
//
//   bun run demo/e2e/knowledge-lint.ts demo/bulldogs <mcp-url>

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const datasetDir = process.argv[2] ?? "demo/bulldogs";
const mcpUrl = process.argv[3] ?? process.env.DEMO_MCP_URL ??
  "https://demo.setoku.com/mcp/55e767ea376aa3783cfb4653e2bf81772876b9b5c36339d9";

// value sanity heuristics keyed on the OUTPUT column name (model-free).
const HEURISTICS: { match: RegExp; bad: (n: number) => boolean; why: string }[] = [
  { match: /discount|realiz|share|ratio|renewal|sell_through|rate$|_rate\b|pct/i, bad: (n) => n < -0.01 || n > 1.5, why: "ratio/rate out of [0,1] — inverted or mis-scaled" },
  { match: /per_cap|avg.*price|price.*avg|per_attendee/i, bad: (n) => n > 500 || n < 0, why: "per-cap/avg-price implausible — likely cents read as dollars (×100)" },
  { match: /revenue|dollars|booked|contract|value|cost|spend|amt/i, bad: (n) => Math.abs(n) > 1e11, why: "magnitude huge — likely a cents/dollars unit error" },
];

function sqlBlocks(md: string): string[] {
  return [...md.matchAll(/```sql\s*([\s\S]*?)```/g)]
    .map((m) => m[1].trim())
    .filter(Boolean)
    // only lint runnable statements — skip illustrative expression fragments
    // (e.g. a normalized-email expression shown on its own)
    .filter((s) => /^\s*(--.*\n|\s)*\s*(select|with|explain)\b/i.test(s));
}

// parse the gateway's run_query text table → { cols, rows: number-or-string[][] }
function parseTable(text: string): { error?: string; cols: string[]; rows: string[][] } {
  // anchor to line start so a data cell merely containing "error" isn't misread as a failure
  if (/^(run_query failed|MCP error|Error:)/im.test(text)) return { error: text.split("\n")[0].slice(0, 160), cols: [], rows: [] };
  const lines = text.split("\n").map((l) => l.trim());
  const endIdx = lines.findIndex((l) => /row\(s\) in /.test(l));
  // content = header + data, before the "N row(s) in Xms" footer. Handles
  // single-column results too (no " | " separator → one column).
  const content = (endIdx >= 0 ? lines.slice(0, endIdx) : lines).filter((l) => l.length);
  if (!content.length) return { cols: [], rows: [] };
  const cols = content[0].split(" | ").map((c) => c.trim());
  const rows = content.slice(1).map((r) => r.split(" | ").map((c) => c.trim()));
  return { cols, rows };
}

async function main() {
  const client = new Client({ name: "knowledge-lint", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));

  const docs: { file: string; sqls: string[] }[] = [];
  for (const sub of ["metrics", "queries"]) {
    const dir = join(datasetDir, ".setoku", "context", sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      docs.push({ file: `${sub}/${f}`, sqls: sqlBlocks(readFileSync(join(dir, f), "utf8")) });
    }
  }

  let pass = 0, warn = 0, fail = 0, noSql = 0;
  console.log(`knowledge-lint: ${datasetDir}  →  ${mcpUrl.replace(/\/mcp\/.*/, "/mcp/****")}\n`);

  for (const d of docs) {
    if (!d.sqls.length) { noSql++; console.log(`  –  ${d.file} (no SQL)`); continue; }
    const problems: string[] = [];
    let ranOk = 0;
    for (const sql of d.sqls) {
      const res = (await client.callTool({ name: "run_query", arguments: { sql, purpose: "knowledge-lint" } })) as { content: { text: string }[] };
      const text = res.content.map((c) => c.text).join("\n");
      const t = parseTable(text);
      if (t.error) { problems.push(`SQL error: ${t.error}`); continue; }
      if (!t.rows.length) { problems.push("returned 0 rows"); continue; }
      ranOk++;
      for (const row of t.rows) {
        t.cols.forEach((col, i) => {
          const n = Number((row[i] ?? "").replace(/[$,%\s]/g, ""));
          if (!Number.isFinite(n)) return;
          for (const h of HEURISTICS) if (h.match.test(col) && h.bad(n)) problems.push(`${col}=${row[i]} → ${h.why}`);
        });
      }
    }
    // dedupe problems
    const uniq = [...new Set(problems)];
    if (uniq.length) {
      const sev = uniq.some((p) => p.startsWith("SQL error") || /inverted|cents/.test(p)) ? "FAIL" : "WARN";
      if (sev === "FAIL") fail++; else warn++;
      console.log(`  ${sev === "FAIL" ? "✗" : "!"}  ${d.file}\n       ${uniq.join("\n       ")}`);
    } else { pass++; console.log(`  ✓  ${d.file} (${ranOk} query(s) ran, values sane)`); }
  }

  await client.close();
  console.log(`\n${pass} ok · ${warn} warn · ${fail} fail · ${noSql} no-sql`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error("lint failed:", e); process.exit(1); });
