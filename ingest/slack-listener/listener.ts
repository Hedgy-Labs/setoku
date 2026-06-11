#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * Setoku Slack listener — Socket Mode daemon (task 3.3).
 *
 * Hand-rolled Socket Mode (no SDK, zero npm deps): POST apps.connections.open
 * with the app-level token → wss URL → WebSocket → ack every envelope
 * immediately → archive `message` events (all subtypes) into
 * `setoku.slack_messages` over ClickHouse's HTTP interface.
 *
 * Durability (I4) — spool-first: every event is appended to the local NDJSON
 * spool file BEFORE its envelope is acked to Slack — if the spool write fails
 * (disk full), the envelope is left unacked and Slack redelivers. Batches
 * flush every ~2 s or 100 events; a byte-offset file marks delivered
 * progress; on ClickHouse failure we keep spooling and retry with jittered
 * backoff; on startup any un-acked remainder drains first. The in-memory
 * delivery queue is capped — during a long outage the backlog lives on disk
 * and is reloaded from the offset as the queue drains. Survives ClickHouse
 * restarts AND its own restarts with zero loss — the table is
 * ReplacingMergeTree(ingested_at) ORDER BY (channel, ts), so at-least-once
 * redelivery dedupes.
 *
 * Env:
 *   SLACK_APP_TOKEN      — xapp-… app-level token (scope connections:write); required
 *   SLACK_BOT_TOKEN      — xoxb-… bot token (web API; used by backfill.ts, not here)
 *   CLICKHOUSE_URL       — default http://clickhouse:8123
 *   CLICKHOUSE_USER      — default setoku
 *   CLICKHOUSE_PASSWORD  — default "" (empty)
 *   CLICKHOUSE_DB        — default setoku
 *   SETOKU_SPOOL_DIR     — default /spool
 *
 * Health: GET /health on :8686 → { connected, spool_depth, inserted_total }.
 */
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Row shape — must match ingest/schemas/030_slack_messages.sql exactly.
// ---------------------------------------------------------------------------

export interface SlackMessageRow {
  channel: string;
  /** Slack ts, e.g. "1718000000.123456" — the dedupe key with channel. */
  ts: string;
  /** `ts` as "YYYY-MM-DD hh:mm:ss.ffffff" UTC (ClickHouse DateTime64(6)). */
  event_ts: string;
  /** Parent thread ts; "" for top-level messages. */
  thread_ts: string;
  user: string;
  text: string;
  /** Message subtype (message_changed, bot_message, …); "" for plain messages. */
  subtype: string;
  /** Full original event JSON. */
  raw: string;
}

/** "1718000000.123456" → "2024-06-10 06:13:20.123456" (UTC, micros preserved). */
export function slackTsToDateTime(ts: string): string {
  const [sec, frac = ""] = ts.split(".");
  const micros = frac.padEnd(6, "0").slice(0, 6);
  const iso = new Date(Number(sec) * 1000).toISOString(); // 2024-06-10T06:13:20.000Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}.${micros}`;
}

/**
 * Map a Slack `message` event (or a conversations.history message — the
 * backfill injects `channel` before calling) to a row. No subtype is skipped:
 *  - message_changed → keyed on the ORIGINAL message ts with the edited text,
 *    so the edit replaces the original row via ReplacingMergeTree;
 *  - message_deleted → keyed on deleted_ts with empty text (a tombstone that
 *    replaces the deleted row); raw keeps the full event either way;
 *  - everything else (bot_message, thread_broadcast, …) → stored as-is with
 *    its subtype.
 * Returns null only when no ts can be found at all (nothing to key on).
 */
export function eventToRow(event: Record<string, unknown>): SlackMessageRow | null {
  const subtype = typeof event.subtype === "string" ? event.subtype : "";
  // message_changed/message_deleted wrap the affected message.
  const inner =
    subtype === "message_changed" && event.message && typeof event.message === "object"
      ? (event.message as Record<string, unknown>)
      : event;
  const ts =
    subtype === "message_deleted" && typeof event.deleted_ts === "string"
      ? event.deleted_ts
      : typeof inner.ts === "string"
        ? inner.ts
        : typeof event.ts === "string"
          ? event.ts
          : null;
  if (!ts) return null;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    channel: str(event.channel),
    ts,
    event_ts: slackTsToDateTime(ts),
    thread_ts: str(inner.thread_ts),
    user: str(inner.user) || str(event.user),
    text: subtype === "message_deleted" ? "" : str(inner.text),
    subtype,
    raw: JSON.stringify(event),
  };
}

