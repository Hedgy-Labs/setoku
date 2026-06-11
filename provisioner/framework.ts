// SPDX-License-Identifier: Apache-2.0
/**
 * Self-provisioning framework (Phase 4, task 4.1).
 *
 * Setoku's differentiator is that it "hooks itself up": hand it scoped tokens
 * and it discovers your data sources, provisions log drains, infers schemas,
 * creates tables, and documents itself. This file is the spine of that engine.
 *
 * OSS readers will open this file first, so it is deliberately boring and
 * explicit. The three load-bearing rules:
 *
 *   1. Nothing mutates outside apply(). discover() and plan() are read-only;
 *      plan() returns an ordered list of exactly what apply() WOULD create.
 *   2. plan/apply is split and confirmation-gated. A runner prints the plan and
 *      requires explicit confirmation; `dryRun` short-circuits every mutation.
 *   3. apply() is idempotent. Each step carries an idempotencyKey; a step whose
 *      key is already `applied` in the provisioning_log is skipped, so re-runs
 *      are safe.
 *
 * Every action — planned, applied, skipped, or failed — is recorded to the
 * provisioning_log table (task 4.1). Token-shaped material is redacted before
 * anything is logged (task 4.7; see redactSecrets below).
 */
import type {
  KnowledgeStore,
  ProvisioningSource,
} from "../plugin/gateway/lib/store.ts";

/** The author/attribution all provisioner-written rows carry (I2 exception). */
export const PROVISIONER_ACTOR = "setoku-provisioner";

/** Kinds of thing a provisioning step creates. Open-ended on purpose. */
export type PlanStepKind =
  | "log-drain"
  | "log-stream"
  | "slack-app"
  | "backfill"
  | "create-table"
  | "config"
  | "document";

/**
 * One unit of work a provisioner intends to perform. A PlanStep is a pure
 * description — building it must not touch the network or the store.
 */
export interface PlanStep {
  kind: PlanStepKind;
  /** Human-readable, shown in the confirmation prompt. */
  description: string;
  /**
   * Stable key identifying this exact action. Re-running the same provisioning
   * against the same target MUST yield the same key, so already-applied steps
   * are recognised and skipped. Encode the target (project id, table name, …),
   * never anything time- or token-derived.
   */
  idempotencyKey: string;
  /**
   * Structured specifics (the API body, the DDL, the manifest). Logged to the
   * provisioning_log AFTER redaction — never put a raw token in here.
   */
  details: Record<string, unknown>;
}

/** An ordered plan: exactly what apply() will attempt, in order. */
export interface Plan {
  source: ProvisioningSource;
  steps: PlanStep[];
}

export interface ApplyOptions {
  /**
   * When true, print what each step WOULD do and make no changes — no network
   * calls, no store writes. The default everywhere is a real apply, so callers
   * must opt OUT of mutation explicitly per step, but a dryRun apply is always
   * safe to run first.
   */
  dryRun?: boolean;
}

/** Outcome of applying a single step. */
export interface StepResult {
  step: PlanStep;
  status: "applied" | "skipped" | "failed";
  /** Set on failures; human-readable, secret-free. */
  error?: string;
}

/**
 * The lifecycle every source provisioner implements (task 4.1):
 * discover() → plan() → apply() → document().
 *
 *   - discover(): read-only probe of the source (what projects/services exist).
 *   - plan():     turn discovery into an ordered, inspectable Plan. No mutation.
 *   - apply():    execute the plan, idempotently, honouring dryRun.
 *   - document(): write context docs through the membrane (task 4.6) — the
 *                 initial table doc auto-accepts as `setoku-provisioner`;
 *                 provenance gotchas go to the pending corrections queue.
 */
export interface SourceProvisioner {
  readonly source: ProvisioningSource;
  /** Read-only: what does this source contain that we could wire up? */
  discover(): Promise<DiscoveryResult>;
  /** Pure: turn a discovery into an ordered plan. Must not mutate anything. */
  plan(discovery: DiscoveryResult): Plan;
  /** Execute the plan idempotently. dryRun makes no changes. */
  apply(plan: Plan, opts?: ApplyOptions): Promise<StepResult[]>;
  /** Write the self-documentation for what apply() created (task 4.6). */
  document(plan: Plan): Promise<void>;
}

