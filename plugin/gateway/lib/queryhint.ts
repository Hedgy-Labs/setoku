// SPDX-License-Identifier: Apache-2.0
/**
 * Turn a raw query-engine failure into an agent-actionable one.
 *
 * `run_query` used to forward the bare ClickHouse message ("Code: 60. ...
 * doesn't exist"), which makes the agent re-guess and burn turns. Here we keep
 * the original message (humans and agents both want the ground truth) and
 * classify it so the caller can append a "→ next step" hint that points at a
 * discovery tool. That resolves the blocker IN the agent's loop, which the HN
 * "designing APIs for agents" thread (item 48894874) argues beats any
 * after-the-fact feedback channel ("support > feedback").
 *
 * The SAME classifier feeds the friction miner (friction-cli.ts), so the codes
 * here are the vocabulary both the live hint and the offline report speak.
 *
 * MEMBRANE (I2/I9). "table not found" and "access denied" MUST collapse to one
 * code + one hint. The engine returns UNKNOWN_TABLE for a nonexistent table and
 * ACCESS_DENIED for a denied family's tables (source access is engine-enforced,
 * per-role GRANTs). If we branched, the denied case would confirm the table
 * exists — leaking exactly what the membrane hides. Both say the same thing:
 * it isn't available to you, here's how to see what is.
 */

export interface QueryHint {
  /** stable slug — the bucket key for friction clustering */
  code: string;
  /** the "→ next step" line appended to the raw error (empty for our own
   *  already-actionable messages, which need no augmentation) */
  hint: string;
}

/**
 * Ordered most-specific first. `test` matches the raw error text (ClickHouse
 * surfaces both a `Code: N` and a symbolic name, so we match either). A rule
 * with an empty `hint` is classified for the miner but adds nothing live —
 * used where our own gate/engine message is already self-explanatory.
 */
