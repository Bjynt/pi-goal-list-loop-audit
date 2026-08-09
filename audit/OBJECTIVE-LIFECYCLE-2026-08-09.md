# Objective lifecycle, single-active policy, and cancel/wipe — v0.34.120

## User-facing contract

- Auditor approval preserves the completion recap in `.pi-glla/archive/<id>.md`, emits one final `✓ done: ...` summary notification, and clears the live `state.goal` slot after list/reviewer cascade work. A finished objective no longer requires `/goal cancel`.
- A legacy `complete`/`aborted` live slot is cleared on `session_start` when its archive exists, so older projects stop showing a terminal card as `Last` work.
- A same-mode new start offers `Update current objective`, `Replace current objective`, or `Cancel new objective`. Cross-mode starts offer explicit replacement/cancellation. Headless contexts fail closed instead of overwriting a live objective.
- `/glla cancel` cancels the active objective. A list-owned objective includes its active item and waiting queue; an unrelated standalone goal takes precedence over an unrelated waiting backlog.
- `/glla wipe` is interactive-confirmation gated, idempotent, and all-state: it preserves archive/ledger history, clears terminal live records, clears RAM and orphaned queue sidecars, removes the loop record, and persists the clean state before optional scratch-branch cleanup. A second invocation reports an already-clean state without opening another destructive confirmation.

## Concrete implementation evidence

- `extensions/loops/goal-orchestrator.ts`
  - `archiveCurrentGoal()` now returns false when the archive write fails, leaves the objective live, and emits no terminal ledger event.
  - Successful archive writes the markdown first, records `goal_archived`, then clears the live slot after the list successor/reviewer cascade. `completionSummary` remains in the archive markdown.
- `extensions/goal-objective-conflict.ts`
  - Enumerates live goal/list/loop slots, presents the three-way same-mode choice, records `objective_conflict_resolved`, and rejects stale dialog decisions when the slot identity changed while the UI awaited input.
- `extensions/goal-commands.ts` / `extensions/goal-loop.ts` / `extensions/loops/goal-tools.ts`
  - All direct/tool start paths use the conflict guard; `/list next` and `list_activate` no longer silently abort a live objective.
- `extensions/goal-loop-core.ts`
  - `queueItemSidecarCount()` and `clearQueueItemFiles()` make destructive cleanup cover orphaned `.queue.json` files, including invalid JSON sidecars.
- `extensions/loops/goal-activation.ts`
  - Legacy terminal live slots are closed during session start when their archive exists.

## Regression evidence

```text
npx tsc --noEmit
  TypeScript: No errors found

bun test
  1207 pass
  1 skip (env-gated auto-committer test)
  0 fail
  1208 tests across 107 files

Focused lifecycle/conflict/recovery/display/queue suites
  pass (included in the full run)
```

Behavioral coverage includes:

- approved detached completion closes the live slot, preserves archive, and emits exactly one recap;
- approved list completion archives the item and activates exactly one successor;
- `/goal start` update/replace/cancel choices;
- cross-mode `/goal` ↔ `/loop` replacement confirmation;
- `/list next` / `list_activate` conflict confirmation;
- one `/glla wipe` clearing goal + queue + sidecars without a second destructive flow;
- standalone-goal `/glla cancel` precedence over an unrelated waiting queue;
- archive-write failure preserving live work;
- stale-context `/glla wipe` refusal and truthful `/new` fallback.

## Out of scope / residual findings

The plugin does not modify pi core or host APIs. Autonomous event contexts still
cannot create a fresh session after the stale-context error because pi exposes
`newSession()` only on command contexts. The user must use `/new`; this blocker
is recorded in `NOTE-REMAINING-TRIAGE-2026-08-09.md` and the corrected stale
recovery audit. The refresh-icon screenshot has no current glla producer, and
the repeated terminal labels are not current glla tool history. External review
retrieval evidence is archived separately in `EXTERNAL-REVIEWS-2026-08-09.md`.
