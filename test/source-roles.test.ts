// SPDX-License-Identifier: Apache-2.0
/**
 * Drift lock: deploy/clickhouse/lake-users.xml must carry one role per source
 * family in lib/sources.ts, with a SELECT grant per member table, all granted
 * to setoku_ro — and NO `setoku.*` direct wildcard (a direct grant applies
 * regardless of active roles, so a wildcard would silently defeat the per-user
 * `role` subsetting). This is what makes "new connector → new family role"
 * un-forgettable: add a LAKE_SOURCES entry and this test fails until the XML
 * grants it.
 *
 * Textual parse on purpose — the XML is hand-written config, not code, and a
 * substring check per required line is exactly the drift signal we want.
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  lakeFamilies,
  lakeRolesFor,
  familySlug,
  roleFor,
  grantTargetsFor,
  CORE_LAKE_TABLES,
  LAKE_SOURCES,
  NO_SOURCES_ROLE,
} from "../plugin/gateway/lib/sources";

const XML = fs.readFileSync(
  path.resolve(import.meta.dir, "..", "deploy", "clickhouse", "lake-users.xml"),
  "utf8",
);

describe("lake-users.xml ↔ lakeFamilies() drift lock", () => {
  it("defines every family role with a SELECT grant per member table", () => {
    for (const f of lakeFamilies()) {
      expect(XML).toContain(`<${f.role}>`);
      for (const target of grantTargetsFor(f)) {
        expect(XML).toContain(`<query>GRANT SELECT ON ${target}</query>`);
      }
    }
  });

  it("grants setoku_ro every family role (default = everything, incl. future roles)", () => {
    for (const f of lakeFamilies()) {
      expect(XML).toContain(`<query>GRANT ${f.role}</query>`);
    }
  });

  it("defines + grants the empty deny-everything role", () => {
    expect(XML).toContain(`<${NO_SOURCES_ROLE}>`);
    expect(XML).toContain(`<query>GRANT ${NO_SOURCES_ROLE}</query>`);
  });

  it("keeps the always-on core (heartbeats + mirror-run log) as DIRECT grants", () => {
    for (const t of CORE_LAKE_TABLES) {
      expect(XML).toContain(`<query>GRANT SELECT ON setoku.${t}</query>`);
    }
  });

  it("biz.* is a family role (setoku_src_business), NOT a direct grant on setoku_ro", () => {
    // the whole point: business data must be subsettable per user, so biz.* can't
    // ride on setoku_ro as a direct grant (which would survive any role subset)
    const roGrants = XML.slice(XML.indexOf("<setoku_ro>"));
    expect(roGrants).not.toContain("<query>GRANT SELECT ON biz.*</query>");
    expect(roGrants).toContain("<query>GRANT setoku_src_business</query>");
    expect(XML).toContain("<query>GRANT SELECT ON biz.*</query>"); // present, but on the role
  });

  it("has NO setoku.* direct wildcard — it would defeat the role subsetting", () => {
    expect(XML).not.toContain("GRANT SELECT ON setoku.*");
  });

  it("every LAKE_SOURCES table is covered by exactly one grant (family or core)", () => {
    const familyTables = new Set(lakeFamilies().flatMap((f) => f.tables));
    for (const s of LAKE_SOURCES) {
      const core = (CORE_LAKE_TABLES as readonly string[]).includes(s.table);
      expect(core || familyTables.has(s.table)).toBe(true);
      expect(core && familyTables.has(s.table)).toBe(false);
    }
  });
});

describe("family helpers", () => {
  it("slugs are stable and role-prefixed", () => {
    expect(familySlug("Vercel logs")).toBe("vercel_logs");
    expect(familySlug("Unrouted (raw)")).toBe("unrouted_raw");
    expect(familySlug("First-party events")).toBe("first_party_events");
    expect(roleFor("mercury")).toBe("setoku_src_mercury");
  });

  it("groups siblings into one family", () => {
    const github = lakeFamilies().find((f) => f.slug === "github");
    expect(github?.tables.sort()).toEqual(
      ["github_comments", "github_commits", "github_issues", "github_pulls"].sort(),
    );
  });

  it("includes the business-DB mirror as the 'business' (Postgres) family, granting biz.*", () => {
    const biz = lakeFamilies().find((f) => f.slug === "business");
    expect(biz).toBeDefined();
    expect(biz!.family).toBe("Postgres");
    expect(biz!.role).toBe("setoku_src_business");
    expect(grantTargetsFor(biz!)).toEqual(["biz.*"]);
  });

  it("denying 'business' drops setoku_src_business from the active role list", () => {
    const roles = lakeRolesFor(["business"]);
    expect(roles).not.toContain("setoku_src_business");
    expect(roles).toContain("setoku_src_slack"); // other sources unaffected
  });

  it("excludes the core plumbing from deniable families", () => {
    const slugs = lakeFamilies().map((f) => f.slug);
    expect(slugs).not.toContain(familySlug("Business-DB mirror"));
    const tables = lakeFamilies().flatMap((f) => f.tables);
    expect(tables).not.toContain("pg_mirror_runs");
    expect(tables).not.toContain("ingest_heartbeats");
  });
});

describe("lakeRolesFor", () => {
  it("null (omit the role param → default roles → everything) when unrestricted", () => {
    expect(lakeRolesFor([])).toBeNull();
  });

  it("returns every role EXCEPT the denied families'", () => {
    const roles = lakeRolesFor(["slack", "mercury"]);
    expect(roles).not.toBeNull();
    expect(roles).not.toContain("setoku_src_slack");
    expect(roles).not.toContain("setoku_src_mercury");
    expect(roles).toContain("setoku_src_github");
    expect(roles!.length).toBe(lakeFamilies().length - 2);
  });

  it("a stale deny (family no longer in the catalog) still restricts the rest", () => {
    const roles = lakeRolesFor(["some_removed_connector"]);
    // unknown slug denies nothing that exists, but the user IS restricted:
    // an explicit full role list, not the unrestricted null
    expect(roles).not.toBeNull();
    expect(roles!.length).toBe(lakeFamilies().length);
  });

  it("deny-everything activates the empty role — NEVER an empty list (which would mean default roles = full access)", () => {
    expect(lakeRolesFor(lakeFamilies().map((f) => f.slug))).toEqual([NO_SOURCES_ROLE]);
  });

  it("SETOKU_SOURCE_ACCESS=0 is the kill-switch", () => {
    process.env.SETOKU_SOURCE_ACCESS = "0";
    try {
      expect(lakeRolesFor(["slack"])).toBeNull();
    } finally {
      delete process.env.SETOKU_SOURCE_ACCESS;
    }
  });
});
