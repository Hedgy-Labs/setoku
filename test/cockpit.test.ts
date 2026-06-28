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
import { applyApprovalAction, defaultDraft } from "../plugin/gateway/lib/approval";

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

  it("approving a non-gotcha correction with NO draft commits nothing (records only) until one is supplied", () => {
    const store = freshStore();
    const id = store.addCorrection({ user: "alice@co.test", kind: "entity", fact: "orders excludes test accounts" });
    const flash = applyApprovalAction(store, "boss", { id, action: "accepted" });
    expect(store.docCount).toBe(0); // no doc synthesized from free text
    expect(flash).toContain("no draft");
    expect(store.listCorrections("accepted")).toHaveLength(1);
  });

  it("a gotcha still folds via the synthesized default draft (back-compat)", () => {
    const store = freshStore();
    const id = store.addCorrection({ user: "alice@co.test", kind: "gotcha", fact: "GC top-ups are excluded from net revenue", relatesTo: "revenue" });
    applyApprovalAction(store, "boss", { id, action: "accepted" });
    const gotchas = store.gotchas();
    expect(gotchas.some((g) => g.includes("GC top-ups"))).toBe(true);
  });

  it("defaultDraft surfaces a gotcha's synthesized draft and null for an undrafted non-gotcha", () => {
    const store = freshStore();
    const gid = store.addCorrection({ user: "a", kind: "gotcha", fact: "x is y", relatesTo: "x" });
    const eid = store.addCorrection({ user: "a", kind: "entity", fact: "e excludes z" });
    const g = store.getCorrection(gid)!;
    const e = store.getCorrection(eid)!;
    expect(defaultDraft(g)?.type).toBe("gotcha");
    expect(defaultDraft(e)).toBeNull();
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
    expect(defaultDraft(corr)?.body).toBe("SELECT 1");
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
