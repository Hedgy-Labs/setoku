# The knowledge store as an LLM wiki (scale + interlinking)

**Status:** built on `experiment/llm-wiki`. Adds an interlink layer, map-first
retrieval, and structural lint to the curated knowledge store — gated by the
retrieval eval so none of it nerfs answer quality. This is the written reason for
the change (per `CLAUDE.md`).

Prompted by Karpathy's *LLM Wiki* pattern
(<https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f>): an LLM
incrementally maintains a persistent, **interlinked** wiki (raw sources → wiki →
schema), with three operations — ingest, query, lint — and special `index.md` /
`log.md` files. Setoku had independently arrived at most of it (curated synthesized
docs over raw data; `report_correction` as ingest; `find_context` as query;
`facts.ts` compaction as lint; the `audit` table as `log.md`). Two pieces of the
pattern were missing, and they are exactly the two that fix how the store behaves
as it grows: **cross-links** and a **map to traverse them**.

## Why the flat store breaks as it grows

The store was a flat bag of docs with keyword retrieval. At a few dozen docs that
is fine. As it grows, four things degrade:

1. **Retrieval is flat keyword ranking.** `find_context` loads every doc, scores
   by term-frequency, returns the top-k. Recall suffers: the metric you asked for
   ranks, but its governing gotcha and the entity it joins to do not — they use
   different words — so the agent answers with half the context.
2. **No interlinks ⇒ no coherence signal.** Nothing related anything to anything
   (only gotchas had `relates_to`). You cannot detect an orphan or a missing
   connection in a graph with no edges.
3. **Ingest doesn't reconcile neighbors.** A new doc lands without touching what
   it should connect to; the store fragments between compaction passes.
4. **The structure is implicit.** Every `generate` run is free to invent new
   shape, so naming/organization drifts.

## What this change adds

