// SPDX-License-Identifier: Apache-2.0
/**
 * Release notes for the deploy notice. Read from gateway/RELEASES.md (copied
 * into the image with the rest of gateway/), parsed into `## vX.Y.Z` sections
 * of `- ` bullets. A box that jumps several versions gets every section it
 * skipped, newest first, capped so one deploy can't post a wall of text.
 */
import fs from "node:fs";
import path from "node:path";

export interface ReleaseNote {
  version: string;
  bullets: string[];
}

const NOTES_PATH = path.join(import.meta.dir, "..", "RELEASES.md");

/** Parse RELEASES.md text into version sections (order as written). */
export function parseReleaseNotes(md: string): ReleaseNote[] {
  const out: ReleaseNote[] = [];
  let cur: ReleaseNote | null = null;
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^##\s+v?(\d+\.\d+\.\d+)\s*$/);
    if (h) {
      cur = { version: h[1], bullets: [] };
      out.push(cur);
      continue;
    }
    if (/^#\s/.test(line)) cur = null; // a new top-level section ends the notes
    const b = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (cur && b) cur.bullets.push(b[1]);
    else if (cur && line.trim() && cur.bullets.length) cur.bullets[cur.bullets.length - 1] += ` ${line.trim()}`; // wrapped bullet
  }
  return out.filter((n) => n.bullets.length);
}

/** -1 / 0 / 1 for dotted numeric versions ("0.10.0" > "0.9.3"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Notes for versions in (previous, current], newest first. `previous` null →
 *  just the current version's notes. */
export function notesBetween(notes: ReleaseNote[], previous: string | null, current: string): ReleaseNote[] {
  return notes
    .filter((n) => compareVersions(n.version, current) <= 0 && (!previous || compareVersions(n.version, previous) > 0))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** The shipped notes for a deploy from `previous` to `current` ([] if none / unreadable). */
export function releaseNotesFor(previous: string | null, current: string): ReleaseNote[] {
  try {
    return notesBetween(parseReleaseNotes(fs.readFileSync(NOTES_PATH, "utf8")), previous, current);
  } catch {
    return [];
  }
}
