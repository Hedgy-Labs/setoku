// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { useApi } from "../hooks";
import { useAuth } from "../auth";
import { Loading, ErrorMsg, Flash } from "../components/Page";
import { Badge } from "../components/Badge";
import { Menu, MenuItem } from "../components/Menu";
import { reportShareUrl } from "../format";
import type { PublishedReport } from "../types";

/**
 * Render one report. The agent-authored HTML is dropped into a sandboxed iframe
 * via `srcDoc` — WITHOUT allow-same-origin, so it runs in an opaque origin and
 * cannot touch the admin cookie, the /admin/api surface, or this page's DOM.
 * `allow-scripts` lets simple inline interactivity work; an external script load
 * is still blocked by the sandbox's network constraints.
 */
export function ReportView() {
  const { id = "" } = useParams();
  const { me } = useAuth();
  const navigate = useNavigate();
  const isAdmin = me?.role === "admin";
  const { data, loading, error, reload } = useApi<PublishedReport>(() => api.report(id), [id]);
  const [flash, setFlash] = useState<string | null>(null);

  const link = reportShareUrl({ id, visibility: data?.visibility ?? "team" });
  const mine = me?.identity === data?.createdBy;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setFlash(data?.visibility === "public" ? "Public link copied — no login needed." : "Link copied.");
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

  // Archiving makes this report unfetchable (published_get 404s archived rows),
  // so we leave the viewer rather than reload into an error screen.
  const archive = async () => {
    try {
      await api.archive(id);
      navigate("/reports");
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "Failed.");
    }
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link to="/reports" className="text-sm text-stone-500 hover:text-stone-800">
          ← Reports
        </Link>
        <h1 className="flex-1 truncate text-lg font-semibold tracking-tight">{data?.title ?? "Report"}</h1>
        {data ? <Badge tone={data.visibility === "public" ? "ok" : "idle"}>{data.visibility}</Badge> : null}
        <Menu label="Report actions">
          <MenuItem onSelect={() => void copy()}>Copy link</MenuItem>
          {data && !data.archivedAt && (isAdmin || mine) ? (
            <MenuItem
              onSelect={() => void act(() => api.setVisibility(id, data.visibility === "public" ? "team" : "public"))}
            >
              {data.visibility === "public" ? "Make team-only" : "Make public"}
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
        </div>
      ) : null}
      {flash ? <Flash>{flash}</Flash> : null}
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorMsg>{error}</ErrorMsg>
      ) : data ? (
        <iframe
          title={data.title}
          srcDoc={data.body}
          sandbox="allow-scripts"
          className="h-[calc(100vh-14rem)] w-full rounded-lg border border-stone-200 bg-white"
        />
      ) : null}
    </>
  );
}
