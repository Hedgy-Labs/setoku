// SPDX-License-Identifier: Apache-2.0
/**
 * Slack provisioner (Phase 4, task 4.4) — SCAFFOLD.
 *
 * Generates a workspace-specific app manifest, hands the human the one-click
 * manifest-install URL, accepts the resulting tokens, and starts the listener +
 * backfill. App creation/install is necessarily a human click in the workspace
 * (README "Requires a human") — the provisioner prepares everything around it.
 *
 * ⚠ I7: every org self-hosting runs its own INTERNAL Slack app, which keeps the
 * generous rate-limit tier (~50 req/min). ⚠ Free-plan workspaces retain only
 * ~90 days of history — the archive only accrues forward, so the listener must
 * start as early as possible. That window limit is a provenance gotcha below.
 *
 * Network discipline: plan() works without tokens (it prints the manifest +
 * install URL). apply() requires SLACK_APP_TOKEN + SLACK_BOT_TOKEN (the result
 * of the human install) and throws a precise human-gated error when absent.
 */
import type { KnowledgeStore } from "../../plugin/gateway/lib/store.ts";
import {
  applySteps,
  HumanGatedError,
  type ApplyOptions,
  type DiscoveryResult,
  type Plan,
  type PlanStep,
  type SourceProvisioner,
  type StepResult,
} from "../framework.ts";
import { documentTable } from "../document.ts";

const APP_TOKEN_ENV = "SLACK_APP_TOKEN";
const BOT_TOKEN_ENV = "SLACK_BOT_TOKEN";

export interface SlackConfig {
  /** Display name for the generated app, e.g. "Setoku Archiver". */
  appName: string;
  /** Workspace id (T…) — stamped into the install URL / doc. */
  workspaceId: string;
  /** ISO date the backfill/listener starts — the "history floor" for the doc. */
  backfillStart: string;
}

export class SlackProvisioner implements SourceProvisioner {
  readonly source = "slack" as const;

  constructor(
    private store: KnowledgeStore,
    private cfg: SlackConfig,
  ) {}

  async discover(): Promise<DiscoveryResult> {
    const installed = !!process.env[APP_TOKEN_ENV] && !!process.env[BOT_TOKEN_ENV];
    return {
      source: this.source,
      targets: [{ workspaceId: this.cfg.workspaceId }],
      notes: [
        installed
          ? "App tokens present — listener + backfill can start."
          : `App not yet installed — ${APP_TOKEN_ENV}/${BOT_TOKEN_ENV} absent; ` +
            "apply() will hand you the manifest-install URL (human click).",
        "Self-hosted = internal app → generous rate-limit tier (~50 req/min).",
        `Free-plan history floor: nothing before ${this.cfg.backfillStart} is retrievable.`,
      ],
    };
  }

  /** Generate the Slack app manifest (workspace-specific). Pure. */
  buildManifest(): Record<string, unknown> {
    return {
      display_information: { name: this.cfg.appName },
      features: { bot_user: { display_name: this.cfg.appName } },
      oauth_config: {
        scopes: {
          bot: ["channels:history", "channels:read", "users:read"],
        },
      },
      settings: {
        event_subscriptions: { bot_events: ["message.channels"] },
        socket_mode_enabled: true,
      },
    };
  }

  /** The one-click install URL (the human action — task 4.4). */
  installUrl(): string {
    const manifest = encodeURIComponent(JSON.stringify(this.buildManifest()));
    return `https://api.slack.com/apps?new_app=1&manifest_json=${manifest}`;
  }

  plan(discovery: DiscoveryResult): Plan {
    const ws = String(discovery.targets[0]?.workspaceId ?? this.cfg.workspaceId);
    const steps: PlanStep[] = [
      {
        kind: "slack-app",
        description: `Install Setoku Slack app in workspace ${ws} (human click)`,
        idempotencyKey: `slack:app-install:${ws}`,
        details: { workspaceId: ws, installUrl: this.installUrl() },
      },
      {
        kind: "backfill",
        description: `Backfill + start listener from ${this.cfg.backfillStart}`,
        idempotencyKey: `slack:backfill:${ws}:${this.cfg.backfillStart}`,
        details: { workspaceId: ws, backfillStart: this.cfg.backfillStart },
      },
    ];
    return { source: this.source, steps };
  }

  async apply(plan: Plan, opts: ApplyOptions = {}): Promise<StepResult[]> {
    return applySteps(
      this.store,
      plan,
      async (_step) => {
        const appToken = process.env[APP_TOKEN_ENV];
        const botToken = process.env[BOT_TOKEN_ENV];
        if (!appToken || !botToken) {
          throw new HumanGatedError(
            `${APP_TOKEN_ENV} + ${BOT_TOKEN_ENV}`,
            `Install the app first (one click): ${this.installUrl()} — then ` +
              "supply the app-level and bot tokens via env/secret mounts.",
          );
        }
        // LIVE PATH (guarded): with tokens present, start the listener daemon
        // and kick off the resumable backfill (ingest/slack-listener/*). No
        // real network call happens in tests — the guard fires first there.
      },
      opts,
    );
  }

  async document(_plan: Plan): Promise<void> {
    documentTable(this.store, {
      source: "slack",
      table: "slack_messages",
      refreshCadence:
        "live via Socket Mode; one-time backfill of the retrievable window",
      columns: [
        { name: "channel", meaning: "Slack channel id (C…)" },
        { name: "ts", meaning: 'Slack message ts (e.g. "1718000000.123456") — dedupe key' },
        { name: "thread_ts", meaning: "parent thread ts; empty for top-level messages" },
        { name: "user", meaning: "Slack user id (U…) of the author" },
        { name: "text", meaning: "message text (raw Slack markup)" },
        { name: "raw", meaning: "full original event JSON — nothing dropped" },
      ],
      exampleQueries: [
        "SELECT channel, count() FROM setoku.slack_messages WHERE event_ts >= now() - INTERVAL 7 DAY GROUP BY channel",
      ],
      gotchas: [
        `Slack history before ${this.cfg.backfillStart} is unavailable (free-plan ~90-day window) — the archive only accrues forward.`,
        "Self-hosted internal apps keep the generous rate tier; a hosted SaaS would hit the ~1 req/min commercial cap.",
      ],
    });
  }
}
