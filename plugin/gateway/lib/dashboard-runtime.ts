// SPDX-License-Identifier: Apache-2.0
/**
 * Tested chart runtime injected into every dashboard frame, and a static linter
 * for agent-authored templates. The agent kept hand-rolling SVG/CSS and tripping
 * the same traps (inline `<span>` ignores width/height; Postgres numerics arrive
 * as STRINGS so chart math silently NaNs to zero) — both invisible because it
 * publishes blind. `window.Setoku.*` gives it known-good primitives instead, and
 * `lintDashboardTemplate` turns the common footguns into publish-time warnings.
 *
 * The runtime is plain browser JS shipped as a string (it runs in the sandboxed,
 * no-network frame). Its behavior is covered by test/dashboard-runtime.test.ts
 * via a minimal DOM stub.
 */

/** Browser runtime: defines `window.Setoku` with bar/table/stat/line + fmt. Reads
 *  panel data lazily from `window.__SETOKU__` so it's injected after the data. */
export const DASHBOARD_RUNTIME = `(function () {
  // Coerce anything (incl. Postgres numeric strings like "98401245.89") to a number.
  function num(v) {
    if (typeof v === "number") return isFinite(v) ? v : 0;
    var n = parseFloat(String(v == null ? "" : v).replace(/[^0-9eE.+-]/g, ""));
    return isFinite(n) ? n : 0;
  }
  var fmt = {
    money: function (v) { var n = num(v), a = Math.abs(n);
      if (a >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B";
      if (a >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
      if (a >= 1e3) return "$" + (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "k";
      return "$" + Math.round(n); },
    int: function (v) { return Math.round(num(v)).toLocaleString(); },
    num: function (v) { return num(v).toLocaleString(); },
    pct: function (v) { return (num(v)).toFixed(1) + "%"; },
    raw: function (v) { return v == null ? "" : String(v); }
  };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (m) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]; }); }
  function elOf(t) { return typeof t === "string" ? document.getElementById(t) : t; }
  function fmtOf(f) { return typeof f === "function" ? f : (fmt[f] || fmt.raw); }
  // src is a panel key (looked up in __SETOKU__, with its error/rows) or a rows array.
  function resolve(src) {
    if (Array.isArray(src)) return { rows: src, error: null };
    var P = (window.__SETOKU__ && window.__SETOKU__.panels) || {};
    var p = P[src];
    if (!p) return { rows: [], error: 'unknown panel "' + src + '"' };
    return { rows: p.rows || [], error: p.error || p.refreshError || null };
  }
  function guard(el, r) {
    if (!el) return true;
    if (r.error) { el.innerHTML = '<div style="color:#c8472f;font:13px system-ui">' + esc(r.error) + "</div>"; return true; }
    if (!r.rows.length) { el.innerHTML = '<div style="color:#8a99a8;font:13px system-ui">No data</div>'; return true; }
    return false;
  }
  function bar(target, src, opts) {
    opts = opts || {}; var el = elOf(target); var r = resolve(src); if (guard(el, r)) return;
    var lab = opts.label, val = opts.value, f = fmtOf(opts.format || "num");
    var vals = r.rows.map(function (row) { return num(row[val]); });
    var max = opts.max != null ? num(opts.max) : Math.max.apply(null, vals.concat([0]));
    var color = opts.color || "#2f6f8f";
    el.innerHTML = r.rows.map(function (row, i) {
      var v = vals[i], w = max > 0 ? Math.max(0, v / max * 100) : 0; // clamp: no negative widths
      var c = typeof color === "function" ? color(row, i) : color;
      var label = lab ? String(row[lab] == null ? "" : row[lab]) : "";
      return '<div style="display:flex;align-items:center;gap:10px;font:13px system-ui;margin:6px 0">' +
        '<span title="' + esc(label) + '" style="width:130px;flex:none;color:#5b6b7a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(label) + "</span>" +
        '<span style="flex:1;display:block;background:#f1f4f7;border-radius:5px;height:20px;overflow:hidden">' +
        '<span style="display:block;height:100%;border-radius:5px;width:' + w.toFixed(1) + "%;background:" + esc(c) + '"></span></span>' +
        '<span style="width:84px;flex:none;text-align:right;font-weight:600;font-variant-numeric:tabular-nums">' + esc(f(v)) + "</span></div>";
    }).join("");
  }
  // Numeric formats get right-aligned + tabular figures so columns line up.
  function isNumFmt(f) { return f === "money" || f === "int" || f === "num" || f === "pct"; }
  function table(target, src, opts) {
    opts = opts || {}; var el = elOf(target); var r = resolve(src); if (guard(el, r)) return;
    var cols = opts.columns || Object.keys(r.rows[0]);
    var fmts = opts.format || {}, labels = opts.labels || {};
    var aligns = cols.map(function (c) { return isNumFmt(fmts[c]) ? "right" : "left"; });
    var head = "<tr>" + cols.map(function (c, i) {
      return '<th style="text-align:' + aligns[i] + ';padding:6px 10px;border-bottom:1px solid #e3e8ee;color:#5b6b7a;font-weight:500">' + esc(labels[c] || c) + "</th>"; }).join("") + "</tr>";
    var body = r.rows.map(function (row) {
      return "<tr>" + cols.map(function (c, i) { var f = fmtOf(fmts[c] || "raw"); var nums = aligns[i] === "right";
        return '<td style="padding:6px 10px;border-bottom:1px solid #f1f4f7;text-align:' + aligns[i] + (nums ? ";font-variant-numeric:tabular-nums" : "") + '">' + esc(f(row[c])) + "</td>"; }).join("") + "</tr>"; }).join("");
    el.innerHTML = '<table style="width:100%;border-collapse:collapse;font:13px system-ui">' + head + body + "</table>";
  }
  function stat(target, src, opts) {
    opts = opts || {}; var el = elOf(target); if (!el) return; var r = resolve(src);
    if (r.error) { el.innerHTML = '<div style="color:#c8472f;font:13px system-ui">' + esc(r.error) + "</div>"; return; }
    var row = r.rows[0] || {}; var f = fmtOf(opts.format || "num");
    var v = opts.value != null ? row[opts.value] : (opts.raw != null ? opts.raw : "");
    el.innerHTML = '<div style="font:700 30px system-ui;letter-spacing:-.02em">' + esc(f(v)) + "</div>" +
      (opts.label ? '<div style="font:11px system-ui;color:#5b6b7a;text-transform:uppercase;letter-spacing:.05em;margin-top:3px">' + esc(opts.label) + "</div>" : "");
  }
  function line(target, src, opts) {
    opts = opts || {}; var el = elOf(target); var r = resolve(src); if (guard(el, r)) return;
    var f = fmtOf(opts.format || "num");
    var ys = r.rows.map(function (row) { return num(row[opts.value]); });
    var xs = opts.x ? r.rows.map(function (row) { return row[opts.x]; }) : null;
    var W = 600, H = 180, padL = 6, padR = 6, padT = 16, padB = 30, n = ys.length;
    var mn = Math.min.apply(null, ys), mx = Math.max.apply(null, ys);
    if (mx === mn) { mn -= 1; mx += 1; } // flat/single/negative series → a band, never divide-by-zero
    var X = function (i) { return padL + (n > 1 ? i / (n - 1) : 0) * (W - padL - padR); };
    var Y = function (v) { return padT + (1 - (v - mn) / (mx - mn)) * (H - padT - padB); };
    var color = esc(opts.color || "#2f6f8f");
    var line = ys.map(function (v, i) { return (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1); }).join(" ");
    var area = "M" + X(0).toFixed(1) + " " + (H - padB) + " " + ys.map(function (v, i) { return "L" + X(i).toFixed(1) + " " + Y(v).toFixed(1); }).join(" ") + " L" + X(n - 1).toFixed(1) + " " + (H - padB) + " Z";
    var lx = X(n - 1), ly = Y(ys[n - 1]);
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" style="width:100%;height:' + H + 'px;display:block;overflow:visible;font:11px system-ui">';
    s += '<text x="' + padL + '" y="' + (padT - 4) + '" fill="#8a99a8">' + esc(f(mx)) + "</text>"; // y max
    s += '<text x="' + padL + '" y="' + (H - padB + 13) + '" fill="#8a99a8">' + esc(f(mn)) + "</text>"; // y min
    s += '<path d="' + area + '" fill="' + color + '" opacity="0.08"/>';
    s += '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="2"/>';
    s += '<circle cx="' + lx.toFixed(1) + '" cy="' + ly.toFixed(1) + '" r="3" fill="' + color + '"/>';
    s += '<text x="' + lx.toFixed(1) + '" y="' + (ly - 8).toFixed(1) + '" text-anchor="end" fill="#15202b" font-weight="600">' + esc(f(ys[n - 1])) + "</text>";
    if (xs) {
      s += '<text x="' + padL + '" y="' + (H - 4) + '" fill="#8a99a8">' + esc(xs[0]) + "</text>";
      s += '<text x="' + (W - padR) + '" y="' + (H - 4) + '" text-anchor="end" fill="#8a99a8">' + esc(xs[n - 1]) + "</text>";
    }
    s += "</svg>";
    el.innerHTML = s;
  }
  window.Setoku = { bar: bar, table: table, stat: stat, line: line, fmt: fmt, num: num,
    rows: function (k) { return resolve(k).rows; } };
})();`;

