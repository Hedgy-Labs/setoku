// SPDX-License-Identifier: Apache-2.0
// The pure half of the browser file grid (web/app/grid/model.ts) and the shared
// parser it runs on (lib/table-parse.ts). The React component itself is driven
// in a real browser (e2e/); everything here is plain data in, data out.
import { describe, it, expect } from "bun:test";
import {
  computeView,
  filteredName,
  numOf,
  numericColumns,
  rangeStats,
  rangeToClipboard,
  valueCounts,
  viewToCsv,
} from "../plugin/gateway/web/app/grid/model";
import { isTabularMime, parseDelimitedRows, parseJsonRows, parseTabular } from "../plugin/gateway/lib/table-parse";

const cols = ["name", "fee", "status"];
const rows = [
  ["Bluefield", "$1,200", "Warm"],
  ["Avery", "", "New"],
  ["carter", "300", "Warm"],
  ["Dale", "(50)", ""],
  ["Evans", "12%", "New"],
];
const isNum = numericColumns(3, rows);

describe("numOf", () => {
  it("reads numbers the way a spreadsheet shows them", () => {
    expect(numOf("$1,200")).toBe(1200);
    expect(numOf("12%")).toBe(12);
    expect(numOf("(50)")).toBe(-50);
    expect(numOf("-3.5e2")).toBe(-350);
    expect(numOf(".5")).toBe(0.5);
    expect(numOf("")).toBeNaN();
    expect(numOf("12 apples")).toBeNaN();
    expect(numOf("2026-09-01")).toBeNaN();
  });
});

describe("numericColumns", () => {
  it("flags a column when nearly all non-empty values are numbers", () => {
    expect(isNum).toEqual([false, true, false]);
  });
});

describe("computeView", () => {
  it("is every row in file order with no filter or sort", () => {
    expect(computeView(rows, new Map(), null, isNum)).toEqual([0, 1, 2, 3, 4]);
  });
  it("sorts text case-insensitively, blanks last in both directions", () => {
    expect(computeView(rows, new Map(), { col: 0, dir: 1 }, isNum)).toEqual([1, 0, 2, 3, 4]);
    expect(computeView(rows, new Map(), { col: 2, dir: 1 }, isNum)).toEqual([1, 4, 0, 2, 3]);
    expect(computeView(rows, new Map(), { col: 2, dir: -1 }, isNum)).toEqual([0, 2, 1, 4, 3]);
  });
  it("sorts a numeric column by value, not text", () => {
    expect(computeView(rows, new Map(), { col: 1, dir: 1 }, isNum)).toEqual([3, 4, 2, 0, 1]);
    expect(computeView(rows, new Map(), { col: 1, dir: -1 }, isNum)).toEqual([0, 2, 4, 3, 1]);
  });
  it("filters by hidden values, ANDed across columns, then sorts", () => {
    const f = new Map([[2, new Set(["New"])]]);
    expect(computeView(rows, f, null, isNum)).toEqual([0, 2, 3]);
    const f2 = new Map([
      [2, new Set(["New"])],
      [1, new Set([""])],
    ]);
    expect(computeView(rows, f2, { col: 1, dir: 1 }, isNum)).toEqual([3, 2, 0]);
  });
});

describe("valueCounts", () => {
  it("lists a column's values under the OTHER columns' filters, blanks last", () => {
    const { values, counts } = valueCounts(rows, 2, new Map(), false);
    expect(values).toEqual(["New", "Warm", ""]);
    expect(counts.get("Warm")).toBe(2);
    // status's own filter doesn't shrink its list; name's filter does
    const own = valueCounts(rows, 2, new Map([[2, new Set(["Warm"])]]), false);
    expect(own.values).toEqual(["New", "Warm", ""]);
    const other = valueCounts(rows, 2, new Map([[0, new Set(["Bluefield", "carter"])]]), false);
    expect(other.values).toEqual(["New", ""]);
  });
  it("orders a numeric column numerically", () => {
    expect(valueCounts(rows, 1, new Map(), true).values).toEqual(["(50)", "12%", "300", "$1,200", ""]);
  });
});

