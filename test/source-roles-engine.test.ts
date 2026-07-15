// SPDX-License-Identifier: Apache-2.0
/**
 * ENGINE semantics of per-user source access, against a real ClickHouse
 * (gated on SETOKU_E2E_CH_URL, like test/lake.test.ts — CI provides a
 * clickhouse-server container; locally (the CREATE ROLE setup needs the
 * default user to hold access_management):
 *   docker run --rm -d -p 18123:8123 -e CLICKHOUSE_PASSWORD=pw \
 *     -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 clickhouse/clickhouse-server:25.3
 * ).
 *
 * This pins the three facts deploy/clickhouse/lake-users.xml relies on:
 *   1. granted roles are DEFAULT-ACTIVE — a request with no `role` param sees
 *      everything (that's what keeps "no denies = full access, incl. future
 *      connectors" true);
 *   2. an explicit `role` list activates ONLY those roles — tables of an
 *      unlisted role are ACCESS_DENIED and hidden from SHOW TABLES;
 *   3. DIRECT grants survive any explicit role list (the always-on core
 *      plumbing: heartbeats + mirror-run log; biz.* is a family role, not core).
 * The role plumbing itself (which subset each identity sends) is covered
 * pg-free in test/source-access.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { runLakeQuery } from "../plugin/gateway/lib/lake";

const CH_URL = process.env.SETOKU_E2E_CH_URL;

const CAPS = { rowCap: 50, statementTimeoutMs: 5_000 };
const DB = "srcrole_e2e";
const USER = "srcrole_ro";
const PW = "srcrole-pw";
const ROLE_A = "srcrole_src_alpha";
const ROLE_B = "srcrole_src_beta";
const ROLE_NONE = "srcrole_src_none"; // grants nothing — the deny-everything role

/** Admin exec against the test ClickHouse (setup/teardown only). */
async function chAdmin(query: string): Promise<Response> {
  const u = new URL(CH_URL!);
  return fetch(`${u.origin}/`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${decodeURIComponent(u.username) || "default"}:${decodeURIComponent(u.password)}`)}`,
    },
    body: query,
  });
}

/** The reader URL runLakeQuery gets — same shape as SETOKU_LAKE_URL. */
function readerUrl(): string {
  const u = new URL(CH_URL!);
  return `${u.origin.replace("://", `://${USER}:${PW}@`)}/${DB}`;
}

/** This suite needs RBAC DDL (CREATE ROLE/USER + GRANT), which requires the
 *  connecting user to hold access_management. A stock ClickHouse (or a CI
 *  service without CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT) doesn't — probe once
 *  and SKIP rather than red the suite, so the engine check runs where RBAC is
 *  available and is inert (not failing) where it isn't. */
const CAN_MANAGE = CH_URL
  ? await (async () => {
      try {
        const probe = `srcrole_probe_${Math.abs(Date.now() % 100000)}`;
        const r = await chAdmin(`CREATE ROLE IF NOT EXISTS ${probe}`);
        if (!r.ok) return false;
        await chAdmin(`DROP ROLE IF EXISTS ${probe}`);
        return true;
      } catch {
        return false;
      }
    })()
  : false;

