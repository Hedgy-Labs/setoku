// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useApi } from "../hooks";
import { useAuth } from "../auth";
import { Heading, Loading, ErrorMsg } from "../components/Page";
import { Status } from "../components/Status";
import { Sparkline } from "../components/Sparkline";
import { Button } from "../components/Button";
import { toast } from "../components/Toast";
import { relTime, freshness, beatIsLive, type StatusColor } from "../format";
import { formatBytes } from "../../../lib/format";
import { LAKE_SOURCES, type LakeSource } from "../../../lib/sources";
import type { SourcesData, SourceTable, SourceSeriesData, EgressData, EgressDay } from "../types";

export function Sources() {
  const { data, loading, error } = useApi<SourcesData>(() => api.sources(), []);
  // Sparkline data is a second, non-blocking fetch — the page renders with
  // scalar totals immediately and the 30-day trends fill in when they land.
  const { data: seriesData } = useApi<SourceSeriesData>(() => api.sourceSeries(), []);
  // Egress ledger too — absent (non-mirror box, lake down) simply renders no card.
  const { data: egress, reload: reloadEgress } = useApi<EgressData>(() => api.egress(), []);
  const series = new Map((seriesData?.series ?? []).map((s) => [s.source, s.points]));
  return (
    <>
      <Heading title="Sources">
        The databases and feeds your agents can query — what’s connected and whether data is actually
        flowing (a live heartbeat, not just recent rows). Click a source to expand. Sources you haven’t
        connected yet sit under Available. Read-only, refreshed live on each load.
      </Heading>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorMsg>{error}</ErrorMsg>
      ) : data ? (
        <SourceList data={data} series={series} egress={egress} reloadEgress={reloadEgress} />
      ) : null}
    </>
  );
}

// The lake tables of one source family collapse into a single card: "GitHub"
// rather than four sibling rows for issues / pulls / commits / comments. The
// family is the label prefix before " · "; single-table sources are their own.
const familyOf = (label: string): string => label.split(" · ")[0];
const memberName = (label: string): string => (label.includes(" · ") ? label.split(" · ")[1] : label);

// Never shown as their own source card: the mirror's run log renders inside the
// Postgres card, and the raw catch-all only matters once something lands in it.
const MIRROR_TABLE = "pg_mirror_runs";
const RAW_TABLE = "ingest_raw";

/** A source counts as connected when it has data or a live connector beat. */
const isConnected = (t: SourceTable): boolean => (t.rows ?? 0) > 0 || beatIsLive(t.beat);

type SeriesMap = Map<string, SourceSeriesData["series"][number]["points"]>;

/** Ledger days as sparkline points, extended through TODAY: a mirror that died
 *  days ago must show trailing zero bars with today as the (empty) latest bar,
 *  not dark-highlight a stale day as if the chart were current. */
function egressPoints(days: EgressDay[]): { day: string; rows: number }[] {
  const points = days.map((d) => ({ day: d.day, rows: d.bytes }));
  const today = new Date().toISOString().slice(0, 10);
  if (points.length && points[points.length - 1].day < today) points.push({ day: today, rows: 0 });
  return points;
}

/** The mirror's source-egress rows: what pg-mirror pulled out of the business
 *  DB per day (the thing hosted-Postgres vendors bill), plus the daily
 *  Slack-alert threshold — editable here by admins, stored on the box. Rendered
 *  inside the Postgres card (the mirror is that source's read replica). */
function EgressKvs({ egress, reload }: { egress: EgressData; reload: () => void }) {
  const { me } = useAuth();
  const mayEdit = me?.role === "admin";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async (): Promise<void> => {
    const n = Number(draft);
    if (!Number.isFinite(n) || n < 0) {
      toast("Enter a GB/day number (0 disables alerts).");
      return;
    }
    setSaving(true);
    try {
      const r = await api.setEgressThreshold(n || null);
      if (r.flash) toast(r.flash);
      setEditing(false);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      {kv("egress today", formatBytes(egress.todayBytes))}
      {egress.days.length
        ? kv("last 30 days", <Sparkline points={egressPoints(egress.days)} format={formatBytes} label="Daily mirror egress" />)
        : null}
      {kv(
        "alert threshold",
        editing ? (
          <span className="inline-flex items-center gap-2">
            <input
              type="number"
              min={0}
              step="any"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void save()}
              className="w-20 rounded border border-stone-300 bg-white px-2 py-0.5 text-right text-sm text-stone-900"
              autoFocus
            />
            <span className="text-stone-500">GB/day</span>
            <Button variant="ghost" className="px-2 py-0.5 text-xs" disabled={saving} onClick={() => void save()}>
              Save
            </Button>
          </span>
        ) : (
          <span className="inline-flex items-center gap-2">
            <span>
              {egress.thresholdBytes === null
                ? "alerts off"
                : `${formatBytes(egress.thresholdBytes)}/day → Slack`}
            </span>
            {mayEdit ? (
              <button
                className="text-xs text-stone-500 underline underline-offset-2 hover:text-stone-800"
                onClick={() => {
                  // Exact GB, never rounded: a 0.4 GB threshold must round-trip
                  // through open-and-save unchanged, not collapse to 0 (= off).
                  setDraft(egress.thresholdBytes === null ? "0" : String(egress.thresholdBytes / 1e9));
                  setEditing(true);
                }}
              >
                edit
              </button>
            ) : null}
          </span>
        ),
      )}
      {kv(
        "what egress is",
        <span className="text-stone-500">
          data the mirror streamed out of the source DB — what hosted vendors bill
        </span>,
      )}
      {egress.appId
        ? kv(
            "app",
            <Link
              to={`/p/${egress.appId}`}
              className="text-stone-600 underline underline-offset-2 hover:text-stone-900"
            >
              Mirror egress →
            </Link>,
          )
        : null}
    </>
  );
}

