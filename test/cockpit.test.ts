// SPDX-License-Identifier: Apache-2.0
// Curation cockpit (curation-cockpit-spec): a pending correction carries a
// DRAFT + advisory FLAGS; approving COMMITS the drafted doc-edit for ALL kinds
// (not just gotchas — the regression that motivated piece A). Reject is soft,
// audited, and reversible. All of this is store + approval level (no gateway
// spawn) so it runs in the fast suite.
import { describe, it, expect, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeStore } from "../plugin/gateway/lib/store";
import { previewBody } from "../plugin/gateway/lib/search";
import { applyApprovalAction, defaultDraft, foldIntoBody } from "../plugin/gateway/lib/approval";

const dbs: string[] = [];
function freshStore(): KnowledgeStore {
  const dbPath = path.join(os.tmpdir(), `setoku-cockpit-${process.pid}-${dbs.length}.db`);
  dbs.push(dbPath);
  return new KnowledgeStore(dbPath);
}
afterAll(() => {
  for (const d of dbs) for (const f of [d, `${d}-wal`, `${d}-shm`]) fs.rmSync(f, { force: true });
});

describe("cockpit: accept commits the drafted doc for non-gotcha kinds", () => {
  it("approving a metric correction with a draft actually CHANGES the metric doc (the non-gotcha gap)", () => {
    const store = freshStore();
    // a curated metric exists with the wrong definition
    store.upsertDoc({ type: "metric", name: "revenue", body: "SELECT sum(amount) FROM orders", meta: {} }, "gen");
    // an analyst proposes the fix
    const id = store.addCorrection({
      user: "alice@co.test",
      kind: "metric",
      fact: "revenue must net out refunds",
      relatesTo: "revenue",
    });

    // BEFORE the fix this did nothing to the doc. Now the human approves WITH a draft.
    const flash = applyApprovalAction(store, "boss", {
      id,
      action: "accepted",
      draft: {
        type: "metric",
        name: "revenue",
        body: "SELECT sum(amount) - sum(refunds) FROM orders",
        meta: { summary: "net revenue" },
      },
    });

    const doc = store.getDoc("metric", "revenue");
    expect(doc?.body).toContain("sum(refunds)");
    expect(doc?.updatedBy).toBe("boss"); // approver attributed
    expect(flash).toContain("revenue");
    expect(store.listCorrections("pending")).toHaveLength(0);
  });

  it("approving a non-gotcha correction with no draft and no parent doc lands as a gotcha, not a stub", () => {
    const store = freshStore();
    const id = store.addCorrection({ user: "alice@co.test", kind: "entity", fact: "orders excludes test accounts" });
    const flash = applyApprovalAction(store, "boss", { id, action: "accepted" });
    expect(store.listDocs().map((d) => d.type)).toEqual(["gotcha"]);
    expect(store.gotchas().some((g) => g.includes("excludes test accounts"))).toBe(true);
    expect(flash).toContain("[gotcha]");
    expect(store.listCorrections("accepted")).toHaveLength(1);
  });

  it("a gotcha still folds via the synthesized default draft (back-compat)", () => {
    const store = freshStore();
    const id = store.addCorrection({ user: "alice@co.test", kind: "gotcha", fact: "GC top-ups are excluded from net revenue", relatesTo: "revenue" });
    applyApprovalAction(store, "boss", { id, action: "accepted" });
    const gotchas = store.gotchas();
    expect(gotchas.some((g) => g.includes("GC top-ups"))).toBe(true);
  });

  it("defaultDraft surfaces a gotcha's synthesized draft, and a gotcha for a non-gotcha with nothing to fold into", () => {
    const store = freshStore();
    const gid = store.addCorrection({ user: "a", kind: "gotcha", fact: "x is y", relatesTo: "x" });
    const eid = store.addCorrection({ user: "a", kind: "entity", fact: "e excludes z" });
    const g = store.getCorrection(gid)!;
    const e = store.getCorrection(eid)!;
    expect(defaultDraft(g).type).toBe("gotcha");
    expect(defaultDraft(e).type).toBe("gotcha");
    expect(defaultDraft(e).body).toBe("e excludes z");
  });
});

