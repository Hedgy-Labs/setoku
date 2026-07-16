---
name: eval
description: Run the Setoku golden-question eval for this repository and report a scorecard. Use when the user asks to eval/test setoku answer quality, or after significant context-artifact changes.
---

# Setoku eval

Run the repo's golden questions end-to-end through the normal retrieve-then-query path and score the results. This is how we measure whether the context artifact actually improves answers. All inference happens right here in this session — no harness, no API keys.

> **One box per session.** This skill calls tools by bare name (`find_context`, `get_metric`, `run_query`, …). If more than one Setoku box is connected, the same tool name resolves ambiguously and you'd score the wrong box's artifact. If you see a bare tool offered by multiple setoku connectors, **stop and ask the user which box** to eval before running — or have them disconnect the others.

## Golden questions file

`.setoku/eval/questions.md` — one section per question:

```markdown
## Q: How much revenue did we make last month?

expect: a single number; must exclude refunded orders
expect_sql_includes: status = 'paid'
tolerance: exact

## Q: How many active customers do we have?

expect: number; soft-deleted customers excluded
tolerance: exact
```

`expect` is the rubric (plain language, checkable). Optional `expect_sql_includes` asserts the generated SQL contains a fragment (case-insensitive). `tolerance`: `exact` | `±N%` | `judgment`.

If the file doesn't exist, offer to create it: propose 5–10 questions from the artifact's metrics + gotchas (each gotcha should have at least one question that would expose ignoring it), confirm expected answers with the user (or compute them together and have the user verify), then write the file.

## Run protocol (per question, in order)

