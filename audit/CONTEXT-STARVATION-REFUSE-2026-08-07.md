# Context-starvation refuse gate (v0.34.82)

## Symptom

Screenshot `Screenshot_20260807_165055.png` (this user, 2026-08-07 16:50:55):
terminal footer shows `CH98.3% $5.585 118.6%/200k`, six repetitions of
`Heartbeat: supervisor active but session stalled — re-firing continuation
(stall 1/5).` and `Response was truncated before completion.`, then a single
`glla: output-token stop was context starvation (tiny output at a nearly full
context) — yielding to pi auto-compaction instead of re-sending.`, and
finally the user runs `/compact` manually — only after which a real
`session_compact` event lands.

Without manual intervention, the session drained from 98% to 120.7% across
the six retries (`.pi-glla/active.jsonl` records
`length_continue_deferred_context_full` at
`contextPercent: 98.082, 100.135, 102.188, 104.241, 106.294, 108.347,
110.4, 112.453, 114.506, 116.559, 118.612, 120.683`).

## Root cause

Two independent defects combined to produce the freeze:

1. **Disabled auto-compaction in user-level settings** —
   `~/.pi/agent/settings.json` had `"compaction": { "enabled": false,
   "reserveTokens": 100000, "keepRecentTokens": 20000 }`. With
   `enabled:false`, pi's `_checkCompaction` short-circuits at
   `agent-session.js:1511-1513` and never fires `session_compact`,
   regardless of how full the context is. The `reserveTokens: 100000`
   would have made compaction only kick in when the session was already
   almost out of room even with `enabled:true` — the high reserve was
   masking whatever the user intended the flag to do.

2. **The plugin's heartbeat kept refiring full turns against the
   uncompacted context** — `agent_end` correctly yielded (no premature
   1-token send; v0.34.19 `length-continue.ts:42-80`). But the 60s
   heartbeat's `scheduleContinuation` did not know that compaction was
   effectively off, so it kept queueing a fresh `[GOAL CHECKPOINT ...]`
   full turn against the same near-full context. The new turn truncated
   with 1 output token. The yield path wrote another
   `length_continue_deferred_context_full` ledger record. The 60s
   heartbeat refired again. The cycle ran until the user noticed the
   `118.6%` and the `auditor verdict: disapproved` notification, then
   `/compact` triggered a real compaction.

The deferred context path itself is **not** a defect: yielding to pi
auto-compaction is the right behavior when the model returns
`stopReason:"length"` with `output:1` at ≥ 90% context, because sending
`LENGTH_CONTINUE_TEXT` would queue another 1-token request and delay the
real cure. The deferred path is correct; the gap was that the heartbeat
did not know compaction was not coming.

## Fix (v0.34.82)

### Code

`extensions/loops/goal.ts`:

- New `contextStarvedStreak` counter + `lastContextStarvedAt` timestamp
  with a 90s window.
- `noteContextStarvedYield()` is called from the agent_end yield path; it
  increments the streak when called within the window, resets it otherwise,
  and reports whether the threshold is met.
- `isContextStarvedRefused()` returns true when the streak ≥ 2 AND no
  `session_compact` has landed after the streak started. Cleared by
  `onCompactionLanded()`.
- The heartbeat's refire branch gates `scheduleContinuation` /
  `scheduleLoopTick` behind `!isContextStarvedRefused()`. When refused,
  it ledger-records `continuation_refused_context_starved` and posts a
  one-shot `ctx.ui.notify` explaining the failure mode and the two
  recoveries: `Run /compact once` or `set compaction.enabled:true in
  ~/.pi/agent/settings.json`.
- The session_compact hook calls `onCompactionLanded()` so a real
  compaction clears the streak and the heartbeat resumes its normal
  refire on the next 60s tick.
- The yield-path ledger record now carries `starvedStreak` for postmortem.

### Settings

`~/.pi/agent/settings.json`:
- `compaction.enabled: false → true`
- `compaction.reserveTokens: 100000 → 16384` (pi default; reserves one
  full response budget for the model, so the trigger is realistic)
- `compaction.keepRecentTokens` left at `20000` (already correct)

`globalContextLimit: 200000`, the `enabledModels` list, `retry.*`, the
packages list, and the rest of the file are untouched.

## Test

`tests/stall-handling.test.ts` (+1):
- pins the threshold constant and the window
- pins the yield-path ledger carries `starvedStreak`
- pins the heartbeat gate precedes the refire schedule
- pins the one-shot notify text and the refusal ledger event
- pins that `session_compact` clears the streak so the heartbeat resumes

## Suite status

`bun test` → 1062 pass / 1 skip / 0 fail across 99 files (was 1061/1/0;
+1 for v0.34.82). `npx tsc --noEmit` → only the expected `bun:test` types
warning.

## Why a refuse gate, not a hard fail

A "compaction is off" configuration is legitimately useful for some
sessions (manual `/compact` cadence, deliberate work to keep the whole
history). v0.34.82 does not block the deferred-context path — yielding
is still safe and right. It only blocks the heartbeat's *refire* of a
full continuation against an uncompacted context, because that is the
specific shape that drains the session. Users who genuinely want
manual-only compaction can either (a) flip the flag back off and live
with the warning + the implicit cap (the heartbeat will not refire
forever; the goal will sit paused on whatever condition drove the
starvation), or (b) keep `enabled:true` and accept pi's default cadence.

## What I did NOT change

- `length-continue.ts:42-80` `isContextStarvedLengthStop` — correct, do not
  touch.
- `extensions/loops/goal.ts:9997-10016` (the agent_end yield path) —
  correct as written; v0.34.82 only adds an `appendLedger` field
  `starvedStreak`.
- `extensions/loops/goal.ts:9386-9440` (session_compact hook) — the only
  addition is a single `onCompactionLanded()` call right after the
  existing `lastCompactionAt = Date.now()`.
- pi itself — no upstream change is required; the default pi 0.84.1
  `_checkCompaction` correctly fires auto-compaction when the user
  enables it.
