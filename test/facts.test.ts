// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeStore, type Correction, type KnowledgeDoc } from "../plugin/gateway/lib/store";
import {
  buildKnowledgeView,
  compact,
  conciseClaim,
  extractFacts,
  findContradictions,
  findDuplicates,
  findStale,
  judgeProposal,
  splitFactCommentary,
  wellFormedness,
  type Fact,
  type Proposal,
} from "../plugin/gateway/lib/facts";
import { judgementMetrics } from "../plugin/gateway/lib/quality";
import { applyApprovalAction } from "../plugin/gateway/lib/approval";

function doc(over: Partial<KnowledgeDoc> & { name: string; type: KnowledgeDoc["type"] }): KnowledgeDoc {
  return {
    meta: {},
    body: "",
    verified: true,
    updatedBy: "curator@example.com",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function correction(over: Partial<Correction> & { id: number; content: string }): Correction {
  return {
    ts: "2026-01-02T00:00:00Z",
    user: "analyst@example.com",
    kind: "gotcha",
    fact: null,
    relatesTo: null,
    status: "pending",
    ...over,
  };
}

/* ----------------------------- avenue 1 ---------------------------------- */

describe("conciseClaim / splitFactCommentary (avenue 1)", () => {
  it("keeps only the first sentence as the fact", () => {
    const text =
      "Revenue excludes refunded orders. We learned this the hard way after the Q1 report double-counted.";
    expect(conciseClaim(text)).toBe("Revenue excludes refunded orders.");
    const { fact, commentary } = splitFactCommentary(text);
    expect(fact).toBe("Revenue excludes refunded orders.");
    expect(commentary).toContain("hard way");
  });

  it("skips markdown headers and caps length", () => {
    expect(conciseClaim("# Heading\n\nThe real fact here.")).toBe("The real fact here.");
    expect(conciseClaim("x".repeat(500)).endsWith("…")).toBe(true);
  });
});

describe("wellFormedness (avenue 1)", () => {
  it("scores a concise, sourced, subject-bearing fact highly", () => {
    const p: Proposal = {
      subject: "revenue",
      fact: "Revenue excludes refunded orders.",
      provenance: { source: "src/billing.ts:14" },
    };
    expect(wellFormedness(p).score).toBe(1);
  });

  it("penalizes a multi-sentence paragraph and names the fix", () => {
    const p: Proposal = {
      subject: "revenue",
      fact: "Revenue excludes refunds. It also excludes test orders. And chargebacks.",
    };
    const wf = wellFormedness(p);
    expect(wf.score).toBeLessThan(0.7);
    expect(wf.reasons.some((r) => r.includes("split"))).toBe(true);
  });

  it("flags empty and subjectless proposals", () => {
    expect(wellFormedness({ fact: "" }).score).toBe(0);
    expect(wellFormedness({ fact: "a thing happens" }).reasons.some((r) => r.includes("no subject"))).toBe(true);
  });

  it("rejects a punctuation-only fact as having no word content", () => {
    expect(wellFormedness({ fact: "!!!", subject: "x" }).score).toBe(0);
    expect(judgeProposal({ fact: "???", subject: "x" }, []).verdict).toBe("reject");
  });
});

/* ----------------------------- avenue 4 ---------------------------------- */

describe("extractFacts (avenue 4)", () => {
  const docs = [
    doc({
      type: "metric",
      name: "revenue",
      meta: { summary: "Revenue excludes refunded orders.", source: "src/billing.ts:14" },
    }),
  ];

  it("derives a fact per doc with a type-prefixed subject", () => {
    const facts = extractFacts(docs);
    expect(facts).toHaveLength(1);
    expect(facts[0].subject).toBe("metric:revenue");
    expect(facts[0].claim).toBe("Revenue excludes refunded orders.");
    expect(facts[0].origin).toBe("doc");
    expect(facts[0].provenance?.source).toBe("src/billing.ts:14");
  });

  it("resolves a correction's relatesTo onto the matching doc subject", () => {
    const corr = [correction({ id: 7, relatesTo: "revenue", kind: "metric", content: "Revenue includes refunded orders." })];
    const facts = extractFacts(docs, corr);
    const corrFact = facts.find((f) => f.origin === "correction")!;
    expect(corrFact.subject).toBe("metric:revenue"); // grouped with the doc, not "revenue"
  });

  it("resolves a name collision to the canonical (non-gotcha) doc, regardless of order", () => {
    // a metric and a gotcha share the name "mrr"; a correction about "mrr"
    // must group with the metric (so a real conflict is detected), not the gotcha.
    const mixed = [
      doc({ type: "gotcha", name: "mrr", body: "MRR note." }),
      doc({ type: "metric", name: "mrr", meta: { summary: "MRR is recognized monthly." } }),
    ];
    const corr = [correction({ id: 9, relatesTo: "mrr", kind: "metric", content: "MRR is recognized annually." })];
    const facts = extractFacts(mixed, corr);
    expect(facts.find((f) => f.origin === "correction")!.subject).toBe("metric:mrr");
  });
});

/* ----------------------------- avenue 2 ---------------------------------- */

describe("findDuplicates (avenue 2)", () => {
  it("flags near-identical facts on the same subject and ignores cross-subject overlap", () => {
    const facts: Fact[] = [
      { subject: "metric:revenue", predicate: "definition", object: "", claim: "Revenue excludes refunded orders entirely", origin: "doc", ref: "revenue" },
      { subject: "metric:revenue", predicate: "definition", object: "", claim: "Revenue excludes refunded orders completely", origin: "doc", ref: "recognized_revenue" },
      { subject: "entity:order", predicate: "entity", object: "", claim: "An order excludes refunded line items", origin: "doc", ref: "Order" },
    ];
    const dups = findDuplicates(facts, 0.6);
    expect(dups).toHaveLength(1);
    expect([dups[0].a, dups[0].b].sort()).toEqual(["recognized_revenue", "revenue"]);
  });

  it("flags two near-identical facts on DIFFERENT subjects as one fact", () => {
    const facts: Fact[] = [
      { subject: "metric:revenue", predicate: "definition", object: "", claim: "Revenue excludes refunded orders", origin: "doc", ref: "revenue" },
      { subject: "metric:recognized_revenue", predicate: "definition", object: "", claim: "Revenue excludes refunded orders", origin: "doc", ref: "recognized_revenue" },
    ];
    const dups = findDuplicates(facts);
    expect(dups).toHaveLength(1);
    expect(dups[0].reason).toContain("across subjects");
  });
});

describe("findContradictions (avenue 2)", () => {
  it("catches an antonym clash on the same subject", () => {
    const facts: Fact[] = [
      { subject: "metric:revenue", predicate: "definition", object: "", claim: "Revenue excludes refunded orders", origin: "doc", ref: "revenue" },
      { subject: "metric:revenue", predicate: "metric", object: "", claim: "Revenue includes refunded orders", origin: "correction", ref: "correction:9" },
    ];
    const c = findContradictions(facts);
    expect(c).toHaveLength(1);
    expect(c[0].reason).toContain("opposing");
  });

  it("does NOT deterministically flag numeric differences (left to in-session compaction)", () => {
    // numbers can't be told apart structurally — a salient quantity vs an
    // incidental id (member 100 vs 101) vs a year. The heuristic false-fired on
    // real data, so it's gone; /setoku:compact judges these semantically.
    const facts: Fact[] = [
      { subject: "topic:member-origin", predicate: "metric", object: "", claim: "Manual review by steven for member 100", origin: "correction", ref: "a" },
      { subject: "topic:member-origin", predicate: "metric", object: "", claim: "Manual review by steven for member 101", origin: "correction", ref: "b" },
      { subject: "metric:revenue", predicate: "unit", object: "", claim: "Divide total_cents by 100 for dollars", origin: "doc", ref: "c" },
      { subject: "metric:revenue", predicate: "unit", object: "", claim: "Divide total_cents by 1000 for dollars", origin: "correction", ref: "d" },
    ];
    expect(findContradictions(facts)).toHaveLength(0);
  });

  it("catches an atomic-predicate object mismatch", () => {
    const facts: Fact[] = [
      { subject: "metric:revenue", predicate: "unit", object: "cents", claim: "unit is cents", origin: "doc", ref: "a" },
      { subject: "metric:revenue", predicate: "unit", object: "dollars", claim: "unit is dollars", origin: "doc", ref: "b" },
    ];
    expect(findContradictions(facts)[0].reason).toContain("disagrees");
  });

  it("does not flag unrelated facts or unscoped corrections", () => {
    const facts: Fact[] = [
      { subject: "metric:revenue", predicate: "definition", object: "", claim: "Revenue excludes refunds", origin: "doc", ref: "a" },
      { subject: "entity:customer", predicate: "entity", object: "", claim: "Customers can be soft-deleted", origin: "doc", ref: "b" },
      { subject: "unscoped", predicate: "gotcha", object: "", claim: "Something excludes and includes things", origin: "correction", ref: "c" },
    ];
    expect(findContradictions(facts)).toHaveLength(0);
  });
});

describe("findStale (avenue 2)", () => {
  const facts: Fact[] = [
    { subject: "metric:revenue", predicate: "definition", object: "", claim: "x", origin: "doc", ref: "a", provenance: { source: "src/gone.ts:1" } },
    { subject: "metric:mrr", predicate: "definition", object: "", claim: "y", origin: "doc", ref: "b", provenance: { source: "src/here.ts:1" } },
  ];
  it("flags facts whose source is not in the known set", () => {
    const flags = findStale(facts, new Set(["src/here.ts:1"]));
    expect(flags).toHaveLength(1);
    expect(flags[0].ref).toBe("a");
  });
  it("flags nothing without a known-source set (no false stales)", () => {
    expect(findStale(facts)).toHaveLength(0);
  });
});

/* ----------------------------- avenue 3 ---------------------------------- */

describe("judgeProposal (avenue 3 — advisory)", () => {
  const existing: Fact[] = extractFacts([
    doc({ type: "metric", name: "revenue", meta: { summary: "Revenue excludes refunded orders.", source: "src/billing.ts:14" } }),
  ]);

  it("rejects a malformed proposal", () => {
    expect(judgeProposal({ fact: "" }, existing).verdict).toBe("reject");
  });

  it("rejects a duplicate of curated knowledge", () => {
    const r = judgeProposal({ subject: "revenue", fact: "Revenue excludes refunded orders." }, existing);
    expect(r.verdict).toBe("reject");
    expect(r.reasons[0]).toContain("duplicate");
  });

  it("routes a contradiction to review, never auto-reject", () => {
    const r = judgeProposal({ subject: "revenue", fact: "Revenue includes refunded orders.", provenance: { source: "x" } }, existing);
    expect(r.verdict).toBe("review");
    expect(r.reasons[0]).toContain("conflicts");
  });

  it("accepts a well-formed, sourced, novel fact", () => {
    const r = judgeProposal(
      { subject: "customer", fact: "Customers are soft-deleted via deleted_at.", provenance: { source: "src/models/customer.ts:12" } },
      existing,
    );
    expect(r.verdict).toBe("accept");
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("downgrades a novel but unsourced fact to review", () => {
    const r = judgeProposal({ subject: "customer", fact: "Customers are soft-deleted via deleted_at." }, existing);
    expect(r.verdict).toBe("review"); // confidence below the accept bar without provenance
  });
});

/* ------------------------- compaction integration ------------------------ */

describe("compact() integration", () => {
  it("reports merges, contradictions, and subject stats together", () => {
    const facts = extractFacts(
      [doc({ type: "metric", name: "revenue", meta: { summary: "Revenue excludes refunded orders." } })],
      [correction({ id: 1, relatesTo: "revenue", kind: "metric", content: "Revenue includes refunded orders." })],
    );
    const report = compact(facts);
    expect(report.contradictions.length).toBeGreaterThanOrEqual(1);
    expect(report.stats.facts).toBe(2);
    expect(report.stats.subjects).toBe(1); // both resolve to metric:revenue
  });
});

/* ------------- avenue 1: structured propose path + migration ------------- */

describe("structured proposals through the store (avenue 1)", () => {
  const dbPath = path.join(os.tmpdir(), `setoku-propose-${process.pid}.db`);
  afterAll(() => {
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
  });

  it("stores the concise fact and the context separately, and feeds the authoritative fact to extraction", () => {
    const store = new KnowledgeStore(dbPath);
    store.addCorrection({
      user: "a@x.com",
      kind: "metric",
      fact: "Revenue excludes refunded orders.",
      context: "Confirmed against the Q1 export, which double-counted refunds.",
      relatesTo: "revenue",
    });
    const [row] = store.listCorrections("pending");
    expect(row.fact).toBe("Revenue excludes refunded orders.");
    expect(row.content).toContain("Q1 export"); // context lives in content, not the fact

    const f = extractFacts([], [row]).find((x) => x.origin === "correction")!;
    expect(f.claim).toBe("Revenue excludes refunded orders."); // authoritative, not heuristic-split
    expect(f.commentary).toContain("Q1 export");
  });

  it("still accepts a legacy single-blob proposal (fact NULL → heuristic split)", () => {
    const store = new KnowledgeStore(dbPath);
    const id = store.addCorrection({ user: "a@x.com", kind: "gotcha", content: "Money is cents. Divide by 100." });
    const row = store.listCorrections("pending").find((c) => c.id === id)!;
    expect(row.fact).toBeNull();
    expect(row.content).toBe("Money is cents. Divide by 100.");
    const f = extractFacts([], [row])[0];
    expect(f.claim).toBe("Money is cents."); // conciseClaim of the blob
  });
});

describe("corrections schema migrates in place (back-compat)", () => {
  const dbPath = path.join(os.tmpdir(), `setoku-migrate-${process.pid}.db`);
  afterAll(() => {
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
  });

  it("adds the `fact` column to a pre-#10 corrections table without losing rows", () => {
    // hand-build the OLD schema (no `fact` column) + a legacy row
    const raw = new Database(dbPath);
    raw.run(`CREATE TABLE corrections (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, user TEXT NOT NULL,
      kind TEXT NOT NULL, content TEXT NOT NULL, relates_to TEXT, status TEXT NOT NULL DEFAULT 'pending',
      resolved_by TEXT, resolved_ts TEXT)`);
    raw.run("INSERT INTO corrections (ts, user, kind, content) VALUES ('2026-01-01','old@x.com','gotcha','Legacy gotcha.')");
    raw.close();

    // opening through KnowledgeStore runs the idempotent ALTER
    const store = new KnowledgeStore(dbPath);
    const rows = store.listCorrections("pending");
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("Legacy gotcha.");
    expect(rows[0].fact).toBeNull();
    // and a new structured proposal works against the migrated table
    expect(() => store.addCorrection({ user: "n@x.com", kind: "gotcha", fact: "New fact.", context: "why" })).not.toThrow();
  });
});

/* --------------- subject-grouped knowledge view (/admin) ----------------- */

describe("buildKnowledgeView", () => {
  const longBody = Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ");
  const docs: KnowledgeDoc[] = [
    doc({ type: "metric", name: "revenue", meta: { summary: "Revenue excludes refunded orders." } }),
    doc({ type: "gotcha", name: "money-is-cents", body: "Money columns are integer cents — divide by 100.", meta: { relates_to: "revenue" } }),
    doc({ type: "gotcha", name: "standalone-note", body: "An unrelated standalone gotcha." }),
    doc({ type: "entity", name: "Customer", meta: { summary: "A shopper account." }, body: longBody }),
  ];

  it("groups a gotcha under the subject it relates to", () => {
    const v = buildKnowledgeView(docs);
    const revenue = v.subjects.find((s) => s.label === "revenue")!;
    expect(revenue.primaryType).toBe("metric");
    expect(revenue.members.map((m) => m.type).sort()).toEqual(["gotcha", "metric"]);
  });

  it("keeps an unrelated gotcha as its own subject", () => {
    const v = buildKnowledgeView(docs);
    expect(v.subjects.some((s) => s.key === "gotcha:standalone-note")).toBe(true);
  });

  it("infers a gotcha's subject from its content (plural-aware) when relates_to is absent", () => {
    const v = buildKnowledgeView([
      doc({ type: "entity", name: "Customer", meta: { summary: "A shopper." } }),
      doc({ type: "metric", name: "revenue", meta: { summary: "Paid orders only." } }),
      // no relates_to; mentions "customers" (plural) → attaches to entity Customer
      doc({ type: "gotcha", name: "soft-delete", body: "Soft-deleted customers are excluded from counts." }),
      // mentions "revenue" → attaches to metric revenue
      doc({ type: "gotcha", name: "refunds", body: "Refunded orders are excluded from revenue." }),
    ]);
    const customer = v.subjects.find((s) => s.label === "Customer")!;
    const revenue = v.subjects.find((s) => s.label === "revenue")!;
    expect(customer.members.some((m) => m.name === "soft-delete")).toBe(true);
    expect(revenue.members.some((m) => m.name === "refunds")).toBe(true);
  });

  it("surfaces concise claims and flags a verbose body", () => {
    const v = buildKnowledgeView(docs);
    const customer = v.subjects.find((s) => s.label === "Customer")!;
    expect(customer.members[0].claim).toBe("A shopper account.");
    expect(customer.members[0].flags).toContain("verbose");
    expect(v.health.verbose).toBeGreaterThanOrEqual(1);
  });

  it("flags a subject for review when a pending correction contradicts it", () => {
    const pending = [correction({ id: 5, relatesTo: "revenue", kind: "metric", content: "Revenue includes refunded orders." })];
    const v = buildKnowledgeView(docs, pending);
    const revenue = v.subjects.find((s) => s.label === "revenue")!;
    expect(revenue.flags).toContain("review");
    expect(revenue.members.find((m) => m.name === "revenue")!.flags).toContain("conflict");
    expect(v.health.contradictions).toBeGreaterThanOrEqual(1);
  });
});

/* ------------------- attribution + usage (/admin) ------------------------ */

describe("knowledge attribution + usage", () => {
  const dbPath = path.join(os.tmpdir(), `setoku-attr-${process.pid}.db`);
  afterAll(() => {
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
  });

  it("records the proposer on approval and shows proposed-by + approved-by", () => {
    const store = new KnowledgeStore(dbPath);
    const id = store.addCorrection({
      user: "alice@x.com",
      kind: "gotcha",
      fact: "Refunded orders are excluded from revenue.",
      relatesTo: "revenue",
    });
    applyApprovalAction(store, "boss@x.com", { id, action: "accepted" });

    const view = buildKnowledgeView(store.listDocs(), store.listCorrections("pending"));
    const member = view.subjects.flatMap((s) => s.members).find((m) => m.proposedBy);
    expect(member?.proposedBy).toBe("alice@x.com"); // who filed it
    expect(member?.updatedBy).toBe("boss@x.com"); // who approved it
  });

  it("knowledgeUsage tallies surfaced docs from the audit log", () => {
    const store = new KnowledgeStore(dbPath);
    store.audit("u@x.com", "find_context", { question: "q", docs: ["revenue", "Customer"] });
    store.audit("u@x.com", "find_context", { question: "q2", docs: ["revenue"] });
    store.audit("u@x.com", "get_metric", { name: "revenue", ok: true });
    store.audit("u@x.com", "describe_entity", { name: "Missing", ok: false }); // not counted
    const usage = store.knowledgeUsage();
    expect(usage["revenue"]).toBe(3); // 2 find_context + 1 get_metric
    expect(usage["Customer"]).toBe(1);
    expect(usage["Missing"]).toBeUndefined();
  });

  it("buildKnowledgeView attaches usage counts to members", () => {
    const docs = [doc({ type: "metric", name: "revenue", meta: { summary: "Paid orders only." } })];
    const view = buildKnowledgeView(docs, [], { revenue: 7 });
    const m = view.subjects[0].members[0];
    expect(m.uses).toBe(7);
    expect(m.name).toBe("revenue");
  });
});

/* ------- harness loop: auto-judge output scored by the #11 metric --------- */

describe("auto-judgement measured by the #11 false-accept-rate harness", () => {
  const curated: Fact[] = extractFacts([
    doc({ type: "metric", name: "revenue", meta: { summary: "Revenue excludes refunded orders.", source: "src/billing.ts:14" } }),
  ]);

  // labeled proposals: what a human would decide (gold)
  const labeled: { p: Proposal; gold: "accept" | "reject" }[] = [
    { p: { subject: "customer", fact: "Customers are soft-deleted via deleted_at.", provenance: { source: "src/models/customer.ts:12" } }, gold: "accept" },
    { p: { subject: "order", fact: "An order's status drives revenue recognition.", provenance: { source: "src/models/order.ts:3" } }, gold: "accept" },
    { p: { subject: "revenue", fact: "Revenue excludes refunded orders." }, gold: "reject" }, // duplicate
    { p: { fact: "" }, gold: "reject" }, // malformed
    { p: { subject: "revenue", fact: "Revenue includes refunded orders.", provenance: { source: "x" } }, gold: "reject" }, // contradiction
  ];

  it("never green-lights a proposal a human would reject (false-accept rate 0)", () => {
    const rows = labeled.map(({ p, gold }) => ({
      gold,
      // map advisory verdict to the binary metric: only an explicit "accept"
      // counts as an accept; "review" defers to the human, so it is NOT an
      // accept and cannot be a false-accept.
      predicted: (judgeProposal(p, curated).verdict === "accept" ? "accept" : "reject") as "accept" | "reject",
    }));
    const m = judgementMetrics(rows);
    expect(m.falseAcceptRate).toBe(0); // the membrane-critical number (I9)
    expect(m.recall).toBeGreaterThan(0); // and it does accept the good ones
  });
});