function kv(k: string, v: ReactNode): ReactNode {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5" key={k}>
      <span className="text-stone-500">{k}</span>
      <span className="text-right text-stone-800">{v}</span>
    </div>
  );
}

/** Labeled subsection inside a card — a member table of a family, or the
 *  Postgres card's mirror block. */
function SubHead({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 mb-0.5 border-b border-stone-100 pb-1 text-[11px] font-medium uppercase tracking-wider text-stone-400">
      {children}
    </div>
  );
}

function Row({
  name,
  status,
  last,
  children,
}: {
  name: string;
  status: { color: StatusColor; label: string };
  last?: string | null;
  children: ReactNode;
}) {
  const rel = last ? relTime(last) : "";
  return (
    <details className="card group">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="shrink-0 text-stone-500 transition group-open:rotate-90">›</span>
        <span className="min-w-0 flex-1 truncate font-medium text-stone-900">{name}</span>
        {rel ? <span className="shrink-0 text-xs text-stone-500">{rel}</span> : null}
        <Status color={status.color}>{status.label}</Status>
      </summary>
      <div className="border-t border-stone-200 px-4 py-2.5 text-sm">{children}</div>
    </details>
  );
}

/** One member table's detail rows (rows / last ingest / 30-day trend). */
function MemberKvs({ t, series }: { t: SourceTable; series: SeriesMap }) {
  const points = series.get(t.source);
  return (
    <>
      {kv("rows", t.rows == null ? "—" : Number(t.rows).toLocaleString("en-US"))}
      {kv("last ingest", t.last ? `${String(t.last).slice(0, 19)} UTC` : "—")}
      {points && points.length ? kv("last 30 days", <Sparkline points={points} />) : null}
    </>
  );
}

/** One connected source family: a single card, expanding to per-table detail. */
function GroupRow({ name, members, series }: { name: string; members: SourceTable[]; series: SeriesMap }) {
  const rows = members.reduce((n, m) => n + (m.rows ?? 0), 0);
  const last = members.reduce<string | null>((a, m) => (m.last && (!a || m.last > a) ? m.last : a), null);
  const beat = members.reduce<string | null>((a, m) => (m.beat && (!a || m.beat > a) ? m.beat : a), null);
  return (
    <Row name={name} status={freshness(rows, last, beat)} last={last}>
      {beat
        ? kv("connector", beatIsLive(beat) ? `live · last beat ${relTime(beat)}` : `last beat ${relTime(beat)}`)
        : null}
      {members.length === 1 ? (
        <MemberKvs t={members[0]} series={series} />
      ) : (
        members.map((m) => (
          <div key={m.table}>
            <SubHead>{memberName(m.source)}</SubHead>
            <MemberKvs t={m} series={series} />
          </div>
        ))
      )}
    </Row>
  );
}

/** The sources this box could ingest but isn't yet — kept out of the connected
 *  list (an unconfigured feed isn't a problem to fix), but listed so it's easy
 *  to see what a box can take. */
function AvailableSection({ entries }: { entries: { name: string; desc: string }[] }) {
  if (!entries.length) return null;
  return (
    <details className="card group mt-6">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-stone-500 [&::-webkit-details-marker]:hidden">
        <span className="shrink-0 transition group-open:rotate-90">›</span>
        <span className="min-w-0 flex-1 truncate font-medium">Available</span>
        <span className="shrink-0 text-xs">
          {entries.length} source{entries.length === 1 ? "" : "s"} this box could ingest
        </span>
      </summary>
      <div className="border-t border-stone-200 px-4 py-2.5 text-sm">
        {entries.map((e) => (
          <div key={e.name} className="flex items-baseline justify-between gap-4 py-1.5">
            <span className="shrink-0 font-medium text-stone-700">{e.name}</span>
            <span className="text-right text-stone-500">{e.desc}</span>
          </div>
        ))}
        <div className="pt-2 text-xs text-stone-400">
          Connect one from Claude Code with the <code className="kbd">/setoku:connect</code> skill.
        </div>
      </div>
    </details>
  );
}

/** One line for the Available list: a multi-table family lists what it holds
 *  ("accounts, transactions, …"); a single table uses its blurb's head clause. */
