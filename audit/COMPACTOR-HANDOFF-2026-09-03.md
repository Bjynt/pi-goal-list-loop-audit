# Emergency compactor handoff — v0.38.10 (2026-09-03)

The walked-away-stuck session (101% context, no compact possible) had no
automatic recourse: trim is maxed, rotation needs setup, /new needs the
user, and park-and-guide assumes a present reader. The compactor is the
automatic rung: a fresh-context worker that never sees the bloated
transcript at all.

## Design

- **Emergency-only.** Fires on the starvation-refuse transition (streak ≥ 2,
  one shot per episode via `claimCompactorRefuseTransition`), never on a
  timer or a first wobble. Routine cheap-brief mode was considered and
  rejected in grilling: spawns cost money, and a standing brief goes stale.
- **Never the session model.** When the compactor fires, the session model
  is by definition the stuck one — the chain has no session last resort
  (unlike drafter), and plan B excludes the current ref explicitly.
- **Resolution order:** `compactorModel` + `compactorModelFallbacks`
  (0-10, walked exactly like Main/drafter/auditor via ModelSelector scope
  `{kind:"compactor"}`) → registry plan B → skip with
  `compactor_skipped_no_model` (the ladder covers).
- **Plan B is structured, not substring.** No "free" in the name: candidates
  come from `getAvailable()` and must ALL hold — configured auth, KNOWN
  `contextWindow >= need` (measured usage × 1.25, floor 100k), KNOWN zero
  cost (input and output), not forbidden, not the stuck model. Unknown
  metadata is disqualified, never assumed. Largest window first, max 2
  attempts, rationale ledgered (`compactor_plan_b_select`). Paid models only
  via explicit `compactorModel` — surprise bills are impossible by
  construction, not by luck.
- **Prompt-in / text-out worker** (`scripts/goal-compactor-worker.mjs`,
  ~100 lines vs the auditor's 840): `pi -p --no-session --no-tools` plus
  the full isolation flags, fixed `--thinking minimal`. The parent composes
  the bounded packet (objective 400 / 5 pending tasks / last verdict +
  report / 25 ledger lines, 6k total) from durable disk state — the worker
  never reads the repo, never sees the transcript, cannot write code.
- **Warm handoff, not cold restart.** The ~2k-capped brief persists to
  `.pi-glla/handoff-brief.md`; the post-compact resync and the load-hold
  recovery banner both quote it. `/new` + resume lands with objective +
  next task + verdicts already in context.
- **The page rides along.** Refuse-engage also fires one `notifyExternal`
  desktop page per episode (`notifyCmd: "off"` respected) — the walked-away
  user is summoned; the brief is waiting when they return.
- **Boundaries (kept):** no transcript edits (projection is per-send; the
  real transcript is pi-owned), no auto-`/new` (absent from the event API
  by SDK design, and unprompted session replacement is policy-out),
  no paid auto-spend, no routine spawns.

## What it converts

~10KB of GLLA margin cases (101–105%) may now compact where summarization
failed; every stuck session now pages + preserves a narrative handoff
instead of sitting mute. 243%-class overflows still need `/new` — stated,
not sold (see `OVERCAP-STRATEGY-2026-09-03.md`).

## Verification

- `tests/compactor-handoff.test.ts` (15 tests): plan-B matrix (order, cap,
  five disqualifiers, registry-throw), chain normalize/cap parity, no
  session lease, transition one-shot, packet/scope/worker tool-less pins,
  resync ± brief, banner excerpt unit + behavioral reload, behavioral
  chain spawn (once, chain model, packet scope, ledger, capped brief,
  banner, exactly one page), behavioral plan-B pick with rationale ledger,
  behavioral skip (ledger + ladder, zero spawns), notify-off silence.
- Full suite green (`release:check`), `tsc` clean.