1. Answer the question **exactly as you would for a real question** (find_context → get_metric → SQL → run_query). Do not peek at the `expect` line until your answer is produced.
2. Then compare against the rubric: PASS / FAIL / PARTIAL, one line of reasoning.
3. On FAIL, diagnose the layer: retrieval miss (find_context didn't surface the right doc) / context gap (doc missing or wrong) / SQL error / rubric stale. Propose the fix; for context gaps, draft the `report_correction` call and make it.

## Scorecard (end of run)

| #   | Question | Result | Layer at fault | Fix |
| --- | -------- | ------ | -------------- | --- |

Summarize: pass rate, the dominant failure layer, and the top 1–2 artifact improvements that would raise the score. Offer to apply them via `/setoku:generate` (refresh mode).

## Structural quality metrics (the fact database itself — issue #10)

The golden-question run above scores the *answer*. To credit (or catch regressions in) changes to the **knowledge store's structure** — concise facts, compaction, auto-judgement — score the intermediate layers directly. These are **deterministic** (pure token/set math reusing the production retrieval scorer), so they need **no model and no API key** and run for free in CI (I8):

```bash
bun run eval:knowledge --spec <spec.json> [--db <knowledge.db>] [--gate]
```

The spec (see `test/fixtures/eval/knowledge.json` for the shape) carries frozen, representation-agnostic ground truth — questions and doc **names**, never internal ids, so the goldens survive a migration of the fact representation. Dimensions:

- **Retrieval** — `precision/recall@k`, hit rate, MRR against labeled `question → relevant doc names`, scored **two ways**: baseline (keyword top-k) and **map-first** (top-k + 1-hop link-graph neighbors). The A/B is the guardrail for the interlink layer — map-first must lift recall without dropping the baseline's precision/MRR (gate knobs `minRecallAtKExpanded`, `minPrecisionAtKExpanded`). See [llm-wiki.md](../../../docs/llm-wiki.md).
- **Wiki structure** — link count, **orphans** (docs disconnected from the graph), **suggested connections** (overlapping-but-unlinked pairs), and **broken links** (refs to no doc). Gradable against planted `orphan:` / `connection:` / `broken:` ground truth; gate with `maxBrokenLinks`. Linked corpus fixture: `test/fixtures/eval/wiki.json`.
- **Redundancy** — near-duplicate doc pairs (Jaccard); the deterministic signal behind "merge repetitive facts".
- **Auto-judgement** — confusion matrix vs human-gold accept/reject labels. The headline is **false-accept rate** (FP/(FP+TN)): the I2/I9 number, since false-accepts are an agent waving bad knowledge past the human-click membrane.
- **Defect detection** — precision/recall of the compaction ("REM sleep") pass against **planted** contradictions/duplicates (ground truth you seeded).

`--gate` enforces threshold floors (`minHitRate`, `maxFalseAcceptRate`, …) and exits non-zero — wire it into CI alongside the fast suite.

**Cost split.** The structural metrics are free (deterministic, automatable in CI). The *fuzzy detectors that produce the labels* — does fact X contradict fact Y? did the auto-judge decide right? — run in **this session on the Max subscription** (no server-side inference, I8). Reserve those for interactive runs after a structural change; gate the deterministic metrics continuously.

## Value: gotcha-trap answer-lift (does Setoku change the answer?)

The metrics above ask "is the right context retrievable." This asks the product question: **does Setoku actually make the answer right?** A "trap" is a question where the naive (schema-only) answer is wrong and only a curated fact saves it (refunds excluded, cents→dollars, dedupe-by-email, …). The trap set lives in `demo/eval/value-traps.json` (Bulldogs demo).

**Deterministic half (free, CI):**
```bash
bun run eval:value [--gate]
```
Reproduces what `find_context` would surface for each trap and checks whether the trap-avoiding fact is reachable — the **necessary condition** for value. Reports grounded-vs-ungrounded **coverage lift** (ungrounded is 0 by construction) and the **context cost** (docs + gotchas surfaced per trap — high coverage bought by flooding gotchas is a precision problem, not a win). Uncovered traps print as a punch-list (add a keyword / `relates_to` link).

**In-session half (the real answer-lift, on Max — I8):** for each trap, answer it **twice**, scoring whether the answer avoids the trap:
1. **Ungrounded** — do NOT call `find_context`/`get_metric`; answer from `get_schema` only.
2. **Grounded** — answer per the analyst skill (find_context → get_metric → run_query).

Scorecard: per trap, ungrounded ✓/✗ and grounded ✓/✗; the **answer-lift = grounded − ungrounded** correct rate. That single number is the closest thing to "is Setoku worth it" — a trap the agent gets right *only* when grounded is Setoku earning its keep. A trap it gets right *both* ways means the curated fact added nothing (drop it or harden the trap); wrong *both* ways means the fact is missing or unreachable (see the deterministic punch-list).

## Tool friction (does the query surface itself get in the way?)

The evals above score the *answer*. This one scores the **tool ergonomics** — where agents get stuck driving `run_query`. It's deterministic and model-free (I8): it mines the box's audit log for the fail→retry→success pattern, clusters failures by cause (`table_unavailable`, `syntax`, `unknown_column`, …), and reports the **in-session recovery rate** per cause.

```bash
bun run eval:friction --db <knowledge.db> [--window <min>] [--json] [--no-sql]
```

A cause with a **low recovery rate** is where agents stay blocked — the priority for a better error hint (`plugin/gateway/lib/queryhint.ts`, which already appends a "→ next step" to live `run_query` failures), a schema rename, or a new curated metric. The **"intents that keep failing"** section lists the `purpose` strings on repeated failed queries — a question agents can't reliably turn into SQL is often a metric worth curating. This is behavioral (grounded in what agents actually did), not self-report, so it doesn't depend on the model introspecting. SQL snippets can contain customer values; pass `--no-sql` before sharing a report off the box.

## Compaction (the companion pass — issue #10)

Compaction ("REM sleep") — merging duplicate facts, resolving contradictions, tightening verbose docs — is judgment work, so it runs **in a curator session** via [`/setoku:compact-knowledge`](../compact-knowledge/SKILL.md), not as a server-side job (I8). The `/admin/knowledge` health bar surfaces the deterministic signals (contradictions / duplicates / verbose / stale counts) as a cheap map; the skill does the actual semantic cleanup and commits it through the curator membrane (I9). The metrics above are how you check that a compaction pass actually improved the store.
