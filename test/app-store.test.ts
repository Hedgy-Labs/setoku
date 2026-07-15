// SPDX-License-Identifier: Apache-2.0
// The per-app datastore lets an app persist its OWN state while the business DB
// stays read-only. These tests pin the two properties that make it safe:
// isolation (no app/viewer can read another's state) and bounded resources.
import { describe, it, expect, beforeEach } from "bun:test";
import {
  AppStore,
  AppStoreQuotaError,
  MAX_KEYS_PER_OWNER,
  MAX_VALUE_CHARS,
} from "../plugin/gateway/lib/app-store";

let store: AppStore;
const T = "2026-06-27T00:00:00.000Z";

beforeEach(() => {
  store = new AppStore(":memory:");
});

describe("app state — basic KV", () => {
  it("round-trips a JSON value", () => {
    store.set("app1", "app", null, "config", { theme: "stone" }, T);
    expect(store.get("app1", "app", null, "config")?.value).toEqual({ theme: "stone" });
  });
  it("upserts in place (no duplicate keys)", () => {
    store.set("app1", "app", null, "n", 1, T);
    store.set("app1", "app", null, "n", 2, T);
    expect(store.get("app1", "app", null, "n")?.value).toBe(2);
    expect(store.usage("app1", "app", null).keys).toBe(1);
  });
  it("lists and deletes", () => {
    store.set("app1", "app", null, "a", 1, T);
    store.set("app1", "app", null, "b", 2, T);
    expect(store.list("app1", "app", null).map((e) => e.key)).toEqual(["a", "b"]);
    expect(store.delete("app1", "app", null, "a")).toBe(true);
    expect(store.list("app1", "app", null).map((e) => e.key)).toEqual(["b"]);
  });
});

describe("isolation — the safety property", () => {
  it("one app cannot read another app's state", () => {
    store.set("app1", "app", null, "secret", "alpha", T);
    expect(store.get("app2", "app", null, "secret")).toBeNull();
  });
  it("one viewer cannot read another viewer's state", () => {
    store.set("app1", "viewer", "alice", "notes", "for-alice", T);
    store.set("app1", "viewer", "bob", "notes", "for-bob", T);
    expect(store.get("app1", "viewer", "alice", "notes")?.value).toBe("for-alice");
    expect(store.get("app1", "viewer", "bob", "notes")?.value).toBe("for-bob");
    // carol sees nothing
    expect(store.get("app1", "viewer", "carol", "notes")).toBeNull();
  });
  it("app scope ignores identity — shared by everyone", () => {
    store.set("app1", "app", "alice", "shared", 1, T); // identity ignored for app scope
    expect(store.get("app1", "app", "bob", "shared")?.value).toBe(1);
  });
  it("viewer scope and app scope are separate namespaces", () => {
    store.set("app1", "app", null, "k", "shared", T);
    store.set("app1", "viewer", "alice", "k", "private", T);
    expect(store.get("app1", "app", null, "k")?.value).toBe("shared");
    expect(store.get("app1", "viewer", "alice", "k")?.value).toBe("private");
  });
});

describe("bounded resources — the disk guard", () => {
  it("rejects an oversized value and writes nothing", () => {
    const big = "x".repeat(MAX_VALUE_CHARS + 1);
    expect(() => store.set("app1", "app", null, "k", big, T)).toThrow(AppStoreQuotaError);
    expect(store.get("app1", "app", null, "k")).toBeNull();
  });
  it("caps the number of keys per owner", () => {
    for (let i = 0; i < MAX_KEYS_PER_OWNER; i++) store.set("app1", "app", null, `k${i}`, i, T);
    expect(() => store.set("app1", "app", null, "one-too-many", 0, T)).toThrow(
      AppStoreQuotaError,
    );
    // updating an EXISTING key still works at the cap (no new key created)
    expect(() => store.set("app1", "app", null, "k0", 999, T)).not.toThrow();
  });
});

describe("the overlay pattern — annotate business rows without writing prod", () => {
  it("keys app state by a business row id to layer a 'reviewed' flag", () => {
    // business row id 'order-4821' lives in the read-only biz.* mirror; the flag lives here
    store.set("triage", "app", null, "order-4821", { reviewed: true, by: "alice" }, T);
    expect(store.get("triage", "app", null, "order-4821")?.value).toEqual({
      reviewed: true,
      by: "alice",
    });
  });
});
