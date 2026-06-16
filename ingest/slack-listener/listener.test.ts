// SPDX-License-Identifier: Apache-2.0
/**
 * slack-listener tests — no network, no real Slack, no real ClickHouse.
 *
 * FakeSlack serves apps.connections.open over loopback HTTP and runs the
 * Socket Mode WebSocket itself (hello → scripted envelopes → records acks →
 * optional disconnect). FakeClickHouse accepts the INSERT POSTs and can be
 * told to fail with 500s. Everything binds port 0 (ephemeral, loopback).
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SlackListener,
  Spool,
  eventToRow,
  slackTsToDateTime,
  type SlackMessageRow,
} from "./listener";
import { tsCompare } from "./backfill";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function tmpSpoolDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-slack-test-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** Wrap a message event in a Socket Mode events_api envelope. */
function envelope(id: string, event: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "events_api",
    envelope_id: id,
    accepts_response_payload: false,
    payload: { event: { type: "message", ...event } },
  };
}

/** apps.connections.open + the Socket Mode WebSocket, on one ephemeral port. */
class FakeSlack {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly acks: string[] = [];
  openCalls = 0;
  socketsOpened = 0;
  private current: Bun.ServerWebSocket<unknown> | null = null;
  private pending: Record<string, unknown>[];

  constructor(initialEnvelopes: Record<string, unknown>[] = []) {
    this.pending = [...initialEnvelopes];
    this.server = Bun.serve({
      port: 0,
      fetch: (req, server) => {
        const { pathname } = new URL(req.url);
        if (pathname === "/apps.connections.open") {
          this.openCalls++;
          return Response.json({ ok: true, url: `ws://127.0.0.1:${this.server.port}/ws` });
        }
        if (pathname === "/ws" && server.upgrade(req, { data: null })) {
          return undefined as unknown as Response;
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open: (ws) => {
          this.socketsOpened++;
          this.current = ws;
          ws.send(JSON.stringify({ type: "hello", num_connections: 1 }));
          const queued = this.pending;
          this.pending = [];
          for (const env of queued) ws.send(JSON.stringify(env));
        },
        message: (_ws, raw) => {
          const msg = JSON.parse(String(raw)) as { envelope_id?: string };
          if (msg.envelope_id) this.acks.push(msg.envelope_id);
        },
        close: (ws) => {
          if (this.current === ws) this.current = null;
        },
      },
    });
    cleanups.push(() => this.server.stop(true));
  }

  get apiUrl(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  /** Deliver an envelope now (or queue it for the next socket). */
  send(env: Record<string, unknown>): void {
    if (this.current) this.current.send(JSON.stringify(env));
    else this.pending.push(env);
  }

  /** Slack-style "this socket is going away" warning. */
  disconnect(): void {
    this.current?.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
  }
}

/** Accepts INSERT … FORMAT JSONEachRow POSTs; `fail = true` → 500s. */
class FakeClickHouse {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly rows: SlackMessageRow[] = [];
  readonly heartbeats: Array<{ connector: string; beat_at: string; detail: string }> = [];
  readonly queries: string[] = [];
  fail = false;
  failedRequests = 0;

  constructor() {
    this.server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (this.fail) {
          this.failedRequests++;
          return new Response("Code: 999. simulated outage", { status: 500 });
        }
        const query = new URL(req.url).searchParams.get("query") ?? "";
        this.queries.push(query);
        const body = await req.text();
        for (const line of body.split("\n")) {
          if (!line.trim()) continue;
          if (query.includes("ingest_heartbeats")) this.heartbeats.push(JSON.parse(line));
          else this.rows.push(JSON.parse(line) as SlackMessageRow);
        }
        return new Response("");
      },
    });
    cleanups.push(() => this.server.stop(true));
  }

  get options() {
    return {
      url: `http://127.0.0.1:${this.server.port}`,
      user: "setoku",
      password: "test",
      db: "setoku",
    };
  }
}

function makeListener(
  slack: FakeSlack,
  ch: FakeClickHouse,
  spoolDir: string,
  overrides: Partial<ConstructorParameters<typeof SlackListener>[0]> = {},
): SlackListener {
  const listener = new SlackListener({
    appToken: "xapp-test-token",
    slackApiUrl: slack.apiUrl,
    clickhouse: ch.options,
    spoolDir,
    healthPort: 0, // ephemeral
    flushIntervalMs: 25,
    maxBatch: 100,
    retryBaseMs: 30,
    retryMaxMs: 200,
    heartbeatIntervalMs: 0, // off by default — heartbeat has its own test
    ...overrides,
  });
  cleanups.push(() => listener.stop());
  return listener;
}

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

