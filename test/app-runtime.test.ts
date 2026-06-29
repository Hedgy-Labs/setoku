// SPDX-License-Identifier: Apache-2.0
// The chart runtime ships as browser JS (a string injected into the frame). We
// exercise it here with a minimal DOM stub so its behavior — numeric-string
// coercion, correct sizing, empty/error states — is covered in CI.
import { describe, it, expect } from "bun:test";
import { APP_RUNTIME, lintAppTemplate } from "../plugin/gateway/lib/app-runtime";

function runRuntime(
  panels: Record<string, unknown>,
  opts: { params?: Record<string, string>; search?: string } = {},
) {
  const els: Record<string, { innerHTML: string }> = {};
  const messages: Record<string, unknown>[] = [];
  // The runtime registers a message listener for the Setoku.state bridge at load;
  // stub the browser globals it touches. `parent`/`location` are bare globals in
  // the runtime — pass them as Function params so they're captured here (not the
  // real globals) and the parent-bound echoes are observable.
  const win = {
    __SETOKU__: { panels, params: opts.params },
    addEventListener: () => {},
  } as Record<string, unknown>;
  const doc = { getElementById: (id: string) => (els[id] ||= { innerHTML: "" }) };
  const parentStub = { postMessage: (m: Record<string, unknown>) => messages.push(m) };
  const location = { search: opts.search ?? "" };
  // eslint-disable-next-line no-new-func
  new Function("window", "document", "parent", "location", APP_RUNTIME)(win, doc, parentStub, location);
  return {
    Setoku: win.Setoku as Record<string, (...a: unknown[]) => void>,
    html: (id: string) => (els[id] ||= { innerHTML: "" }).innerHTML,
    messages,
  };
}

describe("Setoku chart runtime", () => {
  it("bar: coerces numeric STRINGS and sizes the fill with display:block", () => {
    // Postgres returns numerics as strings — the recurring break. Max=100 → 100%/50%.
    const { Setoku, html } = runRuntime({ rev: { rows: [{ s: "a", v: "100" }, { s: "b", v: "50" }], error: null } });
    Setoku.bar("chart", "rev", { label: "s", value: "v", format: "money" });
    const out = html("chart");
    expect(out).toContain("width:100.0%");
    expect(out).toContain("width:50.0%");
    expect(out).toContain("display:block"); // the inline-span fix — fill actually renders
    expect(out).toContain("$100");
  });

  it("bar: shows an empty state and an error state instead of breaking", () => {
    const empty = runRuntime({ p: { rows: [], error: null } });
    empty.Setoku.bar("c", "p", { label: "x", value: "y" });
    expect(empty.html("c")).toContain("No data");

    const errored = runRuntime({ p: { rows: [], error: "relation does not exist" } });
    errored.Setoku.bar("c", "p", {});
    expect(errored.html("c")).toContain("relation does not exist");
  });

  it("echoes per-panel provenance to the parent, tagged with the reload nonce (t)", () => {
    const { messages } = runRuntime(
      {
        rev: { rows: [{ v: 1 }], rowCount: 1, computedAt: "2026-01-01T00:00:00Z", error: null },
        cnt: { rows: [], rowCount: 0, computedAt: "2026-01-01T00:00:00Z", error: "boom", refreshError: null },
      },
      { search: "?p.region=NA&t=7" },
    );
    const prov = messages.find((m) => m.__setoku_provenance === true) as
      | { t: string; panels: Record<string, { rowCount: number; error: string | null }> }
      | undefined;
    expect(prov).toBeTruthy();
    expect(prov!.t).toBe("7"); // correlation token from the frame's own URL
    expect(prov!.panels.rev.rowCount).toBe(1);
    expect(prov!.panels.cnt.error).toBe("boom"); // per-panel error rides along
  });

  it("stat + table coerce and render", () => {
    const { Setoku, html } = runRuntime({
      s: { rows: [{ n: "1298" }], error: null },
      t: { rows: [{ a: "1", b: "x" }], error: null },
    });
    Setoku.stat("st", "s", { value: "n", format: "int", label: "Fans" });
    expect(html("st")).toContain("1,298");
    Setoku.table("tb", "t", {});
    expect(html("tb")).toContain("<table");
  });

  it("table: right-aligns numeric-format columns", () => {
    const { Setoku, html } = runRuntime({ t: { rows: [{ name: "A", amt: "1000" }], error: null } });
    Setoku.table("c", "t", { columns: ["name", "amt"], format: { amt: "money" } });
    const out = html("c");
    expect(out).toContain("text-align:right"); // the numeric column
    expect(out).toContain("$1.0k");
  });

  it("line: draws a path plus y min/max, x endpoints, and a last-value label", () => {
    const { Setoku, html } = runRuntime({ t: { rows: [{ d: "Jan", v: "10" }, { d: "Feb", v: "30" }, { d: "Mar", v: "20" }], error: null } });
    Setoku.line("c", "t", { x: "d", value: "v", format: "int" });
    const out = html("c");
    expect(out).toContain("<path"); // the line itself
    expect(out).toContain(">Jan<"); // first x label
    expect(out).toContain(">Mar<"); // last x label
    expect(out).toContain(">30<"); // y max
    expect(out).toContain(">10<"); // y min
  });
});

describe("lintAppTemplate", () => {
  it("flags a <span> sized without display (the blank-bar bug)", () => {
    const w = lintAppTemplate('<span style="width:50%;height:10px"></span>', []);
    expect(w.join(" ")).toContain("display");
  });

  it("flags an unused panel and a reference to a missing panel", () => {
    const w = lintAppTemplate('<div>Setoku.bar("c","known",{}) panels.bogus</div>', ["known", "extra"]);
    const j = w.join(" ");
    expect(j).toContain('panel "extra" is never referenced');
    expect(j).toContain('no panel "bogus"');
  });

  it("clean template → no warnings", () => {
    const w = lintAppTemplate('<div id="c"></div><script>Setoku.bar("c","rev",{label:"s",value:"v"})</script>', ["rev"]);
    expect(w).toEqual([]);
  });
});
