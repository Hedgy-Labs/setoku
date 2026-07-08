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
import { VisibilityBadge } from "../components/VisibilityBadge";
import { Button } from "../components/Button";
import { Menu, MenuItem } from "../components/Menu";
import { Confirm } from "../components/Confirm";
import { appShareUrl } from "../format";
import type { PublishedMeta } from "../types";

export function Apps() {
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  const { data, loading, error, reload } = useApi<PublishedMeta[]>(() => api.apps(), []);
  const [archiving, setArchiving] = useState<PublishedMeta | null>(null);
  // App awaiting the make-public confirm — promoting to a credential-free link is
  // a deliberate exposure (I9), confirmed the same way as in the app header.
  const [makingPublic, setMakingPublic] = useState<PublishedMeta | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const copy = async (r: PublishedMeta) => {
    try {
      await navigator.clipboard.writeText(appShareUrl(r));
      toast(
        r.visibility === "public"
          ? "Public link copied — anyone can open it, no login."
          : "Link copied — recipients must sign in to the box to view.",
      );
    } catch {
      toast(appShareUrl(r));
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
        <Heading title="Apps">
          Dashboards, trackers, and internal tools your agent builds on your data. They run on{" "}
          <b className="text-stone-800">live data</b> and never write to your sources.{" "}
          <b className="text-stone-800">Team</b> links work for anyone signed in here; the author or an
          admin can make one <b className="text-stone-800">public</b> for a link that needs no login.
        </Heading>
        <Button className="mt-1 shrink-0" onClick={() => setNewOpen(true)}>
          New app
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
                      <MenuItem key="vis" onSelect={() => setMakingPublic(r)}>
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
                    {panelCount ? (
                      <Badge tone="ok">live</Badge>
                    ) : r.format === "app" ? (
                      <Badge tone="idle">interactive</Badge>
                    ) : (
                      <Badge tone="idle">static</Badge>
                    )}
                    <VisibilityBadge
                      visibility={r.visibility}
                      canManage={canManage}
                      isAdmin={isAdmin}
                      onMakePublic={() => setMakingPublic(r)}
                      onMakeTeam={() => void act(() => api.setVisibility(r.id, "team"))}
                    />
                    <Menu label={`Actions for ${r.title}`}>{items}</Menu>
                  </div>
                );
              })
            ) : (
              <div className="card p-8 text-center text-stone-500">
                Nothing published yet. Ask your agent to build a business metrics dashboard.
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
        title="Archive this app?"
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
      <Confirm
        open={!!makingPublic}
        title="Make this app public?"
        body="Anyone with the public link can open it without signing in to the box. You can switch it back to team-only anytime."
        confirmLabel="Make public"
        defaultAction
        onConfirm={() => {
          const p = makingPublic;
          setMakingPublic(null);
          if (p) void act(() => api.setVisibility(p.id, "public"));
        }}
        onClose={() => setMakingPublic(null)}
      />
      <NewDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCopied={() => toast("Prompt copied — paste it into your agent (describe the app you want).")}
      />
    </>
  );
}

/** Like the viewer's Edit dialog: apps are built by your agent, not a form.
 *  Hands the user a ready prompt to paste in and describe what they want. */
function NewDialog({ open, onClose, onCopied }: { open: boolean; onClose: () => void; onCopied: () => void }) {
  const prompt =
    `Build a new app on my Setoku (${location.origin}).\n` +
    `Develop the queries with run_query (find_context / get_metric for curated metrics), then publish_app — give each panel a title + one-line description, and a template using the Setoku.bar/table/stat/line helpers.\n\n` +
    `What I want:\n`;
  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-stone-900/20 backdrop-blur-sm" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-stone-200 bg-white p-5 shadow-xl">
          <AlertDialog.Title className="text-base font-semibold text-stone-900">New app</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-stone-600">
            Apps are built by your agent, not a form. Paste this into your Setoku-connected agent, describe what
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
