// SPDX-License-Identifier: Apache-2.0
/**
 * Per-person pinned apps: the shape of one person's pin layout, plus the pure
 * operations on it. Dependency-free so BOTH runtimes import it: the store
 * normalizes what it saves, and the admin SPA applies moves optimistically with
 * the same rules (so the list never jumps when the server's copy comes back).
 *
 * A layout is an ordered list of groups, each an ordered list of app ids. The
 * group named "" is the ungrouped pins; it always exists and always comes first
 * (rendered without a header). Named groups are the person's own folders.
 * Pins are personal: they reorder one person's Apps page, never anyone else's,
 * and grant nothing (an id here is just a reference to an app they can see).
 */

export interface PinGroup {
  name: string;
  ids: string[];
}
export interface PinLayout {
  groups: PinGroup[];
}

export const MAX_PINS = 500;
export const MAX_PIN_GROUPS = 50;
export const MAX_PIN_GROUP_NAME = 60;

export const emptyPins = (): PinLayout => ({ groups: [{ name: "", ids: [] }] });

/** Clean an untrusted layout into the canonical shape: the ungrouped group
 *  first, names trimmed + capped, groups of the same name merged, every id in
 *  exactly one place (first occurrence wins), named groups left empty dropped,
 *  and the whole thing capped. `keep` (optional) filters out ids that no longer
 *  name an app. Never throws: junk input becomes an empty layout. */
export function normalizePins(input: unknown, keep?: (id: string) => boolean): PinLayout {
  const raw = (input as { groups?: unknown } | null)?.groups;
  const out: PinGroup[] = [{ name: "", ids: [] }];
  const byName = new Map<string, PinGroup>([["", out[0]]]);
  const seen = new Set<string>();
  let total = 0;
  for (const g of Array.isArray(raw) ? raw : []) {
    if (!g || typeof g !== "object") continue;
    const name = typeof g.name === "string" ? g.name.trim().slice(0, MAX_PIN_GROUP_NAME) : "";
    let group = byName.get(name);
    if (!group) {
      if (out.length > MAX_PIN_GROUPS) continue; // +1: the ungrouped group doesn't count
      group = { name, ids: [] };
      byName.set(name, group);
      out.push(group);
    }
    for (const id of Array.isArray(g.ids) ? g.ids : []) {
      if (typeof id !== "string" || !id || id.length > 64 || seen.has(id)) continue;
      if (keep && !keep(id)) continue;
      if (total >= MAX_PINS) break;
      seen.add(id);
      group.ids.push(id);
      total++;
    }
  }
  return { groups: out.filter((g) => g.name === "" || g.ids.length > 0) };
}

export const isPinned = (l: PinLayout, id: string): boolean => l.groups.some((g) => g.ids.includes(id));

/** Where to put an app: in group `group`, before the app `before` (or at the
 *  end of the group when `before` is absent / not in that group). */
export interface PinTarget {
  group: string;
  before?: string;
}

/** Pin `id` at `to`, moving it there if it's already pinned elsewhere. A group
 *  name that doesn't exist yet is created (appended after the others). */
export function placePin(l: PinLayout, id: string, to: PinTarget): PinLayout {
  const name = to.group.trim().slice(0, MAX_PIN_GROUP_NAME);
  // "Before itself" (a drop on its own slot) means "stay put": anchor on
  // whatever follows it instead, so removing it first doesn't send it to the end.
  let before = to.before;
  if (before === id) {
    const src = l.groups.find((g) => g.name === name)?.ids ?? [];
    before = src[src.indexOf(id) + 1];
  }
  const groups = l.groups.map((g) => ({ name: g.name, ids: g.ids.filter((x) => x !== id) }));
  let group = groups.find((g) => g.name === name);
  if (!group) {
    group = { name, ids: [] };
    groups.push(group);
  }
  const at = before ? group.ids.indexOf(before) : -1;
  if (at < 0) group.ids.push(id);
  else group.ids.splice(at, 0, id);
  return normalizePins({ groups });
}

export function unpin(l: PinLayout, id: string): PinLayout {
  return normalizePins({ groups: l.groups.map((g) => ({ name: g.name, ids: g.ids.filter((x) => x !== id) })) });
}

/** Nudge a pin one slot up or down within its own group (the keyboard-friendly
 *  twin of dragging). A no-op at either end. `shown` (optional) says which ids
 *  the person can actually see: hidden ones (an archived app keeps its pin) are
 *  stepped over, so a nudge always visibly moves. */
export function nudgePin(l: PinLayout, id: string, dir: -1 | 1, shown: (id: string) => boolean = () => true): PinLayout {
  const groups = l.groups.map((g) => {
    const i = g.ids.indexOf(id);
    let j = i + dir;
    while (i >= 0 && j >= 0 && j < g.ids.length && !shown(g.ids[j])) j += dir;
    if (i < 0 || j < 0 || j >= g.ids.length) return g;
    const ids = [...g.ids];
    [ids[i], ids[j]] = [ids[j], ids[i]];
    return { name: g.name, ids };
  });
  return { groups };
}

/** Rename a group. Renaming onto an existing name merges the two (the target
 *  keeps its position; the renamed group's pins follow its own). */
export function renamePinGroup(l: PinLayout, from: string, to: string): PinLayout {
  if (from === "") return l;
  const name = to.trim().slice(0, MAX_PIN_GROUP_NAME);
  if (!name || name === from) return l;
  return normalizePins({ groups: l.groups.map((g) => (g.name === from ? { name, ids: g.ids } : g)) });
}

/** Dissolve a group: its pins stay pinned, moved to the end of the ungrouped ones. */
export function ungroupPins(l: PinLayout, name: string): PinLayout {
  if (name === "") return l;
  const moved = l.groups.find((g) => g.name === name)?.ids ?? [];
  return normalizePins({
    groups: l.groups
      .filter((g) => g.name !== name)
      .map((g) => (g.name === "" ? { name: "", ids: [...g.ids, ...moved] } : g)),
  });
}

/** Move a named group one slot up or down among the named groups (the
 *  ungrouped pins stay first regardless). Like nudgePin, groups with nothing
 *  `shown` in them are stepped over. */
export function nudgePinGroup(
  l: PinLayout,
  name: string,
  dir: -1 | 1,
  shown: (id: string) => boolean = () => true,
): PinLayout {
  const i = l.groups.findIndex((g) => g.name === name);
  let j = i + dir;
  while (i >= 0 && j >= 1 && j < l.groups.length && !l.groups[j].ids.some(shown)) j += dir;
  if (name === "" || i < 0 || j < 1 || j >= l.groups.length) return l;
  const groups = [...l.groups];
  [groups[i], groups[j]] = [groups[j], groups[i]];
  return { groups };
}
