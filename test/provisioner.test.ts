// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 4 self-provisioning framework tests (no network).
 *
 * Covers task 4.1 (plan/apply, idempotency, dryRun, provisioning_log),
 * 4.5 (schema inference golden tests), 4.6 (self-documentation membrane split),
 * and 4.7 (secret redaction — nothing token-shaped reaches provisioning_log).
 */
import { describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeStore } from "../plugin/gateway/lib/store.ts";
import {
  applySteps,
  redactSecrets,
  redactValue,
  HumanGatedError,
  PROVISIONER_ACTOR,
  type Plan,
} from "../provisioner/framework.ts";
import { inferColumns, emitDDL, inferTableDDL } from "../provisioner/infer-schema.ts";
import { documentTable } from "../provisioner/document.ts";
import { VercelProvisioner } from "../provisioner/sources/vercel.ts";

function freshStore(): KnowledgeStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-prov-"));
  return new KnowledgeStore(path.join(dir, "knowledge.db"));
}

// ---------------------------------------------------------------------------
// 4.5 — schema inference golden tests
// ---------------------------------------------------------------------------

describe("schema inference (4.5)", () => {
  it("infers types, LowCardinality, timestamp; collapses nested → raw", () => {
    const sample: Record<string, unknown>[] = [
      { ts: "2026-06-11T10:00:00.000Z", level: "info", code: 200, latency: 12.5, ok: true, meta: { a: 1 } },
      { ts: "2026-06-11T10:00:01.000Z", level: "info", code: 200, latency: 8.0, ok: false, meta: { a: 2 } },
      { ts: "2026-06-11T10:00:02.000Z", level: "warn", code: 500, latency: 40.1, ok: true, meta: { a: 3 } },
      { ts: "2026-06-11T10:00:03.000Z", level: "info", code: 404, latency: 5.5, ok: false, tags: [1, 2] },
      { ts: "2026-06-11T10:00:04.000Z", level: "info", code: 200, latency: 9.9, ok: true },
      { ts: "2026-06-11T10:00:05.000Z", level: "info", code: 200, latency: 3.3, ok: false },
    ];
    const schema = inferColumns(sample);
    const byName = Object.fromEntries(schema.columns.map((c) => [c.name, c.type]));

    expect(byName.ts).toBe("DateTime64(3)");
    expect(byName.level).toBe("LowCardinality(String)"); // few distinct over 6 rows
    expect(byName.code).toBe("Int64");
    expect(byName.latency).toBe("Float64");
    expect(byName.ok).toBe("Bool");
    // nested object + array were NOT given columns; they survive in raw.
    expect(byName.meta).toBeUndefined();
    expect(byName.tags).toBeUndefined();
    expect(schema.hasRaw).toBe(true);
    expect(schema.orderByTimestamp).toBe("ts");
  });

  it("detects epoch-ms timestamps", () => {
    const sample = [{ when: 1_750_000_000_000 }, { when: 1_750_000_001_000 }];
    const schema = inferColumns(sample);
    expect(schema.columns.find((c) => c.name === "when")?.type).toBe("DateTime64(3)");
  });

  it("high-cardinality strings stay String, not LowCardinality", () => {
    const sample = Array.from({ length: 10 }, (_, i) => ({ id: `id-${i}` }));
    const schema = inferColumns(sample);
    expect(schema.columns.find((c) => c.name === "id")?.type).toBe("String");
  });

  it("emits CREATE TABLE DDL with a raw column and timestamp ORDER BY", () => {
    const { ddl } = inferTableDDL("logs_unknown", [
      { ts: "2026-06-11T10:00:00.000Z", level: "info", code: 200 },
      { ts: "2026-06-11T10:00:01.000Z", level: "info", code: 200 },
      { ts: "2026-06-11T10:00:02.000Z", level: "warn", code: 500 },
      { ts: "2026-06-11T10:00:03.000Z", level: "info", code: 404 },
      { ts: "2026-06-11T10:00:04.000Z", level: "error", code: 200 },
    ]);
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS setoku.logs_unknown");
    expect(ddl).toContain("ENGINE = MergeTree");
    expect(ddl).toContain("PARTITION BY toYYYYMM(ts)");
    expect(ddl).toContain("ORDER BY (ts)");
    expect(ddl).toMatch(/raw\s+String\s+COMMENT/);
    expect(ddl).toContain("-- SPDX-License-Identifier: Apache-2.0");
  });

  it("falls back to ORDER BY (raw) when no timestamp is present", () => {
    const ddl = emitDDL("blob", inferColumns([{ name: "x" }, { name: "y" }]));
    expect(ddl).toContain("ORDER BY (raw)");
    expect(ddl).not.toContain("PARTITION BY");
  });
});

