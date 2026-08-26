# PROGRESS — commissar release-readiness loop

## Current state
- `feat/commissar` @ 71bb12e, PR #36 OPEN/MERGEABLE/CLEAN, gate 1653 pass / 0 fail
- Shipped: watchdog port, zombie standdown, force-new-session termination,
  loop-mode support (prompt/termination/restart), behavioral pins, 3 upstream syncs

## What keeps failing
- Upstream daemon re-drifts the PR every ~30min (3 sync rounds so far) —
  environmental, not fixable from here; re-sync on demand

## Next 3 concrete steps
1. Audit schemas/goal.schema.json: LoopState.commissarRestart likely missing
   from the published loop schema — add it if the schema tracks loop state
2. Refresh PR #36 body: still describes only the original port; missing
   force-new-session + loop support sections
3. Re-verify gate + mergeable after 1-2; stop when nothing substantive remains
