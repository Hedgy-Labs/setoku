// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type ReactNode } from "react";
import { AlertDialog } from "@base-ui-components/react/alert-dialog";
import { Link, useSearchParams } from "react-router-dom";
import { api, type MutationResult } from "../api";
import { useApi } from "../hooks";
import { useAuth } from "../auth";
import { Heading, Loading, ErrorMsg } from "../components/Page";
import { Status } from "../components/Status";
import { Sparkline } from "../components/Sparkline";
import { Button } from "../components/Button";
import { Confirm } from "../components/Confirm";
import { toast } from "../components/Toast";
import { relTime, freshness, beatIsLive, type StatusColor } from "../format";
import { formatBytes } from "../../../lib/format";
import { LAKE_SOURCES, type LakeSource } from "../../../lib/sources";
import type { SourcesData, SourceTable, SourceSeriesData, EgressData, EgressDay, TeamData } from "../types";

export function Sources() {
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  const { data, loading, error } = useApi<SourcesData>(() => api.sources(), []);
  // Sparkline data is a second, non-blocking fetch — the page renders with
  // scalar totals immediately and the 30-day trends fill in when they land.
  const { data: seriesData } = useApi<SourceSeriesData>(() => api.sourceSeries(), []);
  // Egress ledger too — absent (non-mirror box, lake down) simply renders no card.
  const { data: egress, reload: reloadEgress } = useApi<EgressData>(() => api.egress(), []);
  const series = new Map((seriesData?.series ?? []).map((s) => [s.source, s.points]));
  // Connect dialog state: null = closed, { source? } = open, optionally
  // pre-filled with the Available row that launched it.
  const [connect, setConnect] = useState<{ source?: string } | null>(null);
  // Surface the flash the Gmail OAuth callback redirects back with (?flash=…), once.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const flash = params.get("flash");
    if (flash) {
      toast(flash);
      params.delete("flash");
      setParams(params, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <Heading
        title="Sources"
        action={<Button onClick={() => setConnect({})}>Connect source</Button>}
      >
        The databases and feeds your agents can query — what’s connected and whether data is actually
        flowing (a live heartbeat, not just recent rows). Click a source to expand. Sources you haven’t
        connected yet sit under Available. Read-only, refreshed live on each load.
      </Heading>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorMsg>{error}</ErrorMsg>
      ) : data ? (
        <SourceList
          data={data}
          series={series}
          egress={egress}
          reloadEgress={reloadEgress}
          isAdmin={isAdmin}
          onConnect={(source) => setConnect({ source })}
        />
      ) : null}
      <ConnectDialog
        open={connect !== null}
        source={connect?.source}
        isAdmin={isAdmin}
        onClose={() => setConnect(null)}
        onCopied={() => toast("Prompt copied — paste it into Claude Code and say which source.")}
      />
    </>
  );
}

/** Like Apps' New-app dialog: sources are connected by your agent, not a form.
 *  Admins get a ready prompt to paste into Claude Code on the box; members
 *  can't wire the box themselves, so they get the admins to ask instead. */
function ConnectDialog({
  open,
  source,
  isAdmin,
  onClose,
  onCopied,
}: {
  open: boolean;
  /** Pre-fills the prompt when launched from an Available row. */
  source?: string;
  isAdmin: boolean;
  onClose: () => void;
  onCopied: () => void;
}) {
  // Who to contact, members only — the team list is readable by any signed-in
  // user, so a member's dialog can name real people rather than "an admin".
  const { data: team } = useApi<TeamData | null>(
    () => (isAdmin ? Promise.resolve(null) : api.team()),
    [isAdmin],
  );
  const admins = (team?.people ?? []).filter((p) => p.role === "admin").map((p) => p.identity);
  const prompt =
    `Connect a new data source to my Setoku (${location.origin}).\n` +
    `Use the /setoku:connect skill — it wires the source up read-only, verifies data is actually flowing, and saves what it learns as knowledge.\n\n` +
    `What I want to connect: ${source ?? ""}\n`;
  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-stone-900/20 backdrop-blur-sm" />
        <AlertDialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-stone-200 bg-white p-5 shadow-xl">
          <AlertDialog.Title className="text-base font-semibold text-stone-900">Connect a source</AlertDialog.Title>
          {isAdmin ? (
            <>
              <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-stone-600">
                Sources are connected by your agent, not a form. Paste this into Claude Code with the Setoku
                plugin, say which source, and it’ll wire it up end-to-end.
              </AlertDialog.Description>
              <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-xs text-stone-700">
                {prompt}
              </pre>
              <div className="mt-4 flex justify-end gap-2">
                <AlertDialog.Close className="btn btn-ghost">Close</AlertDialog.Close>
                <AlertDialog.Close
                  className="btn btn-primary"
                  onClick={() => {
                    void navigator.clipboard?.writeText(prompt).catch(() => {});
                    onCopied();
                  }}
                >
                  Copy prompt
                </AlertDialog.Close>
              </div>
            </>
          ) : (
            <>
              <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-stone-600">
                Connecting a source happens on the box this Setoku runs on — read-only credentials, wired
                up by whoever operates it — so it takes an admin. Tell{" "}
                {admins.length ? (
                  <b className="font-medium text-stone-800">{admins.join(", ")}</b>
                ) : (
                  "your admin"
                )}{" "}
                {source ? (
                  <>
                    you’d like <b className="font-medium text-stone-800">{source}</b> connected.
                  </>
                ) : (
                  <>what you’d like connected; the Available list below shows what this box can take.</>
                )}
              </AlertDialog.Description>
              <div className="mt-4 flex justify-end">
                <AlertDialog.Close className="btn btn-primary">Close</AlertDialog.Close>
              </div>
            </>
          )}
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
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
              to={`/apps/${egress.appId}`}
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
  time,
  children,
}: {
  name: string;
  status: { color: StatusColor; label: string };
  time?: string | null;
  children: ReactNode;
}) {
  return (
    <details className="card group">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="shrink-0 text-stone-500 transition group-open:rotate-90">›</span>
        <span className="min-w-0 flex-1 truncate font-medium text-stone-900">{name}</span>
        {time ? <span className="shrink-0 text-xs text-stone-500">{time}</span> : null}
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
      {kv("last new data", t.last ? `${String(t.last).slice(0, 19)} UTC` : "—")}
      {points && points.length ? kv("last 30 days", <Sparkline points={points} />) : null}
    </>
  );
}

