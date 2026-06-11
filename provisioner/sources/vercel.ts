// SPDX-License-Identifier: Apache-2.0
/**
 * Vercel provisioner (Phase 4, task 4.2) — SCAFFOLD.
 *
 * With a scoped Vercel token, this lists projects and creates a Log Drain
 * pointed at https://<host>/ingest/vercel carrying the ingest bearer token, so
 * Vercel POSTs NDJSON log batches to Setoku. ⚠ Drains require the Vercel **Pro**
 * plan (README data-sources note; I7 — re-verify), and creating one is the
 * self-provisioning hook.
 *
 * Network discipline: plan() works WITHOUT a token (it prints what it WOULD
 * create); apply() requires VERCEL_TOKEN and throws a precise human-gated error
 * when absent. Tests never make real network calls — apply() is exercised only
 * in dryRun, or with the token-absent guard.
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

const TOKEN_ENV = "VERCEL_TOKEN";

export interface VercelConfig {
  /** Public ingest host, e.g. "setoku.example.com". */
  ingestHost: string;
  /** The bearer token Vercel will send on each POST (NOT the Vercel API token). */
  ingestToken: string;
  /** Optional: restrict to these Vercel project ids; else all discovered. */
  projectIds?: string[];
}

export class VercelProvisioner implements SourceProvisioner {
  readonly source = "vercel" as const;

  constructor(
    private store: KnowledgeStore,
    private cfg: VercelConfig,
  ) {}

  /**
   * Read-only: list Vercel projects. Without a token we cannot enumerate, so
   * discovery returns a single placeholder target and a note — plan() still
   * produces a meaningful "this is what I would create" preview.
   */
  async discover(): Promise<DiscoveryResult> {
    const token = process.env[TOKEN_ENV];
    if (!token) {
      return {
        source: this.source,
        targets: (this.cfg.projectIds ?? ["<all-projects>"]).map((id) => ({
          projectId: id,
        })),
        notes: [
          `${TOKEN_ENV} not set — discovery is a preview only.`,
          "Vercel Log Drains require the Pro plan (verify at apply time).",
        ],
      };
    }
    // LIVE PATH (guarded; not exercised in tests): GET /v9/projects.
    const projects = await this.vercelGET<{ projects: { id: string }[] }>(
      "/v9/projects",
      token,
    );
    const ids = this.cfg.projectIds ?? projects.projects.map((p) => p.id);
    return {
      source: this.source,
      targets: ids.map((id) => ({ projectId: id })),
      notes: [],
    };
  }

  /** Pure: one create-log-drain step per project. No mutation. */
  plan(discovery: DiscoveryResult): Plan {
    const url = `https://${this.cfg.ingestHost}/ingest/vercel`;
    const steps: PlanStep[] = discovery.targets.map((t) => {
      const projectId = String(t.projectId);
      return {
        kind: "log-drain",
        description: `Create Vercel Log Drain for project ${projectId} → ${url}`,
        // Idempotency: a drain is uniquely identified by (project, url).
        idempotencyKey: `vercel:log-drain:${projectId}:${url}`,
        details: {
          projectId,
          url,
          // The ingest token travels in a header; redaction masks it in logs.
          deliveryFormat: "ndjson",
          sources: ["lambda", "edge", "static", "external"],
        },
      };
    });
    return { source: this.source, steps };
  }

  /** Execute; idempotent; dryRun makes no changes; token-gated. */
  async apply(plan: Plan, opts: ApplyOptions = {}): Promise<StepResult[]> {
    return applySteps(
      this.store,
      plan,
      async (step) => {
        const token = process.env[TOKEN_ENV];
        if (!token) {
          throw new HumanGatedError(
            TOKEN_ENV,
            "Provide a scoped Vercel token (scope: log-drain create) to create drains.",
          );
        }
        // LIVE PATH (guarded): POST /v1/log-drains.
        //   body: { projectIds, url, deliveryFormat, sources, headers:
        //           { Authorization: `Bearer ${this.cfg.ingestToken}` } }
        // A 402/403 here means the project lacks Pro — surface it plainly.
        await this.createLogDrain(step, token);
      },
      opts,
    );
  }

  /** Self-documentation (task 4.6): entity doc auto-accepts; gotcha pends. */
  async document(_plan: Plan): Promise<void> {
    documentTable(this.store, {
      source: "vercel",
      table: "logs_vercel",
      refreshCadence:
        "live; Vercel POSTs NDJSON batches to /ingest/vercel as logs occur",
      columns: [
        { name: "ts", meaning: "log creation time (Vercel timestamp, ms epoch, UTC)" },
        { name: "source", meaning: "build | edge | lambda | static | external | firewall" },
        { name: "level", meaning: "info | warning | error | fatal" },
        { name: "status_code", meaning: "HTTP status; -1 = lambda crash; 0 = n/a" },
        { name: "raw", meaning: "full original drain event JSON — nothing dropped" },
      ],
      exampleQueries: [
        "SELECT toStartOfHour(ts) h, quantile(0.95)(status_code) FROM setoku.logs_vercel GROUP BY h ORDER BY h",
      ],
      // PENDING (not auto-accepted) — a human confirms these claims (I2).
      gotchas: [
        "Vercel drains drop batches when the receiver is down; gaps in logs_vercel ≠ traffic dips.",
        "Health checks and crawlers pollute traffic metrics — filter user_agent before reading volume.",
      ],
    });
  }

  // --- live HTTP (guarded; never called in tests) --------------------------

  private async vercelGET<T>(pathname: string, token: string): Promise<T> {
    const res = await fetch(`https://api.vercel.com${pathname}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Vercel GET ${pathname} → ${res.status}`);
    return (await res.json()) as T;
  }

  private async createLogDrain(step: PlanStep, token: string): Promise<void> {
    const res = await fetch("https://api.vercel.com/v1/log-drains", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectIds: [step.details.projectId],
        url: step.details.url,
        deliveryFormat: step.details.deliveryFormat,
        sources: step.details.sources,
        headers: { Authorization: `Bearer ${this.cfg.ingestToken}` },
      }),
    });
    if (res.status === 402 || res.status === 403) {
      throw new Error(
        `Vercel rejected drain creation (${res.status}) — the project likely ` +
          `lacks the Pro plan required for Log Drains. This is a human-gated step.`,
      );
    }
    if (!res.ok) throw new Error(`Vercel POST /v1/log-drains → ${res.status}`);
  }
}
