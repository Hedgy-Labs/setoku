// SPDX-License-Identifier: Apache-2.0
/**
 * The spreadsheet grid for a shared tabular file. Reads like a Sheets tab:
 * cells truncate (never wrap), columns and rows resize by dragging their edges
 * (double-click an edge to fit), the header row and row numbers stay frozen, and
 * a formula bar shows the active cell in full. Each header's ▾ menu sorts and
 * filters by value; a range selects by drag, shift, a row number, a column
 * header, or Cmd/Ctrl+A, shows Sum/Avg/Count, and copies as TSV + HTML. A
 * filtered view downloads as CSV.
 *
 * Rows are virtualized past VIRTUAL_AT; below it every row is in the DOM so the
 * browser's own find (Cmd/Ctrl+F) sees the whole file. Selection and overlays
 * are in VIEW rows (the filtered + sorted order); row numbers are the file's own.
 * The pure logic (view, stats, serializers) lives in ./model.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { computeView, filteredName, numericColumns, rangeStats, rangeToClipboard, valueCounts, viewToCsv, type Range, type Sort } from "./model";
import { GRID_CSS } from "./styles";

const RH = 27; // default row height; also the minimum (rows grow, never shrink)
const HH = 30; // header height
const MINW = 40;
const MAXW = 320; // initial width cap (a long note doesn't make its column huge)
const FITMAX = 900; // double-click fit cap
const VIRTUAL_AT = 1500;
const OVERSCAN = 12;
const LIST_CAP = 500; // values shown at once in a filter menu
const STATS_CAP = 400_000; // cells summed for Sum/Avg/Count

type Mode = "cells" | "rows" | "cols" | "all";
/** Anchor (the active cell) + focus corner, in view rows. */
interface Sel {
  ar: number;
  ac: number;
  fr: number;
  fc: number;
  mode: Mode;
}

function rangeOf(s: Sel, NV: number, NC: number): Range {
  let r1 = Math.min(s.ar, s.fr);
  let r2 = Math.max(s.ar, s.fr);
  let c1 = Math.min(s.ac, s.fc);
  let c2 = Math.max(s.ac, s.fc);
  if (s.mode === "rows" || s.mode === "all") [c1, c2] = [0, NC - 1];
  if (s.mode === "cols" || s.mode === "all") [r1, r2] = [0, NV - 1];
  return { r1, r2, c1, c2 };
}

const fmtInt = (n: number): string => n.toLocaleString();
const fmtNum = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const oneLine = (s: string): string => s.replace(/\s+/g, " "); // what nowrap shows

type Measure = (s: string, bold: boolean) => number;
function makeMeasure(font: string): Measure {
  // Canvas, not layout: fitting a column over thousands of rows stays cheap.
  const ctx = document.createElement("canvas").getContext("2d");
  return (s, bold) => {
    if (!ctx) return s.length * 7;
    ctx.font = `${bold ? "600 " : ""}13px ${font}`;
    return ctx.measureText(s).width;
  };
}
/** A column's width: the header plus most of the content (90th percentile of a
 *  sample) — or, for a double-click fit, the widest sampled value. */
function fitWidth(m: Measure, columns: string[], rows: string[][], c: number, all: boolean): number {
  const lim = Math.min(rows.length, all ? 5000 : 300);
  const ws: number[] = [];
  for (let d = 0; d < lim; d++) ws.push(m(oneLine(rows[d][c] ?? ""), false));
  ws.sort((a, b) => a - b);
  const body = ws.length ? (all ? ws[ws.length - 1] : ws[Math.floor((ws.length - 1) * 0.9)]) : 0;
  return Math.ceil(Math.max(m(columns[c], true) + 52, body + 18)); // 52: padding, sort arrow, menu button
}

const Row = memo(function Row(props: { vi: number; d: number; row: string[]; isNum: boolean[]; h: number; hl: boolean }) {
  const { vi, d, row, isNum, h, hl } = props;
  return (
    <div className={h > RH + 4 ? "fg-r wrap" : "fg-r"} data-r={vi} style={{ height: h }}>
      <div className={hl ? "fg-n hl" : "fg-n"} style={{ lineHeight: `${Math.min(h, RH)}px` }}>
        {d + 1}
        <div className="fg-rr" data-r={vi} />
      </div>
      {row.map((v, c) => (
        <div key={c} className={isNum[c] ? `fg-c k${c} num` : `fg-c k${c}`}>
          {v}
        </div>
      ))}
    </div>
  );
});

