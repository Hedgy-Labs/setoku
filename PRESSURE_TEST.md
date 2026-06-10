# Pressure test: does the design produce correct answers? (hedgy, 2026-06-09)

**Riskiest assumption tested:** that gateway-served, code-derived context (retrieval + canonical SQL + gotchas) makes the agent's answers to real business questions _correct_, where schema-only guessing would be wrong.

## Method

- Knowledge generated from hedgy's actual code (`lib/company-plan.ts`, `lib/weekly-connections.ts`, `prisma/schema.prisma`) into the gateway's SQLite store: 4 entities, 4 metrics, 8 gotchas, overview — every claim `file:line`-grounded.
- **Ground truth** computed independently via psql using the canonical predicates from the code.
- **Naive baseline** = the most plausible SQL written from column names alone (what a schema-only agent guesses).
- Eval driven through the real gateway over MCP (`scripts/call.ts`); inference = the Claude Code session (subscription-native, zero API keys).

## Results — 4/4 exact matches; naive is wrong on all four

| Q   | Question                          | Setoku answer | Ground truth | Naive (schema-only) | Why naive fails                                                                                                        |
| --- | --------------------------------- | ------------- | ------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | How many companies are paying us? | **66** ✅     | 66           | **4** (16× low)     | misses success-fee (`billingModel=PLACEMENT_FEE`) + trialing + feeAcknowledged                                         |
| 2   | Intros accepted in May 2026?      | **62** ✅     | 62           | **11** (5.6× low)   | counts current `UserCompanyPairing.status` instead of `PairingStatusChange` events                                     |
| 3   | …how many were _paid_ intros?     | **59** ✅     | 59           | **12** (4.9× low)   | uses `companyIsPaying` instead of the deliberately-different paid-connection predicate (ACTIVE/PLACEMENT_FEE/PARAFORM) |
| 4   | Live roles right now?             | **5363** ✅   | 5363         | **6817** (27% high) | ignores `expiredAt IS NULL` (no status column to hint at it)                                                           |

Retrieval behavior:

- Q1/Q3: the **predicate gotchas surfaced first**, before the metric — exactly the prevent-wrong-answer ordering intended. Q3 is the subtlest trap (two near-identical "paid" predicates) and retrieval disambiguated it.
- Q2: canonical SQL (event table + Pacific boundaries + both accept statuses) retrieved as top hit.
- Honesty probe ("average time to hire", uncovered): no false confidence — surfaced adjacent-relevant context (PairingStatusChange, Pacific-time gotcha), which is where that metric would in fact be computed.

## Read on the assumption

**Supported, with a caveat.** The mechanism works end-to-end: keyword retrieval reliably surfaced the right metric + gotchas for paraphrased questions, and following retrieved context converted 4 would-be-wrong answers into 4 exact ones. The deltas are not subtle (4.9×–16×) — this is the difference between a usable analyst and a dangerous one.

Caveat (honest limit of this first run): the same agent wrote the context and answered the questions, hours apart — and that agent had hedgy gotchas in persistent memory. **Addressed by the clean-room A/B below.** Remaining harder test: golden questions written by humans (`/setoku:eval`) and a second business' codebase.

## Clean-room A/B (de-loading the test)

Objection: the answering agent already "knew" the gotchas (conversation + persistent memory). Fix: **fresh subagents with no access to this conversation or memory**, forbidden from reading hedgy source code, driving the same gateway via the shell driver. Condition A = `get_schema` + `run_query` only (schema-only analyst). Condition B = must call `find_context` first and follow it. Protocol compliance **verified from the gateway's own audit log** (per-condition `SETOKU_USER` tags): A-agents made zero context-tool calls; B-agents called `find_context` before querying.

| Q (ground truth)          | A: schema-only                                                                                                                                    | B: setoku      | A effort                                      | B effort                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------- | ---------------------------------------- |
| Paying companies (66)     | **22** ✗ (3× low; invented a `feeActiveAt` qualifier, missed TRIALING + feeAcknowledged)                                                          | **66** ✓ exact | 7 calls, 57s, 20k tok, _medium_ confidence    | 2 calls, 18s, 14k tok, _high_ confidence |
| Paid intros May 2026 (59) | **24** ✗ (2.5× low; missed COMPANY_INTRO_ACCEPTED, reverse-engineered a plausible-but-wrong "paid" predicate; its own alternative reading gave 8) | **59** ✓ exact | 23 calls, 8 min, 60k tok, _medium_ confidence | 2 calls, 24s, 14k tok, _high_ confidence |

Notes:

- The A-agents were _good_ — A2 spent 8 minutes genuinely reverse-engineering the paid predicate from data and produced confident-sounding, well-reasoned, **wrong** answers. That's the production failure mode Setoku exists to prevent: plausible analysis, wrong business semantics.
- B-agents had no prior knowledge, only retrieval — and reproduced the exact canonical answers in 2 tool calls each, citing the gotchas in their reasoning.
- Efficiency bonus: B was ~10–20× faster and ~1.5–4× cheaper per question.

**Verdict: the assumption holds in clean-room conditions.** Context-following, not author-memory, produced the correct answers.

## Artifacts

- hedgy context seed: `hedgy/.setoku/` (config + context markdown; auto-imported into the service store on first gateway boot)
- driver: `scripts/call.ts` · ground truths: canonical SQL in this doc's metrics, verified against `lib/company-plan.ts` / `lib/weekly-connections.ts`
