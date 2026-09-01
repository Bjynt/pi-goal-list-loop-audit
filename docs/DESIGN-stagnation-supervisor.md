# DESIGN — Goal Stagnation Supervisor (v0.36.0)

Source: NVIDIA's Agentic Variation Operators architecture
([arXiv:2603.24517](https://arxiv.org/abs/2603.24517); NVIDIA dev blog,
2026-08 — AVO scored 100% RHAE on the ARC-AGI-3 public set). This note
records what was ported, what was deliberately not, and the contracts.

## What transfers to glla

AVO sustains multi-day autonomous runs with a **self-supervision mechanism**
(paper §3.3) that watches the committed lineage for two failure modes:

| AVO signature | glla goal-mode mapping |
|---|---|
| **Exhaustion** — active exploration, no commit; hypothesis mined out | N consecutive turns with tool activity but zero committed progress (git commits, completed tasks, file writes) |
| **Cycling** — repeated unproductive edit cycles | `cyclingAfter` consecutive near-duplicate replies (word-trigram Jaccard ≥ 0.8), firing even when files changed |
| Supervisor intervention = non-prescriptive strategic framing | SUPERVISOR DIRECTIVE section in the continuation prompt (trajectory review + fresh framing; never a mandated change) |
| Lineage 𝒫ₜ | Per-goal bounded rolling window of `ProgressVector`s on `Goal.stagnation`, plus `goal_progress_vector` ledger events |

## Deliberate non-goals

- **Not a scheduler.** The supervisor fires conditionally and infrequently;
  the agent stays in charge of strategy (paper §3.3: "a recovery mechanism,
  not a scheduler").
- **No world-model / scoring-function port.** AVO's vector-valued benchmark f
  is domain-specific; glla's "score" is committed progress itself.
- **Does not replace the stall watchdog** (silence detection) or the
  commissar (dereliction verdicts). This module owns productive-LOOKING
  stagnation — the gap between them.

## Contracts

- One `ProgressVector` per ACTIVE-goal turn where the model got a say;
  provider-error/abort turns are exempt (stall-nudge philosophy).
- First observation after install/restore sets baselines only (no deltas
  against unknown previous totals).
- Any committed progress resets the exhaustion streak and clears a pending
  directive.
- Bounded nagging: a carried directive stands down after
  `STAGNATION.maxConsecutiveInjections` further stalled turns.
- Wiring sits AFTER the length path and nudge accounting in `agent_end`
  (ordering pinned by tests/length-continue.test.ts); it is best-effort and
  never throws into the loop.
- Schema contract: `Goal.stagnation` is published in
  `schemas/goal.schema.json` (T6 drift test enforces the pair).

## Files

- `extensions/goal-stagnation.ts` — pure detectors + directive rendering
- `extensions/loops/goal-activation.ts` — `noteGoalStagnationTurn` wiring
- `extensions/goal-continuation.ts` — directive injection seam
- `extensions/goal-loop-core.ts` + `schemas/goal.schema.json` — state shape
- `tests/goal-stagnation.test.ts` — unit + source-pin tests
