// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import { api } from "../api";
import { useApi } from "../hooks";
import { Heading, Loading, ErrorMsg } from "../components/Page";
import { Status } from "../components/Status";
import { relTime, freshness, type StatusColor } from "../format";
import type { SourcesData } from "../types";

export function Sources() {
  const { data, loading, error } = useApi<SourcesData>(() => api.sources(), []);
  return (
    <>
      <Heading title="Sources">
        What's connected and whether data is flowing — click a source to expand. Read-only, refreshed
        live on each load.
      </Heading>
      {loading ? <Loading /> : error ? <ErrorMsg>{error}</ErrorMsg> : data ? <SourceList data={data} /> : null}
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

function SourceList({ data }: { data: SourcesData }) {
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
      rows.push(
        <Row key={t.source} name={t.source} status={freshness(t.rows, t.last, t.beat)} last={t.last}>
          {kv("rows", t.rows == null ? "—" : Number(t.rows).toLocaleString("en-US"))}
          {kv("last ingest", t.last ? `${String(t.last).slice(0, 19)} UTC` : "—")}
          {t.beat ? kv("connector", `live · last beat ${relTime(t.beat)}`) : null}
        </Row>,
      );
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

  return (
    <>
      <div className="space-y-2">{rows}</div>
      <div className="mt-5 flex items-center gap-4 text-xs text-stone-500">
        <Status color="green">flowing</Status>
        <Status color="yellow">stale / empty</Status>
        <Status color="red">down</Status>
      </div>
    </>
  );
}
