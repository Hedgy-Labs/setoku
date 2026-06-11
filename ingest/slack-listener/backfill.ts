#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * Setoku Slack backfill — one-shot history import (task 3.4).
 *
 * Paginates conversations.history (then conversations.replies for each thread
 * parent) over the retrievable window and inserts the SAME row shape as the
 * live listener into setoku.slack_messages. Idempotent by construction: the
 * table is ReplacingMergeTree ORDER BY (channel, ts), so re-runs and
 * listener/backfill overlap dedupe to one row.
 *
 * Resumable: per-channel progress (cursor + window) is checkpointed to
 * <SETOKU_SPOOL_DIR>/slack-backfill-state.json after every page; re-running
 * continues where it left off, and a completed channel re-runs incrementally
 * (only messages newer than the last pass).
 *
 * Rate limits (I7 — verified June 2026; re-verify, these churn):
 *  - 429 Retry-After is ALWAYS honored, with the wait logged.
 *  - Tier auto-detection: internal customer-built apps get ~50 req/min with
 *    big pages; commercially-distributed non-Marketplace apps are capped at
 *    1 req/min and 15 objects. We request limit=200 and, if a has_more
 *    response comes back with ≤15 messages, drop the budget to 1 req/min and
 *    say so. Self-hosted Setoku installs create their own internal app, so
 *    the generous tier is the expected case.
 *
 * Free-plan note: workspaces on Slack's free plan can only retrieve ~90 days
 * of history — anything older is gone to the API. The job prints the oldest
 * ts it could reach per channel so the gap is explicit.
 *
 * Env: SLACK_BOT_TOKEN (required, xoxb-…), SLACK_BACKFILL_CHANNELS (optional
 * comma-separated channel IDs; default = all public channels the bot is in),
 * plus the same CLICKHOUSE_* / SETOKU_SPOOL_DIR vars as listener.ts.
 */
import fs from "node:fs";
import path from "node:path";

import {
  eventToRow,
  insertSlackRows,
  slackTsToDateTime,
  type ClickHouseOptions,
} from "./listener";

// ---------------------------------------------------------------------------
// State file — checkpoint after every page so a kill/re-run loses nothing.
// ---------------------------------------------------------------------------

interface ChannelState {
  /** Lower bound (Slack ts) of the pass currently in progress. */
  oldest: string;
  /** conversations.history cursor to resume from, if mid-pass. */
  cursor?: string;
  done: boolean;
  /** Oldest message ts actually reached (the free-plan visibility horizon). */
  oldest_reached?: string;
  /** Newest message ts seen — the next incremental pass starts here. */
  newest_seen?: string;
}

interface BackfillState {
  tier: "internal (~50 req/min)" | "non-marketplace cap (1 req/min)";
  channels: Record<string, ChannelState>;
}

function statePath(spoolDir: string): string {
  return path.join(spoolDir, "slack-backfill-state.json");
}

function loadState(spoolDir: string): BackfillState {
  const p = statePath(spoolDir);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")) as BackfillState;
  return { tier: "internal (~50 req/min)", channels: {} };
}

function saveState(spoolDir: string, state: BackfillState): void {
  const p = statePath(spoolDir);
  fs.writeFileSync(p + ".tmp", JSON.stringify(state, null, 2));
  fs.renameSync(p + ".tmp", p); // atomic checkpoint
}

/** Numeric compare of Slack ts strings ("seconds.micros"). */
export function tsCompare(a: string, b: string): number {
  const [as, af = "0"] = a.split(".");
  const [bs, bf = "0"] = b.split(".");
  return Number(as) - Number(bs) || Number(af.padEnd(6, "0")) - Number(bf.padEnd(6, "0"));
}

// ---------------------------------------------------------------------------
// Slack web API with rate budget + 429 handling.
// ---------------------------------------------------------------------------

const PAGE_LIMIT = 200; // what we ask for; the capped tier returns ≤15 anyway

class SlackApi {
  /** Minimum gap between requests. ~50 req/min generous, 1 req/min capped. */
  private intervalMs = 60_000 / 50;
  private lastRequestAt = 0;
  capped = false;

  constructor(
    private readonly botToken: string,
    private readonly apiUrl = "https://slack.com/api",
  ) {}

