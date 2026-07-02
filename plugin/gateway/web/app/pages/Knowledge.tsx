// SPDX-License-Identifier: Apache-2.0
import { type ReactNode, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useApi } from "../hooks";
import { Heading, Loading, ErrorMsg } from "../components/Page";
import { KnowledgeTabs } from "../components/KnowledgeTabs";
import { Badge } from "../components/Badge";
import { Markdown } from "../components/Markdown";
import { KnowledgeGraph } from "../components/KnowledgeGraph";
import type { Correction, KnowledgeMember, KnowledgeView, SubjectGroup } from "../types";

/* The active worklist/filter. Search (`q`) layers on top of any of these.
 *  - flag: subjects with a member carrying that per-doc flag
 *  - type: subjects of a given primaryType (the map spine)
 *  - panel: a pair/edge list (connections, broken links) — not a subject filter */
type View =
  | { kind: "flag"; flag: string }
  | { kind: "type"; type: string }
  | { kind: "panel"; panel: "connections" | "brokenLinks" }
  | null;

function sameView(a: View, b: View): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "flag" && b.kind === "flag") return a.flag === b.flag;
  if (a.kind === "type" && b.kind === "type") return a.type === b.type;
  if (a.kind === "panel" && b.kind === "panel") return a.panel === b.panel;
  return false;
}

