// SPDX-License-Identifier: Apache-2.0
/**
 * The spreadsheet-style grid a shared CSV/TSV/JSON-rows file renders as. It's a
 * reading surface, closer to a Sheets tab than an app table: cells never wrap
 * (they truncate with an ellipsis), columns and rows resize by dragging their
 * edges (double-click an edge to fit it), the header row and the row-number
 * gutter stay frozen, and the active cell's FULL value shows in a formula bar
 * above the grid, so a truncated cell is always one click from readable.
 *
 * Also Sheets-like: each header's ▾ menu sorts the column and filters it by
 * value (a searchable checklist; filters AND across columns); a range selects by
 * drag, shift-click, shift+arrows, a row number, a column header, or Cmd/Ctrl+A,
 * shows Sum/Avg/Count, and copies (Cmd/Ctrl+C) as TSV + an HTML table so it
 * pastes into a spreadsheet as cells. Row numbers stay the file's own numbers
 * under a sort or filter, so "row 12" always means the same record.
 *
 * Like APP_RUNTIME this is plain browser JS shipped as a string. It runs in the
 * same sandboxed, no-network frame and reads the synthetic `file` panel from
 * `window.__SETOKU__`. Rows are virtualized past a threshold (a 25k-row file must
 * not become a 25k-row DOM); below it every row is in the DOM so the browser's
 * own find (Cmd/Ctrl+F) still sees the whole file. Stone palette only: the
 * viewer is gateway chrome, not the user's content.
 */

/** Styles for the grid. The body is a fixed-height flex column: the formula bar
 *  on top, the scroller filling the rest, an optional cap note at the bottom. */
export const FILE_GRID_CSS =
  `html,body{height:100%}body{display:flex;flex-direction:column;overflow:hidden}` +
  `#fx{flex:none;display:flex;align-items:stretch;border-bottom:1px solid #e7e5e4;background:#fff;font-size:13px;min-height:32px}` +
  `#fxref{flex:none;display:flex;align-items:center;gap:.35rem;min-width:9rem;max-width:16rem;padding:0 .75rem;border-right:1px solid #e7e5e4;color:#57534e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}` +
  `#fxref b{font-weight:600;color:#1c1917;overflow:hidden;text-overflow:ellipsis}` +
  `#fxval{flex:1;min-width:0;padding:.4rem .75rem;white-space:pre-wrap;word-break:break-word;max-height:7.5em;overflow:auto;color:#1c1917;user-select:text}` +
  `#fxref:empty{display:none}#fxval.hint{color:#a8a29e}` +
  `#fxdim{flex:none;display:flex;align-items:center;gap:.6rem;padding:0 .75rem;color:#78716c;font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}` +
  `#fxclr{font:inherit;font-size:12px;color:#44403c;background:#fafaf9;border:1px solid #d6d3d1;border-radius:.4rem;padding:.1rem .5rem;cursor:pointer}#fxclr:hover{background:#f5f5f4}` +
  `@media (max-width:600px){#fxref{min-width:0;max-width:40%}#fxdim span{display:none}}` +
  `#sc{flex:1;min-height:0;overflow:auto;position:relative;outline:none;background:#fff}` +
  `#gw{position:relative;user-select:none}` +
  `.gr{display:flex;position:relative}` +
  `.gc,.gn{flex:none;box-sizing:border-box;height:100%;padding:0 8px;border-right:1px solid #e7e5e4;border-bottom:1px solid #e7e5e4;` +
  `white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:26px;font-size:13px;color:#1c1917;cursor:cell}` +
  `.gc.num{text-align:right;font-variant-numeric:tabular-nums}` +
  `.gn{position:sticky;left:0;z-index:1;width:var(--gw);padding:0 6px;background:#fafaf9;color:#a8a29e;font-size:11px;text-align:right;cursor:default;user-select:none}` +
  `#gh{position:sticky;top:0;z-index:3;height:30px}` +
  `#gh .gc{position:relative;display:flex;align-items:center;gap:2px;padding-right:9px;background:#fafaf9;font-weight:600;color:#44403c;line-height:30px;cursor:default;user-select:none;border-bottom-color:#d6d3d1}` +
  `#gh .gc.num{justify-content:flex-end}` +
  `#gh .gn{z-index:4;border-bottom-color:#d6d3d1}` +
  `.hn{min-width:0;overflow:hidden;text-overflow:ellipsis}#gh .gc:not(.num) .hn{flex:1}` +
  `.si{flex:none;font-size:11px;color:#57534e}` +
  `.fb{flex:none;display:grid;place-items:center;width:20px;height:20px;padding:0;border:0;border-radius:4px;background:transparent;color:#a8a29e;cursor:pointer;opacity:0}` +
  `#gh .gc:hover .fb,.fb.act,.fb.open{opacity:1}.fb:hover{background:#e7e5e4;color:#1c1917}.fb.act{color:#1c1917;background:#e7e5e4}` +
  `@media (hover:none){.fb{opacity:1}}` +
  `.gr.wrap .gc{white-space:pre-wrap;word-break:break-word;line-height:20px;padding-top:3px;padding-bottom:3px;text-overflow:clip}` +
  `.gn.hl,#gh .gc.hl{background:#e7e5e4;color:#1c1917}` +
  // Selection overlays live INSIDE #gw (after the rows): above the cells, below
  // the sticky gutter (z-index 1 in the same stacking context).
  `#gsel,#gact{position:absolute;display:none;pointer-events:none;z-index:0;box-sizing:border-box}` +
  `#gsel{background:rgba(28,25,23,.07);box-shadow:inset 0 0 0 1px #57534e}#gact{box-shadow:inset 0 0 0 2px #1c1917}` +
  `.gempty{padding:1.25rem 1rem;color:#78716c;font-size:13px}` +
  // Resize handles sit INSIDE their cell's edge: cells clip (overflow:hidden), and
  // a handle hanging past a row's bottom would sit under the next row's gutter.
  `.cr{position:absolute;top:0;right:0;width:7px;height:100%;cursor:col-resize;z-index:2}` +
  `.rr{position:absolute;left:0;right:0;bottom:0;height:6px;cursor:row-resize;z-index:2}` +
  `.cr:hover,.cr.drag{background:linear-gradient(90deg,transparent 4px,#78716c 4px,#78716c 6px,transparent 6px)}` +
  `.rr:hover,.rr.drag{background:linear-gradient(180deg,transparent 3px,#78716c 3px,#78716c 5px,transparent 5px)}` +
  `body.resizing,body.resizing *{user-select:none!important}` +
  `body.resizing.col,body.resizing.col *{cursor:col-resize!important}body.resizing.row,body.resizing.row *{cursor:row-resize!important}` +
  // The column menu (sort + filter by values).
  `#gm{position:fixed;z-index:10;width:260px;box-sizing:border-box;background:#fff;border:1px solid #e7e5e4;border-radius:.5rem;box-shadow:0 8px 24px rgba(28,25,23,.12);font-size:13px;color:#1c1917;padding:4px 0}` +
  `#gm .mi{display:block;width:100%;text-align:left;padding:6px 12px;background:none;border:0;font:inherit;color:inherit;cursor:pointer}#gm .mi:hover{background:#f5f5f4}` +
  `#gm hr{border:0;border-top:1px solid #e7e5e4;margin:4px 0}` +
  `#gm .mh{padding:6px 12px 4px;font-size:11px;font-weight:600;color:#78716c;text-transform:uppercase;letter-spacing:.04em}` +
  `#gm input[type=search]{display:block;width:calc(100% - 24px);margin:0 12px 6px;box-sizing:border-box;font:inherit;border:1px solid #d6d3d1;border-radius:.4rem;padding:.3rem .5rem;outline:none}` +
  `#gm input[type=search]:focus{border-color:#a8a29e;box-shadow:0 0 0 2px #e7e5e4}` +
  `#gm .mb{display:flex;gap:.6rem;padding:0 12px 4px;font-size:12px;color:#78716c}#gm .mb button{padding:0;border:0;background:none;font:inherit;color:#44403c;text-decoration:underline;text-underline-offset:2px;cursor:pointer}` +
  `#gm .fl{overflow:auto;padding:0 6px}` +
  `#gm label{display:flex;align-items:center;gap:8px;padding:3px 6px;border-radius:4px;cursor:pointer}#gm label:hover{background:#f5f5f4}` +
  `#gm label span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#gm label i{font-style:normal;color:#a8a29e;font-size:11px}` +
  `#gm input[type=checkbox]{accent-color:#1c1917;margin:0}` +
  `#gm .more{padding:4px 12px;color:#a8a29e;font-size:12px}` +
  `#gm .ft{display:flex;justify-content:flex-end;gap:6px;padding:6px 12px 4px}` +
  `#gm .ft button{font:inherit;border-radius:.4rem;padding:.3rem .75rem;cursor:pointer;border:1px solid #d6d3d1;background:#fff;color:#44403c}` +
  `#gm .ft button.ok{background:#1c1917;border-color:#1c1917;color:#fafaf9}#gm .ft button.ok:hover{background:#44403c}` +
  `#gm .ft .rs{margin-right:auto;border:0;padding-left:0;padding-right:0;text-decoration:underline;text-underline-offset:2px}`;