describe("cockpit: a correction FOLDS into the doc it refines", () => {
  const sql = "SELECT count(*) FROM orders WHERE status = 'PAID'";

  it("keeps the parent doc's body and appends the claim under Curation notes", () => {
    const store = freshStore();
    store.upsertDoc({ type: "metric", name: "paid-orders", body: sql, meta: { summary: "orders paid", keywords: ["orders"] } }, "gen");
    // relatesTo is the doc's own name: the case the old cockpit seed turned into an overwrite
    const id = store.addCorrection({ user: "alice@co.test", kind: "metric", fact: "refunded orders still count as paid here", relatesTo: "paid-orders" });
    applyApprovalAction(store, "boss", { id, action: "accepted" });
    const doc = store.getDoc("metric", "paid-orders")!;
    expect(doc.body.startsWith(sql)).toBe(true);
    expect(doc.body).toContain("## Curation notes");
    expect(doc.body).toContain(`### #${id} (alice@co.test, `);
    expect(doc.body).toContain("refunded orders still count as paid here");
    expect(doc.meta.summary).toBe("orders paid"); // parent meta kept
    expect(store.docCount).toBe(1); // no stub alongside
  });

  it("folds across kinds and case (a metric-kind note about entity Order) but never by substring", () => {
    const store = freshStore();
    store.upsertDoc({ type: "entity", name: "Order", body: "One row per order.", meta: {} }, "gen");
    store.upsertDoc({ type: "entity", name: "OrderItem", body: "A line item.", meta: {} }, "gen");
    const id = store.addCorrection({ user: "a", kind: "metric", fact: "status comes from the payments table", relatesTo: "order" });
    const d = defaultDraft(store.getCorrection(id)!, store.listDocs());
    expect([d.type, d.name]).toEqual(["entity", "Order"]);
    expect(d.body).toContain("One row per order.");
    const other = store.addCorrection({ user: "a", kind: "entity", fact: "x", relatesTo: "Item" });
    expect(defaultDraft(store.getCorrection(other)!, store.listDocs()).type).toBe("gotcha");
  });

  it("a second note appends under the same heading, and re-drafting the same correction is idempotent", () => {
    const store = freshStore();
    store.upsertDoc({ type: "metric", name: "hires", body: sql, meta: {} }, "gen");
    const a = store.addCorrection({ user: "a", kind: "metric", fact: "first", relatesTo: "hires" });
    applyApprovalAction(store, "boss", { id: a, action: "accepted" });
    const b = store.addCorrection({ user: "b", kind: "metric", fact: "second", relatesTo: "hires" });
    const draft = defaultDraft(store.getCorrection(b)!, store.listDocs());
    expect(draft.body.split("## Curation notes")).toHaveLength(2);
    expect(draft.body.indexOf("first")).toBeLessThan(draft.body.indexOf("second"));
    applyApprovalAction(store, "boss", { id: b, action: "accepted" });
    const body = store.getDoc("metric", "hires")!.body;
    expect(foldIntoBody(body, store.getCorrection(b)!)).toBe(body);
  });

  it("hands the committed doc to onCommit (so the semantic index can re-embed it)", () => {
    const store = freshStore();
    store.upsertDoc({ type: "metric", name: "hires", body: sql, meta: {} }, "gen");
    const id = store.addCorrection({ user: "a", kind: "metric", fact: "note", relatesTo: "hires" });
    const seen: string[] = [];
    applyApprovalAction(store, "boss", { id, action: "accepted" }, (doc) => seen.push(`${doc.type}:${doc.name}:${doc.body.includes("note")}`));
    expect(seen).toEqual(["metric:hires:true"]);
  });
});