/** small chip for a per-doc flag */
function Flag({ kind }: { kind: string }) {
  const tone =
    kind === "conflict"
      ? "bg-red-50 text-red-700 ring-red-200"
      : "bg-stone-100 text-stone-500 ring-stone-200";
  const label =
    kind === "verbose"
      ? "✂ verbose"
      : kind === "duplicate"
        ? "⧉ duplicate"
        : kind === "orphan"
          ? "⚲ orphan"
          : "⚠ conflict";
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tone}`}>{label}</span>
  );
}

/** One health/worklist chip. Non-zero counts are clickable filters; zero is muted. */
function HealthChip({
  label,
  n,
  warn,
  active,
  onClick,
}: {
  label: string;
  n: number;
  warn?: boolean;
  active?: boolean;
  onClick?: () => void;
}) {
  const base = "rounded-md px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition";
  const clickable = n > 0 && !!onClick;
  const tone =
    n === 0
      ? "bg-stone-50 text-stone-400 ring-stone-200"
      : active
        ? "bg-stone-800 text-white ring-stone-800"
        : warn
          ? "bg-red-50 text-red-700 ring-red-200"
          : "bg-stone-100 text-stone-600 ring-stone-300";
  if (!clickable) {
    return (
      <span className={`${base} ${tone}`} aria-disabled>
        {label}: {n}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`${base} ${tone} cursor-pointer ${
        active ? "" : warn ? "hover:bg-red-100" : "hover:bg-stone-200"
      }`}
    >
      {label}: {n}
    </button>
  );
}

function HealthBar({
  h,
  view,
  toggle,
}: {
  h: KnowledgeView["health"];
  view: View;
  toggle: (v: View) => void;
}) {
  const flag = (f: string): View => ({ kind: "flag", flag: f });
  const panel = (p: "connections" | "brokenLinks"): View => ({ kind: "panel", panel: p });
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      <HealthChip
        label="⚠ contradictions"
        n={h.contradictions}
        warn
        active={sameView(view, flag("conflict"))}
        onClick={() => toggle(flag("conflict"))}
      />
      <HealthChip
        label="⧉ duplicates"
        n={h.duplicates}
        active={sameView(view, flag("duplicate"))}
        onClick={() => toggle(flag("duplicate"))}
      />
      <HealthChip
        label="✂ verbose"
        n={h.verbose}
        active={sameView(view, flag("verbose"))}
        onClick={() => toggle(flag("verbose"))}
      />
      <HealthChip
        label="⚲ orphans"
        n={h.orphans}
        active={sameView(view, flag("orphan"))}
        onClick={() => toggle(flag("orphan"))}
      />
      <HealthChip
        label="⇄ suggested links"
        n={h.suggestedLinks}
        active={sameView(view, panel("connections"))}
        onClick={() => toggle(panel("connections"))}
      />
      <HealthChip
        label="⛓ broken links"
        n={h.brokenLinks}
        warn
        active={sameView(view, panel("brokenLinks"))}
        onClick={() => toggle(panel("brokenLinks"))}
      />
      {/* stale has no per-subject mapping (only fires with a known-source set) —
          shown for completeness, never clickable */}
      <HealthChip label="⌫ stale" n={h.stale} warn />
    </div>
  );
}

const TYPE_LABEL: Record<string, string> = {
  overview: "overview",
  entity: "entities",
  metric: "metrics",
  query: "queries",
  gotcha: "gotchas",
};

function pct(sim: number): string {
  return `${(sim * 100).toFixed(0)}%`;
}

/** A clickable doc-name token that navigates to that doc's page. */
function DocLink({ name, onNav }: { name: string; onNav: (name: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onNav(name)}
      className="cursor-pointer font-medium text-stone-700 underline decoration-stone-300 underline-offset-2 hover:decoration-stone-600"
    >
      {name}
    </button>
  );
}

function ConnectionsPanel({
  rows,
  onNav,
}: {
  rows: KnowledgeView["connections"];
  onNav: (name: string) => void;
}) {
  if (!rows.length)
    return <div className="card p-6 text-center text-sm text-stone-500">No suggested links.</div>;
  return (
    <div className="card divide-y divide-stone-100">
      {rows.map((c, i) => (
        <div key={`${c.a}:${c.b}:${i}`} className="px-4 py-2.5 text-sm">
          <div className="flex flex-wrap items-center gap-1.5 text-stone-700">
            <DocLink name={c.a} onNav={onNav} />
            <span className="text-stone-400">↔</span>
            <DocLink name={c.b} onNav={onNav} />
            <span className="text-xs text-stone-400">({pct(c.similarity)} overlap)</span>
          </div>
          <div className="mt-0.5 text-xs text-stone-400">{c.reason}</div>
        </div>
      ))}
    </div>
  );
}

function BrokenLinksPanel({
  rows,
  onNav,
}: {
  rows: KnowledgeView["brokenLinks"];
  onNav: (name: string) => void;
}) {
  if (!rows.length)
    return <div className="card p-6 text-center text-sm text-stone-500">No broken links.</div>;
  return (
    <div className="card divide-y divide-stone-100">
      {rows.map((b, i) => (
        <div key={`${b.from}:${b.ref}:${i}`} className="flex flex-wrap items-center gap-1.5 px-4 py-2.5 text-sm">
          <DocLink name={b.from} onNav={onNav} />
          <span className="text-stone-400">→</span>
          <span className="font-medium text-red-700">{b.ref}</span>
          <span className="text-xs text-stone-400">(no such doc)</span>
        </div>
      ))}
    </div>
  );
}

function attribution(m: KnowledgeMember): string {
  const parts: string[] = [];
  if (m.proposedBy && m.proposedBy !== m.updatedBy) {
    parts.push(`proposed by ${m.proposedBy}`);
    if (m.updatedBy) parts.push(`approved by ${m.updatedBy}`);
  } else if (m.updatedBy) {
    parts.push(`by ${m.updatedBy}`);
  }
  if (m.updatedAt) parts.push(String(m.updatedAt).slice(0, 10));
  return parts.join(" · ");
}

/* ──────────────────────  Catalog (the data dictionary)  ─────────────────── */
//
// The default human view: type-sectioned tables (Metrics, Entities, Queries,
// Gotchas) — a scannable data dictionary, not a wiki-prose landing or a flat
// list. Each row clicks through to the existing SubjectPage detail.

/** The subject's primary doc — the member matching its headline type. */
function primaryMember(s: SubjectGroup): KnowledgeMember {
  return s.members.find((m) => m.type === s.primaryType) ?? s.members[0];
}

/** Strip markdown emphasis (**bold**, `code`, leading #) and collapse whitespace
 *  so a claim reads as plain text in a dense row. */
function plainText(s: string): string {
  return String(s ?? "")
    .replace(/`+/g, "")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/^\s*#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trim()}…` : s;
}

/** First fenced code block in a doc body (the SQL for a metric), or null. */
function firstCodeBlock(body: string): string | null {
  const lines = String(body ?? "").replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      const joined = code.join("\n").trim();
      return joined || null;
    }
  }
  return null;
}

/** A "table: X" line if trivially present in the body (no fabrication). */
function tableLine(body: string): string | null {
  const m = String(body ?? "").match(/^\s*table:\s*(.+)$/im);
  return m ? plainText(m[1]) : null;
}

