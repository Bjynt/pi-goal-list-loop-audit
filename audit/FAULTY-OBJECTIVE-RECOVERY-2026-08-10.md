# Faulty-objective recovery

## Decision

A goal/list item that looks like reviewer metadata, a verification-contract
fragment, a marker-only objective, or a command-only objective must not be
allowed to run merely because `/goal resume`, `session_start`, list activation,
or a delayed continuation reached it. The guard is shared at the continuation
choke point, so the four activation paths have one behavioral boundary.

## Recovery policy

1. **Archive fence first.** If a stale in-memory goal has an archive for the
   same ID, the archived/canceled work is non-resumable. The guard removes the
   resurrected active markdown, clears the live slot, and records
   `faulty_objective_archive_fence`.
2. **Provenance-first repair.** Suspicion is detected from durable text signals
   (archive decoration, reviewer/verification vocabulary, marker-only text,
   command-only text, and related fragment signals). A repair may only use
   already-persisted objective normalization, pending tasks, task-list titles,
   or the completion recap. A coherent candidate is applied automatically,
   bumps the goal revision, preserves the replacement contract, and records
   `faulty_objective_auto_repaired` plus the full original/replacement/source/
   evidence/confidence record in `objectiveRepairHistory`.
3. **No invented turn.** If no coherent durable candidate exists, the goal is
   paused as blocked, the original text is never dispatched, and a short
   `Repair suspicious objective: ...` item is queued through the normal
   disk-first list path. The queued repair item is held rather than activated
   over the blocked goal. The durable record is `faulty_objective_repair_queued`.
4. **Valid objectives are untouched.** Normal imperative objectives and
   objectives carrying their own `Done when` text remain on the existing
   continuation path. No Pi core/host API, session creation, transcript
   injection, or valid-objective rewrite was added.

## Evidence

- `extensions/faulty-objective-recovery.ts` owns classification, durable-source
  repair selection, repair records, and repair-task text.
- `extensions/goal-loop-core.ts` and `schemas/goal.schema.json` persist the
  bounded `objectiveRepairHistory` record.
- `extensions/goal-continuation.ts` applies the archive fence and recovery gate
  before scheduling or dispatching a continuation.
- `extensions/loops/goal-activation.ts` routes fallback repairs through the
  existing disk-first enqueue path.
- `tests/faulty-objective-recovery.test.ts` covers classification,
  normalization, provenance selection, revision recording, and fallback.
- `tests/faulty-objective-recovery.behavioral.test.ts` covers startup
  auto-resume, manual resume, list activation, direct dispatch re-check,
  automatic repair, queued fallback, and archive resurrection rejection.

## Verification

```text
npx tsc --noEmit
TypeScript: No errors found

bun test tests/faulty-objective-recovery.test.ts tests/faulty-objective-recovery.behavioral.test.ts
11 pass / 0 fail

bun test tests/behavioral-orchestrator.test.ts
89 pass / 0 fail

bun test tests/list-queue.test.ts
15 pass / 0 fail

bun test tests/disk-first-queue.test.ts
15 pass / 0 fail

bun test tests/revision-bound-audit.test.ts
11 pass / 0 fail

bun test
1228 pass / 1 skip / 0 fail across 109 files
```
