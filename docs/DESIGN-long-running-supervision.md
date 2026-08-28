# Long-running supervision policy

**Decision record: v0.36.0 — 2026-08-28**

This document records the GLLA policy for work that can outlive one agent
turn, one provider session, or one day. It is a project decision record, not a
change to Pi core, `pi-subagents`, or `pi-memory`.

## Decision

GLLA automation is **event-driven and progress-aware**, not duration-guessed.

- A lifecycle event, durable state transition, child-progress signal, or
  process completion marker is the primary reason to inspect or advance work.
- If no public event signal exists, GLLA uses a short adaptive fallback poll
  (`250ms` backoff to the normal safety cadence) rather than sleeping for an
  estimated task duration. A five-second task must not inherit a ten-minute
  wait merely because the system guessed wrong.
- A live process remains eligible while real output, tool activity, durable
  markers, or child progress proves liveness. A silent or unreachable process
  may be classified as wedged only by the existing bounded safety watchdog.
- Timers remain useful for per-attempt backoff, watchdogs, and host safety. A
  timer is never evidence that work completed and is not the definition of a
  long-running process's lifetime.

The shared checker covers all GLLA-owned work planes: ordinary goals, list
items and their queue, metric/spec/audit loops, detached completion auditors,
tracked subagents, provider recovery, and lifecycle/session transitions.

## Aggressive automation

Aggressive mode is the default effective keep-going policy unless the user
explicitly opts out. Its purpose is unattended long-running work:

- Recoverable provider, host, and auditor-infrastructure failures retry with
  bounded per-attempt backoff and durable owner/generation fences.
- In aggressive mode, a recovery episode has no wall-clock expiry. Legacy
  `autoRetryUntil` fields remain readable for compatibility, but new aggressive
  scheduling must not stop solely because that old horizon elapsed.
- A semantic auditor disapproval is actionable work: its extracted objections
  become a bounded durable TODO projection and the next continuation works them.
  Repeated identical objections with no new progress are a state-based stop,
  not an invitation to burn more turns.
- Automation stops on success, explicit user pause/cancel, a non-retriable or
  contradictory semantic result, ownership loss, persistence-integrity failure,
  or repeated no-progress. A cold-start consent/load hold still wins; aggressive
  mode does not silently turn an unattended fresh launch into user consent.
- A retry must be idempotent with respect to durable state. It must not create
  duplicate workers, overwrite a newer generation, duplicate TODOs, or erase a
  recoverable claim.

Conservative mode keeps the pre-v0.36 bounded recovery horizons and explicit
manual holds. This opt-out is retained for users who prefer a finite
unattended recovery envelope.

## User-facing completion summaries

Every archived terminal objective gets one full six-label recap:

```text
Outcome: ...
Changed: ...
Evidence: ...
Tests: ...
Unresolved: ...
Next: ...
```

This applies to complete, aborted/cancelled, auto-dropped, full-auditor-IMPOSSIBLE,
and already-shipped archive paths. A valid executor recap is preserved. A
partial IMPOSSIBLE verdict remains a decision pause in conservative mode (or
continues narrowing in aggressive mode); only a full impossible objective is
terminalized. A missing, generic, or incomplete recap is replaced at the
central archive boundary by a
fallback assembled only from recorded GLLA facts: the objective, terminal
status/reason, durable telemetry, captured audit verdicts, and known archive
path. It says `not recorded` when a changed-file manifest or test result is not
available. It never infers a passing test or invents a commit.

The full recap lives in the archive and status/history surfaces. The terminal
notification may use a compact excerpt. The executor recap and independent
auditor verdict stay separate: an approval is not manufactured from the
presence of a summary.

Metric-loop stops use the same six-label contract in their durable loop state
and `/loop status`, and every terminal loop notification carries a compact
projection of that recap. Lifecycle/recovery holds are not falsely presented
as terminal completion.

## Future decision checklist

Before adding a new long-running GLLA path, record answers to these questions:

1. What durable or lifecycle signal proves start, progress, recovery, and
   completion?
2. If the host has no signal, what is the adaptive fallback, and what bounded
   watchdog identifies confirmed silence without guessing task duration?
3. Which failures are recoverable, and which state-based conditions stop
   automation? Is the retry idempotent across reload and owner changes?
4. What exact six-label user recap is available after every terminal path? Which
   values are recorded facts, and which must explicitly say `not recorded`?
5. Does the change stay at GLLA's public boundary and preserve persistence,
   ownership, lifecycle, auditor, and user-stop semantics?

Do not solve an external Pi/core defect by widening GLLA's scope. Keep the
external-only issue as a documented observation or a separate upstream report.
