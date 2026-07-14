# Knowledge facts v2 (issue #10)

The curated knowledge store today is a bag of free-text markdown docs plus a
free-text corrections queue. In practice it grows **verbose, disorganized, and
easily contradictory**: two docs about the same metric drift apart, the same
gotcha is reported three times in different words, and a correction carries a
paragraph of reasoning where one sentence is the actual fact.

This document defines a structured **Fact** layer and the four processes that
operate on it — the four avenues from #10. It is the written reason for the
architecture (per `CLAUDE.md`: architectural changes need one).

## The constraint that shapes everything

Two invariants bound the design hard, and the design leans into them rather than
around them:

- **I8 — no server-side inference.** The gateway never calls an LLM or embedding
  API. So every process here ships in two halves: a **deterministic core** that
  runs in the gateway/CLI for free, and an **opt-in semantic upgrade** that runs
  *in an agent session* (the analyst/curator's own Claude Code, on their own
  subscription) when natural-language judgement is genuinely required. This repo
  builds the deterministic core; the semantic half is a labeled hand-off, never
  a server call.
- **I2 / I9 — the human membrane.** Nothing here **commits** curated knowledge.
  Compaction and auto-judgement only ever *recommend* and *propose*: their output
  lands in the corrections queue (pending) or in a report. The single accept path
  stays a human click on the approval surface (or a curator-token action, itself
  a human-held credential). An auto-judge that could accept its own proposals
  would be exactly the membrane bypass I9 exists to forbid.

Everything below is **recommend-only and model-free** unless explicitly marked
"semantic (in-session)".

## The atom: a Fact

A `Fact` is a relaxed, NL-friendly triple — the pragmatic descendant of a Prolog
clause (avenue 4), sized for business knowledge rather than formal logic:

```
Fact {
  subject:    string        // normalized topic key, e.g. "metric:revenue", "entity:customer"
  predicate:  string        // the kind of claim, e.g. "definition", "excludes", "unit", "gotcha", "join"
  object:     string        // the value / right-hand side, normalized for comparison
  claim:      string        // the canonical, concise human-readable fact (what gets stored)
  commentary?: string       // reasoning / context — kept for review, NOT part of the answer
  provenance?: { source?: string; author?: string; ts?: string }
  confidence?: number       // 0..1
  origin:     "doc" | "correction"   // where it was extracted from
  ref:        string        // doc name or correction id, to trace back
}
```

Why this shape:

- **(subject, predicate, object)** makes the two hardest problems *structural*
  instead of semantic: two facts with the **same subject+predicate but different
  object** are a contradiction candidate; two facts with near-identical token
  sets are a merge candidate. No model needed for the common case.
- **claim vs commentary** is avenue 1 baked into the type: the concise fact is
  one field, the reasoning is another, and only `claim` flows into a curated
  answer.
- Facts are **derived from the existing store** (`extractFacts`), so the whole
  system runs on real data today with **zero schema migration**. The persisted
  structured columns are a later, optional step (see Migration).

## The four avenues

### 1 — Structure the knowledge proposal

A proposal carries `{ fact, commentary, subject, predicate }` instead of one
`content` blob. `wellFormedness(proposal)` scores it deterministically: has a
subject, is a single concise claim (not a paragraph), carries provenance, isn't
empty. Low scores are the queue's first triage signal. Splitting a legacy
free-text blob into fact+commentary is the **semantic (in-session)** step; the
type and the validator are the deterministic core.

### 2 — Compaction ("REM sleep")

A periodic pass over the extracted facts that produces a `CompactionReport` of
**proposed** actions:

- **merge** — near-duplicate facts (Jaccard over tokens, reusing the #11
  redundancy detector) → one canonical fact, the rest folded in.
- **contradiction** — facts sharing a subject that conflict: same
  subject+predicate with different object, or a negation/antonym clash
  ("excluded" vs "included"), or a numeric mismatch. These are **pulled back to
  the corrections queue as pending** for a human to resolve — never auto-edited.
- **flag** — facts whose provenance points at a source that no longer exists, or
  that are explicitly marked suspect → flagged for review.

The deterministic detectors (`compact()` over the extracted facts) catch
structural + lexical signals and feed the `/knowledge` health bar. But
compaction itself — deciding *which* fact is right, merging two into one good
fact, rewriting verbose into concise — is judgment, so it runs **in a curator
session** via [`/setoku:compact-knowledge`](../plugin/skills/compact-knowledge/SKILL.md), not as a
server-side job (I8). The human curator commits the result through the membrane
(I9); nothing auto-edits curated knowledge.

### 3 — Auto-judgement (advisory)

`judgeProposal(proposal, existingFacts)` returns a `Recommendation { verdict:
"accept" | "reject" | "review", confidence, reasons[] }` from deterministic
signals: well-formedness, exact/near duplicate of an existing curated fact
(→ reject/merge), contradiction with an existing fact (→ **review**, never
auto-reject — it might be the correction!), provenance present (→ confidence).

This **annotates** the pending queue so a human reviews a smaller, pre-sorted
set. It never commits — `verdict: "accept"` is a *recommendation to the human*,
not an action. Its quality is measured by the #11 harness's **false-accept rate**
(FP/(FP+TN)): the rate at which it green-lights proposals a human would reject —
the one number that, if it crept up, would erode the membrane. We gate on it.

### 4 — Fact data structure

The `Fact` triple *is* the data structure — see "The atom" above. The
deterministic contradiction/merge logic is what the structure buys us; a future
step can add simple inference (transitive joins, subject aliasing) and, if ever
warranted, persist facts as first-class rows.

## How the harness closes the loop (#11)

Each avenue has a metric in `lib/quality.ts`:

| avenue | metric |
| --- | --- |
| 1 structured proposals | retrieval precision/recall@k (concise facts retrieve better) |
| 2 compaction | redundancy count ↓; defect-detection recall on planted contradictions/duplicates |
| 3 auto-judgement | confusion matrix, **false-accept rate** |
| 4 fact structure | all of the above on a frozen corpus, A/B vs the free-text baseline |

`bun run eval:knowledge --spec … --gate` is the regression gate. Goldens key on
questions + doc names (not ids), so they survive this restructuring.

## Migration

This PR adds the Fact layer **derived** from the existing store — no DB change,
nothing in the live tool surface accepts knowledge automatically. The explicit
next steps, each its own PR:

1. Persist structured columns on `corrections` (`fact`, `commentary`, `subject`,
   `predicate`) — nullable, backward compatible.
2. Surface auto-judgement verdicts + compaction proposals on the web-console
   approval queue (still a human click to accept).
3. Wire the semantic (in-session) halves into `/setoku:curate` and
   `/setoku:generate`.