/** Dedupe a directional link count across the subject's members (skip self-refs). */
function linkCount(s: SubjectGroup, dir: "links" | "backlinks"): number {
  const own = new Set(s.members.map((m) => m.name));
  const seen = new Set<string>();
  for (const m of s.members) for (const r of m[dir]) if (!own.has(r)) seen.add(r);
  return seen.size;
}

function usesTotal(s: SubjectGroup): number {
  return s.members.reduce((n, m) => n + m.uses, 0);
}

function gotchaCount(s: SubjectGroup): number {
  return s.members.filter((m) => m.type === "gotcha").length;
}

/** ✓ when the primary doc is verified; a muted ⚠ when the subject needs review. */
function StatusBadge({ s }: { s: SubjectGroup }) {
  if (s.flags.includes("review"))
    return (
      <span className="rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset bg-red-50 text-red-700 ring-red-200">
        ⚠
      </span>
    );
  return primaryMember(s).verified ? (
    <span className="text-xs text-stone-400" title="verified">
      ✓
    </span>
  ) : (
    <span className="text-xs text-stone-300" title="unverified">
      ·
    </span>
  );
}

/** A small right-aligned counter chip (→3, ←2, 5×, …). */
function Meta({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="tabular-nums text-xs text-stone-400" title={title}>
      {children}
    </span>
  );
}

/** Section header + a divided table of rows; renders nothing when empty. */
function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  if (!count) return null;
  return (
    <section className="mb-6">
      <h3 className="mb-1.5 flex items-baseline gap-2 px-1 text-sm font-semibold text-stone-700">
        {title}
        <span className="text-xs font-normal text-stone-400">{count}</span>
      </h3>
      <div className="card divide-y divide-stone-100">{children}</div>
    </section>
  );
}

/** Shared row shell: clickable (opens detail), keyboard-accessible, hover-lit. */
function Row({ onOpen, children }: { onOpen: () => void; children: ReactNode }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group flex cursor-pointer items-center gap-3 px-4 py-2.5 transition hover:bg-stone-50"
    >
      {children}
    </div>
  );
}

function MetricRow({ s, onOpen }: { s: SubjectGroup; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const m = primaryMember(s);
  const sql = firstCodeBlock(m.body);
  const links = linkCount(s, "links");
  const uses = usesTotal(s);
  return (
    <div>
      <Row onOpen={onOpen}>
        <span className="w-44 shrink-0 truncate font-medium text-stone-800" title={s.label}>
          {s.label}
        </span>
        <span className="flex-1 truncate text-sm text-stone-500" title={plainText(m.claim)}>
          {clip(plainText(m.claim), 110)}
        </span>
        {sql ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
            aria-expanded={open}
            className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-xs font-medium text-stone-500 ring-1 ring-inset ring-stone-200 transition hover:bg-stone-100"
          >
            SQL {open ? "▾" : "▸"}
          </button>
        ) : null}
        {links ? <Meta title="outbound links">→{links}</Meta> : null}
        {uses ? <Meta title="times surfaced">{uses}×</Meta> : null}
        <StatusBadge s={s} />
      </Row>
      {open && sql ? (
        <pre className="overflow-x-auto border-t border-stone-100 bg-stone-50 px-4 py-2.5 font-mono text-xs leading-relaxed text-stone-700">
          {sql}
        </pre>
      ) : null}
    </div>
  );
}

function EntityRow({ s, onOpen }: { s: SubjectGroup; onOpen: () => void }) {
  const m = primaryMember(s);
  const table = tableLine(m.body);
  const gotchas = gotchaCount(s);
  const links = linkCount(s, "links");
  const backlinks = linkCount(s, "backlinks");
  const uses = usesTotal(s);
  return (
    <Row onOpen={onOpen}>
      <span className="w-44 shrink-0 truncate font-medium text-stone-800" title={s.label}>
        {s.label}
      </span>
      <span className="flex-1 truncate text-sm text-stone-500" title={plainText(m.claim)}>
        {clip(plainText(m.claim), 110)}
      </span>
      {table ? (
        <span className="shrink-0 rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[11px] text-stone-500">
          {table}
        </span>
      ) : null}
      {gotchas ? (
        <Meta title="attached gotchas">
          {gotchas} gotcha{gotchas === 1 ? "" : "s"}
        </Meta>
      ) : null}
      {links ? <Meta title="outbound links">→{links}</Meta> : null}
      {backlinks ? <Meta title="backlinks">←{backlinks}</Meta> : null}
      {uses ? <Meta title="times surfaced">{uses}×</Meta> : null}
      <StatusBadge s={s} />
    </Row>
  );
}