// ---------------------------------------------------------------------------
// 4.7 — secret redaction
// ---------------------------------------------------------------------------

describe("redactSecrets (4.7)", () => {
  it("masks Slack, Vercel, and Bearer token shapes", () => {
    const slack = redactSecrets("token=xoxb-123456789012-abcdefghijklmnop");
    expect(slack).not.toContain("xoxb-123456789012");
    expect(slack).toContain("xoxb-***redacted");

    const app = redactSecrets("app=xapp-1-A0123456789-abcdefghij");
    expect(app).not.toContain("xapp-1-A0123456789");

    const bearer = redactSecrets("Authorization: Bearer sk_live_AbC123dEf456GhI789jKl012");
    expect(bearer).not.toContain("sk_live_AbC123dEf456GhI789jKl012");
    expect(bearer).toContain("Bearer ");
  });

  it("redactValue walks nested objects/arrays", () => {
    const out = redactValue({
      headers: { Authorization: "Bearer xoxb-111111111111-zzzzzzzzzzzzzzzz" },
      list: ["xapp-1-AAAA1111-bbbbbbbbbb"],
      keep: "plain text",
    }) as Record<string, any>;
    expect(JSON.stringify(out)).not.toContain("xoxb-111111111111");
    expect(JSON.stringify(out)).not.toContain("xapp-1-AAAA1111");
    expect(out.keep).toBe("plain text");
  });
});

// ---------------------------------------------------------------------------
// 4.1 — framework: plan/apply, idempotency, dryRun, logging
// ---------------------------------------------------------------------------

function samplePlan(): Plan {
  return {
    source: "vercel",
    steps: [
      {
        kind: "log-drain",
        description: "Create drain for project p1",
        idempotencyKey: "vercel:log-drain:p1",
        details: { projectId: "p1", token: "xoxb-999999999999-secretsecretsec" },
      },
      {
        kind: "log-drain",
        description: "Create drain for project p2",
        idempotencyKey: "vercel:log-drain:p2",
        details: { projectId: "p2" },
      },
    ],
  };
}

describe("applySteps idempotency + logging (4.1)", () => {
  let store: KnowledgeStore;
  beforeEach(() => {
    store = freshStore();
  });

  it("applies all steps once, then skips them all on a second run", async () => {
    let executed = 0;
    const exec = async () => {
      executed++;
    };

    const first = await applySteps(store, samplePlan(), exec);
    expect(first.map((r) => r.status)).toEqual(["applied", "applied"]);
    expect(executed).toBe(2);

    const second = await applySteps(store, samplePlan(), exec);
    expect(second.map((r) => r.status)).toEqual(["skipped", "skipped"]);
    expect(executed).toBe(2); // executor NOT called again

    // provisioning_log shows applied (run 1) then skipped (run 2).
    const log = store.listProvisioning("vercel");
    const statuses = log.map((r) => r.status).sort();
    expect(statuses).toEqual(["applied", "applied", "skipped", "skipped"]);
    expect(store.wasApplied("vercel:log-drain:p1")).toBe(true);
  });

  it("dryRun makes no store writes beyond 'planned' and executes nothing", async () => {
    let executed = 0;
    const results = await applySteps(store, samplePlan(), async () => { executed++; }, {
      dryRun: true,
    });
    expect(executed).toBe(0);
    expect(results.every((r) => r.status === "skipped")).toBe(true);
    const log = store.listProvisioning();
    expect(log.length).toBe(2);
    expect(log.every((r) => r.status === "planned")).toBe(true);
    // dryRun did NOT mark anything applied.
    expect(store.wasApplied("vercel:log-drain:p1")).toBe(false);
  });

  it("records a failed step and stops, with the error redacted", async () => {
    const results = await applySteps(store, samplePlan(), async () => {
      throw new Error("boom with xoxb-777777777777-leakyleakyleaky inside");
    });
    expect(results[0].status).toBe("failed");
    // second step never ran (stop on first failure).
    expect(results.length).toBe(1);
    const failed = store.listProvisioning().find((r) => r.status === "failed")!;
    expect(JSON.stringify(failed.detail)).not.toContain("xoxb-777777777777");
  });

  it("nothing token-shaped reaches provisioning_log (4.7 AC)", async () => {
    await applySteps(store, samplePlan(), async () => {});
    const dump = JSON.stringify(store.listProvisioning());
    expect(dump).not.toMatch(/xoxb-\d{12}/);
    expect(dump).not.toContain("secretsecretsec");
  });
});