describe("cockpit: draft + flags persistence (piece B)", () => {
  it("draftCorrection attaches a draft + flags without committing or resolving", () => {
    const store = freshStore();
    const id = store.addCorrection({ user: "a", kind: "metric", fact: "fix me", relatesTo: "revenue" });
    const ok = store.draftCorrection(
      id,
      { type: "metric", name: "revenue", body: "SELECT 1", meta: {} },
      ["lint", "dupe"],
      "janitor@bot",
    );
    expect(ok).toBe(true);
    expect(store.docCount).toBe(0); // a draft commits nothing
    const corr = store.getCorrection(id);
    if (corr?.status !== "pending") throw new Error("expected a pending correction");
    expect(corr.draft?.body).toBe("SELECT 1");
    expect(corr.flags).toEqual(["lint", "dupe"]);
    expect(corr.draftedBy).toBe("janitor@bot");
    // and a persisted draft wins over the synthesized default
    expect(defaultDraft(corr).body).toBe("SELECT 1");
  });
});

describe("cockpit: reject is soft, audited, reversible (piece C)", () => {
  it("a human reject records a reason and is NOT marked rejected_by_bot", () => {
    const store = freshStore();
    const id = store.addCorrection({ user: "a", kind: "gotcha", fact: "noise" });
    applyApprovalAction(store, "boss", { id, action: "rejected", reason: "duplicate of existing" });
    const corr = store.getCorrection(id);
    if (corr?.status !== "rejected") throw new Error("expected a rejected correction");
    expect(corr.rejectReason).toBe("duplicate of existing");
    expect(corr.rejectedByBot).toBe(false);
  });

  it("a bot reject is reversible — unreject restores it to pending", () => {
    const store = freshStore();
    const id = store.addCorrection({ user: "a", kind: "gotcha", fact: "maybe good" });
    expect(store.rejectCorrection(id, "drafted SQL errors", "janitor@bot", true)).toBe(true);
    const rejected = store.getCorrection(id);
    if (rejected?.status !== "rejected") throw new Error("expected a rejected correction");
    expect(rejected.rejectedByBot).toBe(true);

    expect(store.unrejectCorrection(id, "boss")).toBe(true);
    // back to pending — a pending correction simply has no reject info (the union
    // makes "pending with a reject reason" unrepresentable).
    expect(store.getCorrection(id)?.status).toBe("pending");
  });
});

describe("find_context preview keeps a long doc's Curation notes", () => {
  const long = "x".repeat(2000);

  it("a doc without notes previews as before (head slice)", () => {
    expect(previewBody(long)).toBe("x".repeat(600) + " …");
  });

  it("shows the notes after the truncated head, so a ruling isn't hidden by the cut", () => {
    const store = freshStore();
    store.upsertDoc({ type: "metric", name: "paid-orders", body: long, meta: {} }, "gen");
    const id = store.addCorrection({ user: "a", kind: "metric", fact: "count refunds as paid", relatesTo: "paid-orders" });
    applyApprovalAction(store, "boss", { id, action: "accepted" });
    const p = previewBody(store.getDoc("metric", "paid-orders")!.body);
    expect(p.startsWith("x".repeat(600) + " …")).toBe(true);
    expect(p).toContain("## Curation notes");
    expect(p).toContain("count refunds as paid");
    expect(p.length).toBeLessThan(800);
  });

  it("over the cap, keeps the newest notes and says earlier ones exist", () => {
    const notes = [1, 2, 3].map((i) => `### #${i} (a, 2026-01-0${i})\n\n${String(i).repeat(500)}`).join("\n\n");
    const p = previewBody(`${long}\n\n## Curation notes\n\n${notes}\n`, 600, 1200);
    expect(p).toContain("(earlier notes in the full doc)");
    expect(p).not.toContain("### #1 ");
    expect(p).toContain("### #2 ");
    expect(p).toContain("### #3 ");
  });
});
