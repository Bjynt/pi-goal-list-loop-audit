# Faulty-objective recovery

## Decision

A goal/list item that looks like reviewer metadata, a verification-contract
fragment, a marker-only objective, a command-only objective, or a dangling
structural fragment must not be allowed to run merely because `/goal resume`,
`session_start`, list activation, a stored completion-audit retry, or a delayed
continuation reached it. The guard is shared at the continuation choke point,
with direct auditor/stall/length dispatches using the same final check.

## Recovery policy

1. **Archive fence first.** If a stale in-memory goal has an archive for the
   same ID, the archived/canceled work is non-resumable. The guard removes the
   resurrected active markdown, clears the live slot, and records
   `faulty_objective_archive_fence`.
2. **Provenance-first repair.** Suspicion is detected from durable text signals
   (archive decoration, reviewer/verification vocabulary, headings, numbered
   audit prose, marker-only text, command-only text, and dangling fragments).
   `Implement archive` and other coherent imperative objectives remain valid.
   A repair consults the original record, user seed, prior repair history,
   pending tasks, task-list titles, pending verification summary, audit history,
   and only auditor-approved completion context. A coherent candidate is
   applied automatically, validates the replacement contract, bumps the goal
   revision, and records the original/replacement/reason/confidence,
   provenance evidence, and revision-before/after in `objectiveRepairHistory`.
3. **No invented turn.** If no coherent durable candidate exists, the goal is
   paused as blocked, the original text is never dispatched, and a safe short
   `Repair the blocked … from saved intent` item is promoted to the next list
   position through the disk-first queue path. The safe task does not echo the
   faulty text and can activate without recursively tripping the detector. The
   durable record is `faulty_objective_repair_queued`.
4. **Valid objectives are untouched.** Normal imperative objectives and
   objectives carrying their own `Done when` text remain on the existing
   continuation path. No Pi core/host API, session creation, transcript
   injection, or valid-objective rewrite was added.

## Evidence

- `extensions/faulty-objective-recovery.ts` owns classification, durable-source
  repair selection, repair records, and repair-task text.
- `extensions/goal-loop-core.ts` and `schemas/goal.schema.json` persist the
  bounded repair history and original/user-seed provenance.
- `extensions/loops/goal-orchestrator.ts` captures provenance at goal creation;
  `/goal tweak` and list activation preserve it.
- `extensions/goal-continuation.ts` applies archive/stale-generation fences
  and the recovery gate before scheduling, retrying, stalling, length nudging,
  or dispatching a continuation.
- `extensions/loops/goal-auditor-hooks.ts` and `goal-tools.ts` gate stored and
  newly-started completion-auditor dispatches.
- `extensions/loops/goal-list-queue.ts` assesses a queued item before taking it
  and promotes an actionable repair item without discarding the original.
- `extensions/loops/goal-activation.ts` routes goal fallback repairs through
  the existing disk-first enqueue path.
- `tests/faulty-objective-recovery.test.ts` covers classification,
  valid-objective preservation, provenance/audit selection, replacement
  contract validation, revision recording, all four activation paths, stored
  dispatch source pins, canceled/stale/archive fences, queued fallback, and
  repair-task activation.

## Verification

```text
npx tsc --noEmit
TypeScript: No errors found

bun test tests/faulty-objective-recovery.test.ts
17 pass / 0 fail

Sequential required suites:
  tests/behavioral-orchestrator.test.ts  — 89 pass / 0 fail
  tests/list-queue.test.ts                — 15 pass / 0 fail
  tests/disk-first-queue.test.ts          — 15 pass / 0 fail
  tests/revision-bound-audit.test.ts      — 11 pass / 0 fail
  combined                                — 130 pass / 0 fail

bun test
1234 pass / 1 skip / 0 fail across 108 files
```