### 1. An interlink layer — zero migration
Links live in the existing free-form `meta` JSON: `meta.links` is an array of
target doc names (a gotcha's `relates_to` is an implicit link). No schema change.
`lib/search.ts` derives the graph (`buildLinkGraph`): forward links, backlinks,
and **unresolved** refs (a link pointing at no doc = a broken link). Refs resolve
by name → table → unique substring (same tolerance as `store.getDoc`).

### 2. How a query ranks (`find_context`)
Ranking is a deliberately simple, **model-free, field-weighted term-frequency**
scorer — no embeddings, no IDF, no network (a SPEC decision: keyword first,
embeddings only if recall proves insufficient). It lives in `lib/search.ts`. The
pipeline for `find_context(question)`:

**a. Tokenize the question** (`queryTokens`): split camelCase + snake_case,
lowercase, drop tokens ≤1 char, dedupe, and remove a ~52-word stoplist (the, how,
many, what, our, …). *"How much ticket revenue did we make?"* → `{ticket, revenue,
make}`.

**b. Score every doc** (`scoreDocs`). For each query term, points are added by
*where* it hits — the curated, high-signal fields are weighted hardest:

| field | points per hit |
| --- | --- |
| doc **name** | +6 |
| `meta.keywords` | +4 |
| `meta.summary` / `meta.question` / `meta.table` | +2 per occurrence |
| doc **body** | +min(3, count) — capped so long docs don't dominate |

Then a **coverage boost**: `score *= 1 + (hits / #queryTerms)`, so a doc matching
*most* of the query beats one matching a single term many times. Docs scoring 0
are dropped; the rest sort descending. (This is why curated **names and
`keywords` are load-bearing** — they're the heaviest fields. See
[knowledge-conventions.md](knowledge-conventions.md).)

**c. Take the top-k** (default 5, max 15) — these are the **direct hits**.

**d. Map-first link-expansion** (`retrieve(docs, question, { expandLinks })`):
append the **1-hop graph neighbors** of the direct hits ("map-first": traverse the
curated wiki instead of ranking the whole corpus). A neighbor that *also* keyword-
matched keeps its real score; a purely structural neighbor inherits
`parentScore × 0.4`, so linked docs always rank **below** the direct hits. The
direct top-k is never reordered or dropped — expansion only *adds* — so **MRR is
preserved by construction**. Purely-structural neighbors (linked but not matching
the query at all) are the precision drain, so they're capped separately
(`maxStructuralLinked`, default 2) while query-relevant neighbors stay uncapped —
this lifted precision@5 on the link eval (38→45%) without costing recall.
`find_context` renders direct hits as full docs and the
neighbors as a compact **"Related context (linked)"** list (one line +
`describe_entity`/`get_metric` pointer each): cheap in tokens, but the agent sees
what else to read before answering.

**Gotchas** are surfaced by a separate, precision-first selector (`selectGotchas`):
a gotcha **attached** to one of the direct hits — explicit `relates_to`, or the
hit's name appearing in the gotcha (the inference `buildKnowledgeView` uses) — is
surfaced first (relevant by construction), then the budget is filled by query
relevance and **capped** (default 3). This replaced "dump every gotcha sharing
one word," which flooded ~half the gotcha corpus into context on broad questions;
the cap was tuned on `eval:value` (see [Measuring value](#measuring-value-gotcha-traps)).
**Pending corrections** still match by looser single-token overlap (top 5, shown
as "unverified team knowledge").

**e. Synonym expansion (I8-clean semantic layer).** A query token with **no exact
field hit** falls back to its best-scoring **semantic neighbor**, discounted (×0.5)
— so "clinician" reaches the `physician` doc. Neighbors come from **static
tables**, looked up with no model call (I8 forbids request-time inference). Two
tiers feed the one `(token) => string[]` seam (`lib/synonyms.ts`):

- a **domain-general base** — generic money/count words + algorithmic plural↔
  singular morphology, safe for every tenant; and
- a **per-tenant derived table** (`lib/derived-synonyms.ts`, issue #33) generated
  **offline** at startup by clustering the tenant's OWN doc vocabulary with the
  local embedding model already on the box (embed each salient term, keep the
  nearest neighbors above a cosine floor). This is where domain-specific bridges
  come from now — *derived, not authored*.

It fires **only on a miss** and is discounted, so exact-match ranking is unchanged
(no regression). On the held-out paraphrase eval synonym expansion lifted recall@5
**80% → 95%** (see [Measuring recall](#measuring-recall-the-hillclimb-test)).

Retiring the old hand-curated *global* thesaurus (which only helped tenants whose
domain matched sports/e-commerce and was inert for everyone else) is the point of
#33: every domain now gets the lexical bridge over its own words, with nobody
hand-editing `synonyms.ts`.

**Remaining limits:** no IDF (common terms aren't down-weighted); the derived
table bridges only words that already appear in the tenant's corpus, so a query
using a term found *nowhere* in the docs still misses until curated `keywords`
cover it — hybrid embedding retrieval (below) is what catches the rest.

### 3. Structural lint — orphans, missing connections, broken links
`facts.ts` gains two model-free detectors that fall straight out of the graph
(Karpathy's "lint" step):
- **orphans** — canonical docs with no link in or out (overview = the hub and
  gotchas-by-`relates_to` are exempt);
- **suggested connections** — doc pairs with strong topic overlap but no edge,
  *below* the merge threshold (so "should link" ≠ "are duplicates");
- **broken links** — declared refs that resolve to no doc.
All three feed `KnowledgeHealth` / the `/admin/knowledge` browser and can become
pending corrections. **Recommend-only** — a human commits the `meta.links` edit.

## The membrane caveat (why this is not "LLM owns the wiki")

Karpathy's wiki is **LLM-owned**: the model rewrites pages and maintains links
freely. Setoku **cannot** do that for curated company knowledge — I8 (no
server-side inference) and I2/I9 (agents propose, a human commits, outside the
loop) forbid it. So we adopt the *pattern* and keep the *gate*: the graph
derivation, orphan/connection detection, and map-first expansion are all
deterministic and read-only in the gateway; the *judgement* halves (which two
docs should link, splitting a verbose doc) run **in-session** (the curator's own
Claude) and land as **proposals**. No tool writes `meta.links` without a human
click. The link layer adds **no new write hole**: links are set via
`upsert_context` (curator) exactly like any other curated edit.

## The guardrail: the retrieval eval (so we don't nerf retrieval/reasoning)

The whole point of changing retrieval is to *help*, so every change is measured.
`lib/quality.ts` already scored retrieval (precision/recall@k, MRR, hit rate)
against golden question→doc-name cases, reusing the production scorer. Extended
here:
- `retrievalMetrics(..., { expandLinks })` scores the **map-first** path too, so
  one run produces an honest **A/B**: baseline vs map-first on the same cases.
- The eval grades the new detectors against **planted ground truth**
  (`orphan:`, `connection:`, `broken:` keys), all model-free.
- New gate knobs: `minRecallAtKExpanded`, `minPrecisionAtKExpanded`,
  `maxBrokenLinks` (alongside the existing floors).

A linked synthetic corpus lives at `test/fixtures/eval/wiki.json` (no real tenant
data, I3). Current scorecard
(`bun plugin/gateway/quality-cli.ts --spec test/fixtures/eval/wiki.json --gate`):

| metric | baseline | map-first | Δ |
| --- | --- | --- | --- |
| hit rate | 100% | 100% | ±0 |
| recall@5 | 79.2% | 100% | **+20.8%** |
| precision@5 | 56.7% | 38.2% | −18.5% |
| MRR | 0.875 | 0.875 | ±0 |

Defect detection (orphan/connection/broken): **recall 100%, precision 100%.**

The recall lift is the win; MRR/hit-rate are flat (direct ranking untouched). The
precision dip is the honest, *bounded* cost of surfacing related neighbors — they
are cheap one-liners labeled "read if relevant," not claimed answers — and the
`minPrecisionAtKExpanded` floor stops a future change from buying recall by
flooding junk. The legacy fixture (`knowledge.json`) shows ±0 on every retrieval
metric: a store with no links is completely unaffected (map-first degenerates to
the old top-k).

Run: `bun test test/wiki-retrieval.test.ts` (graph + A/B + lint unit tests),
`bun run eval:knowledge --spec test/fixtures/eval/wiki.json --gate` (scorecard).

## Measuring recall (the hillclimb test)

`demo/eval/paraphrases.json` is a **failure-first** retrieval set: 40 questions
phrased in genuine synonyms (little word overlap with the target doc), each
empirically verified to be hard, split **dev / held-out test** so improvements
must generalize rather than memorize phrasings. Scored by recall@k — objective,
model-free, no self-grading. Run: `bun run eval:retrieval`. The climb so far, on
held-out test:

| retrieval | recall@5 |
| --- | --- |
| keyword baseline | 75% |
| + map-first (link neighbors) | 80% |
| + synonym expansion | **95%** |

It's deliberately not at 100% — the residual (e.g. "in-stadium purchases" →
`PosTransaction`) is a *curation* gap (a missing keyword), and is the data-driven
signal for the next move (richer keywords, then offline embeddings).

### The hillclimb loop so far

A measured loop: change retrieval, prove it on the eval, keep it only if it holds
recall *and* doesn't regress the others. The eval and the gateway share ONE
retrieval path (`retrieve`), so the metric can't drift from production.

| step | what | measured effect |
| --- | --- | --- |
| map-first | 1-hop link neighbors of hits | recall@5 75→80% (held-out) |
| synonyms | I8-clean static-table query expansion | recall@5 80→**95%** (held-out), MRR up |
| structural cap | cap purely-structural linked at 2 | precision@5 38→**45%** on `wiki.json`, recall held 100% |

Negative results worth recording (probed, found already-covered — so *not* worth
building): typo robustness (1/12 miss — multi-token queries self-heal), acronym
expansion (1/6), gotcha-under-synonyms (0/6 — the attached metric drags its gotcha
in). Precision@k on the paraphrase set is a metric artifact (k=5 ≫ ~1 relevant
doc/query), so it's read on `wiki.json` instead, where structural neighbors exist.

### Embeddings vs synonyms — and why embeddings win for a *product*

We A/B'd real embeddings (local BGE models, run offline via `bun run eval:embed`,
correct asymmetric `queryEmbed`) against the curated synonym table.

**On the home corpus (sports, where the synonym clusters were hand-tuned):**

| keyword | synonyms (curated) | embedding-only | hybrid (kw⊕emb, RRF) |
| --- | --- | --- | --- |
| 75% | **93%** | 73–78% | 88% |

Synonyms edge hybrid by ~5pp — but on a 20-case held-out split that's ~1 case
(noise), and it required hand-building domain clusters.

**On a different domain (healthcare, where the clusters don't apply), hit@3:**

| keyword | sports-tuned synonyms | embedding | hybrid |
| --- | --- | --- | --- |
| 13% | **13%** | **88%** | **88%** |

This is the decisive result. The hand-curated *global* synonym table adds **zero**
outside its domain; embeddings generalize with **no curation**. For a product
serving any company / any data, hand-synonyms are a per-customer maintenance tax
that only ever helps the one domain someone tuned — a non-starter. **Recommendation:
hybrid (keyword ⊕ local embeddings) is the product retrieval path; the synonym
table is a complementary lexical bridge, not the mechanism.**

**Resolution (#33):** the synonym *mechanism* stayed (it's complementary to
embeddings — a lexical bridge on a keyword miss), but its *source* changed. The
global thesaurus is retired down to a domain-general base; the domain-specific
neighbors are now **derived per-tenant offline** by clustering each tenant's own
doc vocabulary with the same local model (`lib/derived-synonyms.ts`). Same seam,
no hand-editing, and it generalizes across domains instead of only the tuned one.

Model choice (VPS-realistic, CPU, no GPU): **bge-small** (~130MB, ~120 ms/query,
~100 ms load) ties bge-base for hybrid and beats e5-large (which was both worse
and ~2 GB). External embedding APIs would score higher but violate I8 and aren't
box-local.

**Decision: hybrid is the product (I8 amended).** I8 permits a local, CPU, non-LLM
embedding model on the box; embeddings are **on by default and required** — not an
opt-in — with `SETOKU_EMBEDDINGS=0` as a diagnostics/test kill-switch only. The
privacy guarantee is intact (data never leaves the box, no LLM, no external call,
no key), and keyword fallback remains as resilience if the model can't load. The
implementation:

- **Model** `lib/embeddings.ts` — bge-small via `fastembed`, **dynamically
  imported** (a gateway with embeddings off never loads onnx) and **graceful**: any
  init failure → null → keyword retrieval keeps serving.
- **Index** `lib/embed-index.ts` — one vector per non-gotcha doc, built in the
  background at startup, updated on upsert. Inert until ready (fallback meanwhile).
- **Fusion** `retrieve(... embedScores)` — reciprocal-rank fusion of the keyword
  and embedding rankings, **keyword-weighted 5:1** so embeddings *rescue* keyword
  misses without overriding confident exact matches.

Production-path benchmark (`SETOKU_EMBEDDINGS=1 bun run eval:embed`):

| | home held-out recall@5 | healthcare (out-of-domain) hit@5 |
| --- | --- | --- |
| keyword + synonyms + map-first | 95% | 13% |
| + hybrid embeddings | 93%* | **~100%** |

*Home is within ~1 fractional (multi-relevant) case of map-first — eval noise on
20 cases; the win is the cross-domain column, where curation-free retrieval goes
from unusable to near-perfect. Doc embeddings are computed offline/at upsert (off
the hot path); only the ~120 ms/query embed runs live (bge-small, CPU). The model
is baked into the image (`--build-arg BAKE_EMBEDDINGS=1`) or cached on the data
volume, so the box never downloads at request time.

## Measuring value (gotcha traps)

Retrieval metrics ask "is the right context reachable." The **value** eval asks
the product question: does a curated fact actually save an answer the naive
(schema-only) agent would get wrong? `demo/eval/value-traps.json` is a set of
**trap questions** grounded in the Bulldogs gotchas (cents-vs-dollars, dedupe-by-
email, refunds/comps, media-rights per-season, merch-is-online-only, …). For each
trap, `trapCoverage` (`lib/quality.ts`) reproduces exactly what `find_context`
would surface and checks whether the trap-avoiding fact is in it — deterministic,
model-free (I8). Ungrounded coverage is 0 by construction, so the rate IS the
grounded-vs-ungrounded lift. Run: `bun run eval:value [--gate]`.

Crucially the scorecard reports **context cost** (docs + gotchas surfaced per
trap), so coverage bought by flooding the window is not mistaken for a win — and
it caught exactly that: `find_context` was dumping every gotcha sharing one word
with the question (~10 of 23 on broad revenue questions). The fix
(`selectGotchas`, above) was tuned against this eval:

| | gotchas / trap | trap coverage |
| --- | --- | --- |
| uncapped (before) | 5.2 | 100% |
| attached + ranked, cap 3 | **2.9** | **100%** |

Coverage held at 100% while gotcha noise dropped ~44%, with no regression on the
retrieval eval — the "improve without nerfing" loop in one pass. The full
answer-lift (does the agent's *answer* change?) needs a model, so it's an
in-session protocol — see `plugin/skills/eval/SKILL.md`.

## What this deliberately does NOT do (yet)

- **Perf at true scale.** `find_context` still loads + scores *all* docs per
  query. Map-first fixes recall, not the O(corpus) scan. The next step is to make
  the curated **index/overview the entry point** the agent reads first and
  traverse from there (an agent-loop change), so retrieval cost tracks the
  neighborhood, not the corpus.
- **Auto-linking on ingest.** `report_correction` does not yet propose link edits
  to neighbors. The suggested-connection lint is the seam where that plugs in.
- **The in-session semantic halves** (which docs to link, verbose→concise) are
  specified, not wired into `/setoku:generate` / `/setoku:curate` here.

See also [knowledge-facts.md](knowledge-facts.md) (the Fact layer this builds on),
[memory.md](memory.md) (the institutional-memory reframe), and
[knowledge-conventions.md](knowledge-conventions.md) (the "schema layer": how the
wiki is organized).
