# Now

The status-surface redesign is complete and recorded under `# Done`. The next
active work is the maintainer issue/PR review documented below.

# Next

## Maintainer issue and PR review

The live inventory is recorded in
`audit/GITHUB-MAINTAINER-INVENTORY-2026-08-25.md`. Compiled-host auditor issue
#23 and in-band provider-result issue #30 are fixed locally and released in
v0.35.66, v0.35.67, v0.35.68, and v0.35.69 without merging PR #24.
Remaining plugin-owned issues are resolved locally; the two blocked feature PRs
(#22, #36), and upstream/out-of-scope requests still need explicit follow-up
decisions.

## Blocked feature PR decisions

PR #22 (stagnation supervisor) and PR #36 (commissar watchdog) were reviewed
read-only against current main. Both are dirty/conflicting and overlap the
hardened lifecycle, recovery, and heartbeat paths; neither should be merged
wholesale. Selective porting remains deferred until the desired feature and
version ordering are explicitly chosen. Upstream/out-of-scope issues remain
catalogued without local action.

# Later

## README/Pi Store thumbnail

After the status-surface work, upload a thumbnail for the README opening and Pi
Store listing. Keep this separate from runtime UI and release behavior.

## `/glla bug` capture flow

Consider a `/glla bug` command that records observed failure context and useful
logs, while keeping the capture artifact separate from durable goal state.

## audit other goal plugins

# Idea

## We are bad at guesing how long tasks take can we record the time it took once then guess basd on that

the problem is that lately we were defaulting to some safe long waits but that is pretty bad velocity
so i think we need a better solution
we should investigate how oters do it like antigravity most of all is quite snappy but codex kind of too
/home/dracon/Pictures/Screenshots/Screenshot_20260826_000412.png

## Audit command naming

`/list audit`, `/goal audit`, and `/loop audit` may need clearer distinctions
from `/list start`, `/goal start`, and `/loop start`. Avoid launching a broad
audit immediately when the user has not specified what they mean.

one problem is htat hte audit often goes outside the folder so i launch audit on a page
then next i see everything is getting audited

## Fewer mid-execution questions

Questions are useful for real decisions, but interrupting a list/goal/loop for
routine implementation choices is costly. Save non-blocking questions for the
end, ask only when the choice changes the result, and gather more constraints
in the initial draft.

# Done

## Status-surface redesign

Implemented the shared evidence-backed status projection: the persistent footer
is compact global liveness and command discovery; the widget shows detailed
current work, queues, stalls, recovery, and worker rows; and `/glla agents`
provides expanded inspection. Worker rows now expose sanitized identity/purpose,
coarse phase/status, elapsed time, silence age, ownership-safe lifecycle state,
and explicit overflow. Detached completion-auditor evidence remains separate.

Evidence: `extensions/goal-agents-panel.ts`, `extensions/goal-heartbeat.ts`,
`extensions/goal-loop-display.ts`, `extensions/loops/goal-ui.ts`, the focused
status/worker tests, and the release fixture review from 2026-08-26.

Validation: 124 focused status tests, 30 worker lifecycle tests, the full
release gate (1601 pass, 1 skip, 0 fail), clean TypeScript, offline auditor
validation, and the expected 76-file npm package.

## Compiled-host auditor launcher (#23)

The detached auditor now resolves `process.execPath` only when it names a
JavaScript runtime (`node`, `nodejs`, `bun`, or `deno`); compiled Pi hosts fall
back to `node`, while explicit runtime overrides remain authoritative. The
fix was selectively ported from PR #24, covered by `tests/auditor-process.test.ts`,
and released as v0.35.66. PR #24 itself remains unmerged.

## In-band provider-result recovery (#30)

Repeated successful tool transports that carry a strong 503/429/network-error
pane are now recognized as provider failure only after the same tool/result
fingerprint repeats. The turn is converted into the existing provider recovery
envelope before loop measurement or stuck accounting; one-off status text in a
searched document remains ordinary output. Coverage includes classifier,
repetition, recovery, and loop behavior. Released as v0.35.67.

## Bound-stop recovery (#32)

Time- and token-bound loops can now be explicitly resumed as fresh supervised
windows while preserving iteration, history, and best-value state. A stopped
loop with a recoverable bound or failure can also accept a confirmed
`propose_loop_refine` change without silently restarting; clean max-iteration
and finished loops still require a fresh `/loop start`. Auto-resume does not
silently reset an explicit budget. Released as v0.35.68.

## Metricless-loop cadence (#34)

Metricless loops support an opt-in `cadence=<seconds>` minimum gap between
successful automatic iterations. Explicit starts/resumes remain urgent, the
armed cadence appears in `/loop status` and the loop prompt, and the default
behavior is unchanged. Time/token bound windows and stopped-loop refinement
remain explicit and durable. Released as v0.35.69.

## Compaction fallback evaluation

The existing context-overflow path is already the dedicated recovery route:
recent failed compaction is detected, then the configured main-model fallback
chain is walked through the normal recovery envelope. No separate hardcoded
free model was added; model choice remains an explicit provider/settings
policy, not a price heuristic.

## Optional subagent provider boundary

`@tintinweb/pi-subagents` remains optional: GLLA core loads without it, while
integration coverage uses it when installed. A genuine no-provider smoke test
now loads the extension while forbidding the provider import, and
`defaultAgentDir()` delegates to pi's host resolver so custom
`PI_CODING_AGENT_DIR` is honored. This boundary remains separate from README
wording tests. Released as v0.35.70.

## Documentation and test-boundary cleanup

README and INSTALL now describe current first-use behavior without pinning a
literal release version or recommending the advisor extension. README prose and
positioning assertions were removed from runtime tests; only stable package and
critical behavior checks remain. The subagent recommendation is conditional on
parallelism being worthwhile.