/** One connected source family: a single card, expanding to per-table detail. */
function GroupRow({ name, members, series }: { name: string; members: SourceTable[]; series: SeriesMap }) {
  const rows = members.reduce((n, m) => n + (m.rows ?? 0), 0);
  const last = members.reduce<string | null>((a, m) => (m.last && (!a || m.last > a) ? m.last : a), null);
  const beat = members.reduce<string | null>((a, m) => (m.beat && (!a || m.beat > a) ? m.beat : a), null);
  // Headline time matches what the status chip measures: the connector beat
  // ("checked Xm ago") when one exists — a quiet-but-healthy poller must not
  // read as broken. Beat-less sources fall back to when data last landed,
  // labeled so the two can't be confused; per-table times stay in the detail.
  const time = beat ? `checked ${relTime(beat)}` : last ? `last new data ${relTime(last)}` : null;
  return (
    <Row name={name} status={freshness(rows, last, beat)} time={time}>
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

/** Gmail is connected through the UI (OAuth per-mailbox), not the agent — so its
 *  card carries the management the others don't: connect/disconnect mailboxes,
 *  plus the one-time OAuth-client setup hint and the data-flow status. Admin-only
 *  (the status endpoint is admin-gated; members see Gmail as an ordinary source). */
function GmailCard({ table }: { table: SourceTable | null }) {
  const { data, loading, reload } = useApi(() => api.gmailStatus(), []);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  const apply = async (p: Promise<MutationResult>) => {
    try {
      const r = await p;
      if (r.flash) toast(r.flash);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed.");
    }
  };

  const mailboxes = data?.mailboxes ?? [];
  const status: { color: StatusColor; label: string } = loading
    ? { color: "yellow", label: "…" }
    : !data?.clientConfigured
      ? { color: "yellow", label: "setup needed" }
      : mailboxes.length === 0
        ? { color: "yellow", label: "no mailboxes" }
        : table
          ? freshness(table.rows, table.last, table.beat)
          : { color: "yellow", label: "syncing" };
  const time = table?.beat ? `checked ${relTime(table.beat)}` : null;

  return (
    <Row name="Gmail" status={status} time={time}>
      {data && !data.clientConfigured ? (
        <div className="mb-3 rounded-lg border border-stone-300 bg-stone-100 px-3 py-2 text-sm text-stone-700">
          <p className="font-medium">Set up the OAuth client first (one time)</p>
          <p className="mt-1 leading-relaxed">
            Set <code className="kbd">GMAIL_CLIENT_ID</code> / <code className="kbd">GMAIL_CLIENT_SECRET</code> on the box,
            and register this authorized redirect URI on the Google client:
          </p>
          <code className="mt-2 block break-all rounded bg-stone-200 px-2 py-1 text-xs">{data.redirectUri}</code>
        </div>
      ) : null}

      {kv("mailboxes", mailboxes.length ? String(mailboxes.length) : "none connected yet")}
      {mailboxes.map((m) =>
        kv(
          m.email || "(mailbox)",
          <button
            className="text-xs text-stone-500 underline underline-offset-2 hover:text-stone-800"
            onClick={() => setDisconnecting(m.email)}
          >
            disconnect
          </button>,
        ),
      )}
      {table ? <MemberKvs t={table} series={new Map()} /> : null}

      <div className="mt-3">
        <Button disabled={!data?.clientConfigured} onClick={() => (window.location.href = "/admin/api/gmail/oauth/start")}>
          Connect a mailbox
        </Button>
      </div>

      <Confirm
        open={disconnecting !== null}
        title="Disconnect mailbox?"
        body={
          <>
            Stop syncing <span className="font-medium">{disconnecting}</span>. Already-ingested mail stays until it ages
            out; reconnecting later re-syncs it.
          </>
        }
        confirmLabel="Disconnect"
        danger
        onConfirm={() => {
          const email = disconnecting!;
          setDisconnecting(null);
          void apply(api.gmailDisconnect(email));
        }}
        onClose={() => setDisconnecting(null)}
      />
    </Row>
  );
}

/** The sources this box could ingest but isn't yet — kept out of the connected
 *  list (an unconfigured feed isn't a problem to fix), but listed so it's easy
 *  to see what a box can take. */
function AvailableSection({
  entries,
  onConnect,
}: {
  entries: { name: string; desc: string }[];
  onConnect: (source: string) => void;
}) {
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
          <div key={e.name} className="flex items-center gap-4 py-1.5">
            <span className="w-36 shrink-0 font-medium text-stone-700">{e.name}</span>
            <span className="min-w-0 flex-1 truncate text-stone-500">{e.desc}</span>
            <Button variant="ghost" className="shrink-0 px-2 py-0.5 text-xs" onClick={() => onConnect(e.name)}>
              Connect
            </Button>
          </div>
        ))}
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
  isAdmin,
  onConnect,
}: {
  data: SourcesData;
  series: SeriesMap;
  egress: EgressData | null;
  reloadEgress: () => void;
  isAdmin: boolean;
  onConnect: (source: string) => void;
}) {
  const rows: ReactNode[] = [];
  const lake = data.lake;
  // Gmail is connected through the UI (OAuth), not the agent, so admins manage it
  // in a dedicated card (below) rather than the generic connected/Available rows.
  const gmailTable = lake.ok ? (lake.tables.find((t) => t.table === "gmail_messages") ?? null) : null;

  // The business DB reaches agents only as its biz.* mirror in the lake — the
  // gateway holds no direct Postgres credential, so this card IS the business
  // database's presence here. A dead mirror (stale biz.* data) or an egress
  // overrun turns the status chip yellow.
  const mirrorRun = lake.tables.find((t) => t.table === MIRROR_TABLE && (t.rows ?? 0) > 0) ?? null;
  const mirrorConnected = data.mirror.tables.length > 0 || mirrorRun !== null;
  const mirrorStale = mirrorRun !== null && freshness(mirrorRun.rows, mirrorRun.last, mirrorRun.beat).label === "stale";
  const overThreshold =
    egress?.configured === true && egress.thresholdBytes !== null && egress.todayBytes >= egress.thresholdBytes;
  const mirrorWarning = mirrorStale
    ? { color: "yellow" as const, label: "mirror stale" }
    : overThreshold
      ? { color: "yellow" as const, label: "egress over threshold" }
      : null;

  if (mirrorConnected) {
    rows.push(
      <Row key="mirror" name="Business DB (mirror)" status={mirrorWarning ?? { color: "green", label: "healthy" }}>
        {kv("read path", <code className="kbd">biz.*</code>)}
        {kv("mirrored tables", String(data.mirror.tables.length))}
        {mirrorRun ? kv("last reload", mirrorRun.last ? relTime(mirrorRun.last) : "—") : null}
        {data.mirror.tables.length
          ? kv(
              "tables",
              data.mirror.tables.map((t) => (
                <code key={t.target} className="kbd mr-1">
                  {t.target}
                </code>
              )),
            )
          : null}
        {egress?.configured ? <EgressKvs egress={egress} reload={reloadEgress} /> : null}
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
      if (isAdmin && fam === "Gmail") continue; // rendered as the GmailCard below
      rows.push(<GroupRow key={fam} name={fam} members={members} series={series} />);
    }
  }

  // Gmail's admin management card — connect/disconnect mailboxes + its data-flow
  // status — always shown to admins (even before a mailbox is connected), and
  // excluded from the generic connected/Available rows so it appears exactly once.
  if (isAdmin) {
    connectedFamilies.add("Gmail");
    rows.push(<GmailCard key="gmail" table={gmailTable} />);
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
  // business DB itself when the mirror isn't flowing yet. Suppressed while
  // the lake is unreachable: with zero probes, "Available" would claim every
  // connected source is unconnected rather than temporarily unprobeable.
  const lakeDown = lake.configured && !lake.ok;
  const avail: { name: string; desc: string }[] = [];
  if (!lakeDown) {
    if (!mirrorConnected) {
      avail.push({ name: "Business database", desc: "mirrored read-only into the lake (biz.*)" });
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
  }

  return (
    <>
      <div className="space-y-2">{rows}</div>
      <AvailableSection entries={avail} onConnect={onConnect} />
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
