## Remaining work, in priority order

### P0 — Stop the host-session stall without hiding failures

Run a controlled live experiment based on the comparison research before
redesigning the detached worker:

1. reproduce or capture a `silent_handle_death` while the goal is visibly still
   working;
2. distinguish the stale-handle warning from a true terminal condition;
3. test the conservative coalescing fix: preserve the ledger evidence, but let
   the next fresh event/rebind re-arm the continuation instead of leaving the
   goal waiting forever;
4. only then consider the deeper option of making the heartbeat diagnostic
   rather than gating.

Do not change detached spawn shape as the first response. The evidence says it
is not the cause, and `pi-dgoal` uses a comparable isolated process without the
same symptom. Any change must retain an honest, durable failure state when a
fresh host never arrives.

### P1 — Make model provenance visible on the goal and footer

The user should be able to answer, at a glance:

- which model is the primary for this goal;
- whether it is inherited from the current session or explicitly pinned;
- which fallback refs remain, in order;
- whether a forbidden/unavailable ref was skipped;
- which model actually handled the current turn or audit.

Add this to the goal card/footer and the relevant status/notification surfaces.
Use “inherited from session” rather than displaying the session model as if it
were a goal-specific pin. The picker should offer an explicit inherit choice,
not merely imply it through a row label.

### P1 — Profile the heavy-resource loop reports

Measure a real long-running session before changing timers or concurrency.
Record heartbeat/UI ticker/continuation counts, detached worker lifetime,
active child count, memory, and provider-turn frequency. Then set explicit
bounds or coalesce duplicate timers if the measurements identify a leak or
storm. Do not optimize by weakening persistence or audit guarantees.

### P2 — Finish the auditor live validation

Exercise the parked/no-verdict cases with a fresh session, reload, forbidden
primary, recoverable provider error, worker timeout, and host-handle swap.
Confirm that each case has one truthful UI state, a durable ledger entry, and a
clear next action. Add a regression test for every newly observed lifecycle
edge rather than adding another display-only workaround.

### P2 — Improve the UI around what matters

Prioritize truth and scanability over decorative polish:

- goal status, model provenance, audit phase, elapsed time, and next action;
- clear distinction between waiting, paused, host-lost, provider recovery, and
  no-verdict states;
- compact layout that remains readable at narrow widths.

The screenshots below are references, not requirements to reproduce literally.

### P2 — Questions and automatic tweaking

Add a notification/status treatment when the agent is waiting for an answer.
Then define when auto-tweaking is allowed: prefer a durable fix, preserve the
contract, show the proposed change, and stop for user input when the choice is
irreversible, security-sensitive, or materially changes scope. “More
intelligence” should improve decision quality, not create silent scope drift.

### P3 — Broader plugin comparison

The host-session comparison is done, but the broader idea of auditing other Pi
goal plugins remains open. Reuse the existing comparison format and focus on
one question at a time: lifecycle ownership, persistence/rebind, continuation
scheduling, model selection, or resource bounds. Do not start a broad survey
until the P0 host-session experiment has a concrete result.

## Original screenshots / field references

- `/home/dracon/Pictures/Screenshots/Screenshot_20260812_054032.png`
- `/home/dracon/Pictures/Screenshots/Screenshot_20260812_054236.png`
- `/home/dracon/Pictures/Screenshots/Screenshot_20260815_225519.png`
- `/home/dracon/Pictures/Screenshots/Screenshot_20260816_103706.png`
- `/home/dracon/Pictures/Screenshots/Screenshot_20260816_121308.png`
- `/home/dracon/Pictures/Screenshots/Screenshot_20260817_064649.png`
- `/home/dracon/Pictures/Screenshots/Screenshot_20260817_124102.png`

## Recommended next goal

Start with **P0 host-session stall experiment and conservative re-arm design**.
Keep the model-visibility work as the next independent UI goal, and leave the
broader plugin survey parked until the host-session behavior is measured.


# Later

##

we cant resume goal without session restart
/home/dracon/Pictures/Screenshots/Screenshot_20260818_053538.png 

##

we are not inside the main session?? while inside the main session
/home/dracon/Pictures/Screenshots/Screenshot_20260818_054102.png 