function QueryRow({ s, onOpen }: { s: SubjectGroup; onOpen: () => void }) {
  const m = primaryMember(s);
  const links = linkCount(s, "links");
  return (
    <Row onOpen={onOpen}>
      <span className="w-44 shrink-0 truncate font-medium text-stone-800" title={s.label}>
        {s.label}
      </span>
      <span className="flex-1 truncate text-sm text-stone-500" title={plainText(m.claim)}>
        {clip(plainText(m.claim), 110)}
      </span>
      {links ? <Meta title="outbound links">→{links}</Meta> : null}
      <StatusBadge s={s} />
    </Row>
  );
}

/** One gotcha rule: plain-text claim + a "re: subject" tag when it's attached to
 *  a canonical subject (standalone gotcha groups get no tag). */
function GotchaRow({ claim, tag, onOpen }: { claim: string; tag: string | null; onOpen: () => void }) {
  return (
    <Row onOpen={onOpen}>
      <span className="text-stone-300">•</span>
      <span className="flex-1 text-sm text-stone-700" title={claim}>
        {claim}
      </span>
      {tag ? <span className="shrink-0 text-xs text-stone-400">re: {tag}</span> : null}
    </Row>
  );
}

/** The type-sectioned data catalog: Metrics, Entities, Queries, Gotchas. */
function Catalog({
  subjects,
  onOpen,
}: {
  subjects: SubjectGroup[];
  onOpen: (key: string) => void;
}) {
  const metrics = subjects.filter((s) => s.primaryType === "metric");
  const entities = subjects.filter((s) => s.primaryType === "entity");
  const queries = subjects.filter((s) => s.primaryType === "query");
  // gotchas aggregate across ALL subjects: standalone groups + rules attached to
  // an entity/metric/query subject (which carry a "re: {subject}" tag).
  const gotchas = subjects.flatMap((s) =>
    s.members
      .filter((m) => m.type === "gotcha")
      .map((m) => ({
        key: `${s.key}:${m.name}`,
        subjectKey: s.key,
        claim: plainText(m.claim),
        tag: s.primaryType === "gotcha" ? null : s.label,
      })),
  );

  if (!metrics.length && !entities.length && !queries.length && !gotchas.length)
    return (
      <div className="card p-6 text-center text-sm text-stone-500">Nothing matches this filter.</div>
    );

  return (
    <div>
      <Section title="Metrics" count={metrics.length}>
        {metrics.map((s) => (
          <MetricRow key={s.key} s={s} onOpen={() => onOpen(s.key)} />
        ))}
      </Section>
      <Section title="Entities" count={entities.length}>
        {entities.map((s) => (
          <EntityRow key={s.key} s={s} onOpen={() => onOpen(s.key)} />
        ))}
      </Section>
      <Section title="Queries" count={queries.length}>
        {queries.map((s) => (
          <QueryRow key={s.key} s={s} onOpen={() => onOpen(s.key)} />
        ))}
      </Section>
      <Section title="Gotchas" count={gotchas.length}>
        {gotchas.map((g) => (
          <GotchaRow key={g.key} claim={g.claim} tag={g.tag} onOpen={() => onOpen(g.subjectKey)} />
        ))}
      </Section>
    </div>
  );
}

/* ─────────────────────────  Detail: a doc page  ───────────────────────── */