  /** Drop the request budget to the non-Marketplace commercial cap. */
  capToOnePerMinute(): void {
    if (this.capped) return;
    this.capped = true;
    this.intervalMs = 60_000;
    console.error(
      "slack-backfill: detected non-Marketplace commercial rate tier " +
        "(responses cap at 15 objects) — dropping to 1 request/min. " +
        "A workspace-internal app gets ~50 req/min; see README.",
    );
  }

  async call(
    method: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    for (;;) {
      const wait = this.lastRequestAt + this.intervalMs - Date.now();
      if (wait > 0) await Bun.sleep(wait);
      this.lastRequestAt = Date.now();

      const res = await fetch(`${this.apiUrl}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.botToken}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(params),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "30") || 30;
        console.error(`slack-backfill: 429 on ${method} — waiting ${retryAfter}s`);
        await Bun.sleep(retryAfter * 1000);
        continue;
      }
      const body = (await res.json()) as Record<string, unknown>;
      if (body.ok !== true) {
        if (body.error === "ratelimited") {
          console.error(`slack-backfill: ratelimited on ${method} — waiting 60s`);
          await Bun.sleep(60_000);
          continue;
        }
        throw new Error(`${method}: ${String(body.error ?? `HTTP ${res.status}`)}`);
      }
      return body;
    }
  }

  /** History-family page with tier auto-detection (I7). */
  async historyPage(
    method: "conversations.history" | "conversations.replies",
    params: Record<string, string>,
  ): Promise<{ messages: Record<string, unknown>[]; nextCursor?: string }> {
    const body = await this.call(method, { ...params, limit: String(PAGE_LIMIT) });
    const messages = (body.messages ?? []) as Record<string, unknown>[];
    if (!this.capped && body.has_more === true && messages.length <= 15) {
      this.capToOnePerMinute();
    }
    const meta = body.response_metadata as { next_cursor?: string } | undefined;
    return { messages, nextCursor: meta?.next_cursor || undefined };
  }
}

// ---------------------------------------------------------------------------
// Insert with bounded retry (one-shot job: fail loudly, state is checkpointed).
// ---------------------------------------------------------------------------

async function insertWithRetry(ch: ClickHouseOptions, lines: string[]): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      await insertSlackRows(ch, lines);
      return;
    } catch (e) {
      if (++attempt >= 8) throw e;
      const delay = Math.min(60_000, 1000 * 2 ** attempt);
      console.error(
        `slack-backfill: insert failed (attempt ${attempt}, retry in ${delay}ms): ${e}`,
      );
      await Bun.sleep(delay);
    }
  }
}

// ---------------------------------------------------------------------------
// The backfill.
// ---------------------------------------------------------------------------

export interface BackfillOptions {
  botToken: string;
  clickhouse: ClickHouseOptions;
  spoolDir: string;
  /** Channel IDs; empty = discover via conversations.list (bot membership). */
  channels: string[];
  slackApiUrl?: string;
}

export async function runBackfill(o: BackfillOptions): Promise<void> {
  fs.mkdirSync(o.spoolDir, { recursive: true });
  const api = new SlackApi(o.botToken, o.slackApiUrl);
  const state = loadState(o.spoolDir);
  if (state.tier.startsWith("non-marketplace")) api.capToOnePerMinute();

  const channels = o.channels.length > 0 ? o.channels : await discoverChannels(api);
  console.error(`slack-backfill: ${channels.length} channel(s) to backfill`);

  for (const channel of channels) {
    await backfillChannel(api, state, o, channel);
  }

  // Final report: the free-plan window means history older than ~90 days is
  // unreachable — make the horizon explicit per channel.
  console.error("slack-backfill: complete. Oldest message reached per channel:");
  for (const channel of channels) {
    const st = state.channels[channel];
    const oldest = st?.oldest_reached
      ? `${st.oldest_reached} (${slackTsToDateTime(st.oldest_reached)} UTC)`
      : "(no messages retrievable)";
    console.error(`  ${channel}: ${oldest}`);
  }
  console.error(
    "slack-backfill: note — on Slack's free plan, history older than ~90 days " +
      "is not retrievable via the API; anything before the timestamps above is " +
      "gone. The live listener is the durable copy going forward.",
  );
}

/** All public channels the bot is a member of. */
async function discoverChannels(api: SlackApi): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const params: Record<string, string> = {
      types: "public_channel",
      exclude_archived: "false", // archived history is still worth archiving
      limit: String(PAGE_LIMIT),
    };
    if (cursor) params.cursor = cursor;
    const body = await api.call("conversations.list", params);
    for (const c of (body.channels ?? []) as Record<string, unknown>[]) {
      if (c.is_member === true && typeof c.id === "string") ids.push(c.id);
    }
    const meta = body.response_metadata as { next_cursor?: string } | undefined;
    cursor = meta?.next_cursor || undefined;
  } while (cursor);
  return ids;
}

async function backfillChannel(
  api: SlackApi,
  state: BackfillState,
  o: BackfillOptions,
  channel: string,
): Promise<void> {
  let st = state.channels[channel];
  if (!st) st = state.channels[channel] = { oldest: "0", done: false };
  if (st.done) {
    // Channel finished a previous pass — run incrementally from the newest
    // message we saw (idempotent overlap is fine; dedupe handles it).
    st.oldest = st.newest_seen ?? "0";
    st.cursor = undefined;
    st.done = false;
  }
  console.error(
    `slack-backfill: ${channel} — starting from oldest=${st.oldest}` +
      (st.cursor ? " (resuming saved cursor)" : ""),
  );

  do {
    const params: Record<string, string> = { channel, oldest: st.oldest };
    if (st.cursor) params.cursor = st.cursor;
    const page = await api.historyPage("conversations.history", params);

    // Oldest-first within the page (Slack pages newest-first; order only
    // matters for readable progress — dedupe makes insert order irrelevant).
    const messages = [...page.messages].sort((a, b) =>
      tsCompare(String(a.ts ?? "0"), String(b.ts ?? "0")),
    );

    const lines: string[] = [];
    for (const m of messages) {
      // history messages carry no channel field — inject it for the row shape.
      const row = eventToRow({ ...m, channel });
      if (!row) continue;
      lines.push(JSON.stringify(row) + "\n");
      if (typeof m.ts === "string") {
        if (!st.oldest_reached || tsCompare(m.ts, st.oldest_reached) < 0) {
          st.oldest_reached = m.ts;
        }
        if (!st.newest_seen || tsCompare(m.ts, st.newest_seen) > 0) {
          st.newest_seen = m.ts;
        }
      }
      // Thread parent → pull the whole thread (replies are not in history).
      if (typeof m.ts === "string" && m.thread_ts === m.ts) {
        for (const reply of await fetchReplies(api, channel, m.ts)) {
          const replyRow = eventToRow({ ...reply, channel });
          if (replyRow) lines.push(JSON.stringify(replyRow) + "\n");
        }
      }
    }

    await insertWithRetry(o.clickhouse, lines);
    st.cursor = page.nextCursor;
    if (!st.cursor) st.done = true;
    saveState(o.spoolDir, {
      ...state,
      tier: api.capped ? "non-marketplace cap (1 req/min)" : "internal (~50 req/min)",
    });
    console.error(
      `slack-backfill: ${channel} — page of ${messages.length} done` +
        (st.cursor ? ", more to go" : ", channel complete"),
    );
  } while (st.cursor);
}

/** Every message in a thread, all pages (includes the parent — dedupe eats it). */
async function fetchReplies(
  api: SlackApi,
  channel: string,
  threadTs: string,
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  do {
    const params: Record<string, string> = { channel, ts: threadTs };
    if (cursor) params.cursor = cursor;
    const page = await api.historyPage("conversations.replies", params);
    all.push(...page.messages);
    cursor = page.nextCursor;
  } while (cursor);
  all.sort((a, b) => tsCompare(String(a.ts ?? "0"), String(b.ts ?? "0")));
  return all;
}

// ---------------------------------------------------------------------------
// Entry — one-shot; safe to re-run any time.
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const env = process.env;
  const botToken = env.SLACK_BOT_TOKEN;
  if (!botToken) {
    console.error("slack-backfill: SLACK_BOT_TOKEN (xoxb-…) is required");
    process.exit(1);
  }
  await runBackfill({
    botToken,
    clickhouse: {
      url: env.CLICKHOUSE_URL ?? "http://clickhouse:8123",
      user: env.CLICKHOUSE_USER ?? "setoku",
      password: env.CLICKHOUSE_PASSWORD ?? "",
      db: env.CLICKHOUSE_DB ?? "setoku",
    },
    spoolDir: env.SETOKU_SPOOL_DIR ?? "/spool",
    channels: (env.SLACK_BACKFILL_CHANNELS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  });
}