/**
 * Static lint of an agent-authored template — non-blocking warnings surfaced at
 * publish/update so the agent can self-correct without seeing the render. Catches
 * the high-signal footguns: a panel that's never used, a reference to a panel key
 * that doesn't exist, and a sized inline `<span>` (the exact bug that ships blank
 * bars). Returns [] when clean.
 */
export function lintDashboardTemplate(html: string, panelKeys: string[]): string[] {
  const warn: string[] = [];
  const keys = new Set(panelKeys);

  // A panel is "used" if its key appears as a quoted string (Setoku.bar('id','key'))
  // or a property access (panels.key). Unused → likely a wiring mistake.
  for (const k of panelKeys) {
    const used =
      html.includes(`'${k}'`) || html.includes(`"${k}"`) || new RegExp(`panels\\.${k}\\b`).test(html);
    if (!used) warn.push(`panel "${k}" is never referenced by the template — its data won't be shown.`);
  }

  // Explicit panels.IDENT / panels["x"] references to keys that don't exist.
  // Skip built-in JS props so panels.length / .map / aliasing don't false-warn.
  const JS_PROPS = new Set([
    "length", "map", "filter", "forEach", "constructor", "hasOwnProperty", "prototype",
    "toString", "valueOf", "keys", "entries", "values", "indexOf", "slice",
  ]);
  const refs = new Set<string>();
  for (const m of html.matchAll(/panels\.([A-Za-z_$][\w$]*)/g)) refs.add(m[1]);
  for (const m of html.matchAll(/panels\[\s*['"]([^'"]+)['"]\s*\]/g)) refs.add(m[1]);
  for (const r of refs) if (!keys.has(r) && !JS_PROPS.has(r)) warn.push(`template reads panels.${r} but there is no panel "${r}".`);

  // A <span> given width/height but no display — inline spans ignore both, so the
  // element renders at zero size (blank bars/fills). The single most common break.
  // Match both quote styles (agents in JS strings often reach for single quotes).
  let sizedSpans = 0;
  for (const m of html.matchAll(/<span\b[^>]*\bstyle\s*=\s*(['"])([\s\S]*?)\1/gi)) {
    const s = m[2];
    if (/(^|;)\s*(width|height)\s*:/.test(s) && !/(^|;)\s*display\s*:/.test(s)) sizedSpans++;
  }
  if (sizedSpans)
    warn.push(
      `${sizedSpans} <span> with width/height but no \`display\` — inline spans ignore size and render blank. ` +
        `Add display:block/inline-block, or use the injected Setoku.bar/table/stat/line helpers.`,
    );

  return warn;
}