const RULES: { code: string; test: RegExp; hint: string }[] = [
  {
    // Our own retirement pointer (dialect:"postgres", or a legacy pg panel).
    // `^pg-retired$` is the short audit sentinel stored on that path.
    code: "pg_retired",
    test: /business-Postgres path is retired|biz\.\* ClickHouse mirror|^pg-retired$/i,
    hint: "",
  },
  {
    // Historical audit sentinel: a query referenced a business table before
    // pg-mirror had populated it into biz.* (issue #47 rollout). Not a rename —
    // the mirror just had to catch up. Distinct bucket keeps the `other` pile
    // honest when mining older audit history.
    code: "mirror_required",
    test: /^mirror-required$/i,
    hint: "",
  },
  {
    // Our own gate messages — already actionable, just bucket them.
    code: "read_only",
    test: /connection is READ ONLY|Only read statements are allowed/i,
    hint: "",
  },
  {
    code: "multi_statement",
    test: /Multiple statements \(semicolons\)/i,
    hint: "",
  },
  {
    code: "format_clause",
    test: /remove any FORMAT clause/i,
    hint: "",
  },
  {
    // The membrane rejecting a lake read on a curator (write-capable) session
    // (I2/I9). Expected + already actionable ("use an analyst connector") — just
    // bucket it so it doesn't dilute the `other` pile.
    code: "curator_lake_denied",
    test: /curator session.*reading the lake|reading the lake .*is disabled/i,
    hint: "",
  },
  {
    // UNKNOWN_TABLE (60) + ACCESS_DENIED (497) + privilege phrasing — UNIFIED on
    // purpose (see MEMBRANE note above). Never branch these. `relation … does
    // not exist` is the Postgres phrasing (legacy/retired-path rows in the audit
    // history); `unknown table expression identifier` is ClickHouse's wording
    // when the Code isn't in the matched slice.
    code: "table_unavailable",
    test:
      /unknown table|unknown table expression identifier|table .*does\s?n.?t exist|relation .*does not exist|code:\s*60\b|access[_ ]denied|not enough privileges|code:\s*497\b/i,
    hint:
      "That table isn’t available on this connector. Business tables are exposed as `biz.<table>` (their raw source names aren’t queryable). Run `get_schema`, or `SHOW TABLES` / `SHOW TABLES FROM biz`, to see what you can query.",
  },
  {
    // UNKNOWN_IDENTIFIER (47), NOT_FOUND_COLUMN_IN_BLOCK (10),
    // THERE_IS_NO_COLUMN (8), "Missing columns". `column … does not exist` is
    // the Postgres phrasing (legacy audit rows).
    code: "unknown_column",
    test:
      /unknown identifier|missing column|there.?s no column|column .*does not exist|code:\s*47\b|code:\s*10\b|code:\s*8\b|not_found_column/i,
    hint:
      "Unknown column. Run `DESCRIBE <table>` (or `get_schema`) for exact names — ClickHouse identifiers are case-sensitive.",
  },
  {
    // UNKNOWN_FUNCTION (46).
    code: "unknown_function",
    test: /unknown function|code:\s*46\b/i,
    hint:
      "Unknown function — this is ClickHouse SQL, not Postgres. Check the ClickHouse name (e.g. `toStartOfMonth`, `countIf`, `uniqExact`).",
  },
  {
    // TYPE_MISMATCH (53), NO_COMMON_TYPE (386), ILLEGAL_TYPE_OF_ARGUMENT (43).
    code: "type_mismatch",
    test:
      /type mismatch|no common type|illegal type|code:\s*53\b|code:\s*386\b|code:\s*43\b/i,
    hint:
      "Type mismatch. ClickHouse is stricter than Postgres — cast explicitly with `CAST(x AS Int64)` / `toInt64(x)` / `toDate(x)` rather than relying on coercion.",
  },
  {
    // ClickHouse correlated-subquery limitation: "Resolved identifier '…' in
    // parent scope". A real recurring gotcha (agents port a Postgres correlated
    // subquery verbatim), so it earns a live hint pointing at the JOIN rewrite.
    code: "correlated_subquery",
    test: /resolved identifier .* in parent scope/i,
    hint:
      "ClickHouse doesn’t support correlated subqueries (a subquery referencing the outer row). Rewrite it as a JOIN, or use an uncorrelated IN (…) / a window function.",
  },
  {
    // TIMEOUT_EXCEEDED (159) + ClickHouse/Postgres statement-timeout phrasing.
    code: "timeout",
    test: /timeout exceeded|timed out|canceling statement due to statement timeout|code:\s*159\b/i,
    hint:
      "Query hit the statement timeout. Narrow the scan: add a date/partition filter or aggregate over a smaller range before joining.",
  },
  {
    // MEMORY_LIMIT_EXCEEDED (241).
    code: "memory",
    test: /memory limit|code:\s*241\b/i,
    hint:
      "Query hit the memory cap. Reduce cardinality — filter before a GROUP BY / DISTINCT / JOIN, or pre-aggregate.",
  },
  {
    // SYNTAX_ERROR (62). Kept last of the engine rules: the more specific codes
    // above should win when both a code and "syntax" phrasing appear.
    code: "syntax",
    test: /syntax error|code:\s*62\b/i,
    hint:
      "Syntax error. This is ClickHouse SQL — the Postgres path is retired. Note `x::Type` casts aren’t valid; use `CAST(x AS Type)` or a `toType(x)` function.",
  },
];

/** The bucket a raw error falls in — for friction clustering. "other" when
 *  nothing matches (worth reading manually; often a genuinely novel failure). */
export function classifyQueryError(rawMsg: string): string {
  const m = String(rawMsg ?? "");
  for (const r of RULES) if (r.test.test(m)) return r.code;
  return "other";
}

/**
 * The live augmentation for `run_query`'s catch. Returns a hint to append, or
 * null when the message is already self-explanatory (our own gate messages) or
 * unrecognized. `sql` sharpens the syntax hint when a Postgres `::` cast is the
 * likely culprit (a very common, very fixable miss against ClickHouse).
 */
export function queryErrorHint(rawMsg: string, sql = ""): QueryHint | null {
  const m = String(rawMsg ?? "");
  for (const r of RULES) {
    if (!r.test.test(m)) continue;
    if (!r.hint) return null; // classified, but no augmentation to add
    if (r.code === "syntax" && /::/.test(sql)) {
      return {
        code: "syntax",
        hint:
          "Your SQL uses a Postgres `::` cast, which ClickHouse rejects. Use `CAST(x AS Type)` or a `toType(x)` function instead. (This is ClickHouse SQL; the Postgres path is retired.)",
      };
    }
    if (r.code === "type_mismatch" && /cannot be inside nullable/i.test(m)) {
      return {
        code: "type_mismatch",
        hint:
          "A JSON/array function got a Nullable column. Wrap the column first: `assumeNotNull(col)`, or `coalesce(col, '')` — ClickHouse won’t build an Array inside a Nullable type.",
      };
    }
    return { code: r.code, hint: r.hint };
  }
  return null;
}