// ---------------------------------------------------------------------------
// ClickHouse sink — plain HTTP, JSONEachRow.
// ---------------------------------------------------------------------------

export interface ClickHouseOptions {
  url: string; // e.g. http://clickhouse:8123
  user: string;
  password: string;
  db: string; // e.g. setoku
}

/** POST NDJSON lines (each "{…}\n") into <db>.slack_messages. Throws on failure. */
export async function insertSlackRows(
  ch: ClickHouseOptions,
  lines: string[],
): Promise<void> {
  if (lines.length === 0) return;
  const query = `INSERT INTO ${ch.db}.slack_messages FORMAT JSONEachRow`;
  const res = await fetch(`${ch.url}/?query=${encodeURIComponent(query)}`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${ch.user}:${ch.password}`),
      "content-type": "application/x-ndjson",
    },
    body: lines.join(""),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(
      `clickhouse insert failed: HTTP ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Spool — append-only NDJSON file + byte-offset progress marker (I4).
// ---------------------------------------------------------------------------

/**
 * Spool-first durability. `append` writes one NDJSON line to disk before the
 * caller acks Slack (append throws → no ack → Slack redelivers);
 * `peek`/`ack` deliver in order; `ack` advances a persisted byte offset so a
 * restart resumes exactly where delivery stopped. When fully drained the
 * file is truncated (compaction). The in-memory queue is capped at
 * `maxQueueLines` — beyond it, backlog stays on disk only and is reloaded
 * from the offset as the queue drains, so a multi-day outage cannot OOM the
 * process. Lines that fail to parse (torn write from a crash) are dropped at
 * flush time but still acked, so the offset never wedges.
 */
export class Spool {
  private readonly filePath: string;
  private readonly offsetPath: string;
  private readonly maxQueueLines: number;
  private queue: { line: string; bytes: number }[] = [];
  private offset = 0;
  private fileBytes = 0;
  private overflowed = false;

  constructor(dir: string, maxQueueLines = 50_000) {
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, "slack-events.ndjson");
    this.offsetPath = path.join(dir, "slack-events.offset");
    this.maxQueueLines = maxQueueLines;
    if (fs.existsSync(this.offsetPath)) {
      this.offset = Number(fs.readFileSync(this.offsetPath, "utf8").trim()) || 0;
    }
    if (!fs.existsSync(this.filePath)) {
      this.offset = 0;
      return;
    }
    this.fileBytes = fs.statSync(this.filePath).size;
    if (this.offset < 0 || this.offset > this.fileBytes) this.offset = 0;
    this.loadFromOffset();
  }

  /** (Re)fill the in-memory queue from the on-disk backlog past the offset. */
  private loadFromOffset(): void {
    this.overflowed = false;
    const buf = fs.readFileSync(this.filePath);
    this.fileBytes = buf.byteLength;
    let at = this.offset + this.queue.reduce((n, e) => n + e.bytes, 0);
    const rest = buf.subarray(at).toString("utf8");
    for (const text of rest.split("\n")) {
      if (text.length === 0) continue;
      if (!this.enqueue(text + "\n")) break;
    }
  }

  /** Push onto the bounded queue; false (and overflow flagged) when full. */
  private enqueue(line: string): boolean {
    if (this.queue.length >= this.maxQueueLines) {
      this.overflowed = true;
      return false;
    }
    this.queue.push({ line, bytes: Buffer.byteLength(line) });
    return true;
  }

  /** Number of in-memory undelivered events (disk backlog may exceed this). */
  get depth(): number {
    return this.queue.length;
  }

  /** Undelivered bytes on disk — the true backlog, including overflow. */
  get backlogBytes(): number {
    return this.fileBytes - this.offset;
  }

  /** Persist one row to disk (throws on failure — caller must NOT ack), then enqueue. */
  append(row: SlackMessageRow): void {
    const line = JSON.stringify(row) + "\n";
    fs.appendFileSync(this.filePath, line);
    this.fileBytes += Buffer.byteLength(line);
    this.enqueue(line);
  }

  /** Next up-to-`max` undelivered lines (each ends in "\n"), oldest first. */
  peek(max: number): string[] {
    return this.queue.slice(0, max).map((e) => e.line);
  }

  /** Mark the first `count` queued lines delivered; persist progress; compact when drained. */
  ack(count: number): void {
    const acked = this.queue.splice(0, count);
    this.offset += acked.reduce((n, e) => n + e.bytes, 0);
    if (this.queue.length === 0 && this.overflowed) {
      // Backlog beyond the queue cap lives on disk only — pull the next chunk.
      this.loadFromOffset();
    }
    if (this.queue.length === 0 && this.offset >= this.fileBytes) {
      // Fully drained — rotate spooled→done by truncating.
      fs.writeFileSync(this.filePath, "");
      this.offset = 0;
      this.fileBytes = 0;
    }
    fs.writeFileSync(this.offsetPath, String(this.offset));
  }
}

// ---------------------------------------------------------------------------
// The listener.
// ---------------------------------------------------------------------------

export interface ListenerOptions {
  appToken: string;
  clickhouse: ClickHouseOptions;
  spoolDir: string;
  /** Slack web API base; tests point this at a fake. Default https://slack.com/api */
  slackApiUrl?: string;
  /** /health port. 0 = ephemeral (tests), null = disabled. Default 8686. */
  healthPort?: number | null;
  flushIntervalMs?: number; // default 2000
  maxBatch?: number; // default 100
  /** Base for both ClickHouse-retry and reconnect backoff (jittered, capped). */
  retryBaseMs?: number; // default 1000
  retryMaxMs?: number; // default 30000
}

export class SlackListener {
  readonly spool: Spool;
  connected = false;
  insertedTotal = 0;

  private readonly o: Required<Omit<ListenerOptions, "healthPort">> & {
    healthPort: number | null;
  };
  private ws: WebSocket | null = null;
  private stopped = true;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private healthServer: ReturnType<typeof Bun.serve> | null = null;
  private flushing = false;
  private chFailures = 0;
  private nextRetryAt = 0;
  private reconnectFailures = 0;

  constructor(options: ListenerOptions) {
    this.o = {
      slackApiUrl: "https://slack.com/api",
      healthPort: 8686,
      flushIntervalMs: 2000,
      maxBatch: 100,
      retryBaseMs: 1000,
      retryMaxMs: 30_000,
      ...options,
    };
    this.spool = new Spool(this.o.spoolDir);
  }

  /** http://127.0.0.1:<port>/health, or null when health serving is disabled. */
  get healthUrl(): string | null {
    return this.healthServer
      ? `http://127.0.0.1:${this.healthServer.port}/health`
      : null;
  }

  start(): void {
    this.stopped = false;
    if (this.o.healthPort !== null) {
      this.healthServer = Bun.serve({
        port: this.o.healthPort,
        fetch: (req) => {
          if (new URL(req.url).pathname !== "/health") {
            return new Response("not found", { status: 404 });
          }
          return Response.json({
            connected: this.connected,
            spool_depth: this.spool.depth,
            spool_backlog_bytes: this.spool.backlogBytes,
            inserted_total: this.insertedTotal,
          });
        },
      });
    }
    this.flushTimer = setInterval(() => void this.flush(), this.o.flushIntervalMs);
    void this.flush(); // drain any spool remainder from a previous run first
    void this.connectLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.ws?.close();
    this.ws = null;
    this.healthServer?.stop(true);
    this.healthServer = null;
    // Let an in-flight flush finish so the offset file is consistent.
    while (this.flushing) await Bun.sleep(5);
  }

  // -- Socket Mode -----------------------------------------------------------

  /**
   * Slack closes Socket Mode connections every few hours (after a
   * {"type":"disconnect"} warning) — reconnecting with a fresh
   * apps.connections.open call is normal operation, not an error path.
   */
  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.runSocket();
        // A session that reached `hello` ended normally (Slack-initiated
        // refresh); one that never said hello is a failure — back off harder.
        if (this.connected) this.reconnectFailures = 0;
        else this.reconnectFailures++;
      } catch (e) {
        this.reconnectFailures++;
        console.error(`slack-listener: connect failed: ${e}`);
      }
      this.connected = false;
      if (this.stopped) break;
      await Bun.sleep(this.backoff(this.reconnectFailures));
    }
  }

  private backoff(failures: number): number {
    const base = Math.min(
      this.o.retryMaxMs,
      this.o.retryBaseMs * 2 ** Math.min(failures, 5),
    );
    return base * (0.5 + Math.random() * 0.5); // jitter: 50–100% of base
  }

  /** One full socket session: open URL → connect → pump until close. */
  private async runSocket(): Promise<void> {
    const res = await fetch(`${this.o.slackApiUrl}/apps.connections.open`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.o.appToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as { ok?: boolean; url?: string; error?: string };
    if (!body.ok || !body.url) {
      throw new Error(`apps.connections.open: ${body.error ?? `HTTP ${res.status}`}`);
    }
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(body.url!);
      this.ws = ws;
      ws.onmessage = (ev) => this.onSocketMessage(ws, String(ev.data));
      ws.onclose = () => resolve();
      ws.onerror = (ev) => {
        // onclose follows onerror; reject only if the socket never opened.
        if (ws.readyState === WebSocket.CLOSED && !this.connected) {
          reject(new Error(`websocket error: ${ev.type}`));
        }
      };
    });
  }

  private onSocketMessage(ws: WebSocket, data: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return; // not JSON — nothing to ack or store
    }
    // Ack AFTER the event is durably spooled (ingest below is synchronous).
    // If the spool write throws (disk full), we skip the ack and Slack
    // redelivers — the ReplacingMergeTree key makes redelivery harmless.
    const ack = () => {
      if (typeof msg.envelope_id === "string") {
        ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
      }
    };
    switch (msg.type) {
      case "hello":
        this.connected = true;
        this.reconnectFailures = 0;
        console.error("slack-listener: connected (hello)");
        ack();
        return;
      case "disconnect":
        // Warning that Slack is about to close this socket — close now and
        // let connectLoop reconnect with a fresh apps.connections.open.
        console.error(`slack-listener: disconnect requested (${String(msg.reason)})`);
        ack();
        ws.close();
        return;
      case "events_api": {
        const payload = msg.payload as Record<string, unknown> | undefined;
        const event = payload?.event as Record<string, unknown> | undefined;
        if (event?.type === "message") {
          try {
            this.ingest(event);
          } catch (e) {
            console.error(`slack-listener: spool write failed — NOT acking (${e})`);
            return; // unacked → Slack redelivers
          }
        }
        ack();
        return;
      }
      default:
        ack(); // other envelope types are not ours to handle
        return;
    }
  }

  // -- Spool → ClickHouse ----------------------------------------------------

  private ingest(event: Record<string, unknown>): void {
    const row = eventToRow(event);
    if (!row) return;
    this.spool.append(row); // disk first (I4) …
    if (this.spool.depth >= this.o.maxBatch) void this.flush(); // … then deliver
  }

  /** Deliver spooled batches; on failure, back off and keep spooling. */
  private async flush(): Promise<void> {
    if (this.flushing || this.spool.depth === 0) return;
    if (Date.now() < this.nextRetryAt) return; // still backing off
    this.flushing = true;
    try {
      while (this.spool.depth > 0) {
        const batch = this.spool.peek(this.o.maxBatch);
        const lines = batch.filter((l) => {
          try {
            JSON.parse(l);
            return true;
          } catch {
            return false; // torn line from a crash — ack past it below
          }
        });
        await insertSlackRows(this.o.clickhouse, lines);
        this.spool.ack(batch.length);
        this.insertedTotal += lines.length;
      }
      if (this.chFailures > 0) {
        console.error("slack-listener: clickhouse recovered, spool drained");
      }
      this.chFailures = 0;
      this.nextRetryAt = 0;
    } catch (e) {
      this.chFailures++;
      const delay = this.backoff(this.chFailures);
      this.nextRetryAt = Date.now() + delay;
      console.error(
        `slack-listener: insert failed (attempt ${this.chFailures}, retry in ${Math.round(delay)}ms, spool depth ${this.spool.depth}): ${e}`,
      );
    } finally {
      this.flushing = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Daemon entry — only when run directly (tests import the pieces above).
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const env = process.env;
  const appToken = env.SLACK_APP_TOKEN;
  if (!appToken) {
    console.error("slack-listener: SLACK_APP_TOKEN (xapp-…) is required");
    process.exit(1);
  }
  const listener = new SlackListener({
    appToken,
    clickhouse: {
      url: env.CLICKHOUSE_URL ?? "http://clickhouse:8123",
      user: env.CLICKHOUSE_USER ?? "setoku",
      password: env.CLICKHOUSE_PASSWORD ?? "",
      db: env.CLICKHOUSE_DB ?? "setoku",
    },
    spoolDir: env.SETOKU_SPOOL_DIR ?? "/spool",
  });
  listener.start();
  console.error(
    `slack-listener: started (spool ${env.SETOKU_SPOOL_DIR ?? "/spool"}, health :8686)`,
  );
  const shutdown = (sig: string) => {
    console.error(`slack-listener: ${sig} — shutting down`);
    void listener.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
