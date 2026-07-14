# Setoku as institutional memory — and the layers beyond data

**Status:** thinking / direction. Captures a reframe and two product directions
(personal context, house design conventions). The data layer is built and live;
the other two are designed here, not yet built.

## The reframe

Setoku is **institutional memory for AI agents**. The thing it actually does —
*remember what a company knows, and hand the right piece to an agent right
before it acts* — is not specific to data. It's a general loop:

> **retrieve relevant memory → act → propose what you learned → a human keeps it.**

Today that loop is pointed at one domain: **what your data means** (entities,
metrics, gotchas). But the machinery underneath — keyword/semantic retrieval, a
versioned store, the membrane (agents propose, humans approve, outside the
loop), engine-enforced read-only access, an append-only audit — is
**domain-agnostic**. The same loop holds other kinds of memory just as well.

Two of those are worth naming, because real users keep asking for them:

| Layer | Whose / what memory | Built? |
|---|---|---|
| **Company data semantics** | how the *business* computes things | ✅ live |
| **Personal context** | how *one person* works / what they mean | ✗ designed below |
| **House design conventions** | how the *team* builds UI | ✗ designed below |

The point of writing this down: keep the layers riding on the **same store,
retrieval, and membrane** instead of bolting on three subsystems. Memory is the
product; data is just the first domain.

---

## Layer 2 — Personal context (whose memory)

**What.** Knowledge scoped to one person, not company canon: how they work, what
they usually mean, their default framings. "When I say *the funnel* I mean
candidate→hire, weekly, Pacific." "Default my revenue questions to net." "I look
at the west region first." It's the difference between a tool that re-asks the
same clarifying question every time and one that knows *you*.

**Why.** Cuts repeated clarification, and lets one Setoku serve different roles
(finance vs ops vs a founder) with different defaults — without each person's
preferences leaking into the shared truth everyone else sees.

**Retrieval.** `find_context(question)` already runs per-identity (the MCP token
maps to an identity). It would merge **company docs + the caller's personal
notes**, with personal notes clearly labeled *"your note (personal)"*. Personal
notes are *additive context the agent weighs*, never a silent override of company
canon — if they conflict, the agent sees both and says so.

**Write path — the membrane question.** Personal knowledge must **not** become a
quiet agent-write hole. An injected agent could otherwise persist a self-targeted
lie ("this user's revenue excludes region X") that biases that person's future
answers. Two membrane-safe options:

- **A. Human-authored.** The person types notes in the web console ("My notes"); agents
  read, never write. Purest, but needs an identity link (below) and gives the
  agent no way to offer "want me to remember that?".
- **B. Propose + self-approve _(recommended)_.** The agent proposes a personal
  note (`report_correction` with `scope: "personal"`); it lands in the *owner's
  own* pending queue; the owner approves their own. Reuses the existing
  propose→approve machinery, but approval is scoped to you — low friction, still
  a human click outside the agent loop. Personal notes never enter company canon.

**Blast radius.** Even if a bad personal note slips through, it misleads exactly
one user; company truth (I2) is untouched. That asymmetry is what makes a lighter
approval acceptable for personal that would be unacceptable for company.

**Schema sketch.** Add `scope TEXT DEFAULT 'company'` and `owner TEXT` to the docs
/ corrections tables (owner = the MCP identity). Personal rows are filtered to
`owner = <caller identity>` at retrieval.

**Open question — the identity link.** Retrieval keys on the **MCP identity**
(`peter@campsh.com`); the approval surface logs in as a **local account**
(`peter`). To approve and merge "your" personal notes, link the two: simplest is
an optional `accounts.mcp_identity` column set at account creation. Decide before
building.

---

## Layer 3 — House design conventions (the same loop, pointed at UI)

**The problem (real, from a client).** Several people vibecode internal apps with
Claude; every app's UI comes out different — inconsistent components, spacing,
color, patterns. Nobody wrote the house style down where an agent would look.

**The insight.** This is the *same* institutional-memory problem as data. A house
design system — tokens (color/spacing/type), component conventions, do's and
don'ts, the canonical component library — is knowledge that lives in a few
people's heads and never reaches the agent generating the UI. Capture it as
retrievable memory and have agents **look it up before building**, exactly like
the analyst looks up a metric before querying.

**Why it fits cleanly.** Design conventions are **read-only context** — agents
only consume them, so there's *no new write hole* (no membrane concern beyond
the usual "a human curates the canon"). It rides the existing store and retrieval
with a `domain: "design"` tag (or a `convention` doc type).

**How to deliver, cheap → rich:**

1. **Conventions as docs.** Author a handful of `convention` docs (generated from
   an existing well-built app, the way `/setoku:generate` derives data context
   from code). Agents `find_context("button")` / read the `house-style` overview
   before building UI.
2. **A retrieval nudge / skill.** A `building-UI` skill (sibling of `analyst`)
   whose first move is "retrieve the house style," and/or `/setoku:design` that
   writes the house tokens + conventions into the current repo's `AGENTS.md` /
   `CLAUDE.md` so every agent in that repo inherits them.
3. **Shippable artifact, not just prose.** Serve an actual tokens file + component
   snippets (e.g. a Tailwind `@layer` + a few component classes) so apps *share*
   the implementation, not only a description of it. Convergence by construction.

**Dogfood.** Setoku's own web console is already a small house style — a stone +
white Tailwind theme with `card` / `btn` / `badge` / `tab` / `input` components
and a wordmark (`plugin/gateway/web/input.css`). That file is a concrete example
of the "small, retrievable, shippable design artifact" a client's own house style
would take — the same shape, their tokens.

---

## Recommended sequencing

1. **Personal context (Option B).** Small, high daily value, reuses the
   propose→approve machinery, membrane-safe. The only real decision is the
   identity link. Build this next.
2. **Design conventions.** Bigger and more speculative; the win (harmonized UIs)
   comes from agents *retrieving before building*, which needs the convention
   docs + a skill. Spec is here; build when a client is ready to seed their
   house style.

Both are the same bet: **the memory layer is the product, and data was just the
first domain.** Keep them on one store, one retrieval path, one membrane.
