# GLLA issue reconciliation — 2026-08-26

## Scope and boundary

This record covers only the eight issue reports requested for the current GLLA
workflow review: #25, #26, #27, #28, #29, #31, #33, and #35. They were
checked against the v0.35.70 baseline and the current GLLA source. The goal
started at `2026-08-26T18:04:45Z`.

GLLA owns its goal/list state, lifecycle boundaries, public recovery decisions,
and evidence surfaces. It does not own the operating system, Pi internals,
pi-subagents, pi-memory, provider implementations, or other plugins. External
behavior may be observed and safely contained at a public GLLA hook, but
external implementation defects are not local fix targets. No pull-request
review or feature-proposal analysis is part of this record.

## Findings and final dispositions

| Issue | Verified ownership at the v0.35.70 baseline | GLLA action | GitHub disposition |
| --- | --- | --- | --- |
| #25 | Async-run tracking and stale-run reconciliation are outside this repository. | No global run/PID sweep or orphan repair was added; GLLA has no safe ownership surface for it. | Evidence comment added; closed `NOT_PLANNED`. |
| #26 | Retryable model-failure classification and child model rotation belong to the external subagent runtime. | No external classifier or provider policy was changed. | Evidence comment added; closed `NOT_PLANNED`. |
| #27 | Worktree cleanup and child session-file lifecycle belong to the external worktree/session implementation. | GLLA does not rewrite or delete external session files. | Evidence comment added; closed `NOT_PLANNED`. |
| #28 | Role-memory read/modify/write behavior belongs to pi-memory. | GLLA does not write or lock that store. | Evidence comment added; closed `NOT_PLANNED`. |
| #29 | Provider-qualified model verification belongs to the external subagent runtime. | GLLA preserves configured model identity and does not normalize or weaken external verification. | Evidence comment added; closed `NOT_PLANNED`. |
| #31 | The same-model retry delay is private Pi-core behavior. | GLLA contains the public boundary only; details are recorded below. | Evidence comment added; closed `NOT_PLANNED` for the Pi-core change. |
| #33 | Inherited-child model verification belongs to the external subagent runtime. | GLLA keeps inherited identity distinct from exact managed pins and adds no exemption. | Evidence comment added; closed `NOT_PLANNED`. |
| #35 | Refinement mission-store artifacts and the associated evidence collector belong to the external subagent runtime. | GLLA exposes only its own bounded, read-only evidence and does not invent a mission-store reader. | Evidence comment added; closed `NOT_PLANNED`. |

The final GitHub check returned zero open reports among these eight issues. Each
has exactly one concise evidence comment and state reason `NOT_PLANNED`.

## GLLA-owned containment for #31

GLLA cannot cap or rewrite Pi's private retry sleeper. At the public boundary,
v0.35.71 now detects a confirmed BUSY/no-stream window, aborts through the
public context, durably parks the owning work, and re-dispatches repeatedly
within a finite configured budget. The default budget is 3 and the accepted
range is 0–10; exhaustion stays parked and requires explicit resume. Generation
and owner fences prevent a stale recovery timer from clearing unrelated state,
and pause/abort paths prevent a retry storm.

The boundary implementation is in `extensions/goal-heartbeat.ts`,
`extensions/loops/goal-activation.ts`, and `extensions/goal-loop-backoff.ts`.
Regression coverage is in `tests/post-accept-hang-retry.test.ts` and
`tests/stall-handling.test.ts`, with settings persistence coverage in
`tests/settings-editors.test.ts`.

## Explicit accounting for pre-existing repository states

The following states predate this goal and are not deliverables or actions
claimed by this reconciliation. The four issue closures occurred at
`2026-08-26T13:45:56Z`, before the goal start above:

- #23 was already closed `COMPLETED` after the compiled-host launcher fix in
  v0.35.66.
- #30 was already closed `COMPLETED` after in-band provider-result recovery in
  v0.35.67.
- #32 was already closed `COMPLETED` after bound-stop recovery in v0.35.68.
- #34 was already closed `COMPLETED` after metricless-loop cadence in v0.35.69.
- PR #24 was already closed unmerged as superseded by the v0.35.66 launcher
  fix.

The required state-only check for PRs #22 and #36 returned both open. This
record does not review, classify, modify, or recommend action on either one.

## Verification references

- Targeted boundary run: 45 tests passed, 0 failed.
- Full release gate: 1611 passed, 1 skipped, 0 failed across 148 files;
  TypeScript, jiti, and offline auditor-extension validation passed.
- Package dry-run: `pi-goal-list-loop-audit-0.35.71.tgz`, 76 files.
- Published release: v0.35.71; npm latest is 0.35.71.
- The working tree is clean on `main`, and no repository outside GLLA was
  modified.
