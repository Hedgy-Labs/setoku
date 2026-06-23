// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useApi } from "../hooks";
import { useAuth } from "../auth";
import { Heading, Loading, ErrorMsg, Flash } from "../components/Page";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import type { PublishedMeta } from "../types";

/** Absolute URL for a report — what gets copied/shared (team-only to open). */
const shareUrl = (id: string): string => `${location.origin}/admin/p/${id}`;

export function Published() {
  const { me } = useAuth();
  const mayRevoke = me?.role === "admin";
  const { data, loading, error, reload } = useApi<PublishedMeta[]>(() => api.published(), []);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const copy = async (id: string) => {
    try {
      await navigator.clipboard.writeText(shareUrl(id));
      setFlash("Link copied — anyone you send it to must sign in to the box to view.");
    } catch {
      setFlash(shareUrl(id));
    }
  };

  const revoke = async (id: string) => {
    setBusy(id);
    try {
      const r = await api.unpublish(id);
      setFlash(r.flash ?? null);
      reload();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(null);
    }
  };

  const active = data?.filter((r) => !r.revokedAt) ?? [];
  const revoked = data?.filter((r) => r.revokedAt) ?? [];

  return (
    <>
      <Heading title="Published">
        Reports agents published to this box. Links are <b className="text-stone-800">team-only</b> — a viewer
        must sign in here to open one, so they're safe to share internally but never public.
      </Heading>
      {flash ? <Flash>{flash}</Flash> : null}
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
              active.map((r) => (
                <div key={r.id} className="card flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-[12rem] flex-1">
                    <Link to={`/p/${r.id}`} className="text-sm font-medium text-stone-900 hover:underline">
                      {r.title}
                    </Link>
                    <div className="mt-0.5 text-xs text-stone-500">
                      {r.createdBy} · {String(r.createdAt).slice(0, 16)}
                    </div>
                  </div>
                  <Link to={`/p/${r.id}`} className="btn btn-ghost">
                    View
                  </Link>
                  <Button variant="ghost" onClick={() => void copy(r.id)}>
                    Copy link
                  </Button>
                  {mayRevoke ? (
                    <Button variant="ghost" disabled={busy === r.id} onClick={() => void revoke(r.id)}>
                      Revoke
                    </Button>
                  ) : null}
                </div>
              ))
            ) : (
              <div className="card p-8 text-center text-stone-500">
                Nothing published yet. An agent publishes with the <code className="kbd">publish_report</code> tool.
              </div>
            )}
          </div>
          {revoked.length ? (
            <>
              <div className="mb-3 mt-8 text-xs font-medium uppercase tracking-wide text-stone-500">
                Revoked ({revoked.length})
              </div>
              <div className="space-y-2">
                {revoked.map((r) => (
                  <div key={r.id} className="card flex items-center gap-3 p-3 opacity-60">
                    <span className="flex-1 text-sm text-stone-600">{r.title}</span>
                    <Badge tone="idle">revoked</Badge>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </>
      )}
    </>
  );
}