/** A linked doc reference in the sidebar; resolves a name → its page when known. */
function SidebarLink({
  name,
  dir,
  resolvable,
  onNav,
}: {
  name: string;
  dir: "out" | "back";
  resolvable: boolean;
  onNav: (name: string) => void;
}) {
  if (!resolvable) {
    // target isn't a known doc — render as plain text (clean data shouldn't hit this)
    return (
      <li className="flex items-center gap-1.5 py-1 text-sm text-stone-400">
        <span className="text-stone-300">{dir === "out" ? "→" : "←"}</span>
        <span className="truncate" title={name}>
          {name}
        </span>
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        onClick={() => onNav(name)}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm text-stone-600 transition hover:bg-stone-100 hover:text-stone-900"
        title={dir === "out" ? `links to ${name}` : `linked from ${name}`}
      >
        <span className="text-stone-400">{dir === "out" ? "→" : "←"}</span>
        <span className="truncate">{name}</span>
      </button>
    </li>
  );
}

/** One member's prose: claim lead line, markdown body, and small meta. */
function MemberBlock({ m, lead }: { m: KnowledgeMember; lead?: boolean }) {
  const meta = attribution(m);
  const hasBody = m.body && m.body.trim() && m.body.trim() !== m.claim.trim();
  return (
    <div className={lead ? "" : "mt-4 border-t border-stone-100 pt-4"}>
      {m.claim ? (
        <p className={lead ? "text-base leading-relaxed text-stone-800" : "text-sm font-medium text-stone-800"}>
          {m.claim}
        </p>
      ) : null}
      {hasBody ? <Markdown body={m.body} /> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-400">
        {meta ? <span>{meta}</span> : null}
        <span title="times surfaced (find_context + lookups)">
          {m.uses === 0 ? "unused" : `${m.uses}× used`}
        </span>
        {m.verified ? <span className="text-stone-500">✓ verified</span> : null}
        {m.flags.map((f) => (
          <Flag key={f} kind={f} />
        ))}
      </div>
    </div>
  );
}

function SubjectPage({
  subject,
  nameToKey,
  onNav,
  onBack,
}: {
  subject: SubjectGroup;
  nameToKey: Map<string, string>;
  onNav: (name: string) => void;
  onBack: () => void;
}) {
  // primary member(s) first, gotchas grouped into their own subsection
  const primaries = subject.members.filter((m) => m.type !== "gotcha");
  const gotchas = subject.members.filter((m) => m.type === "gotcha");

  // dedupe Links/Backlinks across all members of this subject (skip self-refs)
  const ownNames = new Set(subject.members.map((m) => m.name));
  const links = useMemo(() => {
    const seen = new Set<string>();
    for (const m of subject.members) for (const l of m.links) if (!ownNames.has(l)) seen.add(l);
    return [...seen];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject]);
  const backlinks = useMemo(() => {
    const seen = new Set<string>();
    for (const m of subject.members) for (const b of m.backlinks) if (!ownNames.has(b)) seen.add(b);
    return [...seen];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject]);

  const review = subject.flags.includes("review");

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex cursor-pointer items-center gap-1 text-sm font-medium text-stone-500 transition hover:text-stone-900"
      >
        ← all knowledge
      </button>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_16rem]">
        {/* main: the page */}
        <div className="card p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-stone-900">{subject.label}</h2>
            <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-500 ring-1 ring-inset ring-stone-200">
              {TYPE_LABEL[subject.primaryType] ?? subject.primaryType}
            </span>
            {review ? <Badge tone="down">⚠ review</Badge> : null}
          </div>

          <div className="mt-3">
            {primaries.map((m, i) => (
              <MemberBlock key={`${m.type}:${m.name}:${i}`} m={m} lead={i === 0} />
            ))}
            {!primaries.length && gotchas.length ? (
              <p className="text-sm text-stone-400">No primary doc — gotchas only.</p>
            ) : null}
          </div>

          {gotchas.length ? (
            <div className="mt-5 border-t border-stone-200 pt-4">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-stone-400">
                Gotchas
              </div>
              {gotchas.map((m, i) => (
                <MemberBlock key={`g:${m.name}:${i}`} m={m} lead={i === 0} />
              ))}
            </div>
          ) : null}
        </div>

        {/* sidebar: links / backlinks */}
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <div className="card bg-stone-50 p-4">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-400">
              Links →
            </div>
            {links.length ? (
              <ul className="space-y-0.5">
                {links.map((n) => (
                  <SidebarLink key={`o:${n}`} name={n} dir="out" resolvable={nameToKey.has(n)} onNav={onNav} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-stone-400">None</p>
            )}

            <div className="mb-2 mt-4 text-xs font-medium uppercase tracking-wide text-stone-400">
              Backlinks ←
            </div>
            {backlinks.length ? (
              <ul className="space-y-0.5">
                {backlinks.map((n) => (
                  <SidebarLink key={`b:${n}`} name={n} dir="back" resolvable={nameToKey.has(n)} onNav={onNav} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-stone-400">None</p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ─────────────────────────────  Page  ───────────────────────────────── */

export function Knowledge() {
  const { data, loading, error } = useApi<KnowledgeView>(() => api.knowledgeView(), []);
  const { data: queue } = useApi<Correction[]>(() => api.pending(), []);
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"catalog" | "graph">("catalog");

  // toggle a worklist/category filter (clicking the active one clears it)
  const toggle = (v: View) => setView((cur) => (sameView(cur, v) ? null : v));

  // name → subject key index: a member.name lives in exactly one subject group.
  const nameToKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of data?.subjects ?? []) for (const m of s.members) map.set(m.name, s.key);
    return map;
  }, [data]);

  const byKey = useMemo(() => {
    const map = new Map<string, SubjectGroup>();
    for (const s of data?.subjects ?? []) map.set(s.key, s);
    return map;
  }, [data]);

  // navigate to a doc page: resolve its name → owning subject and select it.
  const onNav = (name: string) => {
    const key = nameToKey.get(name);
    if (!key) return; // unknown target (e.g. a broken link ref) — no-op
    setSelected(key);
    window.scrollTo({ top: 0 });
  };

  const openSubject = (key: string) => {
    setSelected(key);
    window.scrollTo({ top: 0 });
  };

  const subjects = useMemo(() => {
    let all = data?.subjects ?? [];
    if (view?.kind === "type") all = all.filter((s) => s.primaryType === view.type);
    if (view?.kind === "flag") all = all.filter((s) => s.members.some((m) => m.flags.includes(view.flag)));
    const needle = q.trim().toLowerCase();
    if (needle)
      all = all.filter(
        (s) =>
          s.label.toLowerCase().includes(needle) ||
          s.members.some(
            (m) => m.name.toLowerCase().includes(needle) || m.claim.toLowerCase().includes(needle),
          ),
      );
    return all;
  }, [data, q, view]);

  const isPanel = view?.kind === "panel";
  const current = selected ? byKey.get(selected) ?? null : null;

  return (
    <>
      <Heading title="Knowledge">
        The curated context your agents read as ground truth — {data?.docs ?? 0} doc(s) across{" "}
        {data?.subjects.length ?? 0} subject(s). This is reference material for agents, not for you:
        browse it to check what they believe and spot problems. Read-only here — curated edits come
        from a curator session, and agent proposals wait in{" "}
        <Link
          className="font-medium text-stone-900 underline decoration-stone-400 underline-offset-2 hover:decoration-stone-600"
          to="/knowledge/review"
        >
          Review
        </Link>{" "}
        for a human to approve.
      </Heading>
      <KnowledgeTabs pending={queue?.length} />

      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorMsg>{error}</ErrorMsg>
      ) : !data?.subjects.length ? (
        <div className="card p-8 text-center text-stone-500">
          No curated knowledge yet. Run <code className="kbd">/setoku:generate</code>.
        </div>
      ) : current ? (
        <SubjectPage
          subject={current}
          nameToKey={nameToKey}
          onNav={onNav}
          onBack={() => setSelected(null)}
        />
      ) : (
        <>
          <HealthBar h={data.health} view={view} toggle={toggle} />

          {/* search + the catalog/graph view-mode toggle, on one row */}
          <div className="mb-4 flex items-center gap-3">
            {mode === "catalog" ? (
              <input
                className="input flex-1"
                placeholder="Search subjects, facts…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            ) : (
              <div className="flex-1" />
            )}
            <div className="inline-flex shrink-0 gap-1 rounded-lg bg-stone-100 p-1">
              <button
                type="button"
                onClick={() => setMode("catalog")}
                aria-pressed={mode === "catalog"}
                className={`tab ${mode === "catalog" ? "tab-active" : ""}`}
              >
                Catalog
              </button>
              <button
                type="button"
                onClick={() => setMode("graph")}
                aria-pressed={mode === "graph"}
                className={`tab ${mode === "graph" ? "tab-active" : ""}`}
              >
                Graph
              </button>
            </div>
          </div>

          {mode === "graph" ? (
            <KnowledgeGraph subjects={data.subjects} onOpen={openSubject} />
          ) : (
            <>
              {isPanel && view.panel === "connections" ? (
                <ConnectionsPanel rows={data.connections} onNav={onNav} />
              ) : isPanel && view.panel === "brokenLinks" ? (
                <BrokenLinksPanel rows={data.brokenLinks} onNav={onNav} />
              ) : (
                <Catalog subjects={subjects} onOpen={openSubject} />
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
