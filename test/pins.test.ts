// SPDX-License-Identifier: Apache-2.0
// Per-person pinned apps: the pure layout ops (lib/pins.ts, shared with the
// admin SPA) and the store's save/load. The HTTP surface (own-identity only,
// demo viewer reads empty) is covered in apps-integration.test.ts.
import { describe, it, expect } from "bun:test";
import { KnowledgeStore } from "../plugin/gateway/lib/store";
import {
  emptyPins,
  normalizePins,
  nudgePin,
  nudgePinGroup,
  placePin,
  renamePinGroup,
  ungroupPins,
  unpin,
  MAX_PIN_GROUP_NAME,
  type PinLayout,
} from "../plugin/gateway/lib/pins";

const L = (...groups: [string, string[]][]): PinLayout => ({ groups: groups.map(([name, ids]) => ({ name, ids })) });

describe("normalizePins", () => {
  it("junk input becomes the empty layout", () => {
    for (const junk of [null, undefined, 42, "x", {}, { groups: "nope" }, { groups: [null, 3] }])
      expect(normalizePins(junk)).toEqual(emptyPins());
  });

  it("puts ungrouped first, merges same-named groups, dedupes ids, drops empty named groups", () => {
    const out = normalizePins({
      groups: [
        { name: " Ops ", ids: ["a", "b"] },
        { name: "Empty", ids: [] },
        { name: "", ids: ["c", "a"] }, // a already in Ops: first occurrence wins
        { name: "Ops", ids: ["d", 7, ""] },
      ],
    });
    expect(out).toEqual(L(["", ["c"]], ["Ops", ["a", "b", "d"]]));
  });

  it("caps names and filters ids through keep()", () => {
    const long = "x".repeat(200);
    const out = normalizePins({ groups: [{ name: long, ids: ["a", "gone"] }] }, (id) => id !== "gone");
    expect(out.groups[1].name.length).toBe(MAX_PIN_GROUP_NAME);
    expect(out.groups[1].ids).toEqual(["a"]);
  });
});

describe("pin moves", () => {
  const base = L(["", ["a", "b", "c"]], ["Ops", ["d"]]);

  it("placePin inserts before a row, appends without one, and creates a group", () => {
    expect(placePin(base, "c", { group: "", before: "a" })).toEqual(L(["", ["c", "a", "b"]], ["Ops", ["d"]]));
    expect(placePin(base, "a", { group: "Ops" })).toEqual(L(["", ["b", "c"]], ["Ops", ["d", "a"]]));
    expect(placePin(base, "x", { group: "New" })).toEqual(L(["", ["a", "b", "c"]], ["Ops", ["d"]], ["New", ["x"]]));
  });

  it("dropping a row on its own slot leaves it where it is", () => {
    expect(placePin(base, "b", { group: "", before: "b" })).toEqual(base);
  });

  it("moving the last pin out of a group dissolves it", () => {
    expect(placePin(base, "d", { group: "" })).toEqual(L(["", ["a", "b", "c", "d"]]));
    expect(unpin(base, "d")).toEqual(L(["", ["a", "b", "c"]]));
  });

  it("nudgePin swaps within a group and is a no-op at the ends", () => {
    expect(nudgePin(base, "b", -1).groups[0].ids).toEqual(["b", "a", "c"]);
    expect(nudgePin(base, "a", -1)).toEqual(base);
    expect(nudgePin(base, "c", 1)).toEqual(base);
  });

  it("groups rename (merging on collision), ungroup, and reorder — ungrouped stays first", () => {
    const two = L(["", ["a"]], ["Ops", ["b"]], ["Sales", ["c"]]);
    expect(renamePinGroup(two, "Ops", "Finance")).toEqual(L(["", ["a"]], ["Finance", ["b"]], ["Sales", ["c"]]));
    expect(renamePinGroup(two, "Sales", "Ops")).toEqual(L(["", ["a"]], ["Ops", ["b", "c"]]));
    expect(ungroupPins(two, "Ops")).toEqual(L(["", ["a", "b"]], ["Sales", ["c"]]));
    expect(nudgePinGroup(two, "Sales", -1)).toEqual(L(["", ["a"]], ["Sales", ["c"]], ["Ops", ["b"]]));
    expect(nudgePinGroup(two, "Ops", -1)).toEqual(two); // can't pass the ungrouped pins
  });
});

describe("store pins", () => {
  it("are per identity, drop unknown ids, keep archived ones, and clear", () => {
    const store = new KnowledgeStore(":memory:");
    store.createPublished({ id: "a1", title: "A", body: "<div></div>", createdBy: "alice" });
    store.createPublished({ id: "a2", title: "B", body: "<div></div>", createdBy: "alice" });
    expect(store.getPins("alice")).toEqual({ layout: emptyPins(), rev: 0 });

    const saved = store.setPins("alice", L(["", ["a1", "nope"]], ["Ops", ["a2"]]), 0)!;
    expect(saved).toEqual({ layout: L(["", ["a1"]], ["Ops", ["a2"]]), rev: 1 });
    expect(store.getPins("alice")).toEqual(saved);
    expect(store.getPins("bob").rev).toBe(0); // nobody else's page changes

    store.archivePublished("a2"); // an archived app keeps its pin (unarchive restores it in place)
    expect(store.setPins("alice", saved.layout, 1)?.layout).toEqual(saved.layout);

    store.clearPins("alice");
    expect(store.getPins("alice")).toEqual({ layout: emptyPins(), rev: 0 });
    store.db.close();
  });

  it("compare-and-set: a save built on a stale (or never-loaded) rev is refused", () => {
    const store = new KnowledgeStore(":memory:");
    store.createPublished({ id: "a1", title: "A", body: "<div></div>", createdBy: "alice" });
    store.createPublished({ id: "a2", title: "B", body: "<div></div>", createdBy: "alice" });
    expect(store.setPins("alice", L(["", ["a1", "a2"]]), 0)?.rev).toBe(1);
    // a tab that never loaded (base 0) can't wipe the stored layout
    expect(store.setPins("alice", L(["", ["a2"]]), 0)).toBeNull();
    // neither can one still holding rev 1 after another tab saved rev 2
    expect(store.setPins("alice", L(["", ["a2", "a1"]]), 1)?.rev).toBe(2);
    expect(store.setPins("alice", L(["", []]), 1)).toBeNull();
    expect(store.getPins("alice")).toEqual({ layout: L(["", ["a2", "a1"]]), rev: 2 });
    store.db.close();
  });
});

describe("nudges skip what the person can't see", () => {
  it("steps over hidden (archived) pins and groups with nothing visible", () => {
    const l = L(["", ["b", "hidden", "c"]], ["Ops", ["d"]], ["Gone", ["hidden2"]], ["Sales", ["e"]]);
    const shown = (id: string) => !id.startsWith("hidden");
    expect(nudgePin(l, "b", 1, shown).groups[0].ids).toEqual(["c", "hidden", "b"]);
    // Sales moves up past the all-hidden "Gone" group (which keeps its pins and slot)
    expect(nudgePinGroup(l, "Sales", -1, shown).groups.map((g) => g.name)).toEqual(["", "Sales", "Gone", "Ops"]);
  });
});
