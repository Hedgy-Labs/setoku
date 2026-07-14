// SPDX-License-Identifier: Apache-2.0
/**
 * A fake ClickHouse HTTP endpoint for the fast suite. The gateway's only query
 * engine is ClickHouse (the direct business-Postgres path is retired), so
 * panel/app/run_query tests need a lake — this serves the ClickHouse JSON wire
 * shape (`{meta, data}`) without a container, and records every request so a
 * test can assert what actually reached the engine (SQL text, `param_*` bind
 * values, and the `role` access-control params).
 *
 * It is a WIRE fake, not a SQL engine: register a handler and match on
 * substrings of the incoming SQL. `runLakeQuery` wraps SELECT/WITH in
 * `SELECT * FROM (…) AS _setoku_q LIMIT n` — match on your inner text, or use
 * `innerSql()` to strip the wrapper first. Real-engine semantics (readonly
 * enforcement, role grants, dialect behavior) live in the CH-gated suites
 * (test/lake.test.ts, SETOKU_E2E_CH_URL).
 */
export interface LakeCall {
  sql: string;
  params: URLSearchParams;
  /** The access-control roles the gateway activated for this request. */
  roles: string[];
}

/** What a handler may answer with:
 *  - rows (+ optional explicit columns) → a ClickHouse JSON result
 *  - { exception } → a 200 body carrying an in-band ClickHouse error
 *  - { status, body } → a raw HTTP response (e.g. 403 ACCESS_DENIED text)
 *  - null/undefined → fall through to the default single-row `{ ok: 1 }` */
export type LakeResponse =
  | { columns?: string[]; rows: Record<string, unknown>[] }
  | { exception: string }
  | { status: number; body: string }
  | null
  | undefined;

export type LakeHandler = (sql: string, call: LakeCall) => LakeResponse;

export interface FakeLake {
  /** Feed this to SETOKU_LAKE_URL (path = the default database, like prod). */
  url: string;
  /** Every request the gateway made, in order. */
  calls: LakeCall[];
  /** Replace the handler (the constructor arg is the initial one). */
  handle(h: LakeHandler): void;
  stop(): void;
}

/** Strip runLakeQuery's row-cap wrapper, returning the caller's inner SQL. */
export function innerSql(sql: string): string {
  const m = sql.match(/^SELECT \* FROM \(\n([\s\S]*)\n\) AS _setoku_q LIMIT \d+$/);
  return m ? m[1] : sql;
}

function toChJson(r: { columns?: string[]; rows: Record<string, unknown>[] }): string {
  const columns = r.columns ?? (r.rows[0] ? Object.keys(r.rows[0]) : []);
  return JSON.stringify({
    meta: columns.map((name) => ({ name })),
    data: r.rows,
    rows: r.rows.length,
  });
}

export function startFakeLake(handler?: LakeHandler): FakeLake {
  let h: LakeHandler = handler ?? (() => null);
  const calls: LakeCall[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const sql = await req.text();
      const call: LakeCall = {
        sql,
        params: url.searchParams,
        roles: url.searchParams.getAll("role"),
      };
      calls.push(call);
      const out = h(sql, call) ?? { rows: [{ ok: 1 }] };
      if ("status" in out && "body" in out) {
        return new Response(out.body, { status: out.status });
      }
      if ("exception" in out) {
        return new Response(JSON.stringify({ meta: [], data: [], exception: out.exception }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(toChJson(out), { headers: { "content-type": "application/json" } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/setoku`,
    calls,
    handle(next: LakeHandler) {
      h = next;
    },
    stop() {
      server.stop(true);
    },
  };
}
