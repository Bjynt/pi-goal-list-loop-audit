# Defer vs durable guidance — 2026-08-29

## Claim

Harden long-term vs defer guidance — 3 defers recommending the durable design were shown but best solution was last (Screenshot_20260829_185215.png plaque collision).

## Initial implementation

The first pass added `record_goal_judgment`, explicit `inline`/`deferred` ledger records, and policy wording. The detached auditor correctly rejected its ordering check because the test compared incidental first occurrences of `durable` and `defer` in prose rather than exercising recommendation behavior. Fresh screenshot transcription was also unavailable because the MMX vision quota was exhausted; the captured desktop was not GLLA evidence.

## Durable follow-up

* `extensions/goal-loop-core.ts` now owns the semantic path: `recommendDurableDeferChoice()` keeps a safe durable action `inline` regardless of prior defer recommendations and permits `deferred` only for an explicit unsafe/impossible/blocked fact.
* `buildDurableDeferRecommendation()` returns typed plaques in the immutable `DURABLE_DEFER_PLAQUE_ORDER` (`durable`, then `defer`) and marks the actual recommendation. `formatDurableDeferPolicyLine()` builds the continuation-policy line from that same path with exactly three defer recommendations, so the policy and behavior cannot drift.
* `extensions/goal-loop-display.ts` exposes `buildDurableDeferDecisionLines()` and wires the same projection into the active goal card through `WidgetExtras.durableDeferRecommendation`. This is an inspectable deterministic UI surface, not a prose index assertion.

## Verification

* `tests/defer-durable-ordering.test.ts` exercises three defer recommendations, asserts the selected choice is `inline`, asserts typed plaque order and recommendation flags, and separately proves only an explicit blocked fact selects `deferred`.
* `tests/durable-defer-ui-fixture.test.ts` renders the real `buildWidgetLines()` path and asserts the visible `1. Durable fix … recommended` plaque precedes `2. Defer / workaround`, with `selected: inline (durable fix)` after the ordered choices.
* `tests/durable-choice-ledger.test.ts` continues to verify bounded `durable_defer_choice` persistence, required deferred follow-ups, and compact rationale.
* `bun test tests/defer-durable-ordering.test.ts tests/durable-defer-ui-fixture.test.ts tests/durable-choice-ledger.test.ts` — 6 pass.
* `npx tsc --noEmit` — 0 errors.

The deterministic UI fixture is the visual-contract evidence for this repository. It avoids claiming that the unrelated desktop screenshot proves GLLA behavior and does not require a model switch when MMX is unavailable.
