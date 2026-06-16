// SPDX-License-Identifier: Apache-2.0
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useApi } from "../hooks";
import { Heading, Loading, ErrorMsg } from "../components/Page";
import { Badge } from "../components/Badge";
import type { KnowledgeMember, KnowledgeView, SubjectGroup } from "../types";

/** small colored chip for a per-doc flag */
function Flag({ kind }: { kind: string }) {
  const tone =
    kind === "conflict"
      ? "bg-red-50 text-red-700 ring-red-200"
      : kind === "duplicate"
        ? "bg-amber-50 text-amber-700 ring-amber-200"
        : "bg-stone-100 text-stone-500 ring-stone-200";
  const label = kind === "verbose" ? "✂ verbose" : kind === "duplicate" ? "⧉ duplicate" : "⚠ conflict";
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tone}`}>{label}</span>
  );
}

function HealthBar({ h }: { h: KnowledgeView["health"] }) {
  const items: [string, number, boolean][] = [
    ["⚠ contradictions", h.contradictions, h.contradictions > 0],
    ["⧉ duplicates", h.duplicates, h.duplicates > 0],
    ["✂ verbose", h.verbose, false],
    ["⌫ stale", h.stale, h.stale > 0],
  ];
  return (
    <div className="mb-5 flex flex-wrap gap-2">
      {items.map(([label, n, warn]) => (
        <span
          key={label}
          className={`rounded-md px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${
            n === 0
              ? "bg-stone-50 text-stone-400 ring-stone-200"
              : warn
                ? "bg-red-50 text-red-700 ring-red-200"
                : "bg-stone-100 text-stone-600 ring-stone-300"
          }`}
        >
          {label}: {n}
        </span>
      ))}
    </div>
  );
}

export function Knowledge() {
  const { data, loading, error } = useApi<KnowledgeView>(() => api.knowledgeView(), []);
  const [q, setQ] = useState("");

  const subjects = useMemo(() => {
    const all = data?.subjects ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (s) =>
        s.label.toLowerCase().includes(needle) ||
        s.members.some(
          (m) => m.name.toLowerCase().includes(needle) || m.claim.toLowerCase().includes(needle),
        ),
    );
  }, [data, q]);

  return (
    <>
      <Heading title="Knowledge">
        Curated business context the analyst reads as ground truth — {data?.docs ?? 0} doc(s) across{" "}
        {data?.subjects.length ?? 0} subject(s). Read-only here: curated edits come from a curator
        session, and corrections land in{" "}
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
      ) : !data?.subjects.length ? (
        <div className="card p-8 text-center text-stone-500">
          No curated knowledge yet. Run <code className="kbd">/setoku:generate</code>.
        </div>
      ) : (
        <>
          <HealthBar h={data.health} />
          <input
            className="input mb-4 w-full"
            placeholder="Search subjects, facts…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {!subjects.length ? (
            <div className="card p-6 text-center text-sm text-stone-500">No subjects match “{q}”.</div>
          ) : (
            <div className="space-y-2">
              {subjects.map((s) => (
                <SubjectCard key={s.key} s={s} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

function memberSummary(s: SubjectGroup): string {
  // "metric +2 gotcha" — headline type plus the rest by type
  const counts = new Map<string, number>();
  for (const m of s.members) counts.set(m.type, (counts.get(m.type) ?? 0) + 1);
  const parts: string[] = [];
  // headline first
  parts.push(s.primaryType);
  for (const [t, n] of counts) {
    if (t === s.primaryType) continue;
    parts.push(`+${n} ${t}`);
  }
  return parts.join(" ");
}

function SubjectCard({ s }: { s: SubjectGroup }) {
  const review = s.flags.includes("review");
  return (
    <details className="card group" open={review}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="text-stone-400 transition group-open:rotate-90">›</span>
        <span className="flex-1 font-medium text-stone-800">{s.label}</span>
        <span className="text-xs text-stone-400">{memberSummary(s)}</span>
        {review ? <Badge tone="down">⚠ review</Badge> : <Badge tone="ok">✓</Badge>}
      </summary>
      <div className="space-y-1 border-t border-stone-200 px-4 py-3">
        {s.members.map((m) => (
          <MemberRow key={`${m.type}:${m.name}`} m={m} />
        ))}
      </div>
    </details>
  );
}

function MemberRow({ m }: { m: KnowledgeMember }) {
  const hasDetail = m.body && m.body.trim() && m.body.trim() !== m.claim.trim();
  return (
    <details className="group/m">
      <summary className="flex cursor-pointer list-none items-start gap-2 py-1 [&::-webkit-details-marker]:hidden">
        <span className="mt-0.5 text-stone-300">·</span>
        <span className="flex-1 text-sm leading-relaxed text-stone-700">{m.claim}</span>
        {m.flags.map((f) => (
          <Flag key={f} kind={f} />
        ))}
      </summary>
      {hasDetail ? (
        <div className="ml-4 mb-1 whitespace-pre-wrap border-l-2 border-stone-100 pl-3 text-xs leading-relaxed text-stone-500">
          {m.body}
        </div>
      ) : null}
    </details>
  );
}
