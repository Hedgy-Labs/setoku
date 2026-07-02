// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks";
import { useAuth } from "../auth";
import { Heading, Loading, ErrorMsg } from "../components/Page";
import { KnowledgeTabs } from "../components/KnowledgeTabs";
import { toast } from "../components/Toast";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import type { Correction, CorrectionDraft } from "../types";

const DOC_TYPES = ["entity", "metric", "query", "overview", "gotcha"] as const;

/** Flags that block a clean approve (red) vs advisory ones (muted). */
const FLAG_TONE: Record<string, "down" | "idle"> = {
  contradiction: "down",
  lint: "down",
  dupe: "idle",
  provenance: "idle",
};

/** Map a correction kind to the doc type a hand-authored draft should default to. */
function defaultTypeForKind(kind: string): CorrectionDraft["type"] {
  return (DOC_TYPES as readonly string[]).includes(kind)
    ? (kind as CorrectionDraft["type"])
    : "gotcha";
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-");
}

/** A draft to seed the editor when a correction has none yet (non-gotcha kinds
 *  before the auto-draft job runs). Pre-fills from the proposal so the human
 *  only tweaks, never types from scratch. */
function seedDraft(c: Correction): CorrectionDraft {
  const claim = c.fact ?? c.content;
  return {
    type: defaultTypeForKind(c.kind),
    name: slug(c.relatesTo || claim) || `note-${c.id}`,
    body: claim,
    meta: c.relatesTo ? { relates_to: c.relatesTo, proposed_by: c.user } : { proposed_by: c.user },
  };
}

export function Review() {
  const { me } = useAuth();
  const mayApprove = me?.role === "admin";
  const { data, loading, error, reload } = useApi<Correction[]>(() => api.pending(), []);
  const [busy, setBusy] = useState<number | null>(null);

  const resolve = async (
    id: number,
    action: "accepted" | "rejected",
    reason: string,
    draft?: CorrectionDraft,
  ) => {
    setBusy(id);
    try {
      const r = await api.resolve(id, action, reason || undefined, draft);
      if (r.flash) toast(r.flash);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Heading title="Knowledge">
        Knowledge your agents proposed, waiting on a human. Each proposal is shown as a finished,
        ready-to-approve change — approving commits it to curated knowledge, and that click is the only
        path in: agents can only propose.
      </Heading>
      <KnowledgeTabs pending={data?.length} />
      {!mayApprove ? (
        <div className="mb-4 rounded-lg border border-stone-300 bg-stone-100 px-3 py-2 text-sm text-stone-600">
          You are signed in as a <b className="text-stone-800">member</b> — viewing only. Ask an admin to
          approve.
        </div>
      ) : null}
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorMsg>{error}</ErrorMsg>
      ) : (
        <>
          <div className="mb-3 text-xs font-medium uppercase tracking-wide text-stone-500">
            Pending ({data?.length ?? 0})
          </div>
          <div className="space-y-3">
            {data && data.length ? (
              data.map((c) => (
                <ReviewCard key={c.id} c={c} mayApprove={mayApprove} busy={busy === c.id} onResolve={resolve} />
              ))
            ) : (
              <div className="card p-8 text-center text-stone-500">Nothing pending. 🎉</div>
            )}
          </div>
          <RejectedSection mayApprove={mayApprove} />
        </>
      )}
    </>
  );
}