/** What discover() returns: opaque to the framework, shaped by each source. */
export interface DiscoveryResult {
  source: ProvisioningSource;
  /** e.g. the list of Vercel projects / Render services found. */
  targets: Record<string, unknown>[];
  /** Human notes surfaced in the plan printout (e.g. "Pro plan required"). */
  notes: string[];
}

/**
 * Raised by apply() when a live step needs a token that is not present in the
 * environment. This is a human-gated step (README "Requires a human"): the
 * message names the exact env var so the operator knows what to provide.
 */
export class HumanGatedError extends Error {
  constructor(
    public readonly tokenEnvVar: string,
    detail: string,
  ) {
    super(`needs ${tokenEnvVar} — this is a human-gated step. ${detail}`);
    this.name = "HumanGatedError";
  }
}

// ---------------------------------------------------------------------------
// Secret redaction (task 4.7).
//
// Tokens are passed via env/secret mounts and must NEVER reach a context doc or
// the provisioning_log. redactSecrets() masks token-shaped substrings; the
// provisioner pipes every value bound for the log through it. This is
// defence-in-depth — the design also simply never puts tokens in `details` —
// but a single chokepoint that an OSS reader can audit is worth having.
// ---------------------------------------------------------------------------

/**
 * Mask token-shaped material in a string. Recognises the provider token shapes
 * Setoku handles plus generic long opaque secrets:
 *   - Slack tokens:  xoxb-…, xoxp-…, xapp-…
 *   - Vercel tokens: long base62 blobs / vercel_… prefixes
 *   - Bearer headers: "Authorization: Bearer <token>"
 *   - Generic:       runs of >=24 base64url chars that look like a secret
 * The shape of the secret is preserved (prefix + length hint) so logs stay
 * debuggable without leaking the secret.
 */
export function redactSecrets(input: string): string {
  let s = input;
  // Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-, xapp-, xoxe-…).
  s = s.replace(/\bxox[a-z]-[A-Za-z0-9-]{6,}/g, (m) => mask(m, m.slice(0, 5)));
  s = s.replace(/\bxapp-[A-Za-z0-9-]{6,}/g, (m) => mask(m, "xapp-"));
  // Vercel-style prefixed secrets.
  s = s.replace(
    /\b(vercel|rnd|render)_[A-Za-z0-9]{8,}/gi,
    (m, p) => mask(m, `${p}_`),
  );
  // Authorization: Bearer <token>.
  s = s.replace(
    /(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/g,
    (_m, p) => `${p}${mask(_m.slice(p.length), "")}`,
  );
  // Generic long opaque blobs (24+ base64url-ish chars, not plain words).
  s = s.replace(/\b[A-Za-z0-9_-]{24,}\b/g, (m) =>
    looksLikeSecret(m) ? mask(m, "") : m,
  );
  return s;
}

/** Deep-redact every string in an arbitrary value (for `details`/`detail`). */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redactValue) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v);
    return out as T;
  }
  return value;
}

function mask(full: string, keepPrefix: string): string {
  return `${keepPrefix}***redacted(${full.length})`;
}

/** Heuristic: enough entropy / mixed classes to be a secret, not an id/word. */
function looksLikeSecret(s: string): boolean {
  const hasUpper = /[A-Z]/.test(s);
  const hasLower = /[a-z]/.test(s);
  const hasDigit = /[0-9]/.test(s);
  // Pure-lowercase or pure-digit runs (ids, hashes-of-known-shape) are common
  // and benign; require mixed case+digits to flag as a likely secret.
  return (hasUpper && hasLower && hasDigit) || s.length >= 40;
}

// ---------------------------------------------------------------------------
// The runner: print → confirm → apply, with idempotency + logging (task 4.1).
// ---------------------------------------------------------------------------

/** Render a plan as a human-readable block for the confirmation prompt. */
export function formatPlan(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`Plan for source "${plan.source}" — ${plan.steps.length} step(s):`);
  plan.steps.forEach((step, i) => {
    lines.push(`  ${i + 1}. [${step.kind}] ${step.description}`);
    lines.push(`     key: ${step.idempotencyKey}`);
    const details = redactValue(step.details);
    if (Object.keys(details).length > 0) {
      lines.push(`     details: ${JSON.stringify(details)}`);
    }
  });
  return lines.join("\n");
}