const IconMenu = (): React.ReactElement => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 6l4 4 4-4" />
  </svg>
);
const IconFunnel = (): React.ReactElement => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M2 3h12l-4.6 5.4V13l-2.8 1.2V8.4z" />
  </svg>
);

export function Grid({ columns, rows, name }: { columns: string[]; rows: string[][]; name: string }): React.ReactElement {
  const NC = columns.length;
  const NR = rows.length;
  const rootRef = useRef<HTMLDivElement>(null);
  const scRef = useRef<HTMLDivElement>(null);
  const gxRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLTextAreaElement>(null);
  const measureRef = useRef<Measure | null>(null);

  const isNum = useMemo(() => numericColumns(NC, rows), [NC, rows]);
  const [widths, setWidths] = useState<number[] | null>(null);
  useLayoutEffect(() => {
    const m = makeMeasure(getComputedStyle(rootRef.current!).fontFamily || "system-ui");
    measureRef.current = m;
    setWidths(columns.map((_, c) => Math.max(MINW, Math.min(MAXW, fitWidth(m, columns, rows, c, false)))));
  }, [columns, rows]);
  const GW = Math.max(36, Math.ceil(fmtInt(NR).length * 6.5) + 16); // gutter
  const lefts = useMemo(() => {
    const l = [GW];
    for (const w of widths ?? []) l.push(l[l.length - 1] + w);
    return l;
  }, [widths, GW]);
  const total = lefts[lefts.length - 1];

  // ---- the view: filter, then sort
  const [filters, setFilters] = useState<Map<number, Set<string>>>(() => new Map());
  const [sort, setSort] = useState<Sort | null>(null);
  const view = useMemo(() => computeView(rows, filters, sort, isNum), [rows, filters, sort, isNum]);
  const NV = view.length;

  // ---- row heights: per DATA row (a height follows its record through a sort)
  const [heights, setHeights] = useState<Map<number, number>>(() => new Map());
  const tops = useMemo(() => {
    if (!heights.size) return null;
    const t = new Float64Array(NV + 1);
    for (let i = 0; i < NV; i++) t[i + 1] = t[i] + (heights.get(view[i]) ?? RH);
    return t;
  }, [view, heights, NV]);
  const rowTop = (vi: number): number => (tops ? tops[vi] : vi * RH);
  const rowH = (vi: number): number => heights.get(view[vi]) ?? RH;
  const rowAt = (y: number): number => {
    if (!NV) return 0;
    if (!tops) return Math.max(0, Math.min(NV - 1, Math.floor(y / RH)));
    let lo = 0;
    let hi = NV - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tops[mid + 1] <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const colAt = (x: number): number => {
    for (let c = 0; c < NC; c++) if (x < lefts[c + 1]) return c;
    return NC - 1;
  };

  // ---- virtual window
  const virtual = NV > VIRTUAL_AT;
  const [vp, setVp] = useState({ top: 0, h: 900 });
  let a = 0;
  let b = NV - 1;
  if (virtual) {
    const y0 = Math.max(0, vp.top - HH);
    a = Math.max(0, rowAt(y0) - OVERSCAN);
    b = Math.min(NV - 1, rowAt(y0 + vp.h) + OVERSCAN);
  }

  // ---- selection, menu, status flash
  const [sel, setSel] = useState<Sel | null>(null);
  const R = sel && NV ? rangeOf(sel, NV, NC) : null;
  // An open column menu, with its value list computed once at open.
  const [menu, setMenu] = useState<{ col: number; rect: DOMRect; values: string[]; counts: Map<string, number> } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const flashT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = (msg: string | null): void => {
    if (flashT.current) clearTimeout(flashT.current);
    setFlash(msg);
    if (msg) flashT.current = setTimeout(() => setFlash(null), 1600);
  };

  // Document-level listeners (drag, copy) read the LATEST render through this.
  const S = useRef({ view, NV, sel, R, heights, widths, lefts, rowTop, rowH, rowAt, colAt });
  S.current = { view, NV, sel, R, heights, widths, lefts, rowTop, rowH, rowAt, colAt };

  const clampR = (r: number): number => Math.max(0, Math.min(S.current.NV - 1, r));
  const clampC = (c: number): number => Math.max(0, Math.min(NC - 1, c));
  function reveal(r: number | null, c: number | null): void {
    const sc = scRef.current;
    if (!sc) return;
    const s = S.current;
    if (r != null) {
      const yT = s.rowTop(r);
      const yB = yT + s.rowH(r);
      const viewH = sc.clientHeight - HH;
      if (yT < sc.scrollTop) sc.scrollTop = yT;
      else if (yB > sc.scrollTop + viewH) sc.scrollTop = yB - viewH;
    }
    if (c != null) {
      const xL = s.lefts[c];
      const xR = s.lefts[c + 1];
      if (xL < sc.scrollLeft + GW) sc.scrollLeft = xL - GW;
      else if (xR > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = Math.min(xL - GW, xR - sc.clientWidth);
    }
  }
  function select(next: Sel | null, revealR: number | null = null, revealC: number | null = null): void {
    if (next) {
      next = { ...next, ar: clampR(next.ar), fr: clampR(next.fr), ac: clampC(next.ac), fc: clampC(next.fc) };
      reveal(revealR == null ? null : clampR(revealR), revealC == null ? null : clampC(revealC));
    }
    say(null); // a new selection replaces a "Copied" note
    setSel(next);
  }
  const selectCell = (r: number, c: number): void => select({ ar: r, ac: c, fr: r, fc: c, mode: "cells" }, r, c);
  const selectAll = (): void => select({ ar: 0, ac: 0, fr: S.current.NV - 1, fc: NC - 1, mode: "all" });
  /** Keep the anchor, move the focus corner to (r, c); a whole-row/column pick
   *  becomes a plain cell range. */
  function extendTo(r: number, c: number): void {
    const s = S.current.sel;
    if (!s) return selectCell(r, c);
    select({ ar: s.ar, ac: s.ac, fr: r, fc: c, mode: "cells" }, r, c);
  }
  /** The focus corner as plain cells (for shift+arrow from a whole-row/col pick). */
  function focusCorner(): { r: number; c: number } {
    const s = S.current.sel!;
    const Rg = S.current.R!;
    return {
      r: s.mode === "cells" || s.mode === "rows" ? s.fr : s.ar === Rg.r1 ? Rg.r2 : Rg.r1,
      c: s.mode === "cells" || s.mode === "cols" ? s.fc : s.ac === Rg.c1 ? Rg.c2 : Rg.c1,
    };
  }

  // A new view (sort/filter) starts from the top with nothing selected.
  function changeView(fn: () => void): void {
    fn();
    setSel(null);
    setMenu(null);
    say(null);
    const sc = scRef.current;
    if (sc) {
      sc.scrollTop = 0;
      // Record the jump ourselves: onScroll ignores a non-virtual view, so a
      // filter that drops below VIRTUAL_AT and back would otherwise window the
      // rows around a stale offset (a blank viewport until the next scroll).
      setVp({ top: 0, h: sc.clientHeight });
    }
  }

  // ---- pointer: resize handles, header menus, range selection
  const resize = useRef<{ col: boolean; i: number; start: number; base: number; el: HTMLElement } | null>(null);
  const pick = useRef<{ mode: Mode; x: number; y: number; moved: boolean } | null>(null);
  function hit(cx: number, cy: number): { r: number; c: number } {
    const sc = scRef.current!;
    const rect = sc.getBoundingClientRect();
    return { r: S.current.rowAt(cy - rect.top + sc.scrollTop - HH), c: S.current.colAt(cx - rect.left + sc.scrollLeft) };
  }
  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.classList.contains("fg-cr") || t.classList.contains("fg-rr")) {
      const isCol = t.classList.contains("fg-cr");
      e.preventDefault();
      const i = Number(t.getAttribute(isCol ? "data-c" : "data-r"));
      resize.current = { col: isCol, i, start: isCol ? e.clientX : e.clientY, base: isCol ? S.current.widths![i] : S.current.rowH(i), el: t };
      t.classList.add("drag");
      rootRef.current?.classList.add("resizing", isCol ? "col" : "row");
      try {
        t.setPointerCapture(e.pointerId);
      } catch {
        /* old browser */
      }
      return;
    }
    const fb = t.closest(".fg-fb");
    if (fb) {
      e.preventDefault();
      const c = Number(fb.getAttribute("data-c"));
      setMenu(menu?.col === c ? null : { col: c, rect: (fb.parentNode as HTMLElement).getBoundingClientRect(), ...valueCounts(rows, c, filters, isNum[c]) });
      return;
    }
    // Only a cell, header, or row number starts a selection: a press on the
    // scroller's own scrollbar (or the empty area past the grid) targets it.
    if (!t.closest(".fg-h .fg-c, .fg-h .fg-n, .fg-gx .fg-c, .fg-gx .fg-n")) return;
    const touch = e.pointerType === "touch";
    if (!touch) e.preventDefault(); // no text-selection drag; we take focus ourselves
    scRef.current?.focus({ preventScroll: true });
    if (!S.current.NV) return;
    const inHead = !!t.closest(".fg-h");
    const gutter = !!t.closest(".fg-n");
    const h = hit(e.clientX, e.clientY);
    const s = S.current.sel;
    const ext = e.shiftKey && s;
    let mode: Mode = "cells";
    if (inHead && gutter) return selectAll();
    if (inHead) {
      mode = "cols";
      select(ext ? { ...s!, fc: h.c, mode } : { ar: 0, ac: h.c, fr: 0, fc: h.c, mode }, null, h.c);
    } else if (gutter) {
      mode = "rows";
      select(ext ? { ...s!, fr: h.r, mode } : { ar: h.r, ac: 0, fr: h.r, fc: 0, mode }, h.r, null);
    } else if (ext) extendTo(h.r, h.c);
    else selectCell(h.r, h.c);
    pick.current = touch ? null : { mode, x: e.clientX, y: e.clientY, moved: false };
  }
  useEffect(() => {
    function dragTo(cx: number, cy: number): void {
      const p = pick.current;
      const s = S.current.sel;
      if (!p || !s) return;
      const h = hit(cx, cy);
      const next = { ...s, mode: p.mode };
      if (p.mode !== "rows") next.fc = h.c;
      if (p.mode !== "cols") next.fr = h.r;
      if (next.fr !== s.fr || next.fc !== s.fc) setSel(next);
    }
    // Auto-scroll while a range drag sits past the scroller's edge.
    function autoScroll(): void {
      const p = pick.current;
      const sc = scRef.current;
      if (!p || !sc) return;
      const rect = sc.getBoundingClientRect();
      let dx = 0;
      let dy = 0;
      if (p.y < rect.top + HH) dy = -Math.min(40, rect.top + HH - p.y);
      else if (p.y > rect.bottom) dy = Math.min(40, p.y - rect.bottom);
      if (p.x < rect.left + GW) dx = -Math.min(40, rect.left + GW - p.x);
      else if (p.x > rect.right) dx = Math.min(40, p.x - rect.right);
      if (p.mode === "cols") dy = 0;
      if (p.mode === "rows") dx = 0;
      if (dx || dy) {
        sc.scrollTop += dy;
        sc.scrollLeft += dx;
        dragTo(p.x, p.y);
      }
      requestAnimationFrame(autoScroll);
    }
    function onMove(e: PointerEvent): void {
      const p = pick.current;
      if (p) {
        const first = !p.moved;
        p.x = e.clientX;
        p.y = e.clientY;
        p.moved = true;
        dragTo(e.clientX, e.clientY);
        if (first) requestAnimationFrame(autoScroll);
        return;
      }
      const r = resize.current;
      if (!r) return;
      const dl = (r.col ? e.clientX : e.clientY) - r.start;
      if (!dl) return; // a still pointer (half of a double-click) changes nothing
      if (r.col) {
        setWidths((w) => {
          const n = w!.slice();
          n[r.i] = Math.max(MINW, Math.round(r.base + dl));
          return n;
        });
      } else {
        const d = S.current.view[r.i];
        setHeights((m) => new Map(m).set(d, Math.max(RH, Math.round(r.base + dl))));
      }
    }
    function onUp(): void {
      pick.current = null;
      const r = resize.current;
      if (!r) return;
      r.el.classList.remove("drag");
      rootRef.current?.classList.remove("resizing", "col", "row");
      resize.current = null;
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onDoubleClick(e: React.MouseEvent<HTMLDivElement>): void {
    const t = e.target as HTMLElement;
    if (t.classList.contains("fg-cr")) {
      const c = Number(t.getAttribute("data-c"));
      const w = Math.max(MINW, Math.min(FITMAX, fitWidth(measureRef.current!, columns, rows, c, true)));
      setWidths((ws) => ws!.map((x, i) => (i === c ? w : x)));
    } else if (t.classList.contains("fg-rr")) {
      const vi = Number(t.getAttribute("data-r"));
      const d = view[vi];
      if ((heights.get(d) ?? RH) > RH + 4) {
        // already expanded → back to one line
        setHeights((m) => {
          const n = new Map(m);
          n.delete(d);
          return n;
        });
        return;
      }
      // Measure the row with wrapping on and no fixed height, then pin it there.
      const row = gxRef.current?.querySelector<HTMLElement>(`.fg-r[data-r="${vi}"]`);
      if (!row) return;
      const prev = row.style.height;
      row.classList.add("wrap");
      row.style.height = "auto";
      let h = RH;
      for (const cell of Array.from(row.children).slice(1) as HTMLElement[]) {
        cell.style.height = "auto";
        h = Math.max(h, cell.scrollHeight + 1);
        cell.style.height = "";
      }
      row.classList.remove("wrap");
      row.style.height = prev;
      if (h > RH + 4) setHeights((m) => new Map(m).set(d, Math.min(h, 600)));
    }
  }

  // ---- keyboard
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.target !== scRef.current || !NV) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key;
    if (mod && (k === "a" || k === "A")) {
      e.preventDefault();
      return selectAll();
    }
    if (mod && (k === "c" || k === "C")) {
      // Safari fires no copy event when nothing is selected, and the grid never
      // holds a text selection: select a hidden textarea so the browser's copy
      // runs (the copy listener below fills it), then hand focus back.
      if (!sel || String(window.getSelection?.() ?? "")) return;
      const clip = clipRef.current!;
      clip.value = " ";
      clip.focus({ preventScroll: true });
      clip.select();
      setTimeout(() => scRef.current?.focus({ preventScroll: true }), 0);
      return;
    }
    if (k === "Escape") {
      if (menu) setMenu(null);
      else if (sel) selectCell(sel.ar, sel.ac);
      return;
    }
    if (!sel) {
      if (k.startsWith("Arrow") || k === "Tab" || k === "Enter") {
        e.preventDefault();
        selectCell(0, 0);
      }
      return;
    }
    const page = Math.max(1, Math.floor((scRef.current!.clientHeight - HH) / RH) - 1);
    const extend = e.shiftKey && k !== "Tab" && k !== "Enter";
    let { r, c } = extend ? focusCorner() : { r: sel.ar, c: sel.ac };
    if (k === "ArrowDown") r = mod ? NV - 1 : r + 1;
    else if (k === "ArrowUp") r = mod ? 0 : r - 1;
    else if (k === "ArrowRight") c = mod ? NC - 1 : c + 1;
    else if (k === "ArrowLeft") c = mod ? 0 : c - 1;
    else if (k === "Tab") c = e.shiftKey ? c - 1 : c + 1;
    else if (k === "Enter") r = e.shiftKey ? r - 1 : r + 1;
    else if (k === "PageDown") r += page;
    else if (k === "PageUp") r -= page;
    else if (k === "Home") {
      c = 0;
      if (mod) r = 0;
    } else if (k === "End") {
      c = NC - 1;
      if (mod) r = NV - 1;
    } else return;
    // Tab past the first/last column leaves the grid (keyboard users need a way out).
    if (k === "Tab" && clampC(c) === sel.ac) return;
    e.preventDefault();
    if (extend) extendTo(clampR(r), clampC(c));
    else selectCell(clampR(r), clampC(c));
  }

  // ---- copy: the range as TSV + an HTML table (pastes into a sheet as cells);
  // whole columns (or select-all) carry their header row.
  useEffect(() => {
    function onCopy(e: ClipboardEvent): void {
      const ae = document.activeElement;
      const viaClip = ae === clipRef.current;
      if (ae !== scRef.current && !viaClip) return;
      if (!viaClip && String(window.getSelection?.() ?? "")) return;
      const { sel: s, R: Rg, view: v } = S.current;
      if (!s || !Rg || !e.clipboardData) return;
      const out = rangeToClipboard(columns, rows, v, Rg, s.mode === "cols" || s.mode === "all");
      e.clipboardData.setData("text/plain", out.text);
      e.clipboardData.setData("text/html", out.html);
      e.preventDefault();
      const n = (Rg.r2 - Rg.r1 + 1) * (Rg.c2 - Rg.c1 + 1);
      say(n === 1 ? "Copied" : `Copied ${fmtInt(n)} cells`);
    }
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, rows]);

  // ---- scroll/resize: the virtual window follows; an open menu closes
  const raf = useRef(0);
  function onScroll(): void {
    if (menu) setMenu(null);
    if (!virtual || raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const sc = scRef.current;
      if (sc) setVp({ top: sc.scrollTop, h: sc.clientHeight });
    });
  }
  useEffect(() => {
    const onResize = (): void => {
      setMenu(null);
      const sc = scRef.current;
      if (sc) setVp({ top: sc.scrollTop, h: sc.clientHeight });
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function downloadView(): void {
    const blob = new Blob([viewToCsv(columns, rows, view)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filteredName(name);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  // ---- render
  const colCss = useMemo(() => columns.map((_, c) => `.fg .k${c}{width:var(--w${c})}`).join(""), [columns]);
  const rootStyle = useMemo(() => {
    const st: Record<string, string> = { "--gw": `${GW}px` };
    (widths ?? []).forEach((w, c) => (st[`--w${c}`] = `${w}px`));
    return st as CSSProperties;
  }, [widths, GW]);

  let status: string;
  if (flash) status = flash;
  else if (R && (R.r1 !== R.r2 || R.c1 !== R.c2)) {
    const cells = (R.r2 - R.r1 + 1) * (R.c2 - R.c1 + 1);
    if (cells > STATS_CAP) status = `${fmtInt(R.r2 - R.r1 + 1)} rows × ${fmtInt(R.c2 - R.c1 + 1)} columns selected`;
    else {
      const st = rangeStats(rows, view, R);
      status = (st.nums ? `Sum ${fmtNum(st.sum)} · Avg ${fmtNum(st.sum / st.nums)} · ` : "") + `Count ${fmtInt(st.count)}`;
    }
  } else status = `${NV === NR ? fmtInt(NR) : `${fmtInt(NV)} of ${fmtInt(NR)}`} rows · ${fmtInt(NC)} columns`;

  const active = sel && NV ? { d: view[sel.ar], c: sel.ac } : null;
  const activeVal = active ? (rows[active.d][active.c] ?? "") : "";
  const y0 = NV ? rowTop(a) : 0;
  const box = (r1: number, r2: number, c1: number, c2: number): CSSProperties => ({
    top: rowTop(r1) - y0,
    height: rowTop(r2 + 1) - rowTop(r1),
    left: lefts[c1],
    width: lefts[c2 + 1] - lefts[c1],
  });

  const body: React.ReactElement[] = [];
  if (widths) for (let vi = a; vi <= b; vi++) body.push(<Row key={view[vi]} vi={vi} d={view[vi]} row={rows[view[vi]]} isNum={isNum} h={rowH(vi)} hl={!!R && vi >= R.r1 && vi <= R.r2} />);

  return (
    <div className="fg" ref={rootRef} style={rootStyle}>
      <style>{GRID_CSS + colCss}</style>
      <div className="fg-fx">
        {active ? (
          <div className="fg-ref">
            <span>Row {fmtInt(active.d + 1)}</span>
            <span>·</span>
            <b title={columns[active.c]}>{columns[active.c]}</b>
          </div>
        ) : null}
        <div className={active && activeVal ? "fg-val" : "fg-val hint"}>{active ? activeVal || "(empty)" : "Select a cell to see everything in it."}</div>
        <div className="fg-st">
          {filters.size ? (
            <>
              <button type="button" className="fg-btn" onClick={downloadView} title="Download the filtered rows as CSV">
                Download {fmtInt(NV)} rows
              </button>
              <button type="button" className="fg-btn" onClick={() => changeView(() => setFilters(new Map()))}>
                Clear filters
              </button>
            </>
          ) : null}
          <span className="fg-count">{status}</span>
        </div>
      </div>
      <div className="fg-sc" ref={scRef} tabIndex={0} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} onKeyDown={onKeyDown} onScroll={onScroll}>
        {widths ? (
          <>
            <div className="fg-r fg-h" style={{ width: total }}>
              <div className="fg-n" title="Select all" />
              {columns.map((col, c) => {
                const filtered = filters.has(c);
                const sorted = sort?.col === c;
                return (
                  <div key={c} className={`fg-c k${c}${isNum[c] ? " num" : ""}${R && c >= R.c1 && c <= R.c2 ? " hl" : ""}`}>
                    <span className="fg-hn" title={col}>
                      {col}
                    </span>
                    {sorted ? <span className="fg-si">{sort!.dir > 0 ? "↑" : "↓"}</span> : null}
                    <button
                      type="button"
                      className={`fg-fb${filtered || sorted ? " act" : ""}${menu?.col === c ? " open" : ""}`}
                      data-c={c}
                      title="Sort & filter"
                      aria-label={`Sort and filter ${col}`}
                    >
                      {filtered ? <IconFunnel /> : <IconMenu />}
                    </button>
                    <div className="fg-cr" data-c={c} />
                  </div>
                );
              })}
            </div>
            <div style={{ position: "relative", width: total, height: NV ? rowTop(NV) : undefined }}>
              {NV ? (
                <div className="fg-gw" style={{ transform: `translateY(${y0}px)` }}>
                  <div className="fg-gx" ref={gxRef}>
                    {body}
                  </div>
                  {R && (R.r1 !== R.r2 || R.c1 !== R.c2) ? <div className="fg-sel" style={box(R.r1, R.r2, R.c1, R.c2)} /> : null}
                  {sel ? <div className="fg-act" style={box(sel.ar, sel.ar, sel.ac, sel.ac)} /> : null}
                </div>
              ) : (
                <div className="fg-empty">{NR ? "No rows match the current filters." : "This file has no rows."}</div>
              )}
            </div>
          </>
        ) : null}
      </div>
      <textarea ref={clipRef} className="fg-clip" aria-hidden="true" tabIndex={-1} readOnly />
      {menu ? (
        <ColumnMenu
          key={menu.col}
          rect={menu.rect}
          isNum={isNum[menu.col]}
          values={menu.values}
          counts={menu.counts}
          hidden={filters.get(menu.col)}
          sorted={sort?.col === menu.col}
          onSort={(dir) => changeView(() => setSort(dir ? { col: menu.col, dir } : null))}
          onApply={(hidden) =>
            changeView(() =>
              setFilters((f) => {
                const n = new Map(f);
                if (hidden && hidden.size) n.set(menu.col, hidden);
                else n.delete(menu.col);
                return n;
              }),
            )
          }
          onClose={() => {
            setMenu(null);
            scRef.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
    </div>
  );
}

/** A column's sort + filter-by-values menu, anchored under its header cell. */
function ColumnMenu(props: {
  rect: DOMRect;
  isNum: boolean;
  values: string[];
  counts: Map<string, number>;
  hidden: ReadonlySet<string> | undefined;
  sorted: boolean;
  onSort: (dir: 1 | -1 | 0) => void;
  onApply: (hidden: Set<string> | null) => void;
  onClose: () => void;
}): React.ReactElement {
  const { rect, isNum, values, counts, sorted, onSort, onApply, onClose } = props;
  // Values hidden earlier that no longer appear (another column's filter removed
  // them) stay hidden: they're still part of this column's filter.
  const [hidden, setHidden] = useState(() => new Set(props.hidden ?? []));
  const [q, setQ] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const qRef = useRef<HTMLInputElement>(null);
  const matching = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? values.filter((v) => v.toLowerCase().includes(s)) : values;
  }, [q, values]);
  const shown = matching.slice(0, LIST_CAP);
  const on = values.reduce((n, v) => n + (hidden.has(v) ? 0 : 1), 0);

  // Place under the header cell, right-aligned to it, kept inside the viewport;
  // the value list takes whatever height is left.
  useLayoutEffect(() => {
    const m = menuRef.current!;
    const list = listRef.current!;
    let left = rect.right - 260;
    if (left < rect.left) left = rect.left;
    left = Math.max(4, Math.min(left, window.innerWidth - 264));
    const top = rect.bottom + 2;
    m.style.left = `${left}px`;
    m.style.top = `${top}px`;
    const chrome = m.offsetHeight - list.offsetHeight;
    list.style.maxHeight = `${Math.max(80, Math.min(260, window.innerHeight - top - chrome - 8))}px`;
    qRef.current?.focus();
  }, [rect]);
  // Close on a press outside (the header's own ▾ toggles it instead).
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const t = e.target as HTMLElement;
      if (!menuRef.current?.contains(t) && !t.closest?.(".fg-fb")) onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  const apply = (): void => onApply(hidden.size ? hidden : null);
  const toggleAll = (show: boolean): void =>
    setHidden((h) => {
      const n = new Set(h);
      for (const v of matching) {
        if (show) n.delete(v);
        else n.add(v);
      }
      return n;
    });

  return (
    <div
      className="fg-menu"
      ref={menuRef}
      role="dialog"
      aria-label="Sort and filter"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <button type="button" className="mi" onClick={() => onSort(1)}>
        {isNum ? "Sort 1 → 9" : "Sort A → Z"}
      </button>
      <button type="button" className="mi" onClick={() => onSort(-1)}>
        {isNum ? "Sort 9 → 1" : "Sort Z → A"}
      </button>
      {sorted ? (
        <button type="button" className="mi" onClick={() => onSort(0)}>
          Clear sort
        </button>
      ) : null}
      <hr />
      <div className="mh">Filter by values</div>
      <input
        ref={qRef}
        type="search"
        placeholder="Search values"
        aria-label="Search values"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            apply();
          }
        }}
      />
      <div className="mb">
        <button type="button" onClick={() => toggleAll(true)}>
          Select all
        </button>
        <button type="button" onClick={() => toggleAll(false)}>
          Clear
        </button>
        <span>
          {fmtInt(on)} of {fmtInt(values.length)}
        </span>
      </div>
      <div className="fl" ref={listRef}>
        {shown.map((v) => (
          <label key={v}>
            <input
              type="checkbox"
              checked={!hidden.has(v)}
              onChange={(e) =>
                setHidden((h) => {
                  const n = new Set(h);
                  if (e.target.checked) n.delete(v);
                  else n.add(v);
                  return n;
                })
              }
            />
            <span title={v}>{v === "" ? "(Blanks)" : oneLine(v)}</span>
            <i>{fmtInt(counts.get(v) ?? 0)}</i>
          </label>
        ))}
      </div>
      <div className="more">
        {matching.length > LIST_CAP ? `Showing ${fmtInt(LIST_CAP)} of ${fmtInt(matching.length)}, search to narrow` : matching.length ? "" : "No matching values"}
      </div>
      <div className="ft">
        {props.hidden ? (
          <button type="button" className="rs" onClick={() => onApply(null)}>
            Reset
          </button>
        ) : null}
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="ok" onClick={apply}>
          OK
        </button>
      </div>
    </div>
  );
}
