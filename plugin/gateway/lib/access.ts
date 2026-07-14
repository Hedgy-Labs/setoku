// SPDX-License-Identifier: Apache-2.0
/**
 * The ONE place per-user source-access filtering is decided for the knowledge
 * plane, so the MCP tools (app.ts) and the /admin web API (http.ts) can never
 * drift — a leak on one plane but not the other was the recurring bug. Every
 * surface that hides a source-tagged doc or a correction about one routes
 * through these helpers; the lake/query plane is enforced by the ClickHouse
 * engine (lib/sources.ts lakeRolesFor) and is not duplicated here.
 *
 * The kill-switch (SETOKU_SOURCE_ACCESS=0) is applied HERE too, via
 * effectiveDenies, so the knowledge filters go inert exactly when the engine
 * can't enforce — never asserting a restriction that isn't real.
 */
import { effectiveDenies, familySlug } from "./sources";

/** Minimal shapes so this module doesn't couple to store.ts types. */
interface TaggedDoc {
  name: string;
  meta: { source?: unknown };
}
interface Relatable {
  relatesTo?: string | null;
}

/** The family slugs to FILTER BY for an identity: the stored denies with the
 *  kill-switch applied. Admins bypass (they manage the store and the denies),
 *  so pass isAdmin=true on the web plane. The MCP plane has no admin identity —
 *  an analyst connector is always subject to its denies — so it omits it. */
export function deniedFamiliesFor(stored: string[], isAdmin = false): Set<string> {
  return isAdmin ? new Set() : new Set(effectiveDenies(stored));
}

/** Whether a doc's OPTIONAL source tag (meta.source, a family slug the curator
 *  set — never inferred) falls inside the denied set. Untagged docs are
 *  team-wide: hiding is a deliberate curatorial act, like the deny itself. */
export function docHidden(meta: { source?: unknown }, denied: Set<string>): boolean {
  return typeof meta.source === "string" && denied.has(familySlug(meta.source));
}

/** Names of docs hidden from a session — so a correction ABOUT one can be
 *  dropped without leaking the hidden fact/doc-name through the pending channel. */
export function hiddenDocNames(docs: readonly TaggedDoc[], denied: Set<string>): Set<string> {
  if (!denied.size) return new Set();
  return new Set(docs.filter((d) => docHidden(d.meta, denied)).map((d) => d.name));
}

/** The docs a session may see: a doc tagged to a denied family doesn't exist
 *  for it (answers exactly as if never written). */
export function visibleDocs<D extends TaggedDoc>(docs: readonly D[], denied: Set<string>): D[] {
  if (!denied.size) return docs as D[];
  return docs.filter((d) => !docHidden(d.meta, denied));
}

/** Corrections a session may see: a proposal whose relatesTo names a hidden doc
 *  is dropped (parity across find_context / list_corrections / the web pending
 *  + rejected + knowledge_view endpoints). */
export function visibleCorrections<C extends Relatable>(
  corrections: readonly C[],
  hiddenNames: Set<string>,
): C[] {
  if (!hiddenNames.size) return corrections as C[];
  return corrections.filter((c) => !(c.relatesTo && hiddenNames.has(c.relatesTo)));
}