export interface RunOptions extends ApplyOptions {
  /**
   * Confirmation gate. The runner prints the plan, then calls confirm() and
   * only proceeds if it resolves true. dryRun runs proceed without confirming
   * (they change nothing). Wire this to a real TTY prompt in the CLI.
   */
  confirm?: (plan: Plan, printed: string) => boolean | Promise<boolean>;
  /** Where the plan + outcomes are printed. Defaults to console.log. */
  log?: (line: string) => void;
}

/**
 * Drive one provisioner through its full lifecycle: discover → plan → print →
 * confirm → apply → document. Returns the per-step results. This is what both
 * `setoku init` (CLI) and the MCP tool call.
 */
export async function runProvisioner(
  p: SourceProvisioner,
  opts: RunOptions = {},
): Promise<{ plan: Plan; results: StepResult[]; confirmed: boolean }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const discovery = await p.discover();
  const plan = p.plan(discovery);
  const printed = formatPlan(plan);
  log(printed);
  if (discovery.notes.length > 0) {
    log("Notes:");
    for (const n of discovery.notes) log(`  - ${n}`);
  }

  if (opts.dryRun) {
    log("(dry run — no changes will be made)");
    const results = await p.apply(plan, { dryRun: true });
    return { plan, results, confirmed: false };
  }

  const confirmed = opts.confirm ? await opts.confirm(plan, printed) : true;
  if (!confirmed) {
    log("Aborted — no changes made.");
    return { plan, results: [], confirmed: false };
  }

  const results = await p.apply(plan, { dryRun: false });
  await p.document(plan);
  return { plan, results, confirmed: true };
}

/**
 * Apply a plan step-by-step against the store with idempotency + logging.
 * Source provisioners call this from their apply(): they supply an executor
 * that performs the actual side effect (an API call, a DDL run). The framework
 * owns the boring, audit-critical parts: skip-if-applied, dryRun, and writing
 * exactly one provisioning_log row per step.
 *
 * Contract for `execute`: perform the side effect, or throw. It is only ever
 * called for steps that are NOT already applied and NOT in a dry run.
 */
export async function applySteps(
  store: KnowledgeStore,
  plan: Plan,
  execute: (step: PlanStep) => Promise<void>,
  opts: ApplyOptions = {},
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of plan.steps) {
    const detail = redactValue(step.details);

    if (opts.dryRun) {
      // Record intent, change nothing.
      store.logProvisioning({
        source: plan.source,
        stepKind: step.kind,
        idempotencyKey: step.idempotencyKey,
        status: "planned",
        detail,
        actor: PROVISIONER_ACTOR,
      });
      results.push({ step, status: "skipped" });
      continue;
    }

    // Idempotency: already applied → skip without touching the source again.
    if (store.wasApplied(step.idempotencyKey)) {
      store.logProvisioning({
        source: plan.source,
        stepKind: step.kind,
        idempotencyKey: step.idempotencyKey,
        status: "skipped",
        detail,
        actor: PROVISIONER_ACTOR,
      });
      results.push({ step, status: "skipped" });
      continue;
    }

    try {
      await execute(step);
      store.logProvisioning({
        source: plan.source,
        stepKind: step.kind,
        idempotencyKey: step.idempotencyKey,
        status: "applied",
        detail,
        actor: PROVISIONER_ACTOR,
      });
      results.push({ step, status: "applied" });
    } catch (err) {
      const message = redactSecrets(
        err instanceof Error ? err.message : String(err),
      );
      store.logProvisioning({
        source: plan.source,
        stepKind: step.kind,
        idempotencyKey: step.idempotencyKey,
        status: "failed",
        detail: { ...detail, error: message },
        actor: PROVISIONER_ACTOR,
      });
      results.push({ step, status: "failed", error: message });
      // Stop on first failure — partial provisioning is easier to reason about
      // when it stops at the break than when it limps on.
      break;
    }
  }
  return results;
}