/* --------------------- schema-aware unknown-column help --------------------- */
/* Turn an `unknown_column` failure into an in-loop fix: surface the referenced
 * tables' REAL columns (scoped by the caller to exactly what get_schema would
 * show) plus a "did you mean". These helpers are pure so they unit-test without
 * a lake; app.ts feeds them the session-scoped schema. */

/** Candidate table identifiers — the tokens after FROM / JOIN. Deliberately
 *  conservative: bare or dotted identifiers (optionally double-quoted), no
 *  subquery/CTE resolution. Over-extraction is harmless — an unmatched token is
 *  dropped when matched against the real schema. */
export function extractTableRefs(sql: string): string[] {
  const re =
    /\b(?:from|join)\s+("?[A-Za-z_]\w*"?(?:\s*\.\s*"?[A-Za-z_]\w*"?)?)/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(sql ?? "")))) out.push(m[1].replace(/\s+/g, ""));
  return [...new Set(out)];
}

/** The identifier the engine flagged as unknown, normalized to the bare column
 *  (drops any table-alias prefix + quoting/backticks). null if not extractable —
 *  then the caller still lists columns, just without a "did you mean". */
export function extractUnknownColumn(rawMsg: string): string | null {
  const m = String(rawMsg ?? "");
  const pats = [
    /unknown (?:expression|identifier)(?: or function identifier)?[:`'\s]+([`"']?[\w.]+)/i,
    /column\s+"?([\w.]+)"?\s+does not exist/i,
    /there.?s no column[:`'\s]+([`"']?[\w.]+)/i,
    /missing columns?:?\s*'?([\w.]+)/i,
  ];
  for (const p of pats) {
    const mm = m.match(p);
    if (!mm) continue;
    const raw = mm[1].replace(/[`"']/g, "");
    const bare = raw.includes(".") ? raw.split(".").pop()! : raw;
    if (bare) return bare;
  }
  return null;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Columns nearest a mistyped identifier (case-insensitive), closest first,
 *  within an edit budget so we never suggest an unrelated column. An exact
 *  case-insensitive match sorts first — ClickHouse is case-sensitive, so
 *  `salaryMin` vs `salarymin` is the likely intended fix. */
export function nearestColumns(bad: string, columns: string[], max = 3): string[] {
  const b = bad.toLowerCase();
  const budget = Math.max(2, Math.ceil(b.length / 3));
  return columns
    .map((c) => ({ c, d: levenshtein(b, c.toLowerCase()) }))
    .filter((x) => x.d <= budget)
    .sort((a, z) => a.d - z.d)
    .slice(0, max)
    .map((x) => x.c);
}

export interface RefTable {
  database: string;
  table: string;
  columns: string[];
}

/** Referenced tables that resolve to a real, session-visible table — matched by
 *  qualified (`db.table`) or bare table name, case-insensitively, quoting
 *  stripped. Anything unmatched (aliases, CTEs, functions) is silently dropped. */
export function matchReferencedTables(
  refs: string[],
  tables: RefTable[],
): { table: string; columns: string[] }[] {
  const norm = (s: string) => s.replace(/["'`\s]/g, "").toLowerCase();
  const qualified = new Set(refs.map(norm));
  const bare = new Set(
    refs.map((r) => {
      const n = norm(r);
      return n.includes(".") ? n.split(".").pop()! : n;
    }),
  );
  return tables
    .filter((t) => {
      const q = `${t.database}.${t.table}`.toLowerCase();
      return qualified.has(q) || bare.has(t.table.toLowerCase());
    })
    .map((t) => ({ table: `${t.database}.${t.table}`, columns: t.columns }));
}

/** Render the schema block appended to an unknown-column error: the referenced
 *  tables' columns + a cross-table "did you mean". null when there's nothing to
 *  add (no matched tables). */
export function renderColumnHint(
  bad: string | null,
  matched: { table: string; columns: string[] }[],
): string | null {
  if (!matched.length) return null;
  const lines = ["Columns of the tables you referenced:"];
  for (const t of matched) {
    const cols = t.columns;
    const shown = cols.length > 60 ? cols.slice(0, 60).join(", ") + `, …(+${cols.length - 60})` : cols.join(", ");
    lines.push(`  ${t.table}: ${shown}`);
  }
  if (bad) {
    const all = [...new Set(matched.flatMap((t) => t.columns))];
    const near = nearestColumns(bad, all);
    lines.push(
      near.length
        ? `No column \`${bad}\` — did you mean ${near.map((c) => `\`${c}\``).join(" / ")}?`
        : `No column \`${bad}\` in those tables.`,
    );
  }
  return lines.join("\n");
}
