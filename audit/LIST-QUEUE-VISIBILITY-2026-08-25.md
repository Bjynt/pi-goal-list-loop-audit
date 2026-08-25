# List queue visibility across reload/rebind — 2026-08-25

## Field evidence

The remaining `# Now` screenshots (`Screenshot_20260823_120853.png`,
`122304.png`, and `130243.png`) show a carried-over queue that is either not
visible or cannot be started before a lifecycle boundary. The recurring shape
is `Active: (none)` with waiting items/carryover in the transcript, followed by
successful recovery after reload. The screenshots also show reviewer-text
activation refusals, but this item addresses the durable queue projection and
its actionable empty-active surface; the separate visual list redesign remains
out of scope.

## Root cause

GLLA has two durable queue representations: the state ledger's `state.list` and
per-item `.queue.json` sidecars. The v0.35.21 `session_start` hydration fixed
ordinary restore, but a silent host successor or same-session stale recovery
could rebind and repaint the old in-memory projection without repeating the
same durable restore/hydration step. A sidecar-only queue could therefore
remain absent from memory until a later full reload.

There was also no display projection for a waiting-only queue. Both
`buildStatusTextBase` and `buildWidgetLinesInner` returned no GLLA surface when
`state.goal` was null, even when `state.list` contained durable waiting work.
That made `Active: (none)` look like an empty system and gave the user no
visible `/list next` action.

The invariant is now explicit: after lifecycle recovery, `state.list` is the
deduplicated durable queue projection (ledger plus valid sidecars), and a
non-empty queue remains visible/actionable even when no item currently owns
the active-goal slot.

## Fix

v0.35.61 changes:

- `extensions/loops/goal-session.ts` re-reads the selected state root and
  hydrates sidecars during silent host-successor absorption, and hydrates
  sidecars during same-session stale self-heal before repainting.
- `extensions/goal-loop-display.ts` renders a queue-only status line and
  widget card with the count, next objective, and `/list next` action. Restore
  holds explicitly say that `/list next` starts the queue.

No reviewer-text policy, queue ordering, or full list-panel redesign was
changed here.

## Verification

- `tests/list-invisible-restart.test.ts` covers:
  - existing sidecar-only session-start convergence;
  - a waiting-only queue visible and startable without reload;
  - sidecar-only silent host-successor rehydration before repaint;
  - idempotent ledger+sidecar convergence.
- Focused lifecycle/display/load suite: **117 pass / 0 fail**.
- `npx tsc --noEmit`: must exit 0.
- `npm run release:check`: must report zero failures.

## Boundary

This fixes the durable projection and no-active queue visibility/startability
boundary. It does not redesign the multi-row list UI, reconcile unrelated
counter styles, or decide whether reviewer/verification-looking queued prose
should be auto-dropped; those concerns remain separately scoped.
