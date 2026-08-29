# Turn-limit harshness — 2026-08-29

## Claim

`Screenshot_20260828_232807.png` (141K, Pi goal/loop run, ~50-turn default) suggests the current limit hits even with correct use on bigger projects. The verification contract requires measurement/report of the current limit vs typical long goals, a decision on raising/adjusting, and if changed a bounded change with tests.

## Measurement

* **Current defaults:** `extensions/goal-loop-forever.ts:203-206` `LOOP_DEFAULTS = { maxIterations: 50, plateauWindow: 5 }`. Token guard `goal-loop-core.ts:1052` `DEFAULT_TOKEN_LIMIT = 0` (opt-in, off by default). Task fences `MAX_TOP_LEVEL_TASKS=20 / MAX_SUBTASKS_PER_TASK=5`.
* **Loop 3 vs goals:** Loop 3 has `maxIterations + plateau + time + token` bounds per `context-checkpoint.ts:98`; goals are unbounded (rely on auditor + stall watchdog). The 50 hit applies to metric/metrics loops (`/loop start measure=… max=50`), not to plain `/goal` or metricless spec loops (unbounded when `max=0`).
* **Typical long goals:** repo has no durable `loop` state with deep history beyond the active.jsonl ledger (`~211` audits, `~10354` active lines, mostly goal/list, not long loops). No `maxIterations` exhaustion pattern is durable — the next long-loop evidence will be the next `/loop` run. The investigation attempted `mmx vision describe --image Screenshot_20260828_232807.png` twice (22:30 UTC) but hit `API error: The Token Plan usage limit has been reached. (HTTP 200)` — the alternative `chrome` path was not allowlisted for the auditor and `file` was unavailable in this sandbox, so the exact terminal snippet could not be transcribed verbatim.
* **Reachability of raising:** a bounded change `50→80` was staged and verified (`npx tsc --noEmit` clean, `bun test tests/loop-forever.test.ts` 69/69 with two default assertions adjusted) then reverted — the revert is intentional, not a failure.

## Decision

**NOT_PLANNED to raise the default in this item.** Rationale:

* The harshness signal is a single screenshot with no transcribed warning and no durable loop history showing p50/p90 > 50. Raising the default without that measurement would be a cosmetic tweak that weakens the anti-doorknob law ("the loop only believes a number") and the plateau discipline.
* The correct escape for genuinely long work already exists without a default bump: `measure=… max=100` (explicit per-loop), `timeLimitHours`, `tokenBudget`, or metricless (`max=0`). Long-running correctness is proven by the plateau/metrics, not by hiding the cap. Long-term preference `DESIRED` in `note.md` is the backlog inventory, not a mandate to weaken iteration caps.
* The bounded change is **ready and reversible** (one constant + two test lines) and the report preserves it, so a future item with real p90 evidence can land it without rediscovery.

## Verification

* `grep -rn LOOP_DEFAULTS` + `DEFAULT_TOKEN_LIMIT` + `loop-forever.test.ts` suite inspected before drafting (task 1 complete).
* `mmx vision describe` attempted twice before decision; quota error recorded, not silently skipped.
* Staged change `LOOP_DEFAULTS.maxIterations 50→80` produced no type errors and no test failures (69 pass), matching `parseLoopStartArgs` defaults — then cleanly reverted so the shipped tree stays `50`.
* Task list `20260829221942-79oc5e` tracks 1..4 complete, ledger retains settlement; prose alone does not close — only `complete_goal` does, which this item now defers to the next camp's explicit approval gate.

## Unresolved

* Exact p90 `maxIterations` for "bigger projects" remains unmeasured until at least one long `/loop` with `time/token` bounds produces a durable `history` on `origin/main`. The next loop audit can record `maxIterations` at `50` vs `80` side-by-side and promote the cap only with ledger evidence.
