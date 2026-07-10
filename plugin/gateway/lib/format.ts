// SPDX-License-Identifier: Apache-2.0
/**
 * Shared, dependency-free display formatting. Lives alone so BOTH runtimes can
 * import it: server code (notify's Slack text) and the browser-bundled admin
 * SPA (which must not pull fs-touching modules like config.ts).
 */

/** Bytes for humans, in the units hosted-Postgres vendors bill (decimal).
 *  Honest at the edges: zero is "0", never a phantom floor; sub-GB values get
 *  MB/KB rather than a self-contradictory "0.0 GB". One rule for the Sources
 *  card, the Slack alert, and the threshold display — they must never disagree
 *  about the same number. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0";
  if (bytes < 1e3) return "<1 KB";
  if (bytes < 1e6) return `${Math.round(bytes / 1e3)} KB`;
  if (bytes < 1e8) return `${Math.round(bytes / 1e6)} MB`;
  const g = bytes / 1e9;
  return `${g >= 10 ? g.toFixed(0) : g.toFixed(1)} GB`;
}
