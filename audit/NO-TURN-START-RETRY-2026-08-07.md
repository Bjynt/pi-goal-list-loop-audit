# No-turn-start retry — v0.34.88 (closes note.md "pi did not start turn")

Field: `chat/pi/note.md` — "pi did not start turn" (Screenshot_20260806_224604.png).
A continuation was accepted by the enqueue, the goal stayed active, but pi never
started the turn — no `before_agent_start` proof. The v0.34.74 handling waited
150s and then declared the dispatch unacknowledged, which requires the user to
run `/list resume` (or `/goal resume`) by hand. Transient misses (turn-start
event lost, busy session, mid-compact race) looked identical to a genuine
provider stall, so every miss cost a manual recovery.

## Design

Two changes in `extensions/loops/goal.ts`:

1. **First window 150s → 30s** (`CONTINUATION_START_TIMEOUT_MS`, env override
   `GLLA_CONTINUATION_START_TIMEOUT_MS` unchanged).
2. **Exactly ONE automatic retry with backoff**: when the first window expires
   and the compaction-rearm branch (v0.34.57) doesn't apply, the watchdog
   re-sends the **verbatim original payload** and re-arms for a 60s backoff
   window (`NO_TURN_START_RETRY_BACKOFF_MS`). Only after the second window does
   it declare `continuation_start_unacknowledged` and hand over to the explicit
   `/list resume` / `/goal resume` / `/loop resume` fallback. Worst case before
   the fallback: 30s + 60s = 90s, still under the old single 150s window.

Retry safety:
- **Exactly one** — `record.retryCount` (persisted in the dispatch sidecar,
  `ContinuationDispatch.retryCount?` / `retrySentAt?` in
  `extensions/goal-loop-dispatch.ts`, no protocol version bump) gates the
  branch: `if (!record.retryCount && retryContinuationDispatch(current, record)) return;`.
- **Verbatim** — `lastContinuationSentPayload` captures `{ content, display }`
  at every send site (goal, stall, length-continue, loop; cleared in
  `clearContinuationStartWatchdog`), so the retry is the original continuation,
  not a freshly-built one that could re-resolve a changed goal state.
- **Actionability guards** — a paused goal/stopped loop is never blind-retried
  (the pause clears the watchdog entirely via
  `releaseContinuationDispatchStandDown`); a skipped/failed retry falls through
  to `dispatchStartUnacknowledged` immediately (fail closed, never loop).
- **Ledger** — `continuation_retry_sent` (with `retryCount` + mutated
  `timeoutMs`) / `continuation_retry_send_failed`; the unacknowledged event now
  mentions the retry and the real elapsed time.
- **Test hooks** — `__testOnlySetContinuationRetryBackoff(v|null)`.

## Files

- `extensions/loops/goal.ts` — constants, payload capture at 4 send sites,
  `retryContinuationDispatch`, watchdog retry branch, updated unacknowledged
  wording/comments.
- `extensions/goal-loop-dispatch.ts` — optional `retryCount`/`retrySentAt` on
  `ContinuationDispatch`.
- `tests/behavioral-orchestrator.test.ts` — 3 existing watchdog tests updated
  (one automatic retry now precedes unacknowledged: `pi.sent` 1→2, resume 2→3)
  + 3 new tests: transient miss self-heals (verbatim retry, settles on start
  proof, no unacknowledged); genuine stall (exactly one retry then
  unacknowledged, `interruptedAt` while status stays active); paused goal never
  blind-retried (pause before T1 → sent stays 1, no retry/unacknowledged
  ledger).
- `tests/loops/goal.test.ts` — v0.34.57 watchdog tests now set the retry
  backoff override; added `__testOnlyResetOwnerSession` to afterEach + test
  starts so the file is order-independent (a previous file's recorded owner
  used to make the foreign-session guard drop the startup event and the goal
  command silently).
- `tests/stall-handling.test.ts` — source pins updated: `?? 30_000`,
  `NO_TURN_START_RETRY_BACKOFF_MS = 60_000`, the one-retry branch.

## Verification

- Suite: **1090 pass / 1 skip / 0 fail across 100 files** (was 1087/1/0).
- `tsc --noEmit` clean.
- Pair-run regression: `behavioral-orchestrator` + `loops/goal` together
  (previously green only in canonical suite order — foreign-session guard
  dropped the loops startup after any file that bound a session owner).