/** The frame markup the grid mounts into. */
export const FILE_GRID_HTML =
  `<div id="fx"><div id="fxref"></div><div id="fxval" class="hint">Select a cell to see everything in it.</div>` +
  `<div id="fxdim"><button id="fxclr" type="button" hidden>Clear filters</button><span id="fxst"></span></div></div>` +
  `<div id="sc" tabindex="0"><div id="gh" class="gr"></div><div id="gb"><div id="gw"><div id="gx"></div><div id="gsel"></div><div id="gact"></div></div></div></div>`;

/** The browser runtime. Mounts once, reading `window.__SETOKU__.panels.file`. */
export const FILE_GRID_RUNTIME = `(function () {
  var P = (window.__SETOKU__ && window.__SETOKU__.panels && window.__SETOKU__.panels.file) || { columns: [], rows: [] };
  var cols = P.columns || [], rows = P.rows || [];
  var NR = rows.length, NC = cols.length;
  var RH = 27, HH = 30, MINW = 40, MAXW = 320, FITMAX = 900, MINH = RH; // rows grow, never shrink below one line
  // Below this many (visible) rows everything is in the DOM (browser find
  // works); above it only the visible window is.
  var VIRTUAL_AT = 1500, OVERSCAN = 12, LIST_CAP = 500;
  var $ = function (id) { return document.getElementById(id); };
  var fxref = $("fxref"), fxval = $("fxval"), fxst = $("fxst");

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (m) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]; }); }
  function val(d, c) { var v = rows[d] && rows[d][cols[c]]; return v == null ? "" : String(v); }
  function fmtInt(n) { return n.toLocaleString(); }

  if (!NC) { fxst.textContent = "0 rows \\u00b7 0 columns"; fxval.textContent = "This file has no columns."; return; }
  var sc = $("sc"), gh = $("gh"), gb = $("gb"), gw = $("gw"), gx = $("gx"),
      gsel = $("gsel"), gact = $("gact"), fxclr = $("fxclr");

  // ---- measuring (canvas: no layout, so fitting a column over 25k rows is cheap)
  var ctx = document.createElement("canvas").getContext("2d");
  var FONT = getComputedStyle(document.body).fontFamily || "system-ui";
  function textW(s, bold) { if (!ctx) return s.length * 7; ctx.font = (bold ? "600 " : "") + "13px " + FONT; return ctx.measureText(s).width; }
  function cellText(s) { return s.replace(/\\s+/g, " "); } // what nowrap shows

  // Numbers as a spreadsheet reads them: "$1,200", "12%", "(40)" (negative).
  function numOf(v) {
    var s = v.replace(/[\\s,$\\u20ac\\u00a3%]/g, "");
    var neg = s.charAt(0) === "(" && s.charAt(s.length - 1) === ")";
    if (neg) s = s.slice(1, -1);
    if (s === "" || !/^[-+]?(\\d+\\.?\\d*|\\.\\d+)([eE][-+]?\\d+)?$/.test(s)) return NaN;
    return neg ? -Number(s) : Number(s);
  }
  // Right-align (and sort numerically) a column when nearly all of its
  // non-empty values are numbers.
  var isNum = cols.map(function (_, c) {
    var seen = 0, hit = 0;
    for (var d = 0; d < NR && seen < 400; d++) { var v = val(d, c); if (v === "") continue; seen++; if (!isNaN(numOf(v))) hit++; }
    return seen > 0 && hit / seen >= 0.9;
  });

  // Initial widths: fit the header and most of the content (90th percentile of a
  // sample, so one long note doesn't make its column huge), clamped.
  function fitW(c, all) {
    var ws = [], lim = all ? Math.min(NR, 5000) : Math.min(NR, 300);
    for (var d = 0; d < lim; d++) ws.push(textW(cellText(val(d, c)), false));
    ws.sort(function (a, b) { return a - b; });
    var body = ws.length ? (all ? ws[ws.length - 1] : ws[Math.floor((ws.length - 1) * 0.9)]) : 0;
    var head = textW(cols[c], true) + 44; // + padding, the menu button, the sort arrow
    return Math.ceil(Math.max(head, body + 18));
  }
  var W = cols.map(function (_, c) { return Math.max(MINW, Math.min(MAXW, fitW(c, false))); });
  var GW = Math.max(36, Math.ceil(textW(fmtInt(NR), false) * 0.85) + 16); // gutter
  sc.style.setProperty("--gw", GW + "px");
  // One class per column whose width reads a CSS variable, so a drag restyles by
  // setting one variable instead of touching every cell.
  var css = "";
  for (var c0 = 0; c0 < NC; c0++) css += ".k" + c0 + "{width:var(--w" + c0 + ")}";
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  function colLeft(c) { var x = GW; for (var i = 0; i < c; i++) x += W[i]; return x; }
  function applyW(c) {
    sc.style.setProperty("--w" + c, W[c] + "px");
    var t = colLeft(NC) + "px"; gh.style.width = t; gb.style.width = t;
  }
  for (var c1 = 0; c1 < NC; c1++) applyW(c1);
  function colAt(x) { // column under an x in scroller coordinates
    x -= GW; if (x < 0) return 0;
    for (var c = 0; c < NC; c++) { x -= W[c]; if (x < 0) return c; }
    return NC - 1;
  }

  // ---- the view: which data rows show, in what order (filter, then sort)
  var view = [], NV = 0;
  var filt = {};          // column -> Set of HIDDEN values (absent = unfiltered)
  var sortCol = -1, sortDir = 1;
  var collator = typeof Intl !== "undefined" ? new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }) : null;
  function passes(d, skip) {
    for (var k in filt) { if (+k !== skip && filt[k].has(val(d, +k))) return false; }
    return true;
  }
  function anyFilter() { for (var k in filt) return true; return false; }

  // ---- row heights: per DATA row (a height follows its record through a sort),
  // prefix sums over the VIEW drive the virtual window.
  var H = null, wrapRow = {}, top = null, virtual = false;
  function rowH(vi) { return H ? H[view[vi]] : RH; }
  function rebuildTops() {
    if (!H) { top = null; gb.style.height = NV * RH + "px"; return; }
    top = new Float64Array(NV + 1);
    for (var i = 0; i < NV; i++) top[i + 1] = top[i] + H[view[i]];
    gb.style.height = top[NV] + "px";
  }
  function rowTop(vi) { return top ? top[vi] : vi * RH; }
  function rowAt(y) { // the view row under a y in body coordinates
    if (NV === 0) return 0;
    if (!top) return Math.max(0, Math.min(NV - 1, Math.floor(y / RH)));
    var lo = 0, hi = NV - 1;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (top[mid + 1] <= y) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function setRowH(d, h) {
    if (!H) { H = new Float64Array(NR); H.fill(RH); }
    H[d] = Math.max(MINH, Math.round(h));
    if (H[d] > RH + 4) wrapRow[d] = 1; else delete wrapRow[d];
    rebuildTops();
  }

  // ---- selection: an anchor (the active cell) and a focus corner, in VIEW rows.
  // mode "rows"/"cols"/"all" = whole rows / columns / everything was picked.
  var sel = null;
  function rng() {
    if (!sel) return null;
    var r1 = Math.min(sel.ar, sel.fr), r2 = Math.max(sel.ar, sel.fr), c1 = Math.min(sel.ac, sel.fc), c2 = Math.max(sel.ac, sel.fc);
    if (sel.mode === "rows" || sel.mode === "all") { c1 = 0; c2 = NC - 1; }
    if (sel.mode === "cols" || sel.mode === "all") { r1 = 0; r2 = NV - 1; }
    return { r1: r1, r2: r2, c1: c1, c2: c2 };
  }

  // ---- header
  var ICON_MENU = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>';
  var ICON_FUNNEL = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h12l-4.6 5.4V13l-2.8 1.2V8.4z"/></svg>';
  function renderHead() {
    gh.innerHTML = '<div class="gn" title="Select all"></div>' + cols.map(function (name, c) {
      var s = sortCol === c ? '<span class="si">' + (sortDir > 0 ? "\\u2191" : "\\u2193") + "</span>" : "";
      var f = !!filt[c];
      return '<div class="gc k' + c + (isNum[c] ? " num" : "") + '" data-c="' + c + '"><span class="hn" title="' + esc(name) + '">' + esc(name) + "</span>" + s +
        '<button type="button" class="fb' + (f || sortCol === c ? " act" : "") + '" data-c="' + c + '" title="Sort &amp; filter" aria-label="Sort and filter ' + esc(name) + '">' + (f ? ICON_FUNNEL : ICON_MENU) + "</button>" +
        '<div class="cr" data-c="' + c + '"></div></div>';
    }).join("");
  }

  // ---- body (the visible window, or every row for a small file)
  var winA = -1, winB = -1;
  function rowHtml(vi, R) {
    var d = view[vi], h = rowH(vi);
    var hl = R && vi >= R.r1 && vi <= R.r2;
    var out = '<div class="gr' + (wrapRow[d] ? " wrap" : "") + '" data-r="' + vi + '" style="height:' + h + 'px">' +
      '<div class="gn' + (hl ? " hl" : "") + '" style="line-height:' + Math.min(h, RH) + 'px">' + (d + 1) + '<div class="rr" data-r="' + vi + '"></div></div>';
    for (var c = 0; c < NC; c++) out += '<div class="gc k' + c + (isNum[c] ? " num" : "") + '">' + esc(val(d, c)) + "</div>";
    return out + "</div>";
  }
  function render(force) {
    if (!NV) {
      winA = winB = -1;
      gx.innerHTML = '<div class="gempty">' + (NR ? "No rows match the current filters." : "This file has no rows.") + "</div>";
      gw.style.transform = ""; drawSel(); return;
    }
    var a = 0, b = NV - 1;
    if (virtual) {
      var y0 = Math.max(0, sc.scrollTop - HH), y1 = y0 + sc.clientHeight;
      a = Math.max(0, rowAt(y0) - OVERSCAN); b = Math.min(NV - 1, rowAt(y1) + OVERSCAN);
    }
    if (!force && a === winA && b === winB) return;
    winA = a; winB = b;
    var R = rng(), html = "";
    for (var vi = a; vi <= b; vi++) html += rowHtml(vi, R);
    gw.style.transform = "translateY(" + rowTop(a) + "px)";
    gx.innerHTML = html;
    drawSel();
  }
  var raf = 0;
  sc.addEventListener("scroll", function () {
    closeMenu();
    if (!virtual || raf) return;
    raf = requestAnimationFrame(function () { raf = 0; render(false); });
  });
  window.addEventListener("resize", function () { closeMenu(); render(true); });

  // Overlays are positioned relative to #gw, which is translated to the top of
  // the rendered window, so a row's y is its offset from that window's top.
  function box(el, r1, r2, c1, c2) {
    var y0 = rowTop(winA < 0 ? 0 : winA), x = colLeft(c1);
    el.style.display = "block";
    el.style.top = rowTop(r1) - y0 + "px"; el.style.height = rowTop(r2 + 1) - rowTop(r1) + "px";
    el.style.left = x + "px"; el.style.width = colLeft(c2 + 1) - x + "px";
  }
  function drawSel() {
    var R = rng();
    if (!R || !NV) { gsel.style.display = gact.style.display = "none"; return; }
    if (R.r1 === R.r2 && R.c1 === R.c2) gsel.style.display = "none";
    else box(gsel, R.r1, R.r2, R.c1, R.c2);
    box(gact, sel.ar, sel.ar, sel.ac, sel.ac);
  }
  // Header + gutter highlights for the selected columns/rows (restyled in place,
  // so dragging a range never rebuilds the window).
  function paintHeads() {
    var R = rng();
    for (var c = 0; c < NC; c++) { var h = gh.children[c + 1]; if (h) h.classList.toggle("hl", !!R && c >= R.c1 && c <= R.c2); }
    for (var i = 0; i < gx.children.length; i++) {
      var row = gx.children[i], vi = Number(row.getAttribute("data-r"));
      if (row.firstChild) row.firstChild.classList.toggle("hl", !!R && vi >= R.r1 && vi <= R.r2);
    }
  }

  // ---- formula bar + status (counts, or Sum/Avg/Count for a range)
  var flash = 0, flashMsg = "";
  function fmtNum(n) { return n.toLocaleString(undefined, { maximumFractionDigits: 2 }); }
  function status() {
    fxclr.hidden = !anyFilter();
    if (flash) { fxst.textContent = flashMsg; return; }
    var R = rng();
    if (R && NV && (R.r1 !== R.r2 || R.c1 !== R.c2)) {
      var n = 0, k = 0, sum = 0, cells = (R.r2 - R.r1 + 1) * (R.c2 - R.c1 + 1);
      if (cells <= 400000) {
        for (var vi = R.r1; vi <= R.r2; vi++) for (var c = R.c1; c <= R.c2; c++) {
          var v = val(view[vi], c); if (v === "") continue; n++;
          var x = numOf(v); if (!isNaN(x)) { k++; sum += x; }
        }
        fxst.textContent = (k ? "Sum " + fmtNum(sum) + " \\u00b7 Avg " + fmtNum(sum / k) + " \\u00b7 " : "") + "Count " + fmtInt(n);
      } else fxst.textContent = fmtInt(R.r2 - R.r1 + 1) + " rows \\u00d7 " + fmtInt(R.c2 - R.c1 + 1) + " columns selected";
      return;
    }
    var rowsTxt = (NV === NR ? fmtInt(NR) + (P.truncated ? "+" : "") : fmtInt(NV) + " of " + fmtInt(NR)) + " rows";
    fxst.textContent = rowsTxt + " \\u00b7 " + fmtInt(NC) + " columns";
  }
  function say(msg) {
    flashMsg = msg; clearTimeout(flash);
    flash = setTimeout(function () { flash = 0; status(); }, 1600);
    status();
  }
  function showSel() {
    if (!sel || !NV) {
      fxref.innerHTML = ""; fxval.className = "hint"; fxval.textContent = "Select a cell to see everything in it."; status(); return;
    }
    var d = view[sel.ar];
    fxref.innerHTML = "<span>Row " + fmtInt(d + 1) + '</span><span>\\u00b7</span><b title="' + esc(cols[sel.ac]) + '">' + esc(cols[sel.ac]) + "</b>";
    var v = val(d, sel.ac);
    fxval.className = v === "" ? "hint" : "";
    fxval.textContent = v === "" ? "(empty)" : v;
    fxval.scrollTop = 0;
    status();
  }

  function reveal(r, c) {
    if (r != null) {
      var yT = rowTop(r), yB = yT + rowH(r), viewH = sc.clientHeight - HH;
      if (yT < sc.scrollTop) sc.scrollTop = yT;
      else if (yB > sc.scrollTop + viewH) sc.scrollTop = yB - viewH;
    }
    if (c != null) {
      var xL = colLeft(c), xR = xL + W[c], viewL = sc.scrollLeft + GW, viewR = sc.scrollLeft + sc.clientWidth;
      if (xL < viewL) sc.scrollLeft = xL - GW;
      else if (xR > viewR) sc.scrollLeft = Math.min(xL - GW, xR - sc.clientWidth);
    }
  }
  function clampR(r) { return Math.max(0, Math.min(NV - 1, r)); }
  function clampC(c) { return Math.max(0, Math.min(NC - 1, c)); }
  // Every selection change funnels through here.
  function unflash() { if (flash) { clearTimeout(flash); flash = 0; } }
  function setSel(next, revealR, revealC) {
    unflash(); // a new selection replaces a "Copied" note
    sel = next;
    if (sel) {
      sel.ar = clampR(sel.ar); sel.fr = clampR(sel.fr); sel.ac = clampC(sel.ac); sel.fc = clampC(sel.fc);
      reveal(revealR == null ? null : clampR(revealR), revealC == null ? null : clampC(revealC));
    }
    render(false); drawSel(); paintHeads(); showSel();
  }
  function selectCell(r, c) { setSel({ ar: r, ac: c, fr: r, fc: c, mode: "cells" }, r, c); }
  function extendTo(r, c) {
    if (!sel) return selectCell(r, c);
    var R = rng(); // materialize a whole-row/column pick into plain cells first
    var s = { ar: sel.ar, ac: sel.ac, fr: sel.fr, fc: sel.fc, mode: "cells" };
    if (sel.mode !== "cells") { s.fr = s.ar === R.r1 ? R.r2 : R.r1; s.fc = s.ac === R.c1 ? R.c2 : R.c1; }
    s.fr = r == null ? s.fr : r; s.fc = c == null ? s.fc : c;
    setSel(s, s.fr, s.fc);
  }

  // ---- pointer: resize handles, the header menu, and range selection
  var drag = null;   // a resize in progress
  var pick = null;   // a range drag in progress: { mode, x, y }
  function hit(cx, cy) {
    var b = sc.getBoundingClientRect();
    return { r: rowAt(cy - b.top + sc.scrollTop - HH), c: colAt(cx - b.left + sc.scrollLeft) };
  }
  sc.addEventListener("pointerdown", function (e) {
    if (e.button !== 0) return;
    var t = e.target, isCol = t.classList.contains("cr"), isRow = t.classList.contains("rr");
    if (isCol || isRow) {
      e.preventDefault(); e.stopPropagation();
      var i = Number(t.getAttribute(isCol ? "data-c" : "data-r"));
      drag = { col: isCol, i: i, start: isCol ? e.clientX : e.clientY, base: isCol ? W[i] : rowH(i), el: t };
      t.classList.add("drag");
      document.body.classList.add("resizing", isCol ? "col" : "row");
      try { t.setPointerCapture(e.pointerId); } catch (err) { /* old browser */ }
      return;
    }
    var fb = t.closest && t.closest(".fb");
    if (fb) { e.preventDefault(); var fc = Number(fb.getAttribute("data-c")); if (menuCol === fc) closeMenu(); else openMenu(fc, fb); return; }
    // Only a cell, header, or row number starts a selection: a press on the
    // scroller's own scrollbar (or the empty area past the grid) targets #sc.
    if (!(t.closest && t.closest("#gh .gc, #gh .gn, #gx .gc, #gx .gn"))) return;
    // Take focus ourselves: a click may rebuild the virtual window, detaching the
    // clicked node, and the browser's default focus would then fall to <body>.
    var touch = e.pointerType === "touch";
    if (!touch) e.preventDefault();
    sc.focus({ preventScroll: true });
    if (!NV) return;
    var inHead = gh.contains(t), gutter = t.closest && t.closest(".gn");
    var h = hit(e.clientX, e.clientY);
    var ext = e.shiftKey && sel;
    if (inHead && gutter) { setSel({ ar: 0, ac: 0, fr: NV - 1, fc: NC - 1, mode: "all" }); return; }
    if (inHead) {
      if (ext) setSel({ ar: sel.ar, ac: sel.ac, fr: sel.fr, fc: h.c, mode: "cols" }, null, h.c);
      else setSel({ ar: 0, ac: h.c, fr: 0, fc: h.c, mode: "cols" }, null, h.c);
      pick = touch ? null : { mode: "cols" };
    } else if (gutter) {
      if (ext) setSel({ ar: sel.ar, ac: sel.ac, fr: h.r, fc: sel.fc, mode: "rows" }, h.r, null);
      else setSel({ ar: h.r, ac: 0, fr: h.r, fc: 0, mode: "rows" }, h.r, null);
      pick = touch ? null : { mode: "rows" };
    } else {
      if (ext) extendTo(h.r, h.c); else selectCell(h.r, h.c);
      pick = touch ? null : { mode: "cells" };
    }
    if (pick) { pick.x = e.clientX; pick.y = e.clientY; }
  });
  function dragTo(cx, cy) {
    var h = hit(cx, cy), s = { ar: sel.ar, ac: sel.ac, fr: sel.fr, fc: sel.fc, mode: pick.mode };
    if (pick.mode !== "rows") s.fc = h.c;
    if (pick.mode !== "cols") s.fr = h.r;
    if (s.fr === sel.fr && s.fc === sel.fc) return;
    unflash(); sel = s; render(false); drawSel(); paintHeads(); status();
  }
  // Auto-scroll while a range drag sits past the scroller's edge.
  function autoScroll() {
    if (!pick) return;
    var b = sc.getBoundingClientRect(), dx = 0, dy = 0;
    if (pick.y < b.top + HH) dy = -Math.min(40, b.top + HH - pick.y); else if (pick.y > b.bottom) dy = Math.min(40, pick.y - b.bottom);
    if (pick.x < b.left + GW) dx = -Math.min(40, b.left + GW - pick.x); else if (pick.x > b.right) dx = Math.min(40, pick.x - b.right);
    if (pick.mode === "cols") dy = 0;
    if (pick.mode === "rows") dx = 0;
    if (dx || dy) { sc.scrollTop += dy; sc.scrollLeft += dx; dragTo(pick.x, pick.y); }
    requestAnimationFrame(autoScroll);
  }
  document.addEventListener("pointermove", function (e) {
    if (pick && sel) {
      var first = pick.moved !== true;
      pick.x = e.clientX; pick.y = e.clientY; pick.moved = true;
      dragTo(e.clientX, e.clientY);
      if (first) requestAnimationFrame(autoScroll);
      return;
    }
    if (!drag) return;
    var dlt = (drag.col ? e.clientX : e.clientY) - drag.start;
    if (!dlt) return; // a still pointer (the first half of a double-click) changes nothing
    if (drag.col) { W[drag.i] = Math.max(MINW, Math.round(drag.base + dlt)); applyW(drag.i); drawSel(); return; }
    // Patch the one row in place (the rows below it are in normal flow, so they
    // follow); a full re-render per pointermove would rebuild the whole window.
    var d = view[drag.i];
    setRowH(d, drag.base + dlt);
    var row = drag.el.parentNode && drag.el.parentNode.parentNode;
    if (row) {
      row.style.height = H[d] + "px";
      row.classList.toggle("wrap", !!wrapRow[d]);
      row.firstChild.style.lineHeight = Math.min(H[d], RH) + "px";
    }
    drawSel();
  });
  function endPointer() {
    pick = null;
    if (!drag) return;
    drag.el.classList.remove("drag");
    document.body.classList.remove("resizing", "col", "row");
    drag = null;
  }
  document.addEventListener("pointerup", endPointer);
  document.addEventListener("pointercancel", endPointer);
  sc.addEventListener("dblclick", function (e) {
    var t = e.target;
    if (t.classList.contains("cr")) {
      var c = Number(t.getAttribute("data-c"));
      W[c] = Math.max(MINW, Math.min(FITMAX, fitW(c, true))); applyW(c); drawSel();
    } else if (t.classList.contains("rr")) {
      var vi = Number(t.getAttribute("data-r")), d = view[vi];
      if (wrapRow[d]) { setRowH(d, RH); render(true); return; } // already expanded → back to one line
      // Measure the row with wrapping on and no fixed height, then pin it there.
      var row = gx.querySelector('.gr[data-r="' + vi + '"]'); if (!row) return;
      row.classList.add("wrap"); row.style.height = "auto";
      var h = RH;
      for (var i = 1; i < row.children.length; i++) { var cell = row.children[i]; cell.style.height = "auto"; h = Math.max(h, cell.scrollHeight + 1); cell.style.height = ""; }
      setRowH(d, Math.min(h, 600)); render(true);
    }
  });

  // ---- keyboard
  sc.addEventListener("keydown", function (e) {
    if (!NV) return;
    var mod = e.metaKey || e.ctrlKey, k = e.key;
    if (mod && (k === "a" || k === "A")) { e.preventDefault(); setSel({ ar: 0, ac: 0, fr: NV - 1, fc: NC - 1, mode: "all" }); return; }
    if (k === "Escape") { if (sel) selectCell(sel.ar, sel.ac); return; }
    if (!sel) {
      if (k.indexOf("Arrow") === 0 || k === "Tab" || k === "Enter") { e.preventDefault(); selectCell(0, 0); }
      return;
    }
    var page = Math.max(1, Math.floor((sc.clientHeight - HH) / RH) - 1);
    var extend = e.shiftKey && k !== "Tab" && k !== "Enter";
    var R = rng();
    // Shift moves the FOCUS corner; otherwise the active cell moves and the range collapses.
    var r = extend ? (sel.mode === "cells" || sel.mode === "rows" ? sel.fr : (sel.ar === R.r1 ? R.r2 : R.r1)) : sel.ar;
    var c = extend ? (sel.mode === "cells" || sel.mode === "cols" ? sel.fc : (sel.ac === R.c1 ? R.c2 : R.c1)) : sel.ac;
    if (k === "ArrowDown") r = mod ? NV - 1 : r + 1;
    else if (k === "ArrowUp") r = mod ? 0 : r - 1;
    else if (k === "ArrowRight") c = mod ? NC - 1 : c + 1;
    else if (k === "ArrowLeft") c = mod ? 0 : c - 1;
    else if (k === "Tab") c = e.shiftKey ? c - 1 : c + 1;
    else if (k === "Enter") r = e.shiftKey ? r - 1 : r + 1;
    else if (k === "PageDown") r += page;
    else if (k === "PageUp") r -= page;
    else if (k === "Home") { c = 0; if (mod) r = 0; }
    else if (k === "End") { c = NC - 1; if (mod) r = NV - 1; }
    else return;
    // Tab past the first/last column leaves the grid (keyboard users need a way out).
    if (k === "Tab" && clampC(c) === sel.ac) return;
    e.preventDefault();
    if (extend) extendTo(clampR(r), clampC(c)); else selectCell(clampR(r), clampC(c));
  });

  // Copy the selected range (Cmd/Ctrl+C) as TSV + an HTML table, so it pastes
  // into a spreadsheet as cells. A copy EVENT, not the async clipboard API: the
  // sandboxed frame has no clipboard-write permission, but a user-initiated copy
  // event may set data. Whole columns (or select-all) carry their header row.
  // Safari fires no copy event when nothing is selected, and the grid never holds
  // a text selection. So on Cmd/Ctrl+C, select a hidden textarea first: the
  // browser then runs its copy (firing the event below) and we refocus the grid.
  var clip = document.createElement("textarea");
  clip.setAttribute("aria-hidden", "true"); clip.tabIndex = -1;
  clip.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0";
  document.body.appendChild(clip);
  sc.addEventListener("keydown", function (e) {
    if (!(e.metaKey || e.ctrlKey) || (e.key !== "c" && e.key !== "C") || !sel || !NV) return;
    if (window.getSelection && String(window.getSelection())) return; // real text selected: native copy
    clip.value = " "; clip.focus({ preventScroll: true }); clip.select();
    setTimeout(function () { sc.focus({ preventScroll: true }); }, 0);
  });
  function tsvCell(v) { return /[\\t\\n\\r"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  document.addEventListener("copy", function (e) {
    var ae = document.activeElement, viaClip = ae === clip;
    if (ae && (ae.tagName === "INPUT" || ae === fxval)) return;
    var ts = !viaClip && window.getSelection && String(window.getSelection());
    if (ts || !sel || !NV || !e.clipboardData) return;
    var R = rng(), head = sel.mode === "cols" || sel.mode === "all";
    var lines = [], html = ["<table>"], c, line, cells;
    if (head) {
      line = []; cells = [];
      for (c = R.c1; c <= R.c2; c++) { line.push(tsvCell(cols[c])); cells.push("<th>" + esc(cols[c]) + "</th>"); }
      lines.push(line.join("\\t")); html.push("<tr>" + cells.join("") + "</tr>");
    }
    for (var vi = R.r1; vi <= R.r2; vi++) {
      line = []; cells = [];
      for (c = R.c1; c <= R.c2; c++) { var v = val(view[vi], c); line.push(tsvCell(v)); cells.push("<td>" + esc(v) + "</td>"); }
      lines.push(line.join("\\t")); html.push("<tr>" + cells.join("") + "</tr>");
    }
    html.push("</table>");
    e.clipboardData.setData("text/plain", lines.join("\\n"));
    e.clipboardData.setData("text/html", html.join(""));
    e.preventDefault();
    var n = (R.r2 - R.r1 + 1) * (R.c2 - R.c1 + 1);
    say(n === 1 ? "Copied" : "Copied " + fmtInt(n) + " cells");
  });

  // ---- sort + filter
  function recompute() {
    view = [];
    for (var d = 0; d < NR; d++) if (passes(d, -1)) view.push(d);
    if (sortCol >= 0) {
      var c = sortCol, keys = {};
      if (isNum[c]) view.forEach(function (d) { keys[d] = numOf(val(d, c)); });
      view.sort(function (a, b) {
        var x, y;
        if (isNum[c]) {
          x = keys[a]; y = keys[b];
          var xn = isNaN(x), yn = isNaN(y);
          if (xn || yn) return xn && yn ? a - b : xn ? 1 : -1; // blanks/text last, either direction
          return x === y ? a - b : (x < y ? -1 : 1) * sortDir;
        }
        x = val(a, c); y = val(b, c);
        if (x === "" || y === "") return x === y ? a - b : x === "" ? 1 : -1;
        var r = collator ? collator.compare(x, y) : (x < y ? -1 : x > y ? 1 : 0);
        return r === 0 ? a - b : r * sortDir;
      });
    }
    NV = view.length;
    virtual = NV > VIRTUAL_AT;
    rebuildTops();
    sel = null; winA = winB = -1; unflash();
    sc.scrollTop = 0;
    renderHead(); render(true); paintHeads(); showSel();
  }
  fxclr.addEventListener("click", function () { filt = {}; recompute(); });

  var menu = null, menuCol = -1;
  function closeMenu() {
    if (!menu) return;
    menu.remove(); menu = null;
    var b = gh.querySelector(".fb.open"); if (b) b.classList.remove("open");
    menuCol = -1;
  }
  document.addEventListener("pointerdown", function (e) {
    if (menu && !menu.contains(e.target) && !(e.target.closest && e.target.closest(".fb"))) closeMenu();
  }, true);
  function openMenu(c, btn) {
    closeMenu();
    menuCol = c; btn.classList.add("open");
    // Values as they'd appear with the OTHER columns' filters applied (Sheets
    // does the same), most common first within a sorted list.
    var counts = new Map();
    for (var d = 0; d < NR; d++) if (passes(d, c)) { var v = val(d, c); counts.set(v, (counts.get(v) || 0) + 1); }
    var items = Array.from(counts.keys());
    items.sort(function (a, b) {
      if (a === "" || b === "") return a === b ? 0 : a === "" ? 1 : -1;
      if (isNum[c]) { var x = numOf(a), y = numOf(b); if (!isNaN(x) && !isNaN(y) && x !== y) return x - y; }
      return collator ? collator.compare(a, b) : (a < b ? -1 : 1);
    });
    var hidden = new Set(filt[c] ? Array.from(filt[c]) : []);
    var asc = isNum[c] ? "Sort 1 \\u2192 9" : "Sort A \\u2192 Z", desc = isNum[c] ? "Sort 9 \\u2192 1" : "Sort Z \\u2192 A";
    menu = document.createElement("div"); menu.id = "gm";
    menu.innerHTML =
      '<button type="button" class="mi" data-a="asc">' + asc + "</button>" +
      '<button type="button" class="mi" data-a="desc">' + desc + "</button>" +
      (sortCol === c ? '<button type="button" class="mi" data-a="unsort">Clear sort</button>' : "") +
      '<hr><div class="mh">Filter by values</div>' +
      '<input type="search" placeholder="Search values" aria-label="Search values">' +
      '<div class="mb"><button type="button" data-a="all">Select all</button><button type="button" data-a="none">Clear</button><span class="cnt"></span></div>' +
      '<div class="fl"></div><div class="more"></div>' +
      '<div class="ft">' + (filt[c] ? '<button type="button" class="rs" data-a="reset">Reset</button>' : "") +
      '<button type="button" data-a="cancel">Cancel</button><button type="button" class="ok" data-a="ok">OK</button></div>';
    document.body.appendChild(menu);
    var q = menu.querySelector("input[type=search]"), fl = menu.querySelector(".fl"), more = menu.querySelector(".more"), cnt = menu.querySelector(".cnt");
    var shown = [];
    function matching() {
      var s = q.value.trim().toLowerCase();
      return s ? items.filter(function (v) { return v.toLowerCase().indexOf(s) >= 0; }) : items;
    }
    function list() {
      var m = matching(); shown = m.slice(0, LIST_CAP);
      fl.innerHTML = shown.map(function (v, i) {
        return '<label><input type="checkbox" data-i="' + i + '"' + (hidden.has(v) ? "" : " checked") + '><span title="' + esc(v) + '">' +
          (v === "" ? "(Blanks)" : esc(cellText(v))) + "</span><i>" + fmtInt(counts.get(v)) + "</i></label>";
      }).join("");
      more.textContent = m.length > LIST_CAP ? "Showing " + fmtInt(LIST_CAP) + " of " + fmtInt(m.length) + " \\u2014 search to narrow" : m.length ? "" : "No matching values";
      var on = 0; items.forEach(function (v) { if (!hidden.has(v)) on++; });
      cnt.textContent = fmtInt(on) + " of " + fmtInt(items.length);
    }
    function apply() {
      // Values hidden earlier that no longer appear (another column's filter
      // removed them) stay hidden: they're part of this column's filter.
      if (hidden.size) filt[c] = hidden; else delete filt[c];
      closeMenu(); recompute();
    }
    q.addEventListener("input", list);
    q.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); apply(); }
      else if (e.key === "Escape") { closeMenu(); sc.focus({ preventScroll: true }); }
    });
    fl.addEventListener("change", function (e) {
      var v = shown[Number(e.target.getAttribute("data-i"))];
      if (e.target.checked) hidden.delete(v); else hidden.add(v);
      list();
    });
    menu.addEventListener("click", function (e) {
      var a = e.target.getAttribute && e.target.getAttribute("data-a");
      if (!a) return;
      if (a === "asc" || a === "desc") { sortCol = c; sortDir = a === "asc" ? 1 : -1; closeMenu(); recompute(); }
      else if (a === "unsort") { sortCol = -1; closeMenu(); recompute(); }
      else if (a === "all") { matching().forEach(function (v) { hidden.delete(v); }); list(); }
      else if (a === "none") { matching().forEach(function (v) { hidden.add(v); }); list(); }
      else if (a === "reset") { delete filt[c]; closeMenu(); recompute(); }
      else if (a === "cancel") { closeMenu(); sc.focus({ preventScroll: true }); }
      else if (a === "ok") apply();
    });
    menu.addEventListener("keydown", function (e) { if (e.key === "Escape") { closeMenu(); sc.focus({ preventScroll: true }); } });
    list();
    // Place under the header cell, kept inside the frame.
    var hr = btn.parentNode.getBoundingClientRect();
    var left = Math.max(4, Math.min(hr.right - 260, window.innerWidth - 264));
    if (hr.right - 260 < hr.left) left = Math.max(4, Math.min(hr.left, window.innerWidth - 264));
    var topY = hr.bottom + 2;
    menu.style.left = left + "px"; menu.style.top = topY + "px";
    fl.style.maxHeight = Math.max(80, Math.min(260, window.innerHeight - topY - (menu.offsetHeight - fl.offsetHeight) - 8)) + "px";
    q.focus();
  }

  recompute();
})();`;
