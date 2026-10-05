// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { AlertDialog } from "@base-ui-components/react/alert-dialog";
import { Dialog } from "@base-ui-components/react/dialog";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useApi } from "../hooks";
import { useAuth } from "../auth";
import { cn } from "../cn";
import { Heading, Loading, ErrorMsg } from "../components/Page";
import { toast } from "../components/Toast";
import { Badge } from "../components/Badge";
import { VisibilityBadge } from "../components/VisibilityBadge";
import { VisibilityDialog } from "../components/VisibilityDialog";
import { Button } from "../components/Button";
import { Menu, MenuItem } from "../components/Menu";
import { Confirm } from "../components/Confirm";
import { appShareUrl, downloadFile, relTime } from "../format";
import { formatBytes } from "../../../lib/format";
import {
  emptyPins,
  isPinned,
  nudgePin,
  nudgePinGroup,
  placePin,
  renamePinGroup,
  ungroupPins,
  unpin,
  MAX_PIN_GROUP_NAME,
  type PinLayout,
  type PinTarget,
} from "../../../lib/pins";
import type { PublishedMeta } from "../types";

// Past this many active apps the list gets a filter box; below it, it's noise.
const FILTER_AT = 6;

// How the unpinned list is ordered (pins keep their own hand-made order).
type SortKey = "recent" | "newest" | "name";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "recent", label: "Recent" },
  { key: "newest", label: "Newest" },
  { key: "name", label: "A–Z" },
];
const SORT_KEY = "setoku.apps.sort";
// A remembered per-browser convenience; storage can be absent or throw.
function loadSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_KEY);
    if (v === "recent" || v === "newest" || v === "name") return v;
  } catch {
    /* no storage */
  }
  return "recent";
}
function sortApps(list: PublishedMeta[], by: SortKey): PublishedMeta[] {
  const created = (r: PublishedMeta) => String(r.createdAt);
  const out = [...list];
  if (by === "name") out.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  else if (by === "newest") out.sort((a, b) => created(b).localeCompare(created(a)));
  // Recent: what you opened last first; never-opened apps follow, newest first.
  else
    out.sort(
      (a, b) =>
        (b.openedAt ?? "").localeCompare(a.openedAt ?? "") || created(b).localeCompare(created(a)),
    );
  return out;
}

/** Where a drag would land right now: a pin slot (drawn as a line), or the
 *  unpinned list (dropping there unpins). */
type DropHint = (PinTarget & { kind: "pin"; line?: { id: string; after: boolean } }) | { kind: "unpin" };

