---
name: eval
description: Run the Setoku golden-question eval for this repository and report a scorecard. Use when the user asks to eval/test setoku answer quality, or after significant context-artifact changes.
---

# Setoku eval

Run the repo's golden questions end-to-end through the analyst workflow and score the results. This is how we measure whether the context artifact actually improves answers. All inference happens right here in this session — no harness, no API keys.

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

1. Answer the question **exactly as the analyst skill prescribes** (find_context → get_metric → SQL → run_query). Do not peek at the `expect` line until your answer is produced.
2. Then compare against the rubric: PASS / FAIL / PARTIAL, one line of reasoning.
3. On FAIL, diagnose the layer: retrieval miss (find_context didn't surface the right doc) / context gap (doc missing or wrong) / SQL error / rubric stale. Propose the fix; for context gaps, draft the `report_correction` call and make it.

## Scorecard (end of run)

| #   | Question | Result | Layer at fault | Fix |
| --- | -------- | ------ | -------------- | --- |

Summarize: pass rate, the dominant failure layer, and the top 1–2 artifact improvements that would raise the score. Offer to apply them via `/setoku:generate` (refresh mode).
