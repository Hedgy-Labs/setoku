// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useApi } from "../hooks";
import { useAuth } from "../auth";
import { Heading, Loading, ErrorMsg, Flash } from "../components/Page";
import { Badge } from "../components/Badge";
import { Menu, MenuItem } from "../components/Menu";
import { dashboardShareUrl } from "../format";
import type { PublishedMeta } from "../types";

export function Dashboards() {
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  const { data, loading, error, reload } = useApi<PublishedMeta[]>(() => api.dashboards(), []);
  const [flash, setFlash] = useState<string | null>(null);

  const copy = async (r: PublishedMeta) => {
    try {
      await navigator.clipboard.writeText(dashboardShareUrl(r));
      setFlash(
        r.visibility === "public"
          ? "Public link copied — anyone can open it, no login."
          : "Link copied — recipients must sign in to the box to view.",
      );
    } catch {
      setFlash(dashboardShareUrl(r));
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

  const active = data?.filter((r) => !r.archivedAt) ?? [];
  const archived = data?.filter((r) => r.archivedAt) ?? [];

  return (
    <>
      <Heading title="Dashboards">
        Dashboards agents published to this box, backed by <b className="text-stone-800">live data</b> — the box
        re-runs each panel's query on a refresh interval. <b className="text-stone-800">Team</b> links are
        session-gated; the author or an admin can make one <b className="text-stone-800">public</b> for a
        credential-free link.
      </Heading>
      {flash ? <Flash>{flash}</Flash> : null}
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorMsg>{error}</ErrorMsg>
      ) : (
        <>
          <div className="mb-3 text-xs font-medium uppercase tracking-wide text-stone-500">
            Active ({active.length})
          </div>
          <div className="space-y-3">
            {active.length ? (
              active.map((r) => {
                const mine = me?.identity === r.createdBy;
                const canManage = isAdmin || mine;
                const panelCount = r.panels?.length ?? 0;
                const items: ReactNode[] = [
                  <MenuItem key="copy" onSelect={() => void copy(r)}>
                    Copy link
                  </MenuItem>,
                ];
                if (canManage)
                  items.push(
                    <MenuItem
                      key="vis"
                      onSelect={() =>
                        void act(() => api.setVisibility(r.id, r.visibility === "public" ? "team" : "public"))
                      }
                    >
                      {r.visibility === "public" ? "Make team-only" : "Make public"}
                    </MenuItem>,
                    <MenuItem key="arch" danger onSelect={() => void act(() => api.archive(r.id))}>
                      Archive
                    </MenuItem>,
                  );
                return (
                  <div key={r.id} className="card flex items-center gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <Link to={`/p/${r.id}`} className="text-sm font-medium text-stone-900 hover:underline">
                        {r.title}
                      </Link>
                      <div className="mt-0.5 text-xs text-stone-500">
                        {r.createdBy} · {String(r.createdAt).slice(0, 16)}
                        {panelCount ? ` · ${panelCount} live panel${panelCount === 1 ? "" : "s"}` : ""}
                      </div>
                    </div>
                    {panelCount ? <Badge tone="ok">live</Badge> : <Badge tone="idle">static</Badge>}
                    <Badge tone={r.visibility === "public" ? "ok" : "idle"}>{r.visibility}</Badge>
                    <Menu label={`Actions for ${r.title}`}>{items}</Menu>
                  </div>
                );
              })
            ) : (
              <div className="card p-8 text-center text-stone-500">
                Nothing published yet. An agent publishes with the{" "}
                <code className="kbd">publish_dashboard</code> tool.
              </div>
            )}
          </div>
          {archived.length ? (
            <>
              <div className="mb-3 mt-8 text-xs font-medium uppercase tracking-wide text-stone-500">
                Archived ({archived.length})
              </div>
              <div className="space-y-2">
                {archived.map((r) => (
                  <div key={r.id} className="card flex items-center gap-3 p-3 opacity-60">
                    <span className="flex-1 text-sm text-stone-600">{r.title}</span>
                    <Badge tone="idle">archived</Badge>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </>
      )}
    </>
  );
}
