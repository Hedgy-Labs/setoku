// SPDX-License-Identifier: Apache-2.0
/**
 * Compaction ("REM sleep") + triage runner for the knowledge store (#10).
 *
 *   bun plugin/gateway/compaction-cli.ts --db <knowledge.db> [--triage] [--json]
 *
 * READ-ONLY and RECOMMEND-ONLY (I2/I9): it prints proposed merges, contradictions
 * to pull back for review, and stale flags — and, with --triage, an advisory
 * accept/reject/review verdict per pending correction. It never edits curated
 * knowledge; a human enacts decisions on the approval surface. Model-free (I8).
 */
import fs from "node:fs";
import { KnowledgeStore, type Correction, type KnowledgeDoc } from "./lib/store";
import {
  compact,
  extractFacts,
  judgeProposal,
  splitFactCommentary,
  type Proposal,
} from "./lib/facts";

function parseArgs(argv: string[]) {
  const out = { db: "", triage: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") out.db = argv[++i] ?? "";
    else if (a === "--triage") out.triage = true;
    else if (a === "--json") out.json = true;
  }
  return out;
}

/** Turn a pending correction into a structured proposal (avenue 1). */
function correctionToProposal(c: Correction): Proposal {
  const { fact, commentary } = splitFactCommentary(c.content);
  return {
    subject: c.relatesTo ?? undefined,
    predicate: c.kind,
    fact,
    commentary: commentary || undefined,
    provenance: { author: c.user, ts: c.ts },
  };
}

export interface TriageRow {
  id: number;
  verdict: string;
  confidence: number;
  reasons: string[];
  fact: string;
}

export function buildReport(
  docs: KnowledgeDoc[],
  pending: Correction[],
  withTriage: boolean,
) {
  const curatedFacts = extractFacts(docs);
  const allFacts = extractFacts(docs, pending);
  const report = compact(allFacts);

  let triage: TriageRow[] = [];
  if (withTriage) {
    triage = pending.map((c) => {
      const rec = judgeProposal(correctionToProposal(c), curatedFacts);
      return {
        id: c.id,
        verdict: rec.verdict,
        confidence: rec.confidence,
        reasons: rec.reasons,
        fact: splitFactCommentary(c.content).fact,
      };
    });
  }
  return { report, triage };
}

function render(
  report: ReturnType<typeof compact>,
  triage: TriageRow[],
  withTriage: boolean,
): string {
  const lines: string[] = ["# Knowledge compaction report\n"];
  lines.push(
    `${report.stats.facts} facts across ${report.stats.subjects} subjects\n`,
  );

  lines.push(`## Merge candidates (${report.merges.length})`);
  if (report.merges.length)
    for (const m of report.merges.slice(0, 20))
      lines.push(`- ${m.a} ↔ ${m.b} — ${m.reason}`);
  else lines.push("- none");
  lines.push("");

  lines.push(`## Contradictions to review (${report.contradictions.length})`);
  if (report.contradictions.length)
    for (const c of report.contradictions.slice(0, 20))
      lines.push(`- [${c.subject}] ${c.a} ✕ ${c.b} — ${c.reason}`);
  else lines.push("- none");
  lines.push("");

  if (report.flags.length) {
    lines.push(`## Flags (${report.flags.length})`);
    for (const f of report.flags.slice(0, 20))
      lines.push(`- ${f.ref} — ${f.reason}`);
    lines.push("");
  }

  if (withTriage) {
    lines.push(`## Triage — advisory verdicts on pending proposals (${triage.length})`);
    lines.push("_Advisory only — a human still clicks accept (I9)._");
    if (triage.length) {
      lines.push("| # | verdict | conf | fact | why |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const t of triage)
        lines.push(
          `| ${t.id} | ${t.verdict} | ${t.confidence.toFixed(2)} | ${t.fact.slice(0, 60)} | ${t.reasons[0] ?? ""} |`,
        );
    } else {
      lines.push("- no pending proposals");
    }
    lines.push("");
  }
  return lines.join("\n");
}

function main() {
  const args = parseArgs(Bun.argv.slice(2));
  if (!args.db) {
    console.error(
      "usage: bun plugin/gateway/compaction-cli.ts --db <knowledge.db> [--triage] [--json]",
    );
    process.exit(2);
  }
  if (!fs.existsSync(args.db)) {
    console.error(`--db not found: ${args.db}`);
    process.exit(2);
  }

  const store = new KnowledgeStore(args.db);
  const docs = store.listDocs();
  const pending = store.listCorrections("pending");
  const { report, triage } = buildReport(docs, pending, args.triage);

  if (args.json) console.log(JSON.stringify({ report, triage }, null, 2));
  else console.log(render(report, triage, args.triage));
}

if (import.meta.main) main();
