// SPDX-License-Identifier: Apache-2.0
/**
 * run_query friction-report runner.
 *
 * Deterministic, model-free, zero-API-cost (I8): mines a box's audit log for
 * the fail→retry→success pattern and prints where agents get stuck using
 * run_query. This is the "reflections" loop from the HN "designing APIs for
 * agents" thread (item 48894874), sourced from BEHAVIOR (the audit log) rather
 * than self-report — see lib/friction.ts.
 *
 *   bun plugin/gateway/friction-cli.ts --db <knowledge.db> [--window <min>] [--json] [--no-sql]
 *
 * PII: SQL literals in the audit log can contain customer values. SQL snippets
 * are shown by default (this is a box-local operator tool, same trust boundary
 * as the /admin audit page); pass --no-sql to redact them before sharing a
 * report off the box.
 */
import fs from "node:fs";
import { KnowledgeStore } from "./lib/store";
import { mineFriction, renderFriction } from "./lib/friction";

function parseArgs(argv: string[]) {
  const out: {
    db?: string;
    window: number;
    json: boolean;
    showSql: boolean;
  } = { window: 15, json: false, showSql: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") out.db = argv[++i];
    else if (a === "--window") out.window = Number(argv[++i]);
    else if (a === "--json") out.json = true;
    else if (a === "--no-sql") out.showSql = false;
  }
  return out;
}

function main() {
  const args = parseArgs(Bun.argv.slice(2));
  if (!args.db) {
    console.error(
      "usage: bun plugin/gateway/friction-cli.ts --db <knowledge.db> [--window <min>] [--json] [--no-sql]",
    );
    process.exit(2);
  }
  // Constructing a KnowledgeStore creates the file if missing, so a typo'd path
  // would silently mine an empty store. Require it to exist.
  if (!fs.existsSync(args.db)) {
    console.error(`--db not found: ${args.db}`);
    process.exit(2);
  }
  if (!Number.isFinite(args.window) || args.window <= 0) {
    console.error(`--window must be a positive number of minutes`);
    process.exit(2);
  }

  const store = new KnowledgeStore(args.db);
  const rows = store.auditForTool("run_query");
  const result = mineFriction(rows, { windowMinutes: args.window });

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderFriction(result, { showSql: args.showSql }));
}

if (import.meta.main) main();