describe.skipIf(!CH_URL || !CAN_MANAGE)("ClickHouse role-subset access control (engine truth)", () => {
  beforeAll(async () => {
    const stmts = [
      `CREATE DATABASE IF NOT EXISTS ${DB}`,
      `CREATE OR REPLACE TABLE ${DB}.alpha_rows (x UInt32) ENGINE = MergeTree ORDER BY x`,
      `CREATE OR REPLACE TABLE ${DB}.beta_rows (x UInt32) ENGINE = MergeTree ORDER BY x`,
      `CREATE OR REPLACE TABLE ${DB}.core_rows (x UInt32) ENGINE = MergeTree ORDER BY x`,
      `INSERT INTO ${DB}.alpha_rows VALUES (1)`,
      `INSERT INTO ${DB}.beta_rows VALUES (2)`,
      `INSERT INTO ${DB}.core_rows VALUES (3)`,
      // the lake-users.xml shape, in SQL: family roles + a reader whose only
      // family access rides on those roles, plus one DIRECT core grant
      `CREATE ROLE IF NOT EXISTS ${ROLE_A}`,
      `CREATE ROLE IF NOT EXISTS ${ROLE_B}`,
      `CREATE ROLE IF NOT EXISTS ${ROLE_NONE}`,
      `GRANT SELECT ON ${DB}.alpha_rows TO ${ROLE_A}`,
      `GRANT SELECT ON ${DB}.beta_rows TO ${ROLE_B}`,
      `CREATE USER IF NOT EXISTS ${USER} IDENTIFIED WITH plaintext_password BY '${PW}'`,
      `GRANT SELECT ON ${DB}.core_rows TO ${USER}`,
      `GRANT ${ROLE_A}, ${ROLE_B}, ${ROLE_NONE} TO ${USER}`,
    ];
    for (const q of stmts) {
      const r = await chAdmin(q);
      if (!r.ok) throw new Error(`setup failed on "${q}": ${await r.text()}`);
    }
  }, 30_000);

  afterAll(async () => {
    await chAdmin(`DROP USER IF EXISTS ${USER}`);
    await chAdmin(`DROP ROLE IF EXISTS ${ROLE_A}`);
    await chAdmin(`DROP ROLE IF EXISTS ${ROLE_B}`);
    await chAdmin(`DROP ROLE IF EXISTS ${ROLE_NONE}`);
    await chAdmin(`DROP DATABASE IF EXISTS ${DB}`);
  });

  it("no role param → granted roles are default-active (full access)", async () => {
    const a = await runLakeQuery(readerUrl(), `SELECT x FROM ${DB}.alpha_rows`, CAPS);
    expect(a.rows).toEqual([{ x: 1 }]);
    const b = await runLakeQuery(readerUrl(), `SELECT x FROM ${DB}.beta_rows`, CAPS);
    expect(b.rows).toEqual([{ x: 2 }]);
  });

  it("an explicit role list activates ONLY those roles — the rest is engine-denied", async () => {
    const ok = await runLakeQuery(readerUrl(), `SELECT x FROM ${DB}.alpha_rows`, CAPS, {}, [ROLE_A]);
    expect(ok.rows).toEqual([{ x: 1 }]);
    await expect(
      runLakeQuery(readerUrl(), `SELECT x FROM ${DB}.beta_rows`, CAPS, {}, [ROLE_A]),
    ).rejects.toThrow(/ACCESS_DENIED|Not enough privileges/i);
  });

  it("SHOW TABLES hides what the active roles can't read (discovery self-filters)", async () => {
    const shown = await runLakeQuery(readerUrl(), `SHOW TABLES FROM ${DB}`, CAPS, {}, [ROLE_A]);
    const names = shown.rows.map((r) => String(Object.values(r)[0]));
    expect(names).toContain("alpha_rows");
    expect(names).toContain("core_rows"); // direct grant
    expect(names).not.toContain("beta_rows");
  });

  it("DIRECT grants survive any explicit role list (the always-on core)", async () => {
    const core = await runLakeQuery(readerUrl(), `SELECT x FROM ${DB}.core_rows`, CAPS, {}, [ROLE_A]);
    expect(core.rows).toEqual([{ x: 3 }]);
  });

  it("the empty deny-everything role: no source table readable, the core still is", async () => {
    await expect(
      runLakeQuery(readerUrl(), `SELECT x FROM ${DB}.alpha_rows`, CAPS, {}, [ROLE_NONE]),
    ).rejects.toThrow(/ACCESS_DENIED|Not enough privileges/i);
    await expect(
      runLakeQuery(readerUrl(), `SELECT x FROM ${DB}.beta_rows`, CAPS, {}, [ROLE_NONE]),
    ).rejects.toThrow(/ACCESS_DENIED|Not enough privileges/i);
    const core = await runLakeQuery(readerUrl(), `SELECT x FROM ${DB}.core_rows`, CAPS, {}, [ROLE_NONE]);
    expect(core.rows).toEqual([{ x: 3 }]);
  });
});
