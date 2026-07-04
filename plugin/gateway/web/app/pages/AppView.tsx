// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { useApi } from "../hooks";
import { useAuth } from "../auth";
import { Loading, ErrorMsg } from "../components/Page";
import { toast } from "../components/Toast";
import { Badge } from "../components/Badge";
import { Menu, MenuItem } from "../components/Menu";
import { Confirm } from "../components/Confirm";
import { appShareUrl, relTime } from "../format";
import type { AppData, AppParam, PanelProvenance } from "../types";

/** The per-panel numbers the frame echoes up for the variant it rendered — the
 *  param-DEPENDENT half of provenance (the SQL/description come from metadata).
 *  A subset of PanelProvenance so the two can't drift on these fields. */
type LivePanel = Pick<PanelProvenance, "rowCount" | "computedAt" | "error" | "refreshError">;

/** A refresh interval as a compact label: 30s · 5m · 1h (rolls up the units). */
function fmtInterval(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

/** Fallback heading when a panel has no title — turn the slug into words. */
function humanizeKey(k: string): string {
  return k.replace(/[_-]+/g, " ").trim();
}

/**
 * Render one app. The agent-authored template + injected live data is
 * served by /admin/frame/<id> and shown in a sandboxed iframe — that endpoint
 * carries the strict no-network CSP, so the template can't reach the admin
 * cookie/API or phone home. The provenance drawer (how each number is computed)
 * is rendered HERE, in trusted chrome OUTSIDE the sandbox, so the template can't
 * spoof or hide it.
 */
export function AppView() {
  const { id = "" } = useParams();
  const { me } = useAuth();
  const navigate = useNavigate();
  const isAdmin = me?.role === "admin";
  // app metadata + per-panel SQL/description (param-INDEPENDENT). Fetched once per
  // id; the LIVE per-variant numbers (row count / freshness) come from the frame's
  // own echo below — not a second server render — so the drawer can't disagree with
  // what the iframe shows.
  const { data, loading, error, reload } = useApi<AppData>(() => api.appData(id), [id]);
  // The calc drawer toggles in/out; collapsed lets the iframe take full height.
  const [showCalc, setShowCalc] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  // null = not editing the title; a string = the in-progress new title.
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const cancelRename = useRef(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // SENT param values — these drive the iframe src. Updated ONLY by a user control
  // change, so the src changes solely via reloadFrame and a one-shot `force` can't
  // linger into an unintended re-navigation.
  const [paramVals, setParamVals] = useState<Record<string, string>>({});
  // DISPLAY overlay — the resolved values the server echoed back, shown in the
  // controls (a rejected value snaps to the default) WITHOUT touching the sent
  // values or the src. Decoupling display from src is what stops an echo from
  // silently re-navigating the frame.
  const [echoed, setEchoed] = useState<Record<string, string>>({});
  // Params the USER explicitly changed — drives what's on the wire.
  const touched = useRef<Set<string>>(new Set());
  // iframe reload control. `n` is the cache-busting nonce AND the echo-correlation
  // token; `force` is a ONE-SHOT cache bypass consumed by exactly the load it's set
  // for. `nonceRef` mirrors `n` SYNCHRONOUSLY so callbacks can read/predict it
  // without waiting for a render.
  const [frame, setFrame] = useState<{ n: number; force: boolean }>({ n: 0, force: false });
  const nonceRef = useRef(0);
  // The iframe REMOUNTS on every reload (key={frame.n}), so a param change shows
  // a blank frame until the new render lands — this drives the overlay loader.
  // Cleared by the iframe's load event; the overlay's CSS delay keeps a fast
  // cached load from flashing it.
  const [frameLoading, setFrameLoading] = useState(false);
  // Per-panel provenance ECHOED UP by the frame for the variant it actually rendered.
  const [framePanels, setFramePanels] = useState<{ t: string; panels: Record<string, LivePanel> } | null>(null);
  const framePanelsRef = useRef(framePanels);
  framePanelsRef.current = framePanels;
  const [frameErr, setFrameErr] = useState(false); // frame load failed (no echo)
  const lastRefresh = useRef(0); // debounce for the manual Refresh button
  // Live format for the watchdog's fire-time decision (see onFrameLoad).
  const formatRef = useRef<string | undefined>(undefined);
  const echoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearEchoTimer = (): void => {
    if (echoTimer.current) {
      clearTimeout(echoTimer.current);
      echoTimer.current = null;
    }
  };

  // Reload the frame. clearLive=true (the VARIANT changed) drops the old numbers so
  // the drawer says "updating…" instead of showing a different variant's numbers;
  // false (a same-variant refresh) keeps them until the new echo so the stamp/drawer
  // don't flicker every auto-refresh tick. Always clears a pending watchdog so a
  // superseded frame's timer can't fire a false error over the new load.
  const reloadFrame = useCallback((opts: { force?: boolean; clearLive?: boolean } = {}) => {
    if (opts.clearLive) setFramePanels(null);
    setFrameErr(false);
    setFrameLoading(true);
    clearEchoTimer();
    nonceRef.current += 1;
    setFrame({ n: nonceRef.current, force: !!opts.force });
  }, []);

  // Reset per-app state on navigation (one AppView instance is reused across
  // /admin/p/:id). reloadFrame bumps the nonce so a late echo from the PREVIOUS
  // app's frame can't match the new one, and clears any lingering force.
  useEffect(() => {
    touched.current = new Set();
    lastRefresh.current = 0; // a fresh app's first Refresh click must not be debounced
    setParamVals({});
    setEchoed({});
    reloadFrame({ clearLive: true });
  }, [id, reloadFrame]);

  // Only user-touched params go on the wire; untouched ones fall to the server
  // default. Built from FRESH data (data.id === id) so it can't bleed the previous
  // app's overrides onto the new app's frame during the transitional render.
  const fresh = data?.id === id ? data : null;
  const paramQuery = (fresh?.params ?? [])
    .filter((p) => touched.current.has(p.name))
    .map((p) => `p.${encodeURIComponent(p.name)}=${encodeURIComponent(paramVals[p.name] ?? String(p.default))}`)
    .join("&");

  const visibility = data?.visibility ?? "team";
  const link = appShareUrl({ id, visibility });
  const mine = me?.identity === data?.createdBy;
  const isApp = (data?.panels?.length ?? 0) > 0;
  const canForce = mine || isAdmin; // mirrors the server's /admin/frame force gate
  formatRef.current = fresh?.format; // for the watchdog's fire-time decision

  // Live numbers for the CURRENT frame only (echo token must match the nonce).
  const livePanels = framePanels && framePanels.t === String(frame.n) ? framePanels.panels : null;
  // Freshness stamp: newest computed_at among SUCCESSFUL panels (an errored panel is
  // stamped "now" server-side, which would falsely read as fresh) — else the
  // metadata fetch's cached timestamp until the first echo lands.
  const stampAt = livePanels
    ? (Object.values(livePanels)
        .filter((p) => !p.error)
        .map((p) => p.computedAt)
        .filter(Boolean)
        .sort()
        .pop() ?? null)
    : (fresh?.updatedAt ?? null);

  // Manual "Refresh data": reload the frame — an author/admin bypasses the server
  // cache (?force=1), anyone else gets a cache-bounded reload. Debounced only to
  // swallow an accidental double-click; force is gated to a trusted, low-cardinality
  // surface (the public DoS path is the token bucket, which has no force), so it
  // needs no concurrency machinery. The frame visibly reloads; the drawer + the
  // load watchdog surface the outcome.
  // Bumped by a manual refresh to RESTART the auto-refresh countdown — so a periodic
  // tick can't fire right after (and supersede) a manual force, and so "refresh now"
  // resets "next auto refresh in N". (Only manual refresh bumps it; param changes
  // don't, so they can't starve the interval.)
  const [manualTick, setManualTick] = useState(0);
  const manualRefresh = useCallback(() => {
    const now = Date.now();
    if (now - lastRefresh.current < 1500) return; // ignore an accidental double-click
    lastRefresh.current = now;
    reloadFrame({ force: canForce, clearLive: false });
    setManualTick((t) => t + 1);
    toast("Refreshing…");
  }, [reloadFrame, canForce]);

  // App-state bridge (I9-style mediation): the sandboxed frame has no network, so
  // it postMessages state ops up to us; we are the policy gate. We inject the app
  // id (the template never names it → an app can only touch its OWN state), accept
  // messages only from our iframe, call the session-gated endpoint, and post the
  // result back. `Setoku.state.*` inside the template rides this channel.
  useEffect(() => {
    async function onMessage(e: MessageEvent) {
      const m = e.data as {
        __setoku_state_req?: boolean;
        __setoku_params_echo?: boolean;
        __setoku_provenance?: boolean;
        t?: string | null;
        panels?: Record<string, LivePanel>;
        params?: Record<string, string>;
        id?: number;
        op?: string;
        scope?: string;
        key?: unknown;
        value?: unknown;
      };
      if (!m) return;
      const frame = frameRef.current;
      if (!frame || e.source !== frame.contentWindow) return; // only OUR iframe
      // Provenance echo: the frame reports the row counts / freshness / errors it
      // actually rendered, tagged with the reload nonce (t). RECEIPT-guarded on the
      // current nonce so a stale echo from a superseded frame is dropped outright
      // (never stored) — otherwise a late echo could blank or freeze the drawer.
      if (m.__setoku_provenance === true) {
        if (m.t !== String(nonceRef.current)) return; // stale frame → ignore
        clearEchoTimer();
        setFramePanels({ t: m.t, panels: m.panels ?? {} });
        setFrameErr(false);
        return;
      }
      // Resolved-param echo: snap a TOUCHED control to what the server actually ran
      // (a rejected value shows as the default). Reconciled into the DISPLAY overlay
      // only — never the sent values / src — so it can't trigger a re-navigation.
      if (m.__setoku_params_echo === true) {
        const params = m.params;
        if (params)
          setEchoed((v) => {
            const next = { ...v };
            for (const k of Object.keys(params)) if (touched.current.has(k)) next[k] = params[k];
            return next;
          });
        return;
      }
      if (m.__setoku_state_req !== true) return;
      const reply = (body: { result?: unknown; error?: string }) =>
        frame.contentWindow?.postMessage({ __setoku_state_res: true, id: m.id, ...body }, "*");
      const scope = m.scope === "viewer" ? "viewer" : "app";
      const key = String(m.key ?? "");
      try {
        if (m.op === "get") {
          const { entries } = await api.appStateList(id, scope);
          const hit = entries.find((en) => en.key === key);
          reply({ result: hit ? hit.value : null });
        } else if (m.op === "list") {
          reply({ result: (await api.appStateList(id, scope)).entries });
        } else if (m.op === "set") {
          reply({ result: (await api.appStateSet(id, scope, key, m.value)).entry });
        } else if (m.op === "delete") {
          reply({ result: (await api.appStateDelete(id, scope, key)).deleted });
        } else {
          reply({ error: "bad op" });
        }
      } catch (err) {
        reply({ error: err instanceof Error ? err.message : "state error" });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [id]);

  // Auto-refresh on the app's interval — a plain cache-bounded frame reload (no
  // force). reloadFrame is stable, so param changes don't tear down the timer; a
  // manual refresh (manualTick) DOES restart it, so an auto tick can't supersede an
  // in-flight manual force and the countdown resets when you refresh by hand.
  useEffect(() => {
    if (!isApp) return;
    const secs = Math.max(30, data?.refreshSeconds ?? 300);
    const t = setInterval(() => reloadFrame({ force: false, clearLive: false }), secs * 1000);
    return () => clearInterval(t);
  }, [isApp, data?.refreshSeconds, reloadFrame, manualTick]);

  // A live app's frame echoes its provenance right after loading. If the frame
  // finishes loading but NO matching echo lands shortly, it served an error page
  // (401/404/500 — no __SETOKU__): surface it instead of leaving the drawer stuck on
  // "updating…". Armed unconditionally on load (metadata may not have resolved yet
  // during navigation); the FIRE-TIME check reads formatRef — by then the current
  // app's metadata has resolved, so a legacy "html" report (which never echoes) and
  // a not-yet-known format don't trip a false error.
  const onFrameLoad = useCallback(() => {
    setFrameLoading(false);
    clearEchoTimer();
    const loadedN = nonceRef.current;
    echoTimer.current = setTimeout(() => {
      echoTimer.current = null;
      if (formatRef.current !== "app") return; // not an app frame → no echo expected
      const fp = framePanelsRef.current;
      // Only flag failure if THIS load is still current and never echoed.
      if (nonceRef.current === loadedN && (!fp || fp.t !== String(loadedN))) setFrameErr(true);
    }, 2500);
  }, []);
  // Drop a pending echo-watchdog on unmount so it can't fire after the view is gone.
  useEffect(() => () => clearEchoTimer(), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast(visibility === "public" ? "Public link copied — no login needed." : "Link copied.");
    } catch {
      toast(link);
    }
  };

  // Inline title rename (author or admin). Enter/blur commits, Escape cancels —
  // both routed through blur so there's a single commit path; cancelRename skips
  // the save. No-op when unchanged or emptied.
  const commitTitle = async () => {
    if (titleEdit === null) return;
    if (cancelRename.current) {
      cancelRename.current = false;
      setTitleEdit(null);
      return;
    }
    const next = titleEdit.trim();
    setTitleEdit(null);
    if (!next || next === data?.title) return;
    try {
      await api.rename(id, next);
      reload();
      toast("Renamed.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Rename failed.");
    }
  };

  const act = async (fn: () => Promise<{ flash?: string }>) => {
    try {
      const r = await fn();
      if (r.flash) toast(r.flash);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed.");
    }
  };

  // Archiving makes this app unfetchable, so leave the viewer rather than
  // reload into an error screen.
  const archive = async () => {
    try {
      await api.archive(id);
      navigate("/");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed.");
    }
  };

  return (
    // Full-screen takeover (mirrors the public /p/<id> shell): one slim header at
    // the top, the iframe filling the rest of the viewport. `fixed inset-0` lifts
    // it out of the app's narrow content column and over the global nav for a
    // focused, full-bleed view — "← Apps" is the way back.
    <div className="fixed inset-0 z-20 flex flex-col bg-stone-50">
      <header className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1 border-b border-stone-200 bg-stone-50/90 px-4 py-2.5 backdrop-blur">
        <Link to="/" className="text-sm text-stone-500 hover:text-stone-800">
          ← Apps
        </Link>
        {data && !data.archivedAt && (mine || isAdmin) && titleEdit !== null ? (
          <input
            autoFocus
            value={titleEdit}
            maxLength={200}
            onChange={(e) => setTitleEdit(e.target.value)}
            onBlur={() => void commitTitle()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              else if (e.key === "Escape") {
                cancelRename.current = true;
                e.currentTarget.blur();
              }
            }}
            aria-label="App title"
            className="min-w-0 flex-1 rounded-md border border-stone-300 bg-white px-2 py-0.5 text-base font-semibold tracking-tight text-stone-900 outline-none focus:border-stone-400 focus:ring-2 focus:ring-stone-200"
          />
        ) : (
          <h1 className="flex min-w-0 items-center gap-1 truncate text-base font-semibold tracking-tight">
            <span className="truncate">{data?.title ?? "App"}</span>
            {data && !data.archivedAt && (mine || isAdmin) ? (
              <button
                onClick={() => setTitleEdit(data.title)}
                aria-label="Rename app"
                title="Rename"
                className="shrink-0 rounded p-0.5 text-stone-400 opacity-70 transition hover:bg-stone-100 hover:text-stone-700 hover:opacity-100"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M11.5 2.5a1.4 1.4 0 0 1 2 2L5 13l-3 .8.8-3 8.7-8.3Z" />
                </svg>
              </button>
            ) : null}
          </h1>
        )}
        {data ? <Badge tone={visibility === "public" ? "ok" : "idle"}>{visibility}</Badge> : null}
        {data ? (
          <span className="hidden text-xs text-stone-500 sm:inline">
            published by {data.createdBy}
            {isApp && stampAt ? ` · data updated ${relTime(stampAt)}` : ""}
            {isApp && data.mirrorAsOf ? ` · source data as of ${relTime(data.mirrorAsOf)}` : ""}
            {isApp && data.refreshSeconds ? ` · auto-refreshes every ${fmtInterval(data.refreshSeconds)}` : ""}
          </span>
        ) : null}
        <div className="ml-auto">
          <Menu label="App actions">
            {isApp ? (
              <MenuItem onSelect={() => setShowCalc((v) => !v)}>
                {showCalc ? "Hide calculations" : "How it's calculated"}
              </MenuItem>
            ) : null}
            {isApp ? <MenuItem onSelect={() => manualRefresh()}>Refresh data</MenuItem> : null}
            {isApp ? <MenuItem onSelect={() => setEditOpen(true)}>Edit…</MenuItem> : null}
            <MenuItem onSelect={() => void copy()}>Copy link</MenuItem>
            {data && !data.archivedAt && visibility === "public" && (isAdmin || mine) ? (
              <MenuItem onSelect={() => void act(() => api.setVisibility(id, "team"))}>Make team-only</MenuItem>
            ) : null}
            {data && !data.archivedAt && visibility === "team" && isAdmin ? (
              <MenuItem onSelect={() => void act(() => api.setVisibility(id, "public"))}>Make public</MenuItem>
            ) : null}
            {data && !data.archivedAt && (isAdmin || mine) ? (
              <MenuItem danger onSelect={() => setArchiveOpen(true)}>
                Archive
              </MenuItem>
            ) : null}
          </Menu>
        </div>
      </header>
      {data && data.params.length > 0 ? (
        <ParamBar
          params={data.params}
          // Controls show the echoed (server-resolved) value when present, else the
          // sent value, else the default — display overlaid on the sent state.
          values={{ ...paramVals, ...echoed }}
          onChange={(name, val) => {
            touched.current.add(name); // an explicit user change → goes on the wire
            setParamVals((v) => ({ ...v, [name]: val }));
            setEchoed((v) => {
              if (!(name in v)) return v;
              const next = { ...v };
              delete next[name]; // user input supersedes the prior server echo
              return next;
            });
            reloadFrame({ clearLive: true }); // new variant → drop the old numbers
          }}
        />
      ) : null}
      {/* Spinner/error only BEFORE the first metadata load. The iframe reloads on
          param/refresh without blanking the page; live numbers arrive via the echo. */}
      {!data && loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loading />
        </div>
      ) : !data ? (
        <div className="p-4">
          <ErrorMsg>{error ?? "Not found."}</ErrorMsg>
        </div>
      ) : (
        // iframe fills the remaining height; the calc drawer toggles in as a footer
        // below it (and the iframe shrinks to make room), out for full height.
        <main className="flex min-h-0 flex-1 flex-col">
          {/* The metadata fetch failed on a reload, or the frame itself failed to
              load (session drop / archived) — surface it WITHOUT blanking the
              still-shown view. Gated on !loading so a prior app's lingering error
              doesn't flash on navigation. */}
          {!loading && (error || frameErr) ? (
            <div className="flex-none border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
              Couldn't load the latest data — showing the last view. Try refreshing.
            </div>
          ) : null}
          <div className="relative min-h-0 w-full flex-1">
            <iframe
              key={frame.n}
              ref={frameRef}
              title={data.title}
              onLoad={onFrameLoad}
              src={`/admin/frame/${encodeURIComponent(id)}?${paramQuery ? paramQuery + "&" : ""}${frame.force ? "force=1&" : ""}t=${frame.n}`}
              // allow-forms so an app's <form> submit handler fires (the natural
              // app pattern); the frame CSP pins form-action 'none', so no actual
              // submission can leave the sandbox. Must match the response CSP's
              // sandbox directive (the effective sandbox is the intersection).
              sandbox="allow-scripts allow-forms"
              referrerPolicy="no-referrer"
              className="h-full w-full border-0 bg-white"
            />
            {/* Loader over the (blank, remounting) frame while the new variant
                renders — param changes and refreshes get visible feedback. The
                opacity delay keeps a fast cached load from flashing it. */}
            <div
              aria-hidden={!frameLoading}
              className={`pointer-events-none absolute inset-0 flex items-center justify-center bg-white/60 transition-opacity duration-150 ${frameLoading ? "opacity-100 delay-150" : "opacity-0"}`}
            >
              <div className="flex items-center gap-2 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-xs text-stone-500 shadow-sm">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600" />
                updating…
              </div>
            </div>
          </div>
          {isApp && showCalc ? (
            // SQL/description are param-independent (from data); the per-variant row
            // counts/freshness come from the frame's own echo (live) — "updating…"
            // until it arrives, "unavailable" if the frame failed to load, never the
            // default variant's numbers labelled as the selection.
            <Provenance panels={data.panels} live={livePanels} failed={frameErr} onClose={() => setShowCalc(false)} />
          ) : null}
        </main>
      )}
      <EditDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        id={id}
        title={data?.title ?? ""}
        canEdit={mine}
        onCopied={() => toast("Prompt copied — paste it into your agent (with the changes you want).")}
      />
      <Confirm
        open={archiveOpen}
        title="Archive this app?"
        body={`"${data?.title ?? ""}" will stop working at its link (public and team). The record is kept — you can restore it from the Apps list.`}
        confirmLabel="Archive"
        danger
        onConfirm={() => {
          setArchiveOpen(false);
          void archive();
        }}
        onClose={() => setArchiveOpen(false)}
      />
    </div>
  );
}

/** Setoku has no in-browser editor by design — editing is a conversational agent
 *  action. The prompt adapts to who you are: the AUTHOR gets an edit-in-place
 *  prompt (update_app, same link); anyone else can only duplicate it
 *  (get_app → publish_app a new copy), since update_app is
 *  author-gated. */
/** The control bar: a stone strip of widgets for an app's declared params (chrome
 *  — no accent color). Changing one re-runs the panels bound to the new value. */
function ParamBar({
  params,
  values,
  onChange,
}: {
  params: AppParam[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
}) {
  return (
    <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-2 border-b border-stone-200 bg-stone-50/80 px-4 py-2">
      {params.map((p) => (
        <label key={p.name} className="flex items-center gap-1.5 text-xs text-stone-600">
          <span>{p.label || p.name}</span>
          <ParamControl p={p} value={values[p.name] ?? String(p.default)} onChange={(v) => onChange(p.name, v)} />
        </label>
      ))}
    </div>
  );
}

function ParamControl({ p, value, onChange }: { p: AppParam; value: string; onChange: (v: string) => void }) {
  const cls =
    "rounded-md border border-stone-300 bg-white px-2 py-0.5 text-xs text-stone-900 outline-none focus:border-stone-400 focus:ring-2 focus:ring-stone-200";
  if (p.type === "enum")
    return (
      <select className={cls} value={value} onChange={(e) => onChange(e.target.value)}>
        {(p.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label || o.value}
          </option>
        ))}
      </select>
    );
  if (p.type === "bool")
    return (
      <select className={cls} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  // Free-text/number/date commit on blur or Enter — NOT per keystroke — so typing
  // a value doesn't remount the iframe (a live DB query) on every character. A
  // local draft holds the in-progress text; an external reset (the resolved-param
  // echo) flows back in via the synced `value`. Mirrors the public shell, which
  // commits on the DOM 'change' event.
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (): void => {
    if (draft !== value) onChange(draft);
  };
  return (
    <input
      type={p.type === "int" ? "number" : p.type === "date" ? "date" : "text"}
      className={cls}
      value={draft}
      min={p.type === "int" ? p.min : undefined}
      max={p.type === "int" ? p.max : undefined}
      step={p.type === "int" ? 1 : undefined}
      maxLength={p.type === "text" ? p.maxLength : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

function EditDialog({
  open,
  onClose,
  id,
  title,
  canEdit,
  onCopied,
}: {
  open: boolean;
  onClose: () => void;
  id: string;
  title: string;
  canEdit: boolean;
  onCopied: () => void;
}) {
  const url = `${location.origin}/admin/p/${id}`;
  const named = title ? ` "${title}"` : "";
  const prompt = canEdit
    ? `Edit my Setoku app${named} at ${url}\n` +
      `Read it with get_app("${id}"), then update_app("${id}", …) in place (same link).\n\n` +
      `Changes I want:\n`
    : `Make my own copy of the Setoku app${named} at ${url}\n` +
      `Read it with get_app("${id}"), then publish_app a new one with my changes (a new link — I can't edit someone else's in place).\n\n` +
      `Changes I want:\n`;
  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-stone-900/20 backdrop-blur-sm" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-stone-200 bg-white p-5 shadow-xl">
          <AlertDialog.Title className="text-base font-semibold text-stone-900">
            {canEdit ? "Edit this app" : "Make your own copy"}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-stone-600">
            {canEdit
              ? "Apps are edited by your agent, not a form. Paste this prompt into your Setoku-connected agent, fill in the changes you want, and it'll update this app in place — same link."
              : "You didn't create this app, so you can't edit it in place. Paste this into your Setoku-connected agent to build your own copy with your changes (it gets a new link)."}
          </AlertDialog.Description>
          <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-xs text-stone-700">
            {prompt}
          </pre>
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialog.Cancel className="btn btn-ghost">Close</AlertDialog.Cancel>
            <AlertDialog.Action
              className="btn btn-primary"
              onClick={() => {
                void navigator.clipboard?.writeText(prompt).catch(() => {});
                onCopied();
              }}
            >
              Copy prompt
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** "How this is calculated" — a collapsible footer (team-only; the public surface
 *  shows no calculations). Per panel: title, plain-language description, the
 *  exact SQL it runs, and freshness. */
function Provenance({
  panels,
  live,
  failed,
  onClose,
}: {
  // Param-independent metadata (title, SQL, description, dialect, metricId).
  panels: PanelProvenance[];
  // Per-panel live numbers echoed by the frame for the variant on screen, or null
  // while a reload is in flight (→ "updating…", never a stale variant's numbers).
  live: Record<string, LivePanel> | null;
  // The frame failed to load → show "unavailable" instead of a perpetual "updating…".
  failed?: boolean;
  onClose: () => void;
}) {
  return (
    <div className="card m-2 flex max-h-[42vh] shrink-0 flex-col overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-stone-100 px-4 py-2">
        <span className="text-sm font-medium text-stone-800">How this is calculated</span>
        <button className="text-xs text-stone-500 hover:text-stone-800" onClick={onClose}>
          Hide
        </button>
      </div>
      <div className="divide-y divide-stone-100 overflow-auto">
        {panels.map((p) => {
          const lp = live?.[p.key]; // live numbers for the variant on screen
          return (
            <div key={p.key} className="px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-stone-900">{p.title || humanizeKey(p.key)}</span>
                {p.metricId ? <Badge tone="ok">metric: {p.metricId}</Badge> : null}
                <span className="ml-auto text-xs text-stone-400">
                  {/* The SQL/desc below are param-independent; the row count and
                      freshness are per-variant and come from the live echo — shown
                      only once it lands, never the default variant's stale numbers. */}
                  {!live ? (
                    failed ? (
                      <span className="text-amber-700">unavailable</span>
                    ) : (
                      <span className="italic">updating…</span>
                    )
                  ) : lp?.error ? (
                    <span className="text-red-700">error</span>
                  ) : lp ? (
                    <>
                      {p.dialect} · {lp.rowCount} row(s)
                      {lp.computedAt ? ` · ${relTime(lp.computedAt)}` : ""}
                      {lp.refreshError ? <span className="text-amber-700"> · refresh failed</span> : null}
                    </>
                  ) : (
                    <span className="italic">no data</span>
                  )}
                </span>
              </div>
              {p.description || p.metricSummary ? (
                <p className="mt-0.5 text-xs text-stone-600">{p.description || p.metricSummary}</p>
              ) : null}
              <pre className="mt-2 overflow-x-auto rounded bg-stone-50 p-2 text-[11px] leading-relaxed text-stone-700">
                {lp?.error ? lp.error : p.sql}
              </pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}
