// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks";
import { useAuth } from "../auth";
import { Heading, Loading, ErrorMsg, Flash } from "../components/Page";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import type { Correction } from "../types";

export function Pending() {
  const { me } = useAuth();
  const mayApprove = me?.role === "admin";
  const { data, loading, error, reload } = useApi<Correction[]>(() => api.pending(), []);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const resolve = async (id: number, action: "accepted" | "rejected", reason: string) => {
    setBusy(id);
    try {
      const r = await api.resolve(id, action, reason || undefined);
      setFlash(r.flash ?? null);
      reload();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Heading title="Pending knowledge">
        Proposals from agents and teammates. Nothing is curated until an admin approves it — this is the
        only path into verified context, and agents can only propose.
      </Heading>
      {flash ? <Flash>{flash}</Flash> : null}
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
                <PendingCard key={c.id} c={c} mayApprove={mayApprove} busy={busy === c.id} onResolve={resolve} />
              ))
            ) : (
              <div className="card p-8 text-center text-stone-500">Nothing pending. 🎉</div>
            )}
          </div>
        </>
      )}
    </>
  );
}

function PendingCard({
  c,
  mayApprove,
  busy,
  onResolve,
}: {
  c: Correction;
  mayApprove: boolean;
  busy: boolean;
  onResolve: (id: number, action: "accepted" | "rejected", reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="card p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-stone-500">
        <Badge tone="idle">{c.kind}</Badge>
        <span className="font-mono text-stone-600">#{c.id}</span>
        <span>
          proposed by {c.user} · {String(c.ts).slice(0, 16)}
          {c.relatesTo ? ` · re: ${c.relatesTo}` : ""}
        </span>
      </div>
      <div className="whitespace-pre-wrap text-sm leading-relaxed text-stone-800">{c.content}</div>
      {mayApprove ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            className="input min-w-[12rem] flex-1"
            placeholder="reason (optional for approve, recommended for reject)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button variant="primary" disabled={busy} onClick={() => onResolve(c.id, "accepted", reason)}>
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