export function Apps() {
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  // The anonymous demo viewer has no person to pin for — no pin controls.
  const pinsAllowed = !!me && me.role !== "viewer";
  const { data, loading, error, reload } = useApi<PublishedMeta[]>(() => api.apps(), []);
  const [archiving, setArchiving] = useState<PublishedMeta | null>(null);
  // App whose lock confirm is open (null = none). Unlock is a direct action.
  const [locking, setLocking] = useState<PublishedMeta | null>(null);
  // App whose visibility picker is open (null = none).
  const [visApp, setVisApp] = useState<PublishedMeta | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSortState] = useState<SortKey>(loadSort);
  const setSort = (k: SortKey) => {
    setSortState(k);
    try {
      localStorage.setItem(SORT_KEY, k);
    } catch {
      /* no storage */
    }
  };

  // ---- pins: the person's own layout, applied optimistically and saved whole ----
  // Saves go out ONE at a time, each against the rev the last one returned
  // (compare-and-set), so they land in order and a stale tab can't clobber
  // newer pins. Moves made while one is in flight coalesce into the next save.
  // The controls stay off until the layout has loaded: a save built on the
  // empty default would otherwise replace everything the person had pinned.
  const [pins, setPins] = useState<PinLayout>(emptyPins);
  const [pinsReady, setPinsReady] = useState(false);
  const canPin = pinsAllowed && pinsReady;
  const rev = useRef(0);
  const inFlight = useRef(false);
  const queued = useRef<PinLayout | null>(null);
  const loadPins = () =>
    api.pins().then(
      (r) => {
        rev.current = r.rev;
        setPins(r.layout);
        setPinsReady(true);
      },
      () => {}, // pins stay off; the rest of the page works without them
    );
  useEffect(() => {
    if (pinsAllowed) void loadPins();
  }, [pinsAllowed]); // eslint-disable-line react-hooks/exhaustive-deps
  const flushPins = () => {
    const next = queued.current;
    if (!next || inFlight.current) return;
    queued.current = null;
    inFlight.current = true;
    api.setPins(next, rev.current).then(
      (r) => {
        inFlight.current = false;
        rev.current = r.rev;
        if (queued.current) flushPins();
        else setPins(r.layout); // the server's normalized copy
      },
      (e) => {
        inFlight.current = false;
        queued.current = null;
        toast(e instanceof Error ? e.message : "Couldn’t save your pins.");
        void loadPins(); // resync with what's actually stored
      },
    );
  };
  const savePins = (next: PinLayout) => {
    setPins(next);
    queued.current = next;
    flushPins();
  };
  // App being pinned / moved into a group (picker open), or a group being renamed.
  const [grouping, setGrouping] = useState<PublishedMeta | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  // ---- drag to reorder (pointer only; the row menu has the keyboard twins) ----
  const [dragId, setDragId] = useState<string | null>(null);
  const [hint, setHint] = useState<DropHint | null>(null);
  const endDrag = () => {
    setDragId(null);
    setHint(null);
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    const id = dragId;
    const h = hint;
    endDrag();
    if (!id || !h) return;
    if (h.kind === "unpin") {
      if (isPinned(pins, id)) savePins(unpin(pins, id));
    } else {
      savePins(placePin(pins, id, { group: h.group, before: h.before }));
    }
  };
  /** Over a pinned tile: the line goes left or right of it by which half the
   *  pointer is in, and the drop target is "before this tile" or "before the
   *  next one" (end of group when it's the last). Tiles wrap in reading order,
   *  so left/right is the whole story even across grid rows. */
  const overRow = (e: DragEvent, group: string, ids: string[], id: string) => {
    if (!dragId) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    const before = after ? ids[ids.indexOf(id) + 1] : id;
    if (hint?.kind === "pin" && hint.line?.id === id && hint.line.after === after) return;
    setHint({ kind: "pin", group, before, line: { id, after } });
  };
  const overGroup = (e: DragEvent, group: string) => {
    if (!dragId) return;
    e.preventDefault();
    // Already aiming somewhere in this group: keep it. The gaps between rows
    // bubble up here, and resetting to "end of group" there makes the line
    // flicker (and a drop in a gap land somewhere unexpected).
    if (hint?.kind === "pin" && hint.group === group) return;
    setHint({ kind: "pin", group });
  };

  const copy = async (r: PublishedMeta) => {
    try {
      await navigator.clipboard.writeText(appShareUrl(r));
      toast(
        r.visibility !== "public"
          ? "Link copied. Recipients must sign in to the box to view."
          : r.hasPassword
            ? "Public link copied. No login, but viewers still need the password."
            : "Public link copied. Anyone can open it, no login.",
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

  const needle = q.trim().toLowerCase();
  const matches = (r: PublishedMeta): boolean =>
    !needle ||
    r.title.toLowerCase().includes(needle) ||
    r.createdBy.toLowerCase().includes(needle) ||
    !!r.files?.first?.name.toLowerCase().includes(needle);
  const allActive = data?.filter((r) => !r.archivedAt) ?? [];
  const byId = new Map(allActive.map((r) => [r.id, r]));
  // Pinned groups resolved to live apps. Archived/unknown ids keep their pin in
  // the layout (unarchiving puts the app back in place) but render nothing here.
  const groups = pins.groups.map((g) => ({
    name: g.name,
    ids: g.ids.filter((id) => byId.has(id)),
  }));
  const pinnedIds = new Set(groups.flatMap((g) => g.ids));
  const pinnedCount = pinnedIds.size;
  // Only groups holding a live app: one whose apps are all archived is kept in
  // the layout (unarchiving restores it) but doesn't exist as far as the page goes.
  const namedGroups = groups.filter((g) => g.name !== "" && g.ids.length > 0).map((g) => g.name);
  const isLive = (id: string): boolean => byId.has(id);
  const unpinned = sortApps(
    allActive.filter((r) => !pinnedIds.has(r.id) && matches(r)),
    sort,
  );
  const archived = data?.filter((r) => r.archivedAt && matches(r)) ?? [];
  // Reordering a filtered list is ambiguous (where do the hidden rows go?).
  const canDrag = canPin && !needle;
  const dragging = !!dragId;

  const menuFor = (r: PublishedMeta, canManage: boolean): ReactNode[] => {
    const isFile = r.format === "file";
    const items: ReactNode[] = [
      <MenuItem key="copy" onSelect={() => void copy(r)}>
        Copy link
      </MenuItem>,
    ];
    if (isFile && r.files?.first) {
      // A real anchor click (not fetch): the session cookie rides along, and
      // the `download` attribute saves it even for inline-served types.
      const f = r.files.first;
      items.push(
        <MenuItem key="dl" onSelect={() => downloadFile(`/admin/files/${encodeURIComponent(r.id)}/${encodeURIComponent(f.name)}`, f.name)}>
          Download
        </MenuItem>,
      );
    }
    if (canPin) {
      const group = groups.find((g) => g.ids.includes(r.id));
      if (group) {
        const at = group.ids.indexOf(r.id);
        items.push(
          <MenuItem key="grp" onSelect={() => setGrouping(r)}>
            Move to group…
          </MenuItem>,
        );
        if (at > 0)
          items.push(
            <MenuItem key="up" onSelect={() => savePins(nudgePin(pins, r.id, -1, isLive))}>
              Move up
            </MenuItem>,
          );
        if (at < group.ids.length - 1)
          items.push(
            <MenuItem key="down" onSelect={() => savePins(nudgePin(pins, r.id, 1, isLive))}>
              Move down
            </MenuItem>,
          );
        items.push(
          <MenuItem key="unpin" onSelect={() => savePins(unpin(pins, r.id))}>
            Unpin
          </MenuItem>,
        );
      } else {
        items.push(
          <MenuItem key="pin" onSelect={() => savePins(placePin(pins, r.id, { group: "" }))}>
            Pin
          </MenuItem>,
          <MenuItem key="grp" onSelect={() => setGrouping(r)}>
            Pin to group…
          </MenuItem>,
        );
      }
    }
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
    return items;
  };

  const row = (r: PublishedMeta, opts: { pinned: boolean; group?: string; ids?: string[] }) => {
    const canManage = isAdmin || me?.identity === r.createdBy;
    const line = hint?.kind === "pin" && hint.line?.id === r.id ? hint.line : null;
    return (
      <AppRow
        key={r.id}
        r={r}
        variant={opts.pinned ? "tile" : "row"}
        showOpened={!opts.pinned && sort === "recent"}
        canManage={canManage}
        pinned={opts.pinned}
        canPin={canPin}
        onTogglePin={() => savePins(opts.pinned ? unpin(pins, r.id) : placePin(pins, r.id, { group: "" }))}
        menu={menuFor(r, canManage)}
        onVisibility={() => setVisApp(r)}
        draggable={canDrag}
        dimmed={dragId === r.id}
        line={line ? (line.after ? "after" : "before") : null}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", r.title);
          setDragId(r.id);
        }}
        onDragEnd={endDrag}
        onDragOver={opts.pinned && opts.group !== undefined ? (e) => overRow(e, opts.group!, opts.ids!, r.id) : undefined}
      />
    );
  };

  const sectionLabel = "mb-3 text-xs font-medium uppercase tracking-wide text-stone-500";
  // Pinned apps are a launcher (tiles you open daily); the rest stay a dense list.
  const tileGrid = "grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4";
  const visiblePinned = groups.reduce((n, g) => n + g.ids.filter((id) => matches(byId.get(id)!)).length, 0);
  const showPinned = (pinnedCount > 0 && (!needle || visiblePinned > 0)) || (dragging && canDrag);

  return (
    <>
      <Heading title="Apps" action={<Button onClick={() => setNewOpen(true)}>New app</Button>}>
        Dashboards, tools, and files your agent builds on live data. Team links need a sign-in; an admin
        can make one public, with an optional password.
      </Heading>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorMsg>{error}</ErrorMsg>
      ) : (
        <>
          {allActive.length > FILTER_AT || q ? (
            <input
              type="search"
              className="input mb-5"
              placeholder="Filter by title, author, or file name"
              aria-label="Filter apps"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          ) : null}

          {showPinned ? (
            <div className="mb-8" onDragOver={(e) => overGroup(e, "")} onDrop={drop}>
              <div className={sectionLabel}>
                Pinned ({needle ? `${visiblePinned} of ${pinnedCount}` : pinnedCount})
              </div>
              {groups.map((g) => {
                const shown = g.ids.filter((id) => matches(byId.get(id)!));
                if (g.name === "") {
                  return shown.length ? (
                    <div key="" className={tileGrid}>
                      {shown.map((id) => row(byId.get(id)!, { pinned: true, group: "", ids: g.ids }))}
                    </div>
                  ) : pinnedCount === 0 ? (
                    <DropZone key="" active={hint?.kind === "pin" && hint.group === ""}>
                      Drop here to pin
                    </DropZone>
                  ) : null;
                }
                if (!shown.length) return null;
                const gi = namedGroups.indexOf(g.name);
                const groupHint = hint?.kind === "pin" && hint.group === g.name && !hint.line;
                return (
                  <div
                    key={`g:${g.name}`}
                    className="mt-5"
                    onDragOver={(e) => {
                      e.stopPropagation();
                      overGroup(e, g.name);
                    }}
                    onDrop={(e) => {
                      e.stopPropagation();
                      drop(e);
                    }}
                  >
                    <div
                      className={cn(
                        "-mx-1 mb-2 flex items-center gap-2 rounded-lg px-1",
                        groupHint && "bg-stone-200/70",
                      )}
                    >
                      <span className="text-sm font-semibold text-stone-800">{g.name}</span>
                      <span className="text-xs tabular-nums text-stone-400">{g.ids.length}</span>
                      {canPin ? (
                        <span className="ml-auto">
                          <Menu label={`Actions for group ${g.name}`}>
                            <MenuItem onSelect={() => setRenaming(g.name)}>Rename…</MenuItem>
                            {gi > 0 ? (
                              <MenuItem onSelect={() => savePins(nudgePinGroup(pins, g.name, -1, isLive))}>Move group up</MenuItem>
                            ) : null}
                            {gi < namedGroups.length - 1 ? (
                              <MenuItem onSelect={() => savePins(nudgePinGroup(pins, g.name, 1, isLive))}>Move group down</MenuItem>
                            ) : null}
                            <MenuItem onSelect={() => savePins(ungroupPins(pins, g.name))}>Ungroup</MenuItem>
                          </Menu>
                        </span>
                      ) : null}
                    </div>
                    <div className={tileGrid}>
                      {shown.map((id) => row(byId.get(id)!, { pinned: true, group: g.name, ids: g.ids }))}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          <div
            onDragOver={(e) => {
              if (!dragId || !pinnedIds.has(dragId)) return;
              e.preventDefault();
              if (hint?.kind !== "unpin") setHint({ kind: "unpin" });
            }}
            onDrop={drop}
            className={cn("rounded-xl transition", hint?.kind === "unpin" && "bg-stone-200/50 ring-2 ring-stone-300 ring-offset-4 ring-offset-stone-50")}
          >
            <div className="mb-3 flex items-center gap-3">
              <div className={cn(sectionLabel, "mb-0")}>
                {pinnedCount ? "Everything else" : "Active"} ({unpinned.length})
              </div>
              {unpinned.length > 1 ? (
                <div role="radiogroup" aria-label="Sort apps" className="ml-auto flex gap-0.5 rounded-lg bg-stone-200/60 p-0.5">
                  {SORTS.map((o) => (
                    <button
                      key={o.key}
                      type="button"
                      role="radio"
                      aria-checked={sort === o.key}
                      onClick={() => setSort(o.key)}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-xs font-medium transition",
                        sort === o.key ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-800",
                      )}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div>
              {unpinned.length ? (
                <div className="card divide-y divide-stone-200 overflow-hidden">
                  {unpinned.map((r) => row(r, { pinned: false }))}
                </div>
              ) : needle ? (
                <div className="card p-6 text-center text-sm text-stone-500">No other apps match “{q.trim()}”.</div>
              ) : pinnedCount ? (
                <div className="card p-6 text-center text-sm text-stone-500">Every app is pinned.</div>
              ) : (
                <div className="card p-8 text-center text-stone-500">
                  Nothing published yet. Ask your agent to build a business metrics dashboard.
                </div>
              )}
            </div>
          </div>
          {archived.length ? (
            <>
              <div className={cn(sectionLabel, "mt-8")}>Archived ({archived.length})</div>
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
        body={`"${archiving?.title}" will stop working at its link (public and team). The record${archiving?.format === "file" ? " and the file" : ""} is kept, so you can restore it from the Archived list.`}
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
        body={`Agents won’t be able to edit or archive "${locking?.title}" until it’s unlocked. Anyone can still view it or copy it into a new app, and the author or an admin can unlock it anytime.`}
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
        hasPassword={!!visApp?.hasPassword}
        canMakePublic={isAdmin}
        onSubmit={(next, password) => {
          const a = visApp;
          setVisApp(null);
          if (a) void act(() => api.setVisibility(a.id, next, password));
        }}
        onClose={() => setVisApp(null)}
      />
      <GroupPicker
        app={grouping}
        groups={namedGroups}
        current={grouping ? (groups.find((g) => g.ids.includes(grouping.id))?.name ?? null) : null}
        onPick={(group) => {
          const a = grouping;
          setGrouping(null);
          if (a) savePins(placePin(pins, a.id, { group }));
        }}
        onClose={() => setGrouping(null)}
      />
      <RenameGroupDialog
        name={renaming}
        taken={namedGroups}
        onRename={(to) => {
          const from = renaming;
          setRenaming(null);
          if (from !== null) savePins(renamePinGroup(pins, from, to));
        }}
        onClose={() => setRenaming(null)}
      />
      <NewDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCopied={() => toast("Prompt copied. Paste it into your agent (describe the app you want).")}
      />
    </>
  );
}

/** When an app was made, at the grain people think in: "3h ago" this week,
 *  then a plain date ("Sep 12"; with the year once it's not this one). */
function madeWhen(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  if (Date.now() - ms < 7 * 864e5) return relTime(iso);
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** One app: a launcher TILE when pinned, a compact list ROW otherwise. Both
 *  drag (wired by the parent); only tiles take a drop line, since only pins
 *  have an order. A tile is clickable anywhere (a stretched link), with its
 *  buttons lifted above that link. */
function AppRow({
  r,
  variant,
  showOpened,
  canManage,
  pinned,
  canPin,
  onTogglePin,
  menu,
  onVisibility,
  draggable,
  dimmed,
  line,
  onDragStart,
  onDragEnd,
  onDragOver,
}: {
  r: PublishedMeta;
  variant: "tile" | "row";
  /** Say when YOU last opened it (the list is in that order), not when it was made. */
  showOpened?: boolean;
  canManage: boolean;
  pinned: boolean;
  canPin: boolean;
  onTogglePin: () => void;
  menu: ReactNode[];
  onVisibility: () => void;
  draggable: boolean;
  dimmed: boolean;
  /** Draw the drop line before (left of) or after (right of) this tile. */
  line: "before" | "after" | null;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver?: (e: DragEvent) => void;
}) {
  const panelCount = r.panels?.length ?? 0;
  const isFile = r.format === "file";
  const fileExt = r.files?.first ? (r.files.first.name.split(".").pop() ?? "").toLowerCase() : "";
  // Tags only for what's NOT the default, so the ones that show mean something:
  // a static team app (the common case) carries none. "Team" visibility stays
  // reachable through the row menu's "Change visibility…".
  const kind = isFile ? (
    // A shared file reads as what it is: its type and size (stone).
    <Badge key="kind" tone="idle">{r.files?.first ? `${fileExt || "file"} · ${formatBytes(r.files.first.size)}` : "file"}</Badge>
  ) : panelCount ? (
    <Badge key="kind" tone="ok">live</Badge>
  ) : null;
  const tags = [
    kind,
    r.lockedAt ? (
      <span key="lock" title={`Locked${r.lockedBy ? ` by ${r.lockedBy}` : ""}. Agents can’t edit or archive it.`}>
        <Badge tone="idle">locked</Badge>
      </span>
    ) : null,
    r.visibility === "public" ? (
      <VisibilityBadge key="vis" visibility={r.visibility} hasPassword={r.hasPassword} canManage={canManage} onOpen={onVisibility} />
    ) : null,
  ].filter(Boolean);
  const badges = tags.length ? <>{tags}</> : null;
  const pinBtn = canPin ? (
    <button
      type="button"
      className={cn(
        "icon-btn",
        pinned ? "text-stone-700" : "text-stone-300",
        // on a tile the pin is implied by where it sits; show the toggle on hover
        variant === "tile" && "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
      )}
      aria-label={pinned ? `Unpin ${r.title}` : `Pin ${r.title}`}
      aria-pressed={pinned}
      title={pinned ? "Unpin" : "Pin to the top"}
      onClick={onTogglePin}
    >
      <PinIcon filled={pinned} />
    </button>
  ) : null;
  const when =
    showOpened && r.openedAt ? `opened ${madeWhen(r.openedAt)}` : madeWhen(String(r.createdAt));
  const drag = {
    draggable,
    onDragStart: draggable ? onDragStart : undefined,
    onDragEnd,
    onDragOver,
  };

  if (variant === "tile") {
    return (
      <div
        className={cn(
          "group card relative flex flex-col p-3 transition hover:border-stone-300 hover:shadow-sm",
          draggable && "cursor-grab active:cursor-grabbing",
          dimmed && "opacity-40",
        )}
        {...drag}
      >
        {line ? (
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-y-2 w-0.5 rounded-full bg-stone-900",
              line === "before" ? "-left-[7px]" : "-right-[7px]",
            )}
          />
        ) : null}
        <Preview r={r} />
        <div className="flex items-start gap-1">
          <Link
            to={`/apps/${r.id}`}
            draggable={false}
            className="min-w-0 flex-1 text-sm font-medium leading-snug text-stone-900 outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-stone-400"
          >
            <span className="line-clamp-3">{r.title}</span>
          </Link>
          <div className="relative z-10 -mr-2 -mt-2 flex shrink-0">
            {pinBtn}
            <Menu label={`Actions for ${r.title}`}>{menu}</Menu>
          </div>
        </div>
        <div className="mt-auto pt-2">
          <div className="truncate text-xs text-stone-500">
            {r.createdBy}
            {when ? ` · ${when}` : ""}
          </div>
          {badges ? <div className="relative z-10 mt-2 flex w-fit flex-wrap gap-1.5">{badges}</div> : null}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-3 px-4 py-2.5 transition hover:bg-stone-50", dimmed && "opacity-40")} {...drag}>
      <div className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-3">
        <Link to={`/apps/${r.id}`} draggable={false} className="truncate text-sm font-medium text-stone-900 hover:underline">
          {r.title}
        </Link>
        <span className="truncate text-xs text-stone-500">
          {r.createdBy}
          {when ? ` · ${when}` : ""}
          {panelCount ? ` · ${panelCount} live panel${panelCount === 1 ? "" : "s"}` : ""}
          {isFile && r.files?.first ? ` · ${r.files.first.name}` : ""}
          {!isFile && r.files?.count ? ` · ${r.files.count} file${r.files.count === 1 ? "" : "s"}` : ""}
        </span>
      </div>
      {badges ? <div className="hidden shrink-0 items-center gap-1.5 sm:flex">{badges}</div> : null}
      {pinBtn}
      <Menu label={`Actions for ${r.title}`}>{menu}</Menu>
    </div>
  );
}

// The width a preview lays the app out at before scaling it down to the tile,
// so it looks like the app at a normal window size, not a squeezed phone view.
const PREVIEW_W = 1000;

/** A live thumbnail of the app: its real frame, laid out at desktop width and
 *  scaled to fit. Served CACHE-ONLY (?preview=1 never runs a query) and lazily
 *  (offscreen tiles don't load), so a page of pins costs the lake nothing. It's
 *  inert: no pointer events, out of the tab order, hidden from screen readers
 *  (the tile's title link is the real control). */
function Preview({ r }: { r: PublishedMeta }) {
  if (r.format === "file") return <FilePreview r={r} />;
  return <FramePreview r={r} />;
}

/** A shared file's tile shows what it is (its extension, large) instead of a
 *  live frame — rendering the real viewer would ship the whole file per tile. */
function FilePreview({ r }: { r: PublishedMeta }) {
  const ext = (r.files?.first?.name.split(".").pop() ?? "file").toLowerCase();
  return (
    <div
      aria-hidden="true"
      className="mb-3 flex aspect-[16/10] items-center justify-center rounded-lg border border-stone-200 bg-stone-50"
    >
      <span className="rounded-md border border-stone-300 bg-white px-2.5 py-1 font-mono text-sm font-medium uppercase text-stone-500">
        {ext.slice(0, 6)}
      </span>
    </div>
  );
}

function FramePreview({ r }: { r: PublishedMeta }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale(e.contentRect.width / PREVIEW_W));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={box}
      aria-hidden="true"
      className="relative mb-3 aspect-[16/10] overflow-hidden rounded-lg border border-stone-200 bg-white"
    >
      {scale ? (
        <iframe
          src={`/admin/frame/${encodeURIComponent(r.id)}?preview=1`}
          title=""
          loading="lazy"
          tabIndex={-1}
          // narrower than the viewer's: a thumbnail needs scripts (charts draw
          // client-side) and nothing else
          sandbox="allow-scripts"
          className="pointer-events-none absolute left-0 top-0 origin-top-left border-0"
          style={{ width: PREVIEW_W, height: (PREVIEW_W * 10) / 16, transform: `scale(${scale})` }}
        />
      ) : null}
    </div>
  );
}

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 1.75h4l-.6 4.1 2.6 2.4v1.25H4V8.25l2.6-2.4L6 1.75Z" />
      <path d="M8 9.5v4.75" strokeLinecap="round" />
    </svg>
  );
}

/** Empty pinned area shown while dragging, before anything is pinned. */
function DropZone({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-xl border-2 border-dashed p-6 text-center text-sm transition",
        active ? "border-stone-500 bg-stone-100 text-stone-700" : "border-stone-300 text-stone-500",
      )}
    >
      {children}
    </div>
  );
}

const dialogPopup =
  "fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-stone-200 bg-white p-5 shadow-xl";

/** Pin an app into a group, or move a pinned one: the existing groups as
 *  one-click choices, plus a field to start a new one. Groups exist only while
 *  they hold something, so "new" is just a name you move the first app into. */
function GroupPicker({
  app,
  groups,
  current,
  onPick,
  onClose,
}: {
  app: PublishedMeta | null;
  groups: string[];
  /** The app's current group ("" = pinned, no group), or null when unpinned. */
  current: string | null;
  onPick: (group: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (app) setName("");
  }, [app]);
  const choice = (label: string, group: string) => (
    <button
      key={`c:${group}`}
      type="button"
      disabled={current === group}
      className="menu-item rounded-lg disabled:cursor-default disabled:text-stone-400 disabled:hover:bg-transparent"
      onClick={() => onPick(group)}
    >
      <span className="flex-1 truncate">{label}</span>
      {current === group ? <span className="text-xs text-stone-400">current</span> : null}
    </button>
  );
  const trimmed = name.trim();
  return (
    <Dialog.Root open={!!app} onOpenChange={(o) => (o ? null : onClose())}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-stone-900/20 backdrop-blur-sm" />
        <Dialog.Popup className={dialogPopup}>
          <Dialog.Title className="text-base font-semibold text-stone-900">
            {current === null ? "Pin to group" : "Move to group"}
          </Dialog.Title>
          <Dialog.Description className="mt-1 truncate text-sm text-stone-600">{app?.title}</Dialog.Description>
          <div className="-mx-1 mt-3 max-h-64 overflow-auto">
            {choice(current === null ? "Pinned, no group" : "No group", "")}
            {groups.map((g) => choice(g, g))}
          </div>
          <form
            className="mt-3 flex gap-2 border-t border-stone-200 pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (trimmed) onPick(trimmed);
            }}
          >
            <input
              className="input"
              placeholder="New group"
              aria-label="New group name"
              maxLength={MAX_PIN_GROUP_NAME}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" disabled={!trimmed}>
              {groups.includes(trimmed) ? "Move" : "Create"}
            </Button>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Rename a pin group. Renaming onto another group's name merges the two, so
 *  the button says so. */
function RenameGroupDialog({
  name,
  taken,
  onRename,
  onClose,
}: {
  name: string | null;
  taken: string[];
  onRename: (to: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  useEffect(() => {
    if (name !== null) setValue(name);
  }, [name]);
  const trimmed = value.trim();
  const merges = trimmed !== name && taken.includes(trimmed);
  return (
    <Dialog.Root open={name !== null} onOpenChange={(o) => (o ? null : onClose())}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-stone-900/20 backdrop-blur-sm" />
        <Dialog.Popup className={dialogPopup}>
          <Dialog.Title className="text-base font-semibold text-stone-900">Rename group</Dialog.Title>
          <form
            className="mt-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (trimmed) onRename(trimmed);
            }}
          >
            <input
              className="input"
              aria-label="Group name"
              maxLength={MAX_PIN_GROUP_NAME}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
            {merges ? (
              <p className="mt-2 text-xs text-stone-500">“{trimmed}” already exists. Its pins and these will merge.</p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <Dialog.Close className="btn btn-ghost">Cancel</Dialog.Close>
              <Button type="submit" disabled={!trimmed}>
                {merges ? "Merge" : "Rename"}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Like the viewer's Edit dialog: apps are built by your agent, not a form.
 *  Hands the user a ready prompt to paste in and describe what they want. */
function NewDialog({ open, onClose, onCopied }: { open: boolean; onClose: () => void; onCopied: () => void }) {
  const prompt =
    `Build a new app on my Setoku (${location.origin}).\n` +
    `Develop the queries with run_query (find_context / get_metric for curated metrics), then publish_app. Give each panel a title + one-line description, and a template using the Setoku.bar/table/stat/line helpers.\n\n` +
    `What I want:\n`;
  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-stone-900/20 backdrop-blur-sm" />
        <AlertDialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-stone-200 bg-white p-5 shadow-xl">
          <AlertDialog.Title className="text-base font-semibold text-stone-900">New app</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-stone-600">
            Apps are built by your agent, not a form. Paste this into your Setoku-connected agent, describe what
            you want, and it'll create and publish it. (To share a file instead, ask it to publish_file.)
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
