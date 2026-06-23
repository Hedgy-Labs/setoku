// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { useApi } from "../hooks";
import { useAuth } from "../auth";
import { Loading, ErrorMsg, Flash } from "../components/Page";
import { Button } from "../components/Button";
import type { PublishedReport } from "../types";

/**
 * Render one published report. The agent-authored HTML is dropped into a
 * sandboxed iframe via `srcDoc` — WITHOUT allow-same-origin, so it runs in an
 * opaque origin and cannot touch the admin cookie, the /admin/api surface, or
 * this page's DOM. `allow-scripts` lets simple inline interactivity work; an
 * external script load is still blocked by the sandbox's network constraints.
 */
export function PublishedView() {
  const { id = "" } = useParams();
  const { me } = useAuth();
  const mayRevoke = me?.role === "admin";
  const { data, loading, error, reload } = useApi<PublishedReport>(() => api.publishedGet(id), [id]);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/admin/p/${id}`);
      setFlash("Link copied — recipients must sign in to the box to view.");
    } catch {
      setFlash(`${location.origin}/admin/p/${id}`);
    }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      const r = await api.unpublish(id);
      setFlash(r.flash ?? null);
      reload();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link to="/published" className="text-sm text-stone-500 hover:text-stone-800">
          ← Published
        </Link>
        <h1 className="flex-1 truncate text-lg font-semibold tracking-tight">{data?.title ?? "Report"}</h1>
        <Button variant="ghost" onClick={() => void copy()}>
          Copy link
        </Button>
        {mayRevoke && data && !data.revokedAt ? (
          <Button variant="ghost" disabled={busy} onClick={() => void revoke()}>
            Revoke
          </Button>
        ) : null}
      </div>
      {data ? (
        <div className="mb-3 text-xs text-stone-500">
          published by {data.createdBy} · {String(data.createdAt).slice(0, 16)}
        </div>
      ) : null}
      {flash ? <Flash>{flash}</Flash> : null}
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorMsg>{error}</ErrorMsg>
      ) : data ? (
        <iframe
          title={data.title}
          srcDoc={data.body}
          sandbox="allow-scripts"
          className="h-[calc(100vh-14rem)] w-full rounded-lg border border-stone-200 bg-white"
        />
      ) : null}
    </>
  );
}
