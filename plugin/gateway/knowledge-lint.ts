#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * Knowledge lint — LIVE-STORE edition (curation-cockpit-spec piece D).
 *
 * Reads metric/query docs straight from the gateway's KnowledgeStore (not a repo
 * of files, so it works on ANY deployed box), pulls each canonical SQL, runs it
 * read-only against the business Postgres, and bounds-checks the result. The
 * check is model-free (I8): it just runs the SQL an agent would run and verifies
 * the doc's own declared invariant (`expect`/`expect_nonempty`) — or, absent
 * one, a column-name heuristic.
 *
 * Usage:
 *   bun plugin/gateway/knowledge-lint.ts            # report only (exit 0 — warn)
 *   bun plugin/gateway/knowledge-lint.ts --gate     # exit 1 if any metric FAILS
 *   bun plugin/gateway/knowledge-lint.ts --file     # file a pending correction per failing metric
 *
 * The canary (deploy/monitor) runs it with --file: a drift it detects lands as a
 * pending correction → shows up in the cockpit → the auto-draft job drafts the
 * fix → a human approves. deploy.sh runs it WITHOUT --gate (warn, never block).
 */
import path from "node:path";
import { loadConfig, resolveDatabaseUrl, resolveLakeUrl, resolveProjectDir } from "./lib/config";
import { runReadOnlyQuery, closePools } from "./lib/db";
import { runLakeQuery } from "./lib/lake";
import { KnowledgeStore, defaultDbPath } from "./lib/store";
import { extractSql, lintDocResults, parseResultTable, type LintResult } from "./lib/lint";

const FILE = process.argv.includes("--file");
const GATE = process.argv.includes("--gate");

function storePath(projectDir: string): string {
  if (process.env.SETOKU_DB_PATH) return process.env.SETOKU_DB_PATH;
  const res = loadConfig(projectDir);
  if (res.ok && typeof res.config.knowledgeDb === "string") {
    const p = res.config.knowledgeDb;
    return path.isAbsolute(p) ? p : path.join(projectDir, p);
  }
  return defaultDbPath(projectDir);
}

async function main() {
  const projectDir = resolveProjectDir();
  const cfg = loadConfig(projectDir);
  if (!cfg.ok) {
    console.error(`knowledge-lint: no config — ${cfg.error}`);
    process.exit(2);
  }
  const db = resolveDatabaseUrl(projectDir, cfg.config);
  if (!db.ok) {
    console.error(`knowledge-lint: no business DB — ${db.error}`);
    process.exit(2);
  }
  // clickhouse-dialect docs (biz.* mirror / lake metrics) lint against the lake
  const lake = resolveLakeUrl(projectDir, cfg.config);
  const store = new KnowledgeStore(storePath(projectDir));
  const docs = store.listDocs().filter((d) => d.type === "metric" || d.type === "query");

  let pass = 0, warn = 0, fail = 0, noSql = 0, filed = 0;
  // dedupe: don't re-file a correction this lint already has pending for a doc
  const existing = new Set(
    store.listCorrections("pending").filter((c) => c.user === LINT_USER).map((c) => c.relatesTo),
  );

  console.log(`knowledge-lint (live store): ${docs.length} metric/query docs\n`);

  for (const doc of docs) {
    const sqls = extractSql(doc.body);
    const results: LintResult[] = [];
    // A doc is canonical in exactly ONE dialect (I5), declared in frontmatter:
    // `dialect: clickhouse` routes its SQL to the lake (the biz.* mirror);
    // default stays postgres. run_query routes the same way.
    const dialect = String((doc.meta as Record<string, unknown>).dialect ?? "postgres");
    for (const sql of sqls) {
      try {
        if (dialect === "clickhouse") {
          if (!lake.ok) throw new Error(`doc declares dialect clickhouse but no lake is configured — ${lake.error}`);
          const out = await runLakeQuery(lake.url, sql, cfg.config);
          results.push(parseResultTable(out.columns, out.rows));
        } else {
          const out = await runReadOnlyQuery(db.url, sql, cfg.config);
          results.push(parseResultTable(out.columns, out.rows));
        }
      } catch (e) {
        results.push({ cols: [], rows: [], error: String((e as Error).message).split("\n")[0].slice(0, 160) });
      }
    }
    const report = lintDocResults({ name: doc.name, meta: doc.meta, body: doc.body }, results);
    if (report.status === "no-sql") { noSql++; console.log(`  –  ${doc.name} (no SQL)`); continue; }
    if (report.status === "pass") { pass++; console.log(`  ✓  ${doc.name} (${report.ranOk} query(s) ran, values sane)`); continue; }
    if (report.status === "warn") warn++; else fail++;
    console.log(`  ${report.status === "fail" ? "✗" : "!"}  ${doc.name}\n       ${report.problems.join("\n       ")}`);

    // file a pending correction for genuine FAILs (drift "heals up to the gate")
    if (FILE && report.status === "fail" && !existing.has(doc.name)) {
      store.addCorrection({
        user: LINT_USER,
        kind: doc.type === "metric" ? "metric" : "query",
        fact: `metric "${doc.name}" SQL fails lint: ${report.problems[0]}`,
        context: `knowledge-lint found: ${report.problems.join("; ")}. Re-derive the canonical SQL against the live schema.`,
        relatesTo: doc.name,
      });
      filed++;
    }
  }

  await closePools();
  store.db.close();
  console.log(`\n${pass} ok · ${warn} warn · ${fail} fail · ${noSql} no-sql${FILE ? ` · ${filed} filed` : ""}`);
  if (GATE && fail) process.exit(1);
}

const LINT_USER = "knowledge-lint";

main().catch((e) => {
  console.error("knowledge-lint failed:", e);
  process.exit(2);
});