function ReviewCard({
  c,
  mayApprove,
  busy,
  onResolve,
}: {
  c: Correction;
  mayApprove: boolean;
  busy: boolean;
  onResolve: (id: number, action: "accepted" | "rejected", reason: string, draft?: CorrectionDraft) => void;
}) {
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState(false);
  // the live draft being reviewed: the server's (auto-drafted or synthesized
  // gotcha default), else a seed pre-filled from the proposal.
  const [draft, setDraft] = useState<CorrectionDraft>(c.draft ?? seedDraft(c));
  const hasServerDraft = c.draft != null;

  return (
    <div className="card p-4">
      {/* ---- the raw proposal ---- */}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-stone-500">
        <Badge tone="idle">{c.kind}</Badge>
        <span className="font-mono text-stone-600">#{c.id}</span>
        <span>
          proposed by {c.user} · {String(c.ts).slice(0, 16)}
          {c.relatesTo ? ` · re: ${c.relatesTo}` : ""}
        </span>
        {c.flags?.map((f) => (
          <Badge key={f} tone={FLAG_TONE[f] ?? "idle"}>
            {f}
          </Badge>
        ))}
      </div>
      <div className="whitespace-pre-wrap text-sm leading-relaxed text-stone-800">{c.fact ?? c.content}</div>
      {c.fact && c.content && c.content !== c.fact ? (
        <div className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-stone-500">context: {c.content}</div>
      ) : null}

      {/* ---- the drafted change (what approving commits) ---- */}
      <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-xs font-medium uppercase tracking-wide text-stone-500">
            {hasServerDraft || c.kind === "gotcha" ? "Drafted change — commits on approve" : "No draft yet"}
            {c.draftedBy ? <span className="ml-1 font-normal normal-case text-stone-400">by {c.draftedBy}</span> : null}
          </div>
          {mayApprove && !editing ? (
            <button className="text-xs font-medium text-stone-500 hover:text-stone-800" onClick={() => setEditing(true)}>
              {hasServerDraft || c.kind === "gotcha" ? "Edit" : "Add draft"}
            </button>
          ) : null}
        </div>
        {editing ? (
          <DraftEditor draft={draft} onChange={setDraft} />
        ) : (
          <DraftPreview draft={draft} />
        )}
      </div>

      {mayApprove ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            className="input min-w-[12rem] flex-1"
            placeholder="reason (optional for approve, recommended for reject)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button
            variant="primary"
            disabled={busy || !draft.name.trim() || !draft.body.trim()}
            onClick={() => onResolve(c.id, "accepted", reason, draft)}
          >
            Approve
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => onResolve(c.id, "rejected", reason)}>
            Reject
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Read-only render of the draft a card will commit. */
function DraftPreview({ draft }: { draft: CorrectionDraft }) {
  const metaEntries = Object.entries(draft.meta ?? {}).filter(([k]) => k !== "proposed_by");
  return (
    <div>
      <div className="mb-1 font-mono text-xs text-stone-600">
        [{draft.type}] {draft.name}
      </div>
      {metaEntries.length ? (
        <div className="mb-1 text-xs text-stone-500">
          {metaEntries.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join(" · ")}
        </div>
      ) : null}
      <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-stone-800">{draft.body}</pre>
    </div>
  );
}

/** Editable draft: type, name, body. Meta is preserved as-is from the seed. */
function DraftEditor({ draft, onChange }: { draft: CorrectionDraft; onChange: (d: CorrectionDraft) => void }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="input w-auto"
          value={draft.type}
          onChange={(e) => onChange({ ...draft, type: e.target.value as CorrectionDraft["type"] })}
        >
          {DOC_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          className="input flex-1"
          placeholder="doc name"
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
      </div>
      <textarea
        className="input min-h-[6rem] font-mono text-xs"
        placeholder="doc body (for a metric, the canonical SQL)"
        value={draft.body}
        onChange={(e) => onChange({ ...draft, body: e.target.value })}
      />
    </div>
  );
}

/** Collapsible list of rejected items (esp. bot-rejected) with un-reject —
 *  makes a janitor that suppresses good proposals visible and reversible. */
function RejectedSection({ mayApprove }: { mayApprove: boolean }) {
  const [open, setOpen] = useState(false);
  const { data, reload } = useApi<Correction[]>(() => api.rejected(), []);
  const botRejected = (data ?? []).filter((c) => c.rejectedByBot);
  if (!botRejected.length) return null;

  const unreject = async (id: number) => {
    try {
      const r = await api.unreject(id);
      if (r.flash) toast(r.flash);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed.");
    }
  };

  return (
    <div className="mt-6">
      <button
        className="text-xs font-medium uppercase tracking-wide text-stone-500 hover:text-stone-800"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "▾" : "▸"} Auto-rejected by the janitor ({botRejected.length})
      </button>
      {open ? (
        <div className="mt-2 space-y-2">
          {botRejected.map((c) => (
            <div key={c.id} className="card flex items-start justify-between gap-3 p-3">
              <div className="min-w-0">
                <div className="text-xs text-stone-500">
                  <span className="font-mono">#{c.id}</span> [{c.kind}] · {c.user}
                </div>
                <div className="truncate text-sm text-stone-700">{c.fact ?? c.content}</div>
                {c.rejectReason ? (
                  <div className="mt-0.5 text-xs text-red-600">reason: {c.rejectReason}</div>
                ) : null}
              </div>
              {mayApprove ? (
                <Button variant="ghost" onClick={() => unreject(c.id)}>
                  Un-reject
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
