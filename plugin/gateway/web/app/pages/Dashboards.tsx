// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useApi } from "../hooks";
import { useAuth } from "../auth";
import { Heading, Loading, ErrorMsg } from "../components/Page";
import { toast } from "../components/Toast";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Menu, MenuItem } from "../components/Menu";
import { Confirm } from "../components/Confirm";
import { dashboardShareUrl } from "../format";
import type { PublishedMeta } from "../types";

export function Dashboards() {
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  const { data, loading, error, reload } = useApi<PublishedMeta[]>(() => api.dashboards(), []);
  const [archiving, setArchiving] = useState<PublishedMeta | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const copy = async (r: PublishedMeta) => {
    try {
      await navigator.clipboard.writeText(dashboardShareUrl(r));
      toast(
        r.visibility === "public"
          ? "Public link copied — anyone can open it, no login."
          : "Link copied — recipients must sign in to the box to view.",
      );
    } catch {
      toast(dashboardShareUrl(r));
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

  const active = data?.filter((r) => !r.archivedAt) ?? [];
  const archived = data?.filter((r) => r.archivedAt) ?? [];

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <Heading title="Dashboards">
          Dashboards agents published to this box, backed by <b className="text-stone-800">live data</b> — the box
          re-runs each panel's query on a refresh interval. <b className="text-stone-800">Team</b> links are
          session-gated; the author or an admin can make one <b className="text-stone-800">public</b> for a
          credential-free link.
        </Heading>
        <Button className="mt-1 shrink-0" onClick={() => setNewOpen(true)}>
          New dashboard
        </Button>
      </div>
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
                if (canManage) {
                  // Making PUBLIC is admin-only (I9); taking it back to team is author-or-admin.
                  if (r.visibility === "public")
                    items.push(
                      <MenuItem key="vis" onSelect={() => void act(() => api.setVisibility(r.id, "team"))}>
                        Make team-only
                      </MenuItem>,
                    );
                  else if (isAdmin)
                    items.push(
                      <MenuItem key="vis" onSelect={() => void act(() => api.setVisibility(r.id, "public"))}>
                        Make public
                      </MenuItem>,
                    );
                  items.push(
                    <MenuItem key="arch" danger onSelect={() => setArchiving(r)}>
                      Archive
                    </MenuItem>,
                  );
                }
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
                {archived.map((r) => {
                  const canManage = isAdmin || me?.identity === r.createdBy;
                  return (
                    <div key={r.id} className="card flex items-center gap-3 p-3">
                      <span className="flex-1 text-sm text-stone-500">{r.title}</span>
                      <Badge tone="idle">archived</Badge>
                      {canManage ? (
                        <Menu label={`Actions for ${r.title}`}>
                          <MenuItem onSelect={() => void act(() => api.unarchive(r.id))}>Unarchive</MenuItem>
                        </Menu>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
        </>
      )}
      <Confirm
        open={!!archiving}
        title="Archive this dashboard?"
        body={`"${archiving?.title}" will stop working at its link (public and team). The record is kept — you can restore it from the Archived list.`}
        confirmLabel="Archive"
        danger
        onConfirm={() => {
          const a = archiving;
          setArchiving(null);
          if (a) void act(() => api.archive(a.id));
        }}
        onClose={() => setArchiving(null)}
      />
      <NewDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCopied={() => toast("Prompt copied — paste it into your agent (describe the dashboard you want).")}
      />
    </>
  );
}

/** Like the viewer's Edit dialog: dashboards are built by your agent, not a form.
 *  Hands the user a ready prompt to paste in and describe what they want. */
function NewDialog({ open, onClose, onCopied }: { open: boolean; onClose: () => void; onCopied: () => void }) {
  const prompt =
    `Build a new dashboard on my Setoku (${location.origin}).\n` +
    `Develop the queries with run_query (find_context / get_metric for curated metrics), then publish_dashboard — give each panel a title + one-line description, and a template using the Setoku.bar/table/stat/line helpers.\n\n` +
    `What I want:\n`;
  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-stone-900/20 backdrop-blur-sm" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-stone-200 bg-white p-5 shadow-xl">
          <AlertDialog.Title className="text-base font-semibold text-stone-900">New dashboard</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-stone-600">
            Dashboards are built by your agent, not a form. Paste this into your Setoku-connected agent, describe what
            you want, and it'll create and publish it.
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
