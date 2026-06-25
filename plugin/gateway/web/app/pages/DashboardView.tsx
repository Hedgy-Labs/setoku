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
import { dashboardShareUrl, relTime } from "../format";
import type { DashboardData, PanelProvenance } from "../types";

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
 * Render one dashboard. The agent-authored template + injected live data is
 * served by /admin/frame/<id> and shown in a sandboxed iframe — that endpoint
 * carries the strict no-network CSP, so the template can't reach the admin
 * cookie/API or phone home. The provenance drawer (how each number is computed)
 * is rendered HERE, in trusted chrome OUTSIDE the sandbox, so the template can't
 * spoof or hide it.
 */
export function DashboardView() {
  const { id = "" } = useParams();
  const { me } = useAuth();
  const navigate = useNavigate();
  const isAdmin = me?.role === "admin";
  const { data, loading, error, reload } = useApi<DashboardData>(() => api.dashboardData(id), [id]);
  // Bumping the nonce changes the iframe src → reloads the frame (re-renders the
  // panels server-side; within the refresh TTL that's a cache hit).
  const [nonce, setNonce] = useState(0);
  // The calc drawer toggles in/out; collapsed lets the iframe take full height.
  const [showCalc, setShowCalc] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const refreshing = useRef(false);

  const visibility = data?.visibility ?? "team";
  const link = dashboardShareUrl({ id, visibility });
  const mine = me?.identity === data?.createdBy;
  const isDashboard = (data?.panels?.length ?? 0) > 0;

  const refresh = useCallback(
    async (force: boolean) => {
      if (refreshing.current) return;
      refreshing.current = true;
      try {
        if (force) await api.dashboardData(id, true);
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

  // Auto-refresh on the dashboard's interval (cache-bounded server-side).
  useEffect(() => {
    if (!isDashboard) return;
    const secs = Math.max(30, data?.refreshSeconds ?? 300);
    const t = setInterval(() => void refresh(false), secs * 1000);
    return () => clearInterval(t);
  }, [isDashboard, data?.refreshSeconds, refresh]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast(visibility === "public" ? "Public link copied — no login needed." : "Link copied.");
    } catch {
      toast(link);
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

  // Archiving makes this dashboard unfetchable, so leave the viewer rather than
  // reload into an error screen.
  const archive = async () => {
    try {
      await api.archive(id);
      navigate("/dashboards");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed.");
    }
  };

  return (
    <div className="flex h-[calc(100vh-9.5rem)] flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <Link to="/dashboards" className="text-sm text-stone-500 hover:text-stone-800">
          ← Dashboards
        </Link>
        <h1 className="flex-1 truncate text-lg font-semibold tracking-tight">{data?.title ?? "Dashboard"}</h1>
        {isDashboard ? <Badge tone="ok">live</Badge> : null}
        {data ? <Badge tone={visibility === "public" ? "ok" : "idle"}>{visibility}</Badge> : null}
        <Menu label="Dashboard actions">
          {isDashboard ? (
            <MenuItem onSelect={() => setShowCalc((v) => !v)}>
              {showCalc ? "Hide calculations" : "How it's calculated"}
            </MenuItem>
          ) : null}
          {isDashboard ? <MenuItem onSelect={() => void refresh(true)}>Refresh data</MenuItem> : null}
          {isDashboard ? <MenuItem onSelect={() => setEditOpen(true)}>Edit…</MenuItem> : null}
          <MenuItem onSelect={() => void copy()}>Copy link</MenuItem>
          {data && !data.archivedAt && (isAdmin || mine) ? (
            <MenuItem
              onSelect={() => void act(() => api.setVisibility(id, visibility === "public" ? "team" : "public"))}
            >
              {visibility === "public" ? "Make team-only" : "Make public"}
            </MenuItem>
          ) : null}
          {data && !data.archivedAt && (isAdmin || mine) ? (
            <MenuItem danger onSelect={() => void archive()}>
              Archive
            </MenuItem>
          ) : null}
        </Menu>
      </div>
      {data ? (
        <div className="mb-2 text-xs text-stone-500">
          published by {data.createdBy} · {String(data.createdAt).slice(0, 16)}
          {isDashboard && data.updatedAt ? ` · data updated ${relTime(data.updatedAt)}` : ""}
          {isDashboard && data.refreshSeconds ? ` · auto-refreshes every ${fmtInterval(data.refreshSeconds)}` : ""}
        </div>
      ) : null}
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorMsg>{error}</ErrorMsg>
      ) : data ? (
        // iframe fills the remaining height; the calc drawer toggles in as a footer
        // below it (and the iframe shrinks to make room), out for full height.
        <>
          <iframe
            key={nonce}
            title={data.title}
            src={`/admin/frame/${encodeURIComponent(id)}?t=${nonce}`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="min-h-0 w-full flex-1 rounded-lg border border-stone-200 bg-white"
          />
          {isDashboard && showCalc ? <Provenance panels={data.panels} onClose={() => setShowCalc(false)} /> : null}
        </>
      ) : null}
      <EditDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        id={id}
        title={data?.title ?? ""}
        onCopied={() => toast("Prompt copied — paste it into your agent (with the changes you want).")}
      />
    </div>
  );
}

/** Setoku has no in-browser editor by design — editing is a conversational agent
 *  action (get_dashboard → update_dashboard). This hands the user a ready prompt
 *  (with a link to this dashboard) to paste into their agent. */
function EditDialog({
  open,
  onClose,
  id,
  title,
  onCopied,
}: {
  open: boolean;
  onClose: () => void;
  id: string;
  title: string;
  onCopied: () => void;
}) {
  const url = `${location.origin}/admin/p/${id}`;
  const prompt =
    `Edit my Setoku dashboard${title ? ` "${title}"` : ""} at ${url}\n` +
    `Read it with get_dashboard("${id}"), then update_dashboard("${id}", …) in place (same link).\n\n` +
    `Changes I want:\n`;
  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-stone-900/20 backdrop-blur-sm" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-stone-200 bg-white p-5 shadow-xl">
          <AlertDialog.Title className="text-base font-semibold text-stone-900">Edit this dashboard</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-stone-600">
            Dashboards are edited by your agent, not a form. Paste this prompt into your Setoku-connected agent,
            fill in the changes you want, and it'll update this dashboard in place — same link.
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
