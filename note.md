# Now

The status-surface redesign is complete and recorded under `# Done`. The
current eight-report GLLA reconciliation is recorded in
`audit/GITHUB-MAINTAINER-INVENTORY-2026-08-25.md`: external reports received
boundary evidence and were closed as not planned, while the public no-stream
containment shipped in v0.35.71.

# Next

No follow-up from this reconciliation is active. GLLA continues to own only
its lifecycle, durable state, public recovery boundaries, and evidence
surfaces; Pi, the OS, providers, and other plugins remain outside its fix
boundary.

## AVO idea triage — 2026-08-27

PR #22 is an unmerged, conflicting fork branch, not shipped product behavior.
The current `main` (v0.35.71) has no AVO/stagnation implementation. The PR's
claim is accurate only in the narrow sense of an **AVO-inspired stagnation
prototype**: it tracks bounded per-turn activity, detects four active turns
without local progress or three near-duplicate replies, and injects a
non-prescriptive trajectory-review prompt. It does **not** implement AVO's
variation-operator search, persistent task memory, objective score/evaluator,
or independent supervisor agent. PR #36 is separate Commissar work, not the
AVO implementation.

Do not merge either PR wholesale. Before taking another AVO-sized bite,
prioritize these smaller foundations:

1. Replace guessed long waits with bounded, status-aware rechecks and record
   observed durations. The agent should keep checking whether a condition is
   done rather than choosing a large sleep from a guess; this is the smallest
   direct velocity win and addresses the current Antigravity/Codex comparison.
2. Define a durable, objective-specific progress/evaluation signal. Commits,
   file writes, and reply similarity are useful telemetry but are not proof
   that an objective improved; this is the prerequisite for an honest AVO-like
   supervisor.
3. Exercise completion and recovery under provider failure, restart, and
   no-stream conditions so a long-running goal can close without a manual
   rescue.
4. If those foundations hold, revisit AVO as one opt-in, narrowly scoped
   trajectory-review experiment with a real evaluation signal—not a wholesale
   architecture port.

This is a prioritization note, not an active implementation request. Keep
AVO research separate from the main release line until the smaller work is
scoped and verified.

### Candidate brief — status-aware waiting

The first likely follow-up is a small wait/recheck investigation, not an AVO
port. Inventory every long wait in continuation, auditor, recovery, and smoke
paths; identify what durable event proves the condition is satisfied; then
prefer a bounded poll/backoff that checks that event over one guessed sleep.
Record elapsed time and the terminal reason so later defaults can be learned
from observations. Preserve explicit user waits, provider hints, cancellation,
ownership fences, and the existing no-storm bounds. A good first deliverable
would be a focused design note plus regressions for success-before-deadline,
real timeout, restart, and provider failure—not a broad timer rewrite.

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

##

antigravity doesnt wait it just keep checking if done maybe we shoulddo the same cause it leads to lno guess and faster work

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
