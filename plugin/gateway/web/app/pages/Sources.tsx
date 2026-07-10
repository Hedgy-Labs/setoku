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
import { densify } from "../series";
import { relTime, freshness, type StatusColor } from "../format";
import type { SourcesData, SourceSeriesData, EgressData, EgressDay } from "../types";

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
        The databases and feeds your agents can query — what's connected and whether data is actually
        flowing (a live heartbeat, not just recent rows). Click a source to expand. Read-only, refreshed
        live on each load.
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

function gb(bytes: number): string {
  const g = bytes / 1e9;
  if (g >= 10) return `${g.toFixed(0)} GB`;
  if (g >= 0.1) return `${g.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** Daily egress bars — Sparkline's shape, but byte-labeled. Stone only. */
function EgressBars({ days }: { days: EgressDay[] }) {
  const dense = densify(days.map((d) => ({ day: d.day, rows: d.bytes })));
  if (dense.length < 2) return <span className="text-stone-400">not enough history</span>;
  const W = 168;
  const H = 34;
  const GAP = 1;
  const max = Math.max(1, ...dense.map((d) => d.rows));
  const bw = (W - GAP * (dense.length - 1)) / dense.length;
  const last = dense.length - 1;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`Daily mirror egress, last ${dense.length} days`}>
      {dense.map((d, i) => {
        const h = d.rows === 0 ? 0.75 : Math.max(1, (d.rows / max) * (H - 2));
        return (
          <rect
            key={d.day}
            x={i * (bw + GAP)}
            y={H - h}
            width={bw}
            height={h}
            rx={bw > 2 ? 1 : 0}
            fill={i === last ? "#57534e" : d.rows === 0 ? "#e7e5e4" : "#d6d3d1"}
          >
            <title>{`${d.day}: ${gb(d.rows)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/** The mirror's source-egress card: what pg-mirror pulled out of the business
 *  DB per day (the thing hosted-Postgres vendors bill), plus the daily
 *  Slack-alert threshold — editable here by admins, stored on the box. */
function EgressCard({ egress, reload }: { egress: EgressData; reload: () => void }) {
  const { me } = useAuth();
  const mayEdit = me?.role === "admin";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const overThreshold = egress.thresholdBytes !== null && egress.todayBytes >= egress.thresholdBytes;
  const status = overThreshold
    ? { color: "yellow" as const, label: "over threshold" }
    : { color: "green" as const, label: "ok" };
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
    <Row name="Business-DB mirror · egress" status={status}>
      {kv("pulled today", gb(egress.todayBytes))}
      {egress.days.length ? kv("last 30 days", <EgressBars days={egress.days} />) : null}
      {kv(
        "alert threshold",
        editing ? (
          <span className="inline-flex items-center gap-2">
            <input
              type="number"
              min={0}
              step={1}
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
                : `${gb(egress.thresholdBytes)}/day → Slack`}
            </span>
            {mayEdit ? (
              <button
                className="text-xs text-stone-500 underline underline-offset-2 hover:text-stone-800"
                onClick={() => {
                  setDraft(egress.thresholdBytes === null ? "0" : String(Math.round(egress.thresholdBytes / 1e9)));
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
        "what this is",
        <span className="text-stone-500">
          data the mirror streamed out of the source DB — what hosted vendors bill as egress
        </span>,
      )}
    </Row>
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

function SourceList({
  data,
  series,
  egress,
  reloadEgress,
}: {
  data: SourcesData;
  series: Map<string, SourceSeriesData["series"][number]["points"]>;
  egress: EgressData | null;
  reloadEgress: () => void;
}) {
  const rows: ReactNode[] = [];

  const pg = data.postgres;
  if (!pg.configured) {
    rows.push(
      <Row key="pg" name="Business database (Postgres)" status={{ color: "yellow", label: "not configured" }}>
        {kv("note", "no SETOKU_DATABASE_URL")}
      </Row>,
    );
  } else {
    const status = pg.ok
      ? { color: "green" as const, label: "healthy" }
      : { color: "red" as const, label: "unreachable" };
    rows.push(
      <Row key="pg" name="Business database (Postgres)" status={status}>
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
      </Row>,
    );
  }

  const lake = data.lake;
  if (lake.configured && !lake.ok) {
    rows.push(
      <Row key="lake" name="Data lake (ClickHouse)" status={{ color: "red", label: "unreachable" }}>
        {kv("error", <span className="text-red-600">{lake.error ?? "unreachable"}</span>)}
      </Row>,
    );
  } else if (lake.configured) {
    for (const t of lake.tables) {
      const points = series.get(t.source);
      rows.push(
        <Row key={t.source} name={t.source} status={freshness(t.rows, t.last, t.beat)} last={t.last}>
          {kv("rows", t.rows == null ? "—" : Number(t.rows).toLocaleString("en-US"))}
          {kv("last ingest", t.last ? `${String(t.last).slice(0, 19)} UTC` : "—")}
          {t.beat ? kv("connector", `live · last beat ${relTime(t.beat)}`) : null}
          {points && points.length ? kv("last 30 days", <Sparkline points={points} />) : null}
        </Row>,
      );
    }
  }

  // Egress ledger card — only when the box actually mirrors (a non-mirror box
  // has no ledger, and a zero card would read as "no egress" rather than "n/a").
  if (egress?.configured) {
    rows.push(<EgressCard key="egress" egress={egress} reload={reloadEgress} />);
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

  return (
    <>
      <div className="space-y-2">{rows}</div>
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
