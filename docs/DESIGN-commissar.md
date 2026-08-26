# DESIGN — Commissar adherence watchdog (v0.37.0)

Source: a local development branch (commissar + zombie standdown), ported
onto current main with every conflict audited for lost semantics.

## Problem

The completion auditor verifies work AFTER `complete_goal`. Nothing watches
the executor DURING a multi-hour run: an agent can stall, loop on the same
failed approach, drift out of scope, or narrate completion without ever
claiming it — and glla's stall watchdog only catches SILENCE. The commissar
covers productive-LOOKING dereliction.

## Architecture

```
heartbeat tick ──> maybeFireCommissarCheck(ctx)        [goal-commissar-hooks.ts]
   │  gates: opt-in setting · active goal OR loop · not paused ·
   │  no in-flight check · no completion audit · no provider recovery ·
   │  interval cadence (default per /glla settings)
   ▼
detached worker (production transport shared with the completion
auditor, scripts/goal-auditor-worker.mjs) ── runs buildCommissarPrompt()
   │  read-only evidence pass: repo state, git history, .pi-glla ledger
   ▼
verdict: final line exactly <adherent/> | <wanting>reason</wanting>
   ▼
applyCommissarResult()
   ├─ ADHERENT → reset wanting streak, ledger commissar_verdict
   ├─ infra failure → ledger commissar_infra, NEVER escalates
   └─ WANTING → streak++
        └─ streak ≥ threshold (default 2) → terminate:
             durable marker (Goal/LoopState.commissarRestart)
             → force NEW main session when the host exposes newSession()
               (fallback: ctx.abort(), same-session restart)
             → successor restore gate sees the marker = restart consent,
               resumes immediately, COMMISSAR RESTART directive rides the
               first continuation; marker cleared on accepted dispatch
```

## Design decisions

- **Watchdog, not judge**: the commissar never decides completion — only
  whether current work honestly serves the objective. Slowness alone is
  never WANTING.
- **One WANTING never terminates**: consecutive-threshold guards against a
  single harsh verdict killing a healthy run.
- **Infra failures never escalate**: provider/model errors add nothing to
  the streak.
- **Force-new-session over in-place restart**: dereliction correlates with
  poisoned conversation context. The fresh session rehydrates durable state
  (.pi-glla) so nothing is lost; honest fallback to same-session restart
  when the host lacks a command-capable `newSession`.
- **Loop parity** (v0.37.0): loops are watched too, with loop-specific
  WANTING criteria (measure fabrication, bounds/ledger editing,
  undiagnosed repeat failures). Termination replaces the run, keeping
  `state.loop.active`; the aborted handler restarts the same loop instead
  of counting toward the abort stop.
- **Prompt-injection posture**: inspected artifacts are evidence, never
  instructions; the verdict vocabulary is narrow and machine-parsed.

## Relationship to other watchdogs

| Mechanism | Owns |
|---|---|
| Stall watchdog / nudges | SILENCE (no tool calls) |
| Zombie zero-stream watchdog | Hung streams (with human-input + subagent-wait standdowns) |
| Completion auditor | Verifies FINISHED claims |
| **Commissar** | **Productive-looking DERELICTION mid-run** |

Sibling mechanism (separate PR): the AVO-inspired **stagnation supervisor**
(`DESIGN-stagnation-supervisor.md`) detects exhaustion/cycling heuristically
over a per-goal progress lineage and injects non-prescriptive framing — no
model call, no termination. Layering guidance: stagnation fires first and
cheap; the commissar is the heavier LLM-judged backstop when heuristic
framing fails to turn the run around. If both are enabled, keep the
commissar interval comfortably above the stagnation exhaustion threshold
(defaults already do: 4 turns vs a per-interval cadence).

## Files

Core: `extensions/goal-commissar.ts` (prompt/verdict machinery),
`goal-commissar-hooks.ts` (cadence, termination). Wiring: heartbeat,
continuation directive, settings UI, schema (`Goal.commissarRestart`).
Tests: `tests/commissar-{core,process,settings,wiring}.test.ts`,
`tests/commissar-terminate.test.ts`, behavioral pins in
`tests/behavioral-orchestrator.test.ts`, live smoke:
`tests/manual/commissar-live-smoke.ts`.
