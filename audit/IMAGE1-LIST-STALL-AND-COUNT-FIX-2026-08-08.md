# IMAGE-#1 — list-stall settle window + completionSummary self-check (v0.34.104)

Field screenshot (dracon-platform 2026-08-08 ~10:29 — the user's "first we
fix the problem" image). Two distinct problems visible in the same
capture, fixed as one batch.

verification: bun test tests/image1-list-stall-and-count-fix.test.ts → 9 pass / 0 fail; full suite 1139 pass / 1 skip / 0 fail (102 files); npx tsc --noEmit clean; version 0.34.104.

## Problem 1 — List-item stall after audit completion

The widget showed list item #1 activated and **immediately** stalled:
`glla: pi accepted the list item 20260808152917-f7dn55 continuation, but no
observable turn-start event arrived within 150s. Automatic re-sends are
stopped to avoid a blind queue storm.` The new item was `interrupted ·
4m 53s`, requiring manual `/list resume`.

### Root cause

`archiveCurrentGoal` on a list-sourced `complete` calls
`activateNextListItem(ctx)` → `setGoal(goal, ctx, "list-cascade")` →
`scheduleContinuation(ctx, true)` with **no delay**. The continuation
hits pi while pi is still settling the completion acknowledgement (the
detached auditor's verdict + the goal-complete cascade). Pi doesn't start
a turn within the v0.34.88 watchdog window (30s first window + 60s retry
backoff = ~90s), so the new item is declared unacknowledged.

This is the same diagnostic as the 091828 (hegemon) report — the
"continuation accepted but pi did not start a turn" shape bites whenever
a list item auto-advances right after a completion.

### Fix (extensions/loops/goal.ts)

A bounded **post-completion settle window** delays the FIRST continuation
dispatched from the list-complete cascade, giving pi time to settle the
verdict. Any agent activity during the window cancels the deferred send
so a wake-up doesn't double-dispatch.

- `LIST_COMPLETION_SETTLE_MS = 15s` (env override `GLLA_LIST_COMPLETION_SETTLE_MS`)
- `archiveCurrentGoal` arms `postCompletionSettleUntil = Date.now() + LIST_COMPLETION_SETTLE_MS`
  right after `activateNextListItem` — the next scheduled continuation
  picks up the remaining settle as its delay.
- `scheduleContinuation` reads `postCompletionSettleUntil` and applies
  `max(requested, settleRemaining)` to the timer; ledgers
  `list_completion_settle_pending`.
- `dispatchStartAcknowledged` (called on `message_update`/`agent_start`/
  `turn_start`/`before_agent_start`) clears the settle AND cancels the
  pending timer (`clearContinuationTimer` + `continuationScheduledFor = null`)
  when pi shows real activity, ledgers `list_completion_settle_cleared`.
  The clear runs BEFORE the `pendingContinuationDispatch` guard so
  wake-up activity cancels even when no dispatch is yet in flight.
- `sendContinuation` resets the flag to 0 so a later, unrelated
  continuation is unaffected.

Net effect: the common case (pi settles in <15s and starts a turn on
its own) is unaffected; the failure case (pi doesn't start a turn) gets
15 more seconds to do so before the 30s watchdog kicks in, and the
queue self-recovers. Total time bound: 15s settle + 30s first-window
+ 60s retry backoff = ~105s (vs the previous ~90s — a 15s tax for a
specific failure mode).

## Problem 2 — "29/28 pass" cosmetic bug

The completion summary line `bun test → 29/28 pass, 0 fail, 75 expect() calls.`
violates pass ≤ total — 29 cannot pass in a 28-test suite. The agent
generated the string; the plugin persisted it verbatim.

### Fix

`validateCompletionSummary(text, ctx)` scans for two impossible-count
shapes:
- `(\d+)/(\d+) pass` — X passed, Y total, where X > Y.
- `(\d+) tests, (\d+) passed` — same shape, written out.

On a hit, ledgers `completion_summary_impossible_count` with the flags
and a 240-char excerpt, and appends an honest `NOTE: Counts appear
inconsistent: X passed vs Y total.` to the recap so the user + the
detached auditor see the discrepancy. Clean input (X ≤ Y, or no count
pattern) is returned untouched — no false-positive NOTE on working
summaries.

The helper is called once at capture time in `complete_goal`'s execute,
right before `updateGoal({ completionSummary })` persists the recap.

## Tests

- tests/image1-list-stall-and-count-fix.test.ts (new, 9 tests):
  - constant + flag exist; archiveCurrentGoal arms the window in the
    correct order (advance → arm, so the scheduled continuation picks
    up the delay);
  - scheduleContinuation honours `settleRemaining`;
  - agent activity during settle cancels the deferred timer (clear runs
    BEFORE the pending-dispatch guard);
  - sendContinuation resets the flag;
  - validateCompletionSummary exists and is wired into the capture
    site; field regex matches "29/28 pass" with the right math;
  - canonical ledger key `completion_summary_impossible_count`;
  - clean input early-returns before any ledger work.

## Ship

- version 0.34.104, CHANGELOG entry, tag v0.34.104, symlink
  v0.34.104-IMAGE1-LIST-STALL-AND-COUNT-FIX.md →
  IMAGE1-LIST-STALL-AND-COUNT-FIX-2026-08-08.md,
  this doc carries the literal `verification:` marker.