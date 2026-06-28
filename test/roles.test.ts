// SPDX-License-Identifier: Apache-2.0
/**
 * The I2/I9 membrane as a type: capabilities are DERIVED from a single role, so
 * the forbidden combination — commit curated knowledge AND read the untrusted
 * lake on one session — is unrepresentable. These tests assert no role can ever
 * yield it (previously four free booleans left that one careless call-site away).
 */
import { describe, expect, it } from "bun:test";
import { capabilitiesFor, type TokenRole } from "../plugin/gateway/app";

const ROLES: TokenRole[] = ["analyst", "curator", "janitor"];

describe("capability membrane (capabilitiesFor)", () => {
  it("NO role can both commit knowledge and read the lake", () => {
    for (const role of ROLES) {
      const c = capabilitiesFor(role);
      expect(c.canWrite && !c.denyLakeRead).toBe(false); // the forbidden combo
    }
  });

  it("curator commits knowledge but is barred from the lake", () => {
    const c = capabilitiesFor("curator");
    expect(c).toEqual({ canWrite: true, denyLakeRead: true, canDraft: false, canReject: false });
  });

  it("analyst reads the lake, holds no write/draft/reject", () => {
    const c = capabilitiesFor("analyst");
    expect(c).toEqual({ canWrite: false, denyLakeRead: false, canDraft: false, canReject: false });
  });

  it("janitor holds draft+reject only (zero authority), may read pending text", () => {
    const c = capabilitiesFor("janitor");
    expect(c).toEqual({ canWrite: false, denyLakeRead: false, canDraft: true, canReject: true });
  });
});
