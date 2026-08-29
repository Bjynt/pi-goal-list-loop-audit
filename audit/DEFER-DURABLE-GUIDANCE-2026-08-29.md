# Defer vs durable guidance — 2026-08-29

## Claim

Harden long-term vs defer guidance — 3 defers recommending the durable design were shown but best solution was last (Screenshot_20260829_185215.png plaque collision).

## Audit

* Long-running judgment (`extensions/goal-loop-core.ts: LONG_RUNNING_JUDGMENT_POLICY`) already stated durable is default and band-aid never a question, but did not explicitly order defer vs durable nor pin the plaque collision N=31 i%2 wrap between the-ember-throne and the-frost-beneath — three defers recommending durable still left the inline choice ambiguous.

## Fix

* Hardened `LONG_RUNNING_JUDGMENT_POLICY` with explicit `Defer vs durable — long-term focused action outranks defer` bullet: when three defers recommend the durable design, the inline choice is still the durable fix, not a defer; the ledger distinguishes `deferred` vs `inline` and ordering pins durable before defer (regression: plaque collision N=31 i%2 wrap between the-ember-throne and the-frost-beneath — durable ordering must not wrap).

## Verification

* `npx tsc --noEmit` 0.
* `bun test tests/defer-durable-ordering.test.ts` 2/2 pins policy contains Defer vs durable, long-term focused action outranks defer, durable fix not a defer, ledger distinguishes deferred vs inline, durable index < defer index, and N=31 i%2 wrap + both plaque names.
