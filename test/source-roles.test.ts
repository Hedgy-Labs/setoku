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
  CORE_DIRECT_GRANT_TABLES,
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

  it("keeps ONLY heartbeats as an always-on core DIRECT grant", () => {
    const roGrants = XML.slice(XML.indexOf("<setoku_ro>"));
    for (const t of CORE_DIRECT_GRANT_TABLES) {
      expect(roGrants).toContain(`<query>GRANT SELECT ON setoku.${t}</query>`);
    }
    // pg_mirror_runs must NOT be a direct grant (it's business-family now)
    expect(roGrants).not.toContain("<query>GRANT SELECT ON setoku.pg_mirror_runs</query>");
  });

  it("biz.* AND the mirror run-log are family roles, NOT direct grants on setoku_ro", () => {
    // business data + its catalog (pg_mirror_runs) must be subsettable per user,
    // so neither can ride on setoku_ro as a direct grant (which survives any subset)
    const roGrants = XML.slice(XML.indexOf("<setoku_ro>"));
    expect(roGrants).not.toContain("<query>GRANT SELECT ON biz.*</query>");
    expect(roGrants).not.toContain("<query>GRANT SELECT ON setoku.pg_mirror_runs</query>");
    expect(roGrants).toContain("<query>GRANT setoku_src_business</query>");
    // present, but on the role — grantTargetsFor(BUSINESS_FAMILY) checked below
    expect(XML).toContain("<query>GRANT SELECT ON biz.*</query>");
    expect(XML).toContain("<query>GRANT SELECT ON setoku.pg_mirror_runs</query>");
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
    // biz.* plus the run-log that enumerates the mirrored tables (both must
    // ride on the role, not a core direct grant)
    expect(grantTargetsFor(biz!)).toEqual(["biz.*", "setoku.pg_mirror_runs"]);
  });

  it("denying 'business' drops setoku_src_business from the active role list", () => {
    const roles = lakeRolesFor(["business"]);
    expect(roles).not.toContain("setoku_src_business");
    expect(roles).toContain("setoku_src_slack"); // other sources unaffected
  });

  it("excludes the core plumbing from deniable families", () => {
    const slugs = lakeFamilies().map((f) => f.slug);
    expect(slugs).not.toContain(familySlug("Postgres mirror"));
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

  it("SETOKU_SOURCE_ACCESS=0 is the kill-switch — roles AND filtering go inert together", async () => {
    const { effectiveDenies, sourceAccessDisabled } = await import("../plugin/gateway/lib/sources");
    process.env.SETOKU_SOURCE_ACCESS = "0";
    try {
      // the engine can't enforce → lakeRolesFor unrestricted...
      expect(lakeRolesFor(["slack"])).toBeNull();
      // ...and effectiveDenies (which every web/knowledge filter routes through)
      // must be empty too, so nothing asserts a restriction the engine isn't
      // holding. Both keyed on the same gate.
      expect(sourceAccessDisabled()).toBe(true);
      expect(effectiveDenies(["slack", "mercury"])).toEqual([]);
    } finally {
      delete process.env.SETOKU_SOURCE_ACCESS;
    }
    expect(effectiveDenies(["slack"])).toEqual(["slack"]); // on again → stored denies apply
  });
});
