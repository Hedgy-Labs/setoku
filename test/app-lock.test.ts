// SPDX-License-Identifier: Apache-2.0
// App locking (store layer): setAppLocked stamps/clears locked_at + locked_by,
// is a no-op when already in the requested state, and never touches archived
// rows. The MCP-side enforcement (update_app / unpublish_app reject a locked
// app) is covered end-to-end in http.test.ts.
import { describe, it, expect } from "bun:test";
import { KnowledgeStore } from "../plugin/gateway/lib/store";

const mk = (): KnowledgeStore => {
  const store = new KnowledgeStore(":memory:");
  store.createPublished({ id: "a1", title: "App", body: "<div></div>", createdBy: "alice" });
  return store;
};

describe("setAppLocked", () => {
  it("locks with who/when, reads back everywhere, and unlocks clean", () => {
    const store = mk();
    expect(store.getPublishedMeta("a1")?.lockedAt).toBeNull();

    expect(store.setAppLocked("a1", true, "boss")).toBe(true);
    const meta = store.getPublishedMeta("a1")!;
    expect(meta.lockedAt).toBeTruthy();
    expect(meta.lockedBy).toBe("boss");
    // the list surface (admin Apps page) sees it too
    expect(store.listPublished()[0].lockedAt).toBe(meta.lockedAt);

    expect(store.setAppLocked("a1", false, "boss")).toBe(true);
    const after = store.getPublishedMeta("a1")!;
    expect(after.lockedAt).toBeNull();
    expect(after.lockedBy).toBeNull();
    store.db.close();
  });

  it("is a no-op when already in the requested state, or for unknown/archived rows", () => {
    const store = mk();
    expect(store.setAppLocked("a1", false, "boss")).toBe(false); // already unlocked
    expect(store.setAppLocked("a1", true, "boss")).toBe(true);
    expect(store.setAppLocked("a1", true, "boss")).toBe(false); // already locked
    expect(store.setAppLocked("nope", true, "boss")).toBe(false); // unknown id

    store.archivePublished("a1");
    expect(store.setAppLocked("a1", false, "boss")).toBe(false); // archived rows are inert
    store.db.close();
  });

  it("a lock does not block human (store-level) edits — only the tool layer gates on it", () => {
    const store = mk();
    store.setAppLocked("a1", true, "boss");
    // rename/revert from /admin go through updatePublished and stay open
    expect(store.updatePublished("a1", { title: "Renamed" }, { editor: "boss" })).toBe(true);
    expect(store.getPublishedMeta("a1")?.title).toBe("Renamed");
    store.db.close();
  });
});
