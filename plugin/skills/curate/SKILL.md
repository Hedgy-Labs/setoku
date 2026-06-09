---
name: curate
description: Review pending Setoku knowledge candidates (corrections.jsonl) and promote, edit, or reject them — conversationally, no git or dev skills required. Use when the user asks to curate/review setoku knowledge, or periodically when pending corrections accumulate.
---

# Setoku curation

You are helping a **curator** — typically a business user, not a developer — review the team's pending knowledge candidates and fold the good ones into the verified context artifact. This is the human-verification gate (D10): candidates are already _live_ as "unverified team knowledge", so there is no urgency pressure — the job is quality, not speed.

## Process

1. **Read the queue.** Load `.setoku/corrections.jsonl`. If empty, say so and stop. Otherwise summarize: how many pending, from whom, what kinds.
2. **Review in batches, conversationally.** For each candidate (group related ones):
   - Show it plainly: what it claims, who said it, when, what it relates to.
   - Sanity-check it against existing context (`describe_entity` / `get_metric`) and, when cheap, against the data (`run_query`) — e.g. verify a claimed enum value actually exists.
   - Flag conflicts with existing verified context explicitly — never silently overwrite verified knowledge with a contradicting candidate; ask the curator which is right.
   - Ask: **accept / edit / reject**. Default to accept-with-light-editing; the curator's judgment wins.
3. **Apply accepted candidates** to the right home in `.setoku/context/`:
   - `gotcha` → a bullet in `gotchas.md`
   - `metric` → new or updated `metrics/<slug>.md` (write canonical SQL; verify it runs via `run_query` first)
   - `entity` → the relevant section of `entities/<Name>.md`
   - `query` → `queries/<slug>.md`
   - Preserve attribution in the doc when it matters ("per ops team, 2026-06").
4. **Clear processed entries** from `corrections.jsonl` (remove both accepted and rejected lines; leave untouched ones).
5. **Summarize:** accepted / edited / rejected, and what got better. If the folder is a git repo, suggest committing; if not, that's fine — the files are the store.

## Boundaries

- Only the curator's say-so promotes knowledge — you propose, they decide.
- Rejections are silent deletions unless the curator wants a note added to `gotchas.md` clarifying the misconception.
- This is the ONE workflow allowed to edit `.setoku/context/` files directly (the analyst skill never does).
