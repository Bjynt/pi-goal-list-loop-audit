# QUOTA WALL removed from the display; blocked pauses auto-clear (v0.34.64, 2026-08-07)

## The incident (screenshot 20260807_090138, dracon-platform/web)

The user came back from sleep to a parked goal. The card said:

    QUOTA WALL · provider quota wall · 4 waiting in list
    automatic retries stopped · manual resume required
    awaiting first turn — resumes exactly here

But the durable state told the truth: the quota had ALREADY recovered at
`05:07:43Z` (`main_model_recovered`, mainModelRecovery → null). The card
was lying on two counts:

1. **`isQuotaWall()` false positive.** The pauseReason the goal was parked
   on was the agent's own past-tense narration: *"Quota recovered, but the
   two contract blockers from my previous pause are unchanged…"* — the
   wall-detector regex matched the literal word "quota" inside "Quota
   recovered". Past-tense narration tripped the active-wall detector.
2. **Blocked pauses never auto-cleared.** The goal was paused with
   `pauseKind === "blocked"` (the agent authored the block), and
   `mainModelRecoverySucceeded` only resumed pauses with `pauseKind ===
   "wait"`. So even after the recovery cleared, the blocked pause stuck.

The user's direction was explicit: *"we dont want a quota wall at all, we
are just retrying a lot and retry after every starts of an hour"* and
*"manual resume is the exact wrong idea — we want to keep going"*.

## What shipped

1. **The QUOTA WALL display concept is removed** (`extensions/goal-loop-
   display.ts`). The wall banner, the "manual resume required" wording,
   and `isQuotaWall` / `quotaWallDetail` / `quotaResumeText` are deleted.
   Every retry-class pause (wait or blocked with a recovery timer) renders
   the same uniform line: `auto-retrying · next probe in X` — quota,
   billing, 429, transient, whatever. The durable reason stays in state +
   ledger for forensics; the card never claims a wall exists. Manual-resume
   nudges ("resumes X — or /goal resume now") are gone from the card; the
   sidebar badge reads `⏳ auto-retrying · auto-retry in X` for waits and
   `⏸ action needed` for blocked-without-timer.
2. **Blocked pauses auto-clear when the underlying condition resolves**
   (`extensions/loops/goal.ts`, `mainModelRecoverySucceeded`). The
   `recoveryPause` check now accepts `pauseKind === "blocked"` (previously
   only "wait") when the pauseReason starts with a quota-style indicator
   (main model recovery / quota / provider quota / rate limit / Token Plan /
   insufficient / credits / billing). autoResume:true honors "keep going" —
   a blocked pause authored in response to the wall is un-parked and
   re-engaged once the wall is gone. Decision/error pauses (intentional
   user action) are still never auto-cleared, and a blocked pause with a
   NON-quota reason stays blocked (we never override agent intent for a
   non-quota cause).

## Files

- `extensions/goal-loop-display.ts` — wall functions deleted; uniform
  auto-retrying card + sidebar badge.
- `extensions/loops/goal.ts` — `isQuotaPauseReason` + broadened
  `recoveryPause` (accepts blocked).
- `tests/blocked-pause-autoclear.test.ts` — 4 new tests (blocked+quota
  auto-clears; blocked+non-quota stays; wait+quota regression guard;
  source guard).
- `tests/display.test.ts` / `tests/uniform-provider-retry.test.ts` /
  `tests/mode-command-guidance.test.ts` / `tests/stall-handling.test.ts` —
  pins updated to the uniform auto-retrying shapes.

## Gates

`bun test`: 951 pass / 1 skip / 0 fail across 86 files.
`npx tsc --noEmit`: clean.

## Deployment + recovery

Runtime path is the repo symlink (see audit/DEPLOYMENT-2026-08-06.md) —
goes live on the next `/reload`. The STUCK session right now (goal
`20260807021600-hah6wj`): its blocked pause was authored with a quota
prefix ("Quota recovered, but the two contract blockers…"), so after the
reload the recovery-cleared path un-parks it automatically — no manual
`/list resume` needed. Until the reload, `/list cancel` clears it manually.

Note: this fix makes autoResume:true genuinely "keep going" through the
stuck-blocked-on-quota class. It does NOT auto-clear blocked pauses whose
reason is a non-quota agent block (e.g. "contract review required") — those
still wait for the user on purpose.
