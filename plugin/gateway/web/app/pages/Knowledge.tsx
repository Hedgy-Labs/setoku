// SPDX-License-Identifier: Apache-2.0
import { Link } from "react-router-dom";
import { api } from "../api";
import { useApi } from "../hooks";
import { Heading, Loading, ErrorMsg } from "../components/Page";
import { Badge } from "../components/Badge";
import type { KnowledgeDoc } from "../types";

const ORDER = ["overview", "entity", "metric", "query", "gotcha"];

export function Knowledge() {
  const { data, loading, error } = useApi<KnowledgeDoc[]>(() => api.knowledge(), []);
  const docs = data ?? [];
  const byType = new Map<string, KnowledgeDoc[]>();
  for (const d of docs) {
    const arr = byType.get(d.type) ?? [];
    arr.push(d);
    byType.set(d.type, arr);
  }

  return (
    <>
      <Heading title="Knowledge">
        Curated business context the analyst reads as ground truth — {docs.length} doc(s). Read-only
        here: curated edits come from a curator session, and corrections land in{" "}
        <Link
          className="font-medium text-stone-900 underline decoration-stone-400 underline-offset-2 hover:decoration-stone-600"
          to="/"
        >
          Pending
        </Link>{" "}
        for review.
      </Heading>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorMsg>{error}</ErrorMsg>
      ) : !docs.length ? (
        <div className="card p-8 text-center text-stone-500">
          No curated knowledge yet. Run <code className="kbd">/setoku:generate</code>.
        </div>
      ) : (
        ORDER.filter((t) => byType.get(t)?.length).map((type) => {
          const list = [...(byType.get(type) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
          return (
            <section key={type} className="mb-6">
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-500">
                {type} ({list.length})
              </h2>
              <div className="space-y-2">
                {list.map((d) => (
                  <DocCard key={d.name} d={d} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </>
  );
}

function DocCard({ d }: { d: KnowledgeDoc }) {
  const meta = Object.entries(d.meta ?? {});
  return (
    <details className="card group">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 font-medium text-stone-800 [&::-webkit-details-marker]:hidden">
        <span className="text-stone-500 transition group-open:rotate-90">›</span>
        <span className="flex-1">{d.name}</span>
        <Badge tone={d.verified ? "ok" : "idle"}>{d.verified ? "verified" : "unverified"}</Badge>
      </summary>
      <div className="border-t border-stone-200 px-4 py-3">
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-stone-700">{d.body}</div>
        <div className="mt-3 text-xs text-stone-500">
          {meta.map(([k, v]) => (
            <span key={k}>
              <code className="kbd">{k}</code> {Array.isArray(v) ? v.join(", ") : v} ·{" "}
            </span>
          ))}
          updated by {d.updatedBy ?? "—"}
          {d.updatedAt ? " · " + String(d.updatedAt).slice(0, 16) : ""}
        </div>
      </div>
    </details>
  );
}