function availDesc(members: LakeSource[]): string {
  return members.length > 1
    ? members.map((m) => memberName(m.source)).join(", ")
    : members[0].blurb.split(" (")[0];
}

function SourceList({
  data,
  series,
  egress,
  reloadEgress,
}: {
  data: SourcesData;
  series: SeriesMap;
  egress: EgressData | null;
  reloadEgress: () => void;
}) {
  const rows: ReactNode[] = [];
  const pg = data.postgres;
  const lake = data.lake;

  // The mirror is the business DB's read replica in the lake — its run log and
  // egress ledger render inside the Postgres card, not as sibling sources.
  const mirror = lake.tables.find((t) => t.table === MIRROR_TABLE && (t.rows ?? 0) > 0) ?? null;
  const mirrorKvs =
    mirror || egress?.configured ? (
      <>
        <SubHead>mirror (biz.*)</SubHead>
        {mirror ? kv("last reload", mirror.last ? relTime(mirror.last) : "—") : null}
        {egress?.configured ? <EgressKvs egress={egress} reload={reloadEgress} /> : null}
      </>
    ) : null;

  if (pg.configured) {
    const status = pg.ok
      ? { color: "green" as const, label: "healthy" }
      : { color: "red" as const, label: "unreachable" };
    rows.push(
      <Row key="pg" name="Postgres" status={status}>
        {pg.error ? kv("error", <span className="text-red-600">{pg.error}</span>) : kv("status", "reachable")}
        {kv("env var", <code className="kbd">{pg.envVar ?? "—"}</code>)}
        {pg.tableCount != null ? kv("tables in scope", String(pg.tableCount)) : null}
        {pg.allow?.length
          ? kv(
              "allow",
              pg.allow.map((a) => (
                <code key={a} className="kbd mr-1">
                  {a}
                </code>
              )),
            )
          : null}
        {mirrorKvs}
      </Row>,
    );
  } else if (mirrorKvs) {
    // A box that mirrors without the gateway's own Postgres binding (unusual,
    // but the ledger shouldn't vanish just because the direct path is off).
    rows.push(
      <Row key="pg-mirror" name="Postgres · mirror" status={{ color: "green", label: "healthy" }}>
        {mirrorKvs}
      </Row>,
    );
  }

  if (lake.configured && !lake.ok) {
    rows.push(
      <Row key="lake" name="Data lake (ClickHouse)" status={{ color: "red", label: "unreachable" }}>
        {kv("error", <span className="text-red-600">{lake.error ?? "unreachable"}</span>)}
      </Row>,
    );
  }

  // Connected lake sources, one card per family, in catalog order.
  const connectedFamilies = new Set<string>();
  if (lake.configured && lake.ok) {
    const groups = new Map<string, SourceTable[]>();
    for (const t of lake.tables) {
      if (t.table === MIRROR_TABLE) continue;
      const fam = familyOf(t.source);
      if (!groups.has(fam)) groups.set(fam, []);
      groups.get(fam)!.push(t);
    }
    for (const [fam, members] of groups) {
      if (!members.some(isConnected)) continue;
      connectedFamilies.add(fam);
      rows.push(<GroupRow key={fam} name={fam} members={members} series={series} />);
    }
  }

  const k = data.knowledge;
  rows.push(
    <Row
      key="knowledge"
      name="Knowledge store"
      status={k.docs > 0 ? { color: "green", label: "healthy" } : { color: "yellow", label: "empty" }}
    >
      {kv("documents", String(k.docs))}
      {Object.entries(k.byType).map(([t, n]) => kv(t, String(n)))}
    </Row>,
  );

  // Everything the catalog knows that isn't connected here — including the
  // business DB itself when no SETOKU_DATABASE_URL is bound.
  const avail: { name: string; desc: string }[] = [];
  if (!pg.configured) {
    avail.push({ name: "Postgres", desc: "any Postgres you want to query — read-only, table allowlist" });
  }
  const catalogFamilies = new Map<string, LakeSource[]>();
  for (const s of LAKE_SOURCES) {
    if (s.table === MIRROR_TABLE || s.table === RAW_TABLE) continue;
    const fam = familyOf(s.source);
    if (!catalogFamilies.has(fam)) catalogFamilies.set(fam, []);
    catalogFamilies.get(fam)!.push(s);
  }
  for (const [fam, members] of catalogFamilies) {
    if (!connectedFamilies.has(fam)) avail.push({ name: fam, desc: availDesc(members) });
  }

  return (
    <>
      <div className="space-y-2">{rows}</div>
      <AvailableSection entries={avail} />
      <div className="mt-5 flex items-center gap-4 text-xs text-stone-500">
        <Status color="green">flowing</Status>
        <Status color="yellow">stale / empty</Status>
        <Status color="red">down</Status>
        {series.size ? (
          <Link
            to="/sources/trends"
            className="ml-auto text-stone-600 underline underline-offset-2 hover:text-stone-900"
          >
            ingestion trends →
          </Link>
        ) : null}
      </div>
    </>
  );
}
