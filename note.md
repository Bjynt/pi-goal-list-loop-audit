# Working notes — updated 2026-08-17

This file is the short backlog and decision log. Detailed evidence belongs in
`audit/` and `.research/`; this note should say what is done, what is still
uncertain, and what deserves the next goal.

## Completed or substantially addressed

### 1. Model fallback consistency

The fallback-surface audit and implementation are complete.

- `audit/FALLBACK-UNIFICATION-2026-08-17.md` records every provider/model
  surface, the exclusions, the ordering policy, and file/line citations.
- Main-model recovery, drafter resolution, auditor resolution, detached-auditor
  retry, and the delayed probe now follow the same conceptual sequence:
  normalize → forbidden gate → select an untried ref → classify failure → use
  bounded backoff.
- Auditor settings deliberately remain `auditorModel` plus the singular
  `auditorModelFallback`, followed by the session last resort. No plural
  settings migration was kept.
- Forbidden models are skipped silently in the UI but remain visible in the
  forensic ledger.
- Detached worker spawn, request/result transport, identity checks, and job
  lifecycle were not redesigned.
- Regression and full-suite verification are green. The implementation is
  complete; formal goal closeout still needs to be submitted by the owning
  main session.

### 2. Long-running judgment policy

The drafting policy now prefers durable, evidence-backed decisions over quick
band-aids. It uses default-decide behavior for ordinary choices, avoids
needless band-aid-versus-proper-fix questions, and supports an explicit
Designer hand-off when design work really needs a separate read-only role.

This addresses the principle behind the original note, but it still needs live
field testing: a default should be reversible and evidence-based, not an excuse
to ignore a genuinely consequential user choice.

### 3. Host-session research and diagnosis

The cross-plugin comparison is complete in `.research/comparison.md`.

The evidence does **not** support “the detached auditor detaches the main
thread” as the root cause. The main loop is in-session; the only detached
process is the short-lived completion auditor. The stronger finding is that
our persistent heartbeat detects silent host-handle swaps and then fail-closes
into a `host session lost` wait. Other plugins generally re-derive state on
session events and do not run this liveness gate.

This is a diagnosis, not a fix. The host-session symptom remains the highest
priority unresolved runtime problem.

### 4. Auditor and no-verdict hardening

The auditor status/recovery work, detached-worker lifecycle guards, stale
handling, and fallback policy are covered by audit documents and regression
suites. The recent fallback work prevents a forbidden or exhausted model chain
from launching an invalid worker and gives recoverable provider failures a
bounded retry path.

A live-session validation pass is still needed for the older “auditor parked —
no verdict” reports; passing tests alone do not prove that a real reload,
host swap, and worker completion settle correctly.

### 5. Model picker groundwork

The model picker now supports ordered multi-model chains, visible unavailable /
blocked entries, forbidden-model handling, and explicit session/manual rows.
This is progress toward making model provenance understandable, but it does
not yet close the UI request below: the active goal and footer must clearly say
whether a model is pinned, inherited, or being tried as a fallback.

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
