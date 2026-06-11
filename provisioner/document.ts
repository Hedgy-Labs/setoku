// SPDX-License-Identifier: Apache-2.0
/**
 * Self-documentation (Phase 4, task 4.6) — "the soul of the feature".
 *
 * When the provisioner creates a table, it documents that table immediately, so
 * every table arrives pre-documented. This is where the membrane (I2) has its
 * single labelled exception, and the split below is the whole point:
 *
 *   - The INITIAL ENTITY DOC for a table the provisioner just created is the
 *     auto-accept exception. It describes a table that did not exist a moment
 *     ago — there is nothing for a human to dispute yet — so it is written
 *     straight to curated context via upsertDoc, attributed `setoku-provisioner`
 *     with a revision history like any doc.
 *
 *   - PROVENANCE GOTCHAS are NOT auto-accepted. "Vercel/Render drains drop
 *     batches when the receiver is down; gaps ≠ traffic dips", "Render caps
 *     ~6k lines/min/instance", "Slack history before <start> is unavailable" —
 *     these are claims about the world that a human should confirm, so they go
 *     through the PENDING corrections queue via addCorrection (I2), exactly like
 *     any other proposed knowledge.
 *
 * The same function emits both, and the code makes the boundary explicit.
 */
import type { KnowledgeStore } from "../plugin/gateway/lib/store.ts";
import { PROVISIONER_ACTOR } from "./framework.ts";

export interface ColumnDoc {
  name: string;
  /** Column meaning — sourced from the ingest/schemas/ COMMENT (task 3.2). */
  meaning: string;
}

export interface TableDoc {
  /** Provisioning source the table belongs to. */
  source: string;
  /** ClickHouse table name (without the setoku. prefix). */
  table: string;
  columns: ColumnDoc[];
  /** Human description of refresh cadence (e.g. "live; drains POST batches"). */
  refreshCadence: string;
  /** Known-good example queries (clickhouse dialect). */
  exampleQueries: string[];
  /**
   * Provenance gotchas — claims a human should confirm. These do NOT
   * auto-accept; each becomes a PENDING correction (I2 / task 4.6).
   */
  gotchas?: string[];
}

export interface DocumentResult {
  /** The auto-accepted entity doc's name. */
  entityDoc: string;
  /** Correction ids created (pending) for each gotcha. */
  gotchaCorrectionIds: number[];
}

/**
 * Write the self-documentation for a created table.
 *
 * Returns the entity-doc name and the ids of the pending gotcha corrections so
 * callers can surface "documented X; queued N gotchas for review".
 */
export function documentTable(
  store: KnowledgeStore,
  doc: TableDoc,
): DocumentResult {
  // --- (1) the entity doc: AUTO-ACCEPTED via the membrane's I2 exception. ----
  const body = renderEntityBody(doc);
  store.upsertDoc(
    {
      type: "entity",
      name: doc.table,
      meta: {
        source: doc.source,
        table: doc.table,
        refresh_cadence: doc.refreshCadence,
        // Mark the provenance so curators can see this auto-accepted (I2).
        provisioned_by: PROVISIONER_ACTOR,
      },
      body,
    },
    // Attribution is load-bearing: this is WHY it may auto-accept (I2). The
    // upsert also writes a revision row, giving it history like any doc.
    PROVISIONER_ACTOR,
  );

  // --- (2) provenance gotchas: PENDING corrections, NOT auto-accepted. -------
  // These are claims about the world; a human confirms them on the approval
  // surface. They share the one membrane with every other proposal (I2).
  const gotchaCorrectionIds: number[] = [];
  for (const gotcha of doc.gotchas ?? []) {
    const id = store.addCorrection({
      user: PROVISIONER_ACTOR,
      kind: "gotcha",
      content: gotcha,
      relatesTo: doc.table,
    });
    gotchaCorrectionIds.push(id);
  }

  return { entityDoc: doc.table, gotchaCorrectionIds };
}

/** Render the entity doc markdown body from the column meanings + examples. */
function renderEntityBody(doc: TableDoc): string {
  const lines: string[] = [];
  lines.push(
    `**${doc.table}** — ${doc.source} data in the lake (\`setoku.${doc.table}\`).`,
  );
  lines.push("");
  lines.push(`Refresh: ${doc.refreshCadence}`);
  lines.push("");
  lines.push("## Columns");
  for (const c of doc.columns) {
    lines.push(`- \`${c.name}\` — ${c.meaning}`);
  }
  if (doc.exampleQueries.length > 0) {
    lines.push("");
    lines.push("## Example queries");
    for (const q of doc.exampleQueries) {
      lines.push("```sql");
      lines.push(q.trim());
      lines.push("```");
    }
  }
  return lines.join("\n");
}
