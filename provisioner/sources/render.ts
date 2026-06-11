// SPDX-License-Identifier: Apache-2.0
/**
 * Render provisioner (Phase 4, task 4.3) — SCAFFOLD.
 *
 * Configures a Render workspace Log Stream to forward HTTPS JSON to
 * https://<host>/ingest/render. Where Render's API allows it, this is done over
 * the API; where it does not, the provisioner emits precise click-by-click
 * instructions with the URL/token pre-filled (guided self-setup is an
 * acceptable fallback; silent failure is not — task 4.3).
 *
 * ⚠ I7: Render's HTTPS-JSON log-stream payload schema is not publicly
 * documented and the log-stream config API surface churns — re-verify at build
 * time. ⚠ Render drops lines beyond ~6k/min/instance (README) — that gap is a
 * provenance gotcha documented below.
 *
 * Network discipline mirrors Vercel: plan() works tokenless; apply() requires
 * RENDER_API_KEY and throws a precise human-gated error when absent.
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

const TOKEN_ENV = "RENDER_API_KEY";

export interface RenderConfig {
  ingestHost: string;
  ingestToken: string;
  /** Render workspace (owner) id the log stream is configured on. */
  workspaceId: string;
}

export class RenderProvisioner implements SourceProvisioner {
  readonly source = "render" as const;

  constructor(
    private store: KnowledgeStore,
    private cfg: RenderConfig,
  ) {}

  async discover(): Promise<DiscoveryResult> {
    const token = process.env[TOKEN_ENV];
    const notes: string[] = [];
    if (!token) {
      notes.push(`${TOKEN_ENV} not set — discovery is a preview only.`);
    }
    notes.push(
      "Log streams are configured at the workspace level (one per workspace).",
      "Render drops lines beyond ~6k/min/instance — streaming out is the durable copy.",
      "If the API rejects log-stream config, apply() prints guided click-by-click setup.",
    );
    return {
      source: this.source,
      targets: [{ workspaceId: this.cfg.workspaceId }],
      notes,
    };
  }

  plan(discovery: DiscoveryResult): Plan {
    const url = `https://${this.cfg.ingestHost}/ingest/render`;
    const steps: PlanStep[] = discovery.targets.map((t) => {
      const workspaceId = String(t.workspaceId);
      return {
        kind: "log-stream",
        description: `Configure Render workspace ${workspaceId} log stream → ${url}`,
        idempotencyKey: `render:log-stream:${workspaceId}:${url}`,
        details: { workspaceId, url, protocol: "https-json" },
      };
    });
    return { source: this.source, steps };
  }

  async apply(plan: Plan, opts: ApplyOptions = {}): Promise<StepResult[]> {
    return applySteps(
      this.store,
      plan,
      async (step) => {
        const token = process.env[TOKEN_ENV];
        if (!token) {
          throw new HumanGatedError(
            TOKEN_ENV,
            "Provide a Render API key (workspace owner) to configure the log stream, " +
              "or follow the printed guided-setup instructions.",
          );
        }
        // LIVE PATH (guarded): PATCH the workspace log-stream setting via the
        // Render API. If the API surface does not expose it, fall back to
        // emitting guided instructions rather than failing silently (4.3):
        await this.configureLogStream(step, token);
      },
      opts,
    );
  }

  /** Instructions a human can follow when the API path is unavailable (4.3). */
  guidedInstructions(step: PlanStep): string {
    return [
      "Render guided log-stream setup:",
      "  1. Render Dashboard → Workspace Settings → Log Streams.",
      `  2. Add an HTTPS endpoint: ${step.details.url}`,
      `  3. Set the bearer header: Authorization: Bearer <ingest token>`,
      "  4. Save. Verify a line lands in setoku.logs_render within ~1 min.",
    ].join("\n");
  }

  async document(_plan: Plan): Promise<void> {
    documentTable(this.store, {
      source: "render",
      table: "logs_render",
      refreshCadence:
        "live; Render forwards HTTPS-JSON log lines to /ingest/render",
      columns: [
        { name: "ts", meaning: "event time (parsed best-effort; falls back to receive time)" },
        { name: "service", meaning: "Render service slug/name annotation" },
        { name: "instance", meaning: "Render instance id (distinguishes replicas)" },
        { name: "level", meaning: "log level (info default)" },
        { name: "raw", meaning: "full original event JSON — nothing dropped" },
      ],
      exampleQueries: [
        "SELECT service, count() FROM setoku.logs_render WHERE level='error' GROUP BY service",
      ],
      gotchas: [
        "Render/Vercel drains drop batches when the receiver is down; gaps in logs_render ≠ traffic dips.",
        "Render caps log forwarding at ~6k lines/min/instance — high-volume telemetry above that is dropped; route it as first-party events instead.",
      ],
    });
  }

  private async configureLogStream(
    step: PlanStep,
    token: string,
  ): Promise<void> {
    // Placeholder for the live API call. The exact endpoint is verified at
    // build time (I7). On any non-2xx, raise with the guided fallback attached
    // so the operator is never left guessing.
    const res = await fetch(
      `https://api.render.com/v1/owners/${step.details.workspaceId}/log-stream`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          endpoint: step.details.url,
          headers: { Authorization: `Bearer ${this.cfg.ingestToken}` },
        }),
      },
    );
    if (!res.ok) {
      throw new Error(
        `Render log-stream API → ${res.status}. Fall back to guided setup:\n` +
          this.guidedInstructions(step),
      );
    }
  }
}
