// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { useApi } from "../hooks";
import { useAuth } from "../auth";
import { Loading, ErrorMsg, Flash } from "../components/Page";
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
  const [flash, setFlash] = useState<string | null>(null);
  // Bumping the nonce changes the iframe src → reloads the frame (re-renders the
  // panels server-side; within the refresh TTL that's a cache hit).
  const [nonce, setNonce] = useState(0);
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
        if (force) setFlash("Refreshed.");
      } catch (e) {
        setFlash(e instanceof Error ? e.message : "Refresh failed.");
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
      setFlash(visibility === "public" ? "Public link copied — no login needed." : "Link copied.");
    } catch {
      setFlash(link);
    }
  };

  const act = async (fn: () => Promise<{ flash?: string }>) => {
    try {
      const r = await fn();
      setFlash(r.flash ?? null);
      reload();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "Failed.");
    }
  };

  // Archiving makes this dashboard unfetchable, so leave the viewer rather than
  // reload into an error screen.
  const archive = async () => {
    try {
      await api.archive(id);
      navigate("/dashboards");
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "Failed.");
    }
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link to="/dashboards" className="text-sm text-stone-500 hover:text-stone-800">
          ← Dashboards
        </Link>
        <h1 className="flex-1 truncate text-lg font-semibold tracking-tight">{data?.title ?? "Dashboard"}</h1>
        {isDashboard ? <Badge tone="ok">live</Badge> : null}
        {data ? <Badge tone={visibility === "public" ? "ok" : "idle"}>{visibility}</Badge> : null}
        <Menu label="Dashboard actions">
          {isDashboard ? <MenuItem onSelect={() => void refresh(true)}>Refresh data</MenuItem> : null}
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
        <div className="mb-3 text-xs text-stone-500">
          published by {data.createdBy} · {String(data.createdAt).slice(0, 16)}
          {isDashboard && data.updatedAt ? ` · data updated ${relTime(data.updatedAt)}` : ""}
          {isDashboard && data.refreshSeconds ? ` · auto-refreshes every ${fmtInterval(data.refreshSeconds)}` : ""}
        </div>
      ) : null}
      {flash ? <Flash>{flash}</Flash> : null}
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorMsg>{error}</ErrorMsg>
      ) : data ? (
        <>
          <iframe
            key={nonce}
            title={data.title}
            src={`/admin/frame/${encodeURIComponent(id)}?t=${nonce}`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="h-[calc(100vh-16rem)] w-full rounded-lg border border-stone-200 bg-white"
          />
          {isDashboard ? <Provenance panels={data.panels} /> : null}
        </>
      ) : null}
    </>
  );
}

/** "How this is calculated": per-panel SQL, dialect, linked metric, freshness.
 *  Rendered in trusted chrome (the agent's template can't reach it). */
function Provenance({ panels }: { panels: PanelProvenance[] }) {
  return (
    <details className="card mt-3 p-0">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-stone-800">
        How this is calculated
      </summary>
      <div className="divide-y divide-stone-100 border-t border-stone-100">
        {panels.map((p) => (
          <div key={p.key} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-stone-900">{p.title || p.key}</span>
              <Badge tone="idle">{p.dialect}</Badge>
              {p.metricId ? <Badge tone="ok">metric: {p.metricId}</Badge> : null}
              <span className="ml-auto text-xs text-stone-500">
                {p.error ? (
                  <span className="text-red-700">error: {p.error}</span>
                ) : (
                  <>
                    {p.rowCount} row(s)
                    {p.computedAt ? ` · ${relTime(p.computedAt)}` : ""}
                    {p.refreshError ? <span className="text-amber-700"> · refresh failed</span> : null}
                  </>
                )}
              </span>
            </div>
            {p.metric?.summary ? <p className="mt-1 text-xs text-stone-600">{p.metric.summary}</p> : null}
            {p.sql ? (
              <pre className="mt-2 overflow-x-auto rounded bg-stone-50 p-2 text-xs text-stone-700">{p.sql}</pre>
            ) : null}
          </div>
        ))}
      </div>
    </details>
  );
}