test("slackTsToDateTime formats UTC DateTime64(6)", () => {
  expect(slackTsToDateTime("1718000000.123456")).toBe("2024-06-10 06:13:20.123456");
  expect(slackTsToDateTime("1718000000.12")).toBe("2024-06-10 06:13:20.120000"); // padded
  expect(slackTsToDateTime("1718000000")).toBe("2024-06-10 06:13:20.000000"); // no frac
});

test("eventToRow: plain, threaded, message_changed, message_deleted", () => {
  const plain = eventToRow({
    type: "message",
    channel: "C001",
    ts: "1718000000.000100",
    user: "U001",
    text: "hello",
  })!;
  expect(plain).toMatchObject({
    channel: "C001",
    ts: "1718000000.000100",
    thread_ts: "",
    user: "U001",
    text: "hello",
    subtype: "",
  });
  expect(JSON.parse(plain.raw).text).toBe("hello");

  const reply = eventToRow({
    type: "message",
    channel: "C001",
    ts: "1718000010.000200",
    thread_ts: "1718000000.000100",
    user: "U002",
    text: "re: hello",
  })!;
  expect(reply.thread_ts).toBe("1718000000.000100");

  // Edit replaces the ORIGINAL row: keyed on the inner message ts.
  const changed = eventToRow({
    type: "message",
    subtype: "message_changed",
    channel: "C001",
    ts: "1718000099.000000",
    event_ts: "1718000099.000000",
    message: { ts: "1718000000.000100", user: "U001", text: "hello (edited)" },
  })!;
  expect(changed.ts).toBe("1718000000.000100");
  expect(changed.text).toBe("hello (edited)");
  expect(changed.subtype).toBe("message_changed");

  // Delete tombstones the original row.
  const deleted = eventToRow({
    type: "message",
    subtype: "message_deleted",
    channel: "C001",
    ts: "1718000100.000000",
    deleted_ts: "1718000000.000100",
  })!;
  expect(deleted.ts).toBe("1718000000.000100");
  expect(deleted.text).toBe("");
  expect(deleted.subtype).toBe("message_deleted");
});

test("tsCompare orders Slack ts numerically", () => {
  expect(tsCompare("1718000000.000100", "1718000000.000200")).toBeLessThan(0);
  expect(tsCompare("1718000001.000000", "1718000000.999999")).toBeGreaterThan(0);
  expect(tsCompare("1718000000.000100", "1718000000.000100")).toBe(0);
});

// ---------------------------------------------------------------------------
// Live flow: acks, row shape, health, reconnect
// ---------------------------------------------------------------------------

