// SPDX-License-Identifier: Apache-2.0
// Pure helpers in lib/apps.ts. isFullDoc decides "legacy full HTML document"
// (served as-is) vs "fragment the runtime wraps" — it must be anchored so a
// fragment that merely CONTAINS the literal `<html` (a code snippet, a template
// string) isn't misclassified and served down the wrong path.
import { describe, it, expect } from "bun:test";
import { isFullDoc } from "../plugin/gateway/lib/apps";

describe("isFullDoc", () => {
  it("treats a body that STARTS with the doctype/html tag as a full document", () => {
    expect(isFullDoc("<!doctype html><html><body>x</body></html>")).toBe(true);
    expect(isFullDoc("<html lang=en><body>x</body></html>")).toBe(true);
    expect(isFullDoc("  \n  <!DOCTYPE HTML>")).toBe(true); // leading whitespace + case
  });
  it("does NOT classify a fragment that merely contains `<html` as a full document", () => {
    expect(isFullDoc("<div>see the &lt;html&gt; tag</div>")).toBe(false);
    expect(isFullDoc("<pre>const t = `<html>`</pre>")).toBe(false);
    expect(isFullDoc('<div id="app"></div>')).toBe(false);
    expect(isFullDoc("")).toBe(false);
  });
});