// ---------------------------------------------------------------------------
// 4.6 — self-documentation membrane split
// ---------------------------------------------------------------------------

describe("documentTable membrane split (4.6 / I2)", () => {
  it("auto-accepts the table doc but pends provenance gotchas", () => {
    const store = freshStore();
    const result = documentTable(store, {
      source: "vercel",
      table: "logs_vercel",
      refreshCadence: "live",
      columns: [{ name: "ts", meaning: "log time" }],
      exampleQueries: ["SELECT count() FROM setoku.logs_vercel"],
      gotchas: ["Vercel drains drop batches when the receiver is down; gaps ≠ traffic dips."],
    });

    // Entity doc auto-accepted, attributed setoku-provisioner, retrievable.
    const doc = store.getDoc("entity", "logs_vercel");
    expect(doc).not.toBeNull();
    expect(doc!.verified).toBe(true);
    expect(doc!.updatedBy).toBe(PROVISIONER_ACTOR);
    expect(doc!.meta.provisioned_by).toBe(PROVISIONER_ACTOR);
    expect(doc!.body).toContain("Example queries");

    // Gotcha landed PENDING via addCorrection (NOT auto-accepted).
    expect(result.gotchaCorrectionIds.length).toBe(1);
    const pending = store.listCorrections("pending");
    expect(pending.length).toBe(1);
    expect(pending[0].user).toBe(PROVISIONER_ACTOR);
    expect(pending[0].kind).toBe("gotcha");
    expect(pending[0].relatesTo).toBe("logs_vercel");
    expect(pending[0].content).toContain("gaps");
  });
});

// ---------------------------------------------------------------------------
// 4.2 — source scaffold: plan() works tokenless; apply() is human-gated
// ---------------------------------------------------------------------------

describe("VercelProvisioner scaffold (4.2)", () => {
  const cfg = { ingestHost: "setoku.example.com", ingestToken: "ingest-secret", projectIds: ["p1"] };

  it("discover + plan work without a token (preview only)", async () => {
    delete process.env.VERCEL_TOKEN;
    const store = freshStore();
    const p = new VercelProvisioner(store, cfg);
    const discovery = await p.discover();
    expect(discovery.notes.join(" ")).toContain("VERCEL_TOKEN not set");
    const plan = p.plan(discovery);
    expect(plan.steps[0].kind).toBe("log-drain");
    expect(plan.steps[0].idempotencyKey).toContain("p1");
    expect(plan.steps[0].details.url).toBe("https://setoku.example.com/ingest/vercel");
  });

  it("apply() throws a precise human-gated error when the token is absent", async () => {
    delete process.env.VERCEL_TOKEN;
    const store = freshStore();
    const p = new VercelProvisioner(store, cfg);
    const plan = p.plan(await p.discover());
    const results = await p.apply(plan, { dryRun: false });
    expect(results[0].status).toBe("failed");
    expect(results[0].error).toContain("VERCEL_TOKEN");
    expect(results[0].error).toContain("human-gated");
  });

  it("dryRun apply makes no changes and no live call", async () => {
    delete process.env.VERCEL_TOKEN;
    const store = freshStore();
    const p = new VercelProvisioner(store, cfg);
    const plan = p.plan(await p.discover());
    const results = await p.apply(plan, { dryRun: true });
    expect(results.every((r) => r.status === "skipped")).toBe(true);
    expect(store.wasApplied(plan.steps[0].idempotencyKey)).toBe(false);
  });

  it("HumanGatedError names the env var", () => {
    const e = new HumanGatedError("VERCEL_TOKEN", "do the thing");
    expect(e.message).toContain("needs VERCEL_TOKEN");
    expect(e.tokenEnvVar).toBe("VERCEL_TOKEN");
  });
});
