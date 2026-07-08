// SPDX-License-Identifier: Apache-2.0
// App version history (issue #58): createPublished / updatePublished append
// append-only content snapshots, the newest mirrors the live row, and a snapshot
// carries who edited + when so the header drawer can list versions and revert.
import { describe, it, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeStore } from "../plugin/gateway/lib/store";

const dbPath = path.join(os.tmpdir(), `setoku-apphist-${process.pid}.db`);
afterAll(() => {
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (fs.existsSync(f)) fs.rmSync(f);
});

const PANELS = [{ key: "p1", sql: "SELECT 1", dialect: "postgres" as const }];

describe("app version history", () => {
  it("records v1 on publish and a new version per content edit", () => {
    const store = new KnowledgeStore(dbPath);
    store.createPublished({ id: "app1", title: "First", body: "<div>a</div>", panels: PANELS, refreshSeconds: 60, createdBy: "alice" });

    let revs = store.listAppRevisions("app1");
    expect(revs.length).toBe(1);
    expect(revs[0].seq).toBe(1);
    expect(revs[0].editor).toBe("alice");
    expect(revs[0].hasPanels).toBe(true);

    // A content edit by a different identity appends v2, attributed to the editor.
    store.updatePublished("app1", { title: "Second", body: "<div>b</div>" }, { editor: "bob" });
    revs = store.listAppRevisions("app1"); // newest first
    expect(revs.map((r) => r.seq)).toEqual([2, 1]);
    expect(revs[0].editor).toBe("bob");
    expect(revs[0].title).toBe("Second");

    // The newest revision mirrors the live row.
    const snap = store.getAppRevision("app1", 2);
    expect(snap?.body).toBe("<div>b</div>");
    expect(store.getPublished("app1")?.body).toBe("<div>b</div>");
  });

  it("does not append a version when the content is unchanged", () => {
    const store = new KnowledgeStore(dbPath);
    const before = store.listAppRevisions("app1").length;
    // No-op update (empty fields) must not create a phantom version.
    store.updatePublished("app1", {}, { editor: "bob" });
    expect(store.listAppRevisions("app1").length).toBe(before);
    // Re-writing IDENTICAL values still matches the row (SQLite reports a
    // "change") but the diff-gate must suppress the duplicate full-body snapshot.
    const live = store.getPublished("app1")!;
    store.updatePublished("app1", { title: live.title, body: live.body }, { editor: "bob" });
    expect(store.listAppRevisions("app1").length).toBe(before);
    // A genuine change DOES append.
    store.updatePublished("app1", { title: "Renamed" }, { editor: "bob" });
    expect(store.listAppRevisions("app1").length).toBe(before + 1);
  });

  it("getAppRevision returns the full snapshot for restore; a restore round-trips", () => {
    const store = new KnowledgeStore(dbPath);
    const v1 = store.getAppRevision("app1", 1);
    expect(v1?.title).toBe("First");
    expect(v1?.body).toBe("<div>a</div>");

    const topBefore = store.listAppRevisions("app1")[0].seq;
    // Simulate the http revert handler: feed v1 back through updatePublished.
    store.updatePublished(
      "app1",
      { title: v1!.title, body: v1!.body, panels: v1!.panels ?? [], params: v1!.params ?? [], format: v1!.format, refreshSeconds: v1!.refreshSeconds },
      { editor: "alice", note: "Restored version 1" },
    );
    const live = store.getPublished("app1");
    expect(live?.body).toBe("<div>a</div>");
    expect(live?.title).toBe("First");
    const revs = store.listAppRevisions("app1");
    expect(revs[0].seq).toBe(topBefore + 1); // restore is itself a new version
    expect(revs[0].note).toBe("Restored version 1");
  });
});

describe("history diff + last-editor", () => {
  it("tags each version with what differs from the live app; current has none", () => {
    const store = new KnowledgeStore(dbPath);
    store.createPublished({ id: "diffapp", title: "T1", body: "b1", refreshSeconds: 60, createdBy: "alice" });
    store.updatePublished("diffapp", { title: "T2" }, { editor: "bob" }); // title-only
    store.updatePublished("diffapp", { body: "b3", panels: [{ key: "p", sql: "SELECT 1", dialect: "postgres" }] }, { editor: "carol" });

    const hist = store.listAppHistory("diffapp"); // newest first: seq 3,2,1
    expect(hist.map((r) => r.seq)).toEqual([3, 2, 1]);
    expect(hist[0].changes).toEqual([]); // current == live
    // v2 (title "T2", body "b1", no panels) vs live (title "T2", body "b3", panels):
    // title matches now, but content + data differ.
    expect(hist[1].changes.sort()).toEqual(["content", "data"]);
    // v1 (title "T1", body "b1", no panels) vs live: title + content + data differ.
    expect(hist[2].changes.sort()).toEqual(["content", "data", "title"]);
  });

  it("latestAppEdit reports the newest editor + version count", () => {
    const store = new KnowledgeStore(dbPath);
    const e = store.latestAppEdit("diffapp");
    expect(e?.editor).toBe("carol");
    expect(e?.versions).toBe(3);
    expect(store.latestAppEdit("nope")).toBeNull();
  });
});

describe("retention", () => {
  it("prunes to the newest 100 versions, keeping the live one", () => {
    const store = new KnowledgeStore(dbPath);
    store.createPublished({ id: "capapp", title: "v", body: "b0", createdBy: "alice" });
    for (let i = 1; i <= 120; i++) store.updatePublished("capapp", { body: `b${i}` }, { editor: "alice" });
    const revs = store.listAppRevisions("capapp"); // newest first
    expect(revs.length).toBe(100);
    // The live row is the newest snapshot (seq 121: v1 + 120 edits).
    expect(revs[0].seq).toBe(121);
    expect(store.getAppRevision("capapp", 121)?.body).toBe("b120");
    expect(store.getPublished("capapp")?.body).toBe("b120");
    // The oldest surviving version is seq 22; earlier ones were pruned.
    expect(revs[revs.length - 1].seq).toBe(22);
    expect(store.getAppRevision("capapp", 1)).toBeNull();
  });
});

describe("backfill", () => {
  it("gives an app published before history a v1 from its current row", () => {
    // Write a published row directly (no snapshot), then reopen the store to run
    // the idempotent backfill — mimics an app that predates the app_revisions table.
    const raw = new Database(dbPath);
    raw.run(
      "INSERT INTO published (id, title, format, body, panels, params, refresh_seconds, visibility, created_by, created_at) VALUES (?, ?, 'app', ?, NULL, NULL, NULL, 'team', ?, ?)",
      ["legacy1", "Legacy", "<div>old</div>", "carol", "2026-01-01T00:00:00.000Z"],
    );
    raw.run("DELETE FROM app_revisions WHERE app_id = 'legacy1'");
    raw.close();

    const store = new KnowledgeStore(dbPath);
    const revs = store.listAppRevisions("legacy1");
    expect(revs.length).toBe(1);
    expect(revs[0].seq).toBe(1);
    expect(revs[0].editor).toBe("carol");
    expect(revs[0].ts).toBe("2026-01-01T00:00:00.000Z");

    // Idempotent — reopening does not duplicate the backfilled v1.
    const store2 = new KnowledgeStore(dbPath);
    expect(store2.listAppRevisions("legacy1").length).toBe(1);
  });
});
