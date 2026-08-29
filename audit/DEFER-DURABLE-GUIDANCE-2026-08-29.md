# Defer vs durable guidance — 2026-08-29

## Claim

Harden long-term vs defer guidance — 3 defers recommending the durable design were shown but best solution was last (Screenshot_20260829_185215.png plaque collision).

## Audit

* Long-running judgment (`extensions/goal-loop-core.ts: LONG_RUNNING_JUDGMENT_POLICY`) already stated durable is default and band-aid never a question, but did not explicitly order defer vs durable nor pin the plaque collision N=31 i%2 wrap between the-ember-throne and the-frost-beneath — three defers recommending durable still left the inline choice ambiguous.

## Fix

* Hardened `LONG_RUNNING_JUDGMENT_POLICY` with explicit `Defer vs durable — long-term focused action outranks defer` guidance: when three defers recommend the durable design, the inline choice is still the durable fix, not a defer. The new `record_goal_judgment` tool writes bounded `durable_defer_choice` ledger entries with `choice: "inline"` or `choice: "deferred"`, a reason, and an optional follow-up; ordering pins durable before defer (regression: plaque collision N=31 i%2 wrap between the-ember-throne and the-frost-beneath — durable ordering must not wrap).

## Verification

* `npx tsc --noEmit` 0.
* `bun test tests/defer-durable-ordering.test.ts tests/durable-choice-ledger.test.ts` 4/4: policy ordering pins Defer vs durable and the plaque collision; the runtime tool records both `inline` and `deferred` choices in the durable ledger; rationale/follow-up payloads are bounded and compacted.