test("acks every envelope and inserts the exact row shape", async () => {
  const slack = new FakeSlack([
    envelope("env-1", { channel: "C001", ts: "1718000000.000100", user: "U001", text: "hello" }),
    envelope("env-2", {
      channel: "C001",
      ts: "1718000010.000200",
      thread_ts: "1718000000.000100",
      user: "U002",
      text: "a threaded reply",
    }),
    envelope("env-3", {
      subtype: "message_changed",
      channel: "C001",
      ts: "1718000099.000000",
      message: { ts: "1718000000.000100", user: "U001", text: "hello (edited)" },
    }),
  ]);
  const ch = new FakeClickHouse();
  const listener = makeListener(slack, ch, tmpSpoolDir());
  listener.start();

  await waitFor(() => slack.acks.length === 3, "3 acks");
  expect(slack.acks.sort()).toEqual(["env-1", "env-2", "env-3"]);
  await waitFor(() => ch.rows.length === 3, "3 rows in clickhouse");

  // INSERT goes to the right table in JSONEachRow.
  expect(ch.queries[0]).toBe("INSERT INTO setoku.slack_messages FORMAT JSONEachRow");

  // Row shape — exactly the schema's columns, correct values.
  const byTs = new Map(ch.rows.map((r) => [`${r.text}`, r]));
  const plain = byTs.get("hello")!;
  expect(Object.keys(plain).sort()).toEqual([
    "channel", "event_ts", "raw", "subtype", "text", "thread_ts", "ts", "user",
  ]);
  expect(plain.channel).toBe("C001");
  expect(plain.ts).toBe("1718000000.000100");
  expect(plain.event_ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
  expect(plain.event_ts).toBe("2024-06-10 06:13:20.000100");
  expect(plain.thread_ts).toBe("");
  expect(plain.subtype).toBe("");
  expect(JSON.parse(plain.raw).type).toBe("message");

  const reply = byTs.get("a threaded reply")!;
  expect(reply.thread_ts).toBe("1718000000.000100");

  const edited = byTs.get("hello (edited)")!;
  expect(edited.subtype).toBe("message_changed");
  expect(edited.ts).toBe("1718000000.000100"); // replaces the original via ReplacingMergeTree

  // Health endpoint reflects a drained, connected listener.
  const health = (await (await fetch(listener.healthUrl!)).json()) as Record<string, unknown>;
  expect(health.connected).toBe(true);
  expect(health.spool_depth).toBe(0);
  expect(health.inserted_total).toBe(3);

  // Slack-style disconnect → fresh apps.connections.open + new socket.
  slack.disconnect();
  await waitFor(() => slack.socketsOpened === 2, "reconnect after disconnect");
  expect(slack.openCalls).toBe(2);

  // The reconnected socket still ingests.
  slack.send(envelope("env-4", { channel: "C001", ts: "1718000200.000000", user: "U001", text: "after reconnect" }));
  await waitFor(() => ch.rows.length === 4, "row after reconnect");

  await listener.stop();
});

// ---------------------------------------------------------------------------
// Liveness heartbeat
// ---------------------------------------------------------------------------

test("emits a connector heartbeat once connected (proves liveness when idle)", async () => {
  const slack = new FakeSlack();
  const ch = new FakeClickHouse();
  // Short interval so the periodic beat fires within the test.
  const listener = makeListener(slack, ch, tmpSpoolDir(), { heartbeatIntervalMs: 40 });
  listener.start();

  await waitFor(() => ch.heartbeats.length >= 1, "at least one heartbeat");

  // Ensures the table first, then beats — best-effort DDL is in the query log.
  expect(ch.queries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS setoku.ingest_heartbeats"))).toBe(true);
  const beat = ch.heartbeats[0]!;
  expect(beat.connector).toBe("slack-listener");
  expect(beat.detail).toBe("connected");
  expect(beat.beat_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  // No Slack messages were sent — the source is "quiet" but still beating.
  expect(ch.rows.length).toBe(0);

  await listener.stop();
});

// ---------------------------------------------------------------------------
// Durability: ClickHouse outage → spool → zero-loss drain
// ---------------------------------------------------------------------------

test("clickhouse outage: events spool and ALL deliver after recovery", async () => {
  const slack = new FakeSlack();
  const ch = new FakeClickHouse();
  ch.fail = true;
  const spoolDir = tmpSpoolDir();
  const listener = makeListener(slack, ch, spoolDir);
  listener.start();
  await waitFor(() => listener.connected, "hello");

  for (let i = 0; i < 5; i++) {
    slack.send(envelope(`out-${i}`, {
      channel: "C002",
      ts: `1718000${i}00.00000${i}`,
      user: "U001",
      text: `during outage ${i}`,
    }));
  }
  await waitFor(() => slack.acks.length === 5, "5 acks during outage");
  await waitFor(() => ch.failedRequests > 0, "at least one failed insert attempt");
  expect(ch.rows.length).toBe(0);
  expect(listener.spool.depth).toBe(5);

  // Events are on disk, not just in memory (spool-FIRST).
  const spooled = fs
    .readFileSync(path.join(spoolDir, "slack-events.ndjson"), "utf8")
    .trim()
    .split("\n");
  expect(spooled.length).toBe(5);

  ch.fail = false; // ClickHouse comes back
  await waitFor(() => ch.rows.length === 5, "all 5 rows after recovery");
  expect(ch.rows.map((r) => r.text).sort()).toEqual(
    [0, 1, 2, 3, 4].map((i) => `during outage ${i}`).sort(),
  );
  await waitFor(() => listener.spool.depth === 0, "spool drained");

  await listener.stop();
});

// ---------------------------------------------------------------------------
// Durability: restart mid-spool → fresh instance drains the remainder
// ---------------------------------------------------------------------------

test("restart mid-spool: a fresh instance on the same spool dir drains the remainder", async () => {
  const spoolDir = tmpSpoolDir();
  const ch = new FakeClickHouse();
  ch.fail = true;

  // First life: ClickHouse down, events land in the spool, then we die.
  const slack1 = new FakeSlack();
  const listener1 = makeListener(slack1, ch, spoolDir);
  listener1.start();
  await waitFor(() => listener1.connected, "first listener hello");
  for (let i = 0; i < 4; i++) {
    slack1.send(envelope(`re-${i}`, {
      channel: "C003",
      ts: `17180001${i}0.000000`,
      user: "U007",
      text: `survives restart ${i}`,
    }));
  }
  await waitFor(() => listener1.spool.depth === 4, "4 events spooled");
  await listener1.stop(); // killed mid-spool — nothing delivered
  expect(ch.rows.length).toBe(0);

  // Second life: same spool dir, ClickHouse healthy, NO Slack events at all —
  // everything that arrives must come from the recovered spool.
  ch.fail = false;
  const slack2 = new FakeSlack();
  const listener2 = makeListener(slack2, ch, spoolDir);
  expect(listener2.spool.depth).toBe(4); // recovered from disk before start
  listener2.start();

  await waitFor(() => ch.rows.length === 4, "spool remainder drained on restart");
  expect(ch.rows.map((r) => r.text).sort()).toEqual(
    [0, 1, 2, 3].map((i) => `survives restart ${i}`).sort(),
  );
  expect(listener2.spool.depth).toBe(0);

  await listener2.stop();
});

// ---------------------------------------------------------------------------
// Spool unit behavior: offset persistence + compaction
// ---------------------------------------------------------------------------

test("spool persists progress across instances and compacts when drained", () => {
  const dir = tmpSpoolDir();
  const row = (i: number): SlackMessageRow => ({
    channel: "C9",
    ts: `1718000000.00000${i}`,
    event_ts: slackTsToDateTime(`1718000000.00000${i}`),
    thread_ts: "",
    user: "U1",
    text: `m${i}`,
    subtype: "",
    raw: "{}",
  });

  const a = new Spool(dir);
  for (let i = 0; i < 3; i++) a.append(row(i));
  expect(a.depth).toBe(3);
  a.ack(2); // two delivered, one left

  const b = new Spool(dir); // "restart"
  expect(b.depth).toBe(1);
  expect((JSON.parse(b.peek(1)[0]) as SlackMessageRow).text).toBe("m2");
  b.ack(1); // drained → compacted
  expect(b.depth).toBe(0);
  expect(fs.readFileSync(path.join(dir, "slack-events.ndjson"), "utf8")).toBe("");

  const c = new Spool(dir);
  expect(c.depth).toBe(0);
});

// ---------------------------------------------------------------------------
// Queue cap: memory stays bounded; overflow reloads from disk as it drains.
// ---------------------------------------------------------------------------

test("spool caps the in-memory queue and reloads overflow from disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spool-cap-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const row = (n: number): SlackMessageRow => ({
    channel: "C1",
    ts: `1718000000.00000${n}`,
    event_ts: slackTsToDateTime(`1718000000.00000${n}`),
    thread_ts: "",
    user: "U1",
    text: `m${n}`,
    subtype: "",
    raw: "{}",
  });
  const spool = new Spool(dir, 2);
  for (let i = 0; i < 5; i++) spool.append(row(i));
  expect(spool.depth).toBe(2); // capped — the rest lives on disk only
  expect(spool.backlogBytes).toBeGreaterThan(0);

  const delivered: string[] = [];
  while (spool.depth > 0) {
    const batch = spool.peek(10);
    delivered.push(...batch);
    spool.ack(batch.length);
  }
  // every appended row delivered despite the cap, in order, then compacted
  expect(delivered.map((l) => (JSON.parse(l) as SlackMessageRow).text)).toEqual(
    ["m0", "m1", "m2", "m3", "m4"],
  );
  expect(spool.backlogBytes).toBe(0);
  expect(fs.readFileSync(path.join(dir, "slack-events.ndjson"), "utf8")).toBe("");
});