describe("rangeStats", () => {
  it("counts non-empty cells and sums the numeric ones", () => {
    const view = [0, 1, 2, 3, 4];
    expect(rangeStats(rows, view, { r1: 0, r2: 4, c1: 1, c2: 1 })).toEqual({ count: 4, nums: 4, sum: 1462 });
    expect(rangeStats(rows, view, { r1: 0, r2: 1, c1: 0, c2: 2 })).toEqual({ count: 5, nums: 1, sum: 1200 });
  });
});

describe("rangeToClipboard", () => {
  it("copies TSV (quoting tabs, newlines, quotes) and an escaped HTML table", () => {
    const r = [["a\tb", 'say "hi"'], ["line\nbreak", "<b>"]];
    const out = rangeToClipboard(["x", "y"], r, [0, 1], { r1: 0, r2: 1, c1: 0, c2: 1 }, true);
    expect(out.text).toBe('x\ty\n"a\tb"\t"say ""hi"""\n"line\nbreak"\t<b>');
    expect(out.html).toBe('<table><tr><th>x</th><th>y</th></tr><tr><td>a\tb</td><td>say "hi"</td></tr><tr><td>line\nbreak</td><td>&lt;b&gt;</td></tr></table>');
  });
  it("follows the view's order and the range's columns", () => {
    const out = rangeToClipboard(cols, rows, [2, 0], { r1: 0, r2: 1, c1: 0, c2: 0 }, false);
    expect(out.text).toBe("carter\nBluefield");
  });
});

describe("viewToCsv / filteredName", () => {
  it("writes the view as RFC 4180 CSV with a header", () => {
    expect(viewToCsv(["n", "note"], [["a", 'x, "y"'], ["b", "ok"]], [1, 0])).toBe('n,note\r\nb,ok\r\na,"x, ""y"""\r\n');
  });
  it("names the download after the source file", () => {
    expect(filteredName("prospects.tsv")).toBe("prospects (filtered).csv");
    expect(filteredName("rows")).toBe("rows (filtered).csv");
  });
});

describe("table-parse (browser + server)", () => {
  it("parses CSV into row ARRAYS padded to the header, with no row cap by default", () => {
    const t = parseDelimitedRows('a,b\n1\n"x,y",2,extra\n', ",");
    expect(t.columns).toEqual(["a", "b"]);
    expect(t.rows).toEqual([
      ["1", ""],
      ["x,y", "2"],
    ]);
    const many = parseDelimitedRows("n\n" + Array.from({ length: 30_000 }, (_, i) => i).join("\n"), ",");
    expect(many.rows.length).toBe(30_000);
    expect(many.truncated).toBe(false);
  });
  it("keeps long quoted fields (with quotes and newlines) intact", () => {
    const note = "x".repeat(5000) + ' "q" \n' + "y".repeat(5000);
    const t = parseDelimitedRows(`a,b\n"${note.replace(/"/g, '""')}",1\n`, ",");
    expect(t.rows[0]).toEqual([note, "1"]);
  });
  it("parses JSON rows into arrays in first-seen column order", () => {
    const t = parseJsonRows('[{"a":1},{"b":{"k":1},"a":null}]');
    expect(t?.columns).toEqual(["a", "b"]);
    expect(t?.rows).toEqual([
      ["1", ""],
      ["", '{"k":1}'],
    ]);
    expect(parseJsonRows('{"a":1}')).toBeNull();
  });
  it("parseTabular picks the parser by mime and rejects non-tables", () => {
    expect(parseTabular("a\tb\n1\t2\n", "text/tab-separated-values")?.rows).toEqual([["1", "2"]]);
    expect(parseTabular('{"not":"rows"}', "application/json")).toBeNull();
    expect(parseTabular("", "text/csv")).toBeNull();
    expect(isTabularMime("text/csv") && !isTabularMime("text/plain")).toBe(true);
  });
});
