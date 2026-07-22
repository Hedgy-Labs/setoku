// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from "react";
import { AlertDialog } from "@base-ui-components/react/alert-dialog";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useApi } from "../hooks";
import { useAuth } from "../auth";
import { Heading, Loading, ErrorMsg } from "../components/Page";
import { toast } from "../components/Toast";
import { Badge } from "../components/Badge";
import { VisibilityBadge } from "../components/VisibilityBadge";
import { VisibilityDialog } from "../components/VisibilityDialog";
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
  // App whose lock confirm is open (null = none). Unlock is a direct action.
  const [locking, setLocking] = useState<PublishedMeta | null>(null);
  // App whose visibility picker is open (null = none).
  const [visApp, setVisApp] = useState<PublishedMeta | null>(null);
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
      <Heading title="Apps" action={<Button onClick={() => setNewOpen(true)}>New app</Button>}>
        Dashboards, trackers, and internal tools your agent builds on your data. They run on{" "}
        <b className="text-stone-800">live data</b> and never write to your sources.{" "}
        <b className="text-stone-800">Team</b> links work for anyone signed in here; the author or an
        admin can make one <b className="text-stone-800">public</b> for a link that needs no login.
      </Heading>
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
                  items.push(
                    <MenuItem key="vis" onSelect={() => setVisApp(r)}>
                      Change visibility…
                    </MenuItem>,
                  );
                  items.push(
                    <MenuItem
                      key="lock"
                      onSelect={() => (r.lockedAt ? void act(() => api.setLocked(r.id, false)) : setLocking(r))}
                    >
                      {r.lockedAt ? "Unlock" : "Lock…"}
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
                      <Link to={`/apps/${r.id}`} className="text-sm font-medium text-stone-900 hover:underline">
                        {r.title}
                      </Link>
                      <div className="mt-0.5 text-xs text-stone-500">
                        {r.createdBy} · {String(r.createdAt).slice(0, 16)}
                        {panelCount ? ` · ${panelCount} live panel${panelCount === 1 ? "" : "s"}` : ""}
                      </div>
                    </div>
                    {panelCount ? (
                      <Badge tone="ok">live</Badge>
                    ) : (
                      // No live-data panels. "static" matches the list_apps tool +
                      // the publish_app "static report" vocabulary; every app is a
                      // fragment now (issue #62), so the old format-based split is gone.
                      <Badge tone="idle">static</Badge>
                    )}
                    {r.lockedAt ? (
                      <span title={`Locked${r.lockedBy ? ` by ${r.lockedBy}` : ""} — agents can’t edit or archive it.`}>
                        <Badge tone="idle">locked</Badge>
                      </span>
                    ) : null}
                    <VisibilityBadge visibility={r.visibility} canManage={canManage} onOpen={() => setVisApp(r)} />
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
        open={!!locking}
        title="Lock this app?"
        body={`Agents won’t be able to edit or archive "${locking?.title}" until it’s unlocked — anyone can still view it or copy it into a new app. The author or an admin can unlock it anytime.`}
        confirmLabel="Lock"
        defaultAction
        onConfirm={() => {
          const a = locking;
          setLocking(null);
          if (a) void act(() => api.setLocked(a.id, true));
        }}
        onClose={() => setLocking(null)}
      />
      <VisibilityDialog
        open={!!visApp}
        visibility={visApp?.visibility ?? "team"}
        canMakePublic={isAdmin}
        onSubmit={(next) => {
          const a = visApp;
          setVisApp(null);
          if (a) void act(() => api.setVisibility(a.id, next));
        }}
        onClose={() => setVisApp(null)}
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
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-stone-900/20 backdrop-blur-sm" />
        <AlertDialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-stone-200 bg-white p-5 shadow-xl">
          <AlertDialog.Title className="text-base font-semibold text-stone-900">New app</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-stone-600">
            Apps are built by your agent, not a form. Paste this into your Setoku-connected agent, describe what
            you want, and it'll create and publish it.
          </AlertDialog.Description>
          <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-xs text-stone-700">
            {prompt}
          </pre>
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialog.Close className="btn btn-ghost">Close</AlertDialog.Close>
            {/* AlertDialog.Close so copying also dismisses the dialog (matches the
                old Radix Action behavior). */}
            <AlertDialog.Close
              className="btn btn-primary"
              onClick={() => {
                void navigator.clipboard?.writeText(prompt).catch(() => {});
                onCopied();
              }}
            >
              Copy prompt
            </AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
