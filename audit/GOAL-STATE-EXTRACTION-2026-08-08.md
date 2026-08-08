# Goal-State Extraction — v0.34.109 (decomposition step 1)

First extraction from the 11,235-line goal.ts monolith per
`docs/GLLA-POSITIONING-AND-DECOMPOSITION-2026-08-08.md` sequencing
("1. Extract goal-state.ts (state shape + persistence) — lowest risk,
highest clarity gain").

verification: bun test → 1146 pass / 1 skip / 0 fail (103 files);
`npx tsc --noEmit` clean; version 0.34.109; new tests/goal-state.test.ts
(4 pins) green.

## What moved

New module `extensions/goal-state.ts`:

- `export let state: State = { goal: null }` — the mutable state singleton,
  now owned by exactly one module (invariant #2).
- `export function replaceState(next: State)` — the wholesale-replacement
  primitive. ESM import bindings are read-only, so goal.ts can no longer
  write `state = ...` even by accident; tsc enforces it structurally.
- `export function persistStateLine(cwd, s)` — the ledger `state`-line
  append (active.jsonl), i.e. the persistence core. The v0.34.57
  lastModelRef + explicit-null-for-recovery-slot comments moved with it.

goal.ts changes:

- `let state: State = { goal: null }` declaration removed; import added.
- All 18 wholesale `state = ...` sites → `replaceState(...)`
  (goal swap, archive, list queue ops, loop start/arbitrate, goal:null,
  lastCompactionAt, readState loads incl. __testOnlyLoadState).
- `persistState(ctx)` now delegates the ledger write to persistStateLine and
  keeps its UI side effects (notifyPersistenceState / refreshUI) — behavior
  identical.

## What deliberately did NOT move (invariants #3, #4)

- `setGoal` / `updateGoal` / `archiveCurrentGoal` /
  `autoArbitrateStackedState` stay in goal.ts: they reset ~10 module-level
  mutable flags (postCompactResumeOwed, countedTokenMessages, recentActions,
  mainModelAbortForRecovery, completionAuditInFlight, sessionGeneration,
  latestAuditProgress, dispatch stand-downs, ...). Invariant #3 keeps flags
  in their owning module until the owning cluster is extracted; these
  functions move in later steps (commands / heartbeat / continuation) with
  their flag clusters.
- Property mutations on the shared object (`state.goal = ...`,
  `state.goal!.activePath = ...`) remain legal and unchanged — only
  whole-object replacement is channeled through replaceState().

## Test changes

- New tests/goal-state.test.ts (4 pins): singleton declared once and only
  in goal-state.ts; zero `state = ` reassignments in goal.ts; persistence
  core location + persistState wrapper shape; spot-check of the 5 critical
  converted sites.
- tests/disk-first-queue.test.ts: three pins re-spelled from
  `state = { ...state, list: ... }` to `replaceState({ ...state, ... })`
  (v0.34.61 disk-first intent unchanged — sidecar write still pinned
  strictly BEFORE the state commit).

## Risk notes

- The 18-site conversion was mechanical; the two multi-line object literals
  (archive block, loop-start block) needed careful brace handling.
- Full suite clean on the first post-change run (1146/1/0) — no daemon
  contention this time.
