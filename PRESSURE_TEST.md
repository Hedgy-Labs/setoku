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

Caveat (honest limit of this test): the same agent wrote the context and answered the questions, hours apart. The harder test is **other people's phrasing** — the next step is golden questions written by the humans (you + cofounder) via `/setoku:eval`, and a second business' codebase where the author isn't steeped in the domain.

## Artifacts

- hedgy context seed: `hedgy/.setoku/` (config + context markdown; auto-imported into the service store on first gateway boot)
- driver: `scripts/call.ts` · ground truths: canonical SQL in this doc's metrics, verified against `lib/company-plan.ts` / `lib/weekly-connections.ts`
