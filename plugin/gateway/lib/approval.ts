// SPDX-License-Identifier: Apache-2.0
/**
 * The web approval surface (Phase 5.5/5.6 — the membrane's human side).
 *
 * This is the "outside the agent loop" accept path that I2/I9 require: a human
 * reads a pending proposal and clicks Approve/Reject. The action is an HTTP
 * POST from a browser form — NOT an MCP tool — so a prompt-injected agent can
 * never reach it, whatever its credential. Agents only ever *propose*
 * (report_correction → pending); knowledge enters curated context only here.
 *
 * Interim scope (until Phase 5.1 OAuth lands): auth reuses the per-user bearer
 * token via the URL path (/admin/<token>), the same mechanism as /mcp/<token>.
 * That carries the known token-in-URL tradeoff (referer/history leakage) and
 * does not yet role-gate *who* may approve — any valid token can. Both are
 * Phase 5 refinements; the security property that matters now — no agent/MCP
 * tool can commit — holds regardless.
 *
 * SECURITY: correction content is attacker-influenceable (it can be distilled
 * from Slack/logs), so every dynamic value is HTML-escaped before rendering.
 */
import type { KnowledgeStore } from "./store";

/** Escape for HTML text/attribute context. */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** kebab slug for a gotcha doc name derived from its content. */
function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "gotcha"
  );
}

const PAGE_CSS = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 820px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1rem; margin-top: 2rem; color: #888; }
  .item { border: 1px solid #8884; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  .meta { color: #888; font-size: 0.85rem; margin-bottom: 0.5rem; }
  .kind { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 4px; background: #8883; font-size: 0.8rem; }
  .content { white-space: pre-wrap; margin: 0.5rem 0; }
  form { display: inline; }
  button { font: inherit; padding: 0.35rem 0.9rem; border-radius: 6px; border: 1px solid #8886; cursor: pointer; }
  button.approve { background: #2e7d32; color: #fff; border-color: #2e7d32; }
  button.reject { background: transparent; }
  textarea { width: 100%; box-sizing: border-box; margin: 0.4rem 0; font: inherit; }
  .empty { color: #888; }
  .note { color: #888; font-size: 0.85rem; border-left: 3px solid #8884; padding-left: 0.8rem; }
`;

/**
 * Render the pending-corrections approval page. `basePath` is /admin/<token>
 * (forms post back to it) — never logged, never shown except in the action URL.
 */
export function renderApprovalPage(
  store: KnowledgeStore,
  identity: string,
  basePath: string,
  flash?: string,
): string {
  const pending = store.listCorrections("pending");
  const items = pending
    .map(
      (c) => `
    <div class="item">
      <div class="meta">
        <span class="kind">${esc(c.kind)}</span>
        #${esc(c.id)} · proposed by ${esc(c.user)} · ${esc(String(c.ts).slice(0, 16))}${
          c.relatesTo ? ` · re: ${esc(c.relatesTo)}` : ""
        }
      </div>
      <div class="content">${esc(c.content)}</div>
      <form method="POST" action="${esc(basePath)}/resolve">
        <input type="hidden" name="id" value="${esc(c.id)}">
        <textarea name="reason" rows="1" placeholder="reason (optional for approve, recommended for reject)"></textarea>
        <button class="approve" name="action" value="accepted">Approve</button>
        <button class="reject" name="action" value="rejected">Reject</button>
      </form>
    </div>`,
    )
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Setoku — pending knowledge</title><style>${PAGE_CSS}</style></head><body>
<h1>Setoku — pending knowledge</h1>
<p class="meta">Signed in as ${esc(identity)}. These are proposals from agents and teammates;
nothing here is curated until you approve it. Approving a gotcha folds it into
verified context immediately; other kinds are recorded for a curator session.</p>
${flash ? `<p class="note">${esc(flash)}</p>` : ""}
<h2>Pending (${pending.length})</h2>
${pending.length ? items : '<p class="empty">Nothing pending. 🎉</p>'}
<p class="note">This is the only path knowledge enters curated context (I2/I9):
a human clicks here, outside any agent. Agents can only propose.</p>
</body></html>`;
}

/**
 * Apply a human approve/reject decision. Returns a flash message for the
 * redirect. The COMMIT happens here, driven by the human's POST — for an
 * accepted gotcha we fold it straight into curated context (a clean mapping);
 * other kinds are marked accepted and left for a curator session to shape into
 * a metric/entity doc (we don't synthesize structured docs from free text).
 */
export function applyApprovalAction(
  store: KnowledgeStore,
  identity: string,
  params: { id: number; action: "accepted" | "rejected"; reason?: string },
): string {
  const { id, action, reason } = params;
  const pending = store.listCorrections("pending");
  const corr = pending.find((c) => c.id === id);
  if (!corr) return `#${id} is not pending (already resolved?).`;

  const ok = store.resolveCorrection(id, action, identity);
  if (!ok) return `#${id} could not be resolved (already resolved?).`;

  let folded = false;
  if (action === "accepted" && corr.kind === "gotcha") {
    store.upsertDoc(
      {
        type: "gotcha",
        name: slug(corr.content),
        body: corr.content,
        meta: corr.relatesTo ? { relates_to: corr.relatesTo } : {},
      },
      identity,
    );
    folded = true;
  }
  store.audit(identity, `approval_${action}`, {
    id,
    kind: corr.kind,
    folded,
    reason: reason || null,
  });

  if (action === "rejected") return `#${id} rejected.`;
  return folded
    ? `#${id} approved — folded into verified context.`
    : `#${id} approved (recorded; shape it into a doc in a curator session).`;
}
