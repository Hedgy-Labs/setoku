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
import type { AppData, PanelProvenance } from "../types";

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
  const { data, loading, error, reload } = useApi<AppData>(() => api.appData(id), [id]);
  // Bumping the nonce changes the iframe src → reloads the frame (re-renders the
  // panels server-side; within the refresh TTL that's a cache hit).
  const [nonce, setNonce] = useState(0);
  // The calc drawer toggles in/out; collapsed lets the iframe take full height.
  const [showCalc, setShowCalc] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  // null = not editing the title; a string = the in-progress new title.
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const cancelRename = useRef(false);
  const refreshing = useRef(false);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const visibility = data?.visibility ?? "team";
  const link = appShareUrl({ id, visibility });
  const mine = me?.identity === data?.createdBy;
  const isApp = (data?.panels?.length ?? 0) > 0;

  const refresh = useCallback(
    async (force: boolean) => {
      if (refreshing.current) return;
      refreshing.current = true;
      try {
        if (force) await api.appData(id, true);
        setNonce((n) => n + 1);
        reload();
        if (force) toast("Refreshed.");
      } catch (e) {
        toast(e instanceof Error ? e.message : "Refresh failed.");
      } finally {
        refreshing.current = false;
      }
    },
    [id, reload],
  );

  // App-state bridge (I9-style mediation): the sandboxed frame has no network, so
  // it postMessages state ops up to us; we are the policy gate. We inject the app
  // id (the template never names it → an app can only touch its OWN state), accept
  // messages only from our iframe, call the session-gated endpoint, and post the
  // result back. `Setoku.state.*` inside the template rides this channel.
  useEffect(() => {
    async function onMessage(e: MessageEvent) {
      const m = e.data as { __setoku_state_req?: boolean; id?: number; op?: string; scope?: string; key?: unknown; value?: unknown };
      if (!m || m.__setoku_state_req !== true) return;
      const frame = frameRef.current;
      if (!frame || e.source !== frame.contentWindow) return; // only OUR iframe
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

  // Auto-refresh on the app's interval (cache-bounded server-side).
  useEffect(() => {
    if (!isApp) return;
    const secs = Math.max(30, data?.refreshSeconds ?? 300);
    const t = setInterval(() => void refresh(false), secs * 1000);
    return () => clearInterval(t);
  }, [isApp, data?.refreshSeconds, refresh]);

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
      navigate("/apps");
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
        <Link to="/apps" className="text-sm text-stone-500 hover:text-stone-800">
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
            {isApp && data.updatedAt ? ` · data updated ${relTime(data.updatedAt)}` : ""}
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
            {isApp ? <MenuItem onSelect={() => void refresh(true)}>Refresh data</MenuItem> : null}
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
      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loading />
        </div>
      ) : error ? (
        <div className="p-4">
          <ErrorMsg>{error}</ErrorMsg>
        </div>
      ) : data ? (
        // iframe fills the remaining height; the calc drawer toggles in as a footer
        // below it (and the iframe shrinks to make room), out for full height.
        <main className="flex min-h-0 flex-1 flex-col p-3">
          <iframe
            key={nonce}
            ref={frameRef}
            title={data.title}
            src={`/admin/frame/${encodeURIComponent(id)}?t=${nonce}`}
            // allow-forms so an app's <form> submit handler fires (the natural
            // app pattern); the frame CSP pins form-action 'none', so no actual
            // submission can leave the sandbox. Must match the response CSP's
            // sandbox directive (the effective sandbox is the intersection).
            sandbox="allow-scripts allow-forms"
            referrerPolicy="no-referrer"
            className="min-h-0 w-full flex-1 rounded-lg border border-stone-200 bg-white"
          />
          {isApp && showCalc ? <Provenance panels={data.panels} onClose={() => setShowCalc(false)} /> : null}
        </main>
      ) : null}
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
function Provenance({ panels, onClose }: { panels: PanelProvenance[]; onClose: () => void }) {
  return (
    <div className="card mt-2 flex max-h-[42vh] shrink-0 flex-col overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-stone-100 px-4 py-2">
        <span className="text-sm font-medium text-stone-800">How this is calculated</span>
        <button className="text-xs text-stone-500 hover:text-stone-800" onClick={onClose}>
          Hide
        </button>
      </div>
      <div className="divide-y divide-stone-100 overflow-auto">
        {panels.map((p) => (
          <div key={p.key} className="px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-stone-900">{p.title || humanizeKey(p.key)}</span>
              {p.metricId ? <Badge tone="ok">metric: {p.metricId}</Badge> : null}
              <span className="ml-auto text-xs text-stone-400">
                {p.error ? (
                  <span className="text-red-700">error</span>
                ) : (
                  <>
                    {p.dialect} · {p.rowCount} row(s)
                    {p.computedAt ? ` · ${relTime(p.computedAt)}` : ""}
                    {p.refreshError ? <span className="text-amber-700"> · refresh failed</span> : null}
                  </>
                )}
              </span>
            </div>
            {p.description || p.metricSummary ? (
              <p className="mt-0.5 text-xs text-stone-600">{p.description || p.metricSummary}</p>
            ) : null}
            <pre className="mt-2 overflow-x-auto rounded bg-stone-50 p-2 text-[11px] leading-relaxed text-stone-700">
              {p.error ? p.error : p.sql}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
