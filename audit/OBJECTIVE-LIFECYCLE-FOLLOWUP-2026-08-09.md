# Objective lifecycle follow-up — v0.34.121

The first v0.34.120 completion audit found three reachable lifecycle gaps. This
follow-up closes each one without changing pi core or host code.

## Auditor objections and fixes

1. **`/glla cancel` with an active loop and unrelated waiting list**
   - `extensions/goal-commands.ts` now checks `state.loop?.active` first and
     stops that active objective before inspecting or clearing any list queue.
   - Regression: `tests/behavioral-orchestrator.test.ts` proves the loop stops
     and the unrelated waiting item remains.

2. **`/glla wipe` omitted provider recovery and continuation dispatch state**
   - The clean-state fast path now includes `state.mainModelRecovery`, the
     recovery timer, in-memory pending dispatch, and the dispatch sidecar.
   - Wipe clears the provider recovery timer/ticker and state, resets recovery
     flags, and clears the continuation timer, start watchdog, queue-stuck
     probe, in-memory dispatch, main sidecar, and atomic temp sidecars.
   - Archive failure still returns before these destructive cleanup steps, so
     resumable work is not discarded when archival cannot land.
   - Regression: the behavioral wipe test seeds provider recovery plus both
     dispatch sidecars and proves one confirmation removes all of them.

3. **Blank startup returned before legacy terminal-slot cleanup**
   - `extensions/loops/goal-activation.ts` now closes an archived legacy
     `complete`/`aborted` slot before the blank-transcript barrier returns.
   - Regression: a blank-start test seeds an archived terminal goal and proves
     `state.goal` is cleared and `terminal_goal_slot_closed` is ledgered.

## Verification

```text
npx tsc --noEmit
  TypeScript: No errors found

bun test
  1209 pass / 1 skip / 0 fail across 107 files
```

The existing note triage, external-review evidence, stale-session limitation,
conflict confirmation, completion closure, and `/glla wipe` history-preserving
contract remain documented in `audit/NOTE-REMAINING-TRIAGE-2026-08-09.md` and
`audit/OBJECTIVE-LIFECYCLE-2026-08-09.md`.

## Sequential completion-audit rerun

A detached audit overlapped an independent rehearsal process and reported
transient failures in the behavioral and full suites. With all other runners
settled, the mandatory commands were rerun sequentially from the same clean
implementation: the behavioral suite passed **86/86**, the full suite passed
**1209/1209** with one env-gated skip, and `npx tsc --noEmit` reported no
errors. No implementation change was needed for that infrastructure race; the
fresh raw sequential output is the evidence used for the next audit claim.
