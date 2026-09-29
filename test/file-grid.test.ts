// SPDX-License-Identifier: Apache-2.0
// The shared-file grid ships as browser JS in a string (lib/file-grid.ts); its
// interactions are exercised in a real browser during QA. Here we pin that the
// string is valid JS and that it bails cleanly on a file with no columns.
import { describe, it, expect } from "bun:test";
import { FILE_GRID_RUNTIME, FILE_GRID_HTML } from "../plugin/gateway/lib/file-grid";

describe("file grid runtime", () => {
  it("parses as JavaScript", () => {
    // eslint-disable-next-line no-new-func
    expect(() => new Function("window", "document", FILE_GRID_RUNTIME)).not.toThrow();
  });

  it("mounts the elements the runtime looks up", () => {
    for (const id of ["fx", "fxref", "fxval", "fxdim", "fxst", "fxclr", "sc", "gh", "gb", "gw", "gx", "gsel", "gact"]) expect(FILE_GRID_HTML).toContain(`id="${id}"`);
  });

  it("says so, and stops, when the file has no columns", () => {
    const els: Record<string, { textContent: string; style: { setProperty: () => void } }> = {};
    const doc = { getElementById: (id: string) => (els[id] ||= { textContent: "", style: { setProperty: () => {} } }) };
    const win = { __SETOKU__: { panels: { file: { columns: [], rows: [] } } } };
    // eslint-disable-next-line no-new-func
    new Function("window", "document", FILE_GRID_RUNTIME)(win, doc);
    expect(els.fxst.textContent).toBe("0 rows · 0 columns");
    expect(els.fxval.textContent).toBe("This file has no columns.");
  });
});
