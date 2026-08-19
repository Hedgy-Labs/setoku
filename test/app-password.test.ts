// SPDX-License-Identifier: Apache-2.0
/**
 * The shared password on a public app (issue #112): the pure cookie/page helpers
 * in lib/app-access.ts, and the store's side of it — a grant is bound to ONE app
 * and dies the moment the password (or the app's public status) changes. The
 * end-to-end HTTP flow lives in test/http.test.ts.
 */
import { describe, it, expect } from "bun:test";
import {
  appAccessClearCookie,
  appAccessCookie,
  appAccessSetCookie,
  appPasswordPage,
  mintAppAccessToken,
  parseUnlockForm,
} from "../plugin/gateway/lib/app-access";
import { KnowledgeStore } from "../plugin/gateway/lib/store";
import { hashPassword, verifyPassword } from "../plugin/gateway/lib/accounts";

describe("unlock cookie", () => {
  it("round-trips through a Cookie header alongside other cookies", () => {
    const set = appAccessSetCookie("abc123", "grant-token");
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax"); // links are opened from Slack/email
    expect(set).toContain("Path=/p/abc123"); // only ever sent to this app
    const value = set.split(";")[0];
    expect(appAccessCookie(`setoku_session=xyz; ${value}; other=1`)).toBe("grant-token");
  });
  it("is absent when no grant cookie is present", () => {
    expect(appAccessCookie(undefined)).toBeUndefined();
    expect(appAccessCookie("setoku_session=xyz")).toBeUndefined();
  });
  it("clears with the same path, so a revoked grant stops being sent", () => {
    expect(appAccessClearCookie("abc123")).toContain("Path=/p/abc123");
    expect(appAccessClearCookie("abc123")).toContain("Max-Age=0");
  });
  it("mints unguessable, distinct tokens", () => {
    const a = mintAppAccessToken();
    expect(a).not.toBe(mintAppAccessToken());
    expect(a.length).toBeGreaterThanOrEqual(48);
  });
});

describe("unlock form + gate page", () => {
  it("reads the password field and tolerates junk", () => {
    expect(parseUnlockForm("password=hunter2")).toBe("hunter2");
    expect(parseUnlockForm("password=a%20b&other=x")).toBe("a b");
    expect(parseUnlockForm("")).toBe("");
    expect(parseUnlockForm("nothing-here")).toBe("");
  });
  it("escapes the app title (the one attacker-adjacent string on the page)", () => {
    const html = appPasswordPage({ title: '<script>alert(1)</script>', actionPath: "/p/x/unlock" });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("carries no script of its own and posts back to the unlock path", () => {
    const html = appPasswordPage({ title: "Report", actionPath: "/p/x/unlock", error: "nope" });
    expect(html).not.toContain("<script");
    expect(html).toContain('action="/p/x/unlock"');
    expect(html).toContain('type="password"');
    expect(html).toContain("nope");
  });
});

describe("password + grants in the store", () => {
  const mkApp = (store: KnowledgeStore, id: string): void =>
    store.createPublished({ id, title: id, body: "<div></div>", visibility: "public", createdBy: "boss" });

  it("stores only the hash and reports hasPassword in metadata", async () => {
    const store = new KnowledgeStore(":memory:");
    mkApp(store, "a1");
    expect(store.getPublishedMeta("a1")?.hasPassword).toBe(false);
    expect(store.getPublished("a1")?.hasPassword).toBe(false);

    store.setAppPassword("a1", await hashPassword("open-sesame-please"));
    expect(store.getPublishedMeta("a1")?.hasPassword).toBe(true);
    expect(store.listPublished()[0].hasPassword).toBe(true);
    // The hash itself is reachable only through the explicit accessor.
    expect(JSON.stringify(store.getPublishedMeta("a1"))).not.toContain("argon2");
    expect(await verifyPassword("open-sesame-please", store.appPasswordHash("a1"))).toBe(true);
    expect(await verifyPassword("wrong", store.appPasswordHash("a1"))).toBe(false);
  });

  it("binds a grant to one app and expires it", () => {
    const store = new KnowledgeStore(":memory:");
    mkApp(store, "a1");
    mkApp(store, "a2");
    store.grantAppAccess("tok", "a1", Date.now() + 60_000);
    expect(store.appAccessValid("tok", "a1")).toBe(true);
    expect(store.appAccessValid("tok", "a2")).toBe(false); // not transferable
    expect(store.appAccessValid("other", "a1")).toBe(false);
    expect(store.appAccessValid("", "a1")).toBe(false);
    expect(store.appAccessValid("tok", "a1", Date.now() + 120_000)).toBe(false); // past expiry
  });

  it("revokes every outstanding grant when the password changes, on archive, and on team-only", async () => {
    const store = new KnowledgeStore(":memory:");
    mkApp(store, "a1");
    const grant = (t: string): void => store.grantAppAccess(t, "a1", Date.now() + 60_000);

    store.setAppPassword("a1", await hashPassword("first-password"));
    grant("t1");
    store.setAppPassword("a1", await hashPassword("second-password"));
    expect(store.appAccessValid("t1", "a1")).toBe(false);

    grant("t2");
    store.setReportVisibility("a1", "team");
    expect(store.appAccessValid("t2", "a1")).toBe(false);
    // …but the password itself survives, so re-publishing can't silently unlock it.
    store.setReportVisibility("a1", "public");
    expect(store.getPublishedMeta("a1")?.hasPassword).toBe(true);

    grant("t3");
    store.archivePublished("a1");
    expect(store.appAccessValid("t3", "a1")).toBe(false);
    // An archived app is out of reach entirely — no password change lands on it.
    expect(store.setAppPassword("a1", null)).toBe(false);
  });
});
