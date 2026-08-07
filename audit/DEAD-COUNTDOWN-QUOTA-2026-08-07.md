# Dead-countdown quota wall + hour-aligned probes (v0.34.63, 2026-08-07)

## The incident (screenshot 20260807_021856, dracon-platform/web)

The user's session showed the QUOTA WALL card with a countdown that would
never fire:

    QUOTA WALL · provider rate limit · 4 waiting in list
    waiting — nothing for you to do · next probe in 14m 07s
    awaiting first turn — resumes exactly here

Ledger timeline (all UTC; screenshot 02:18:56 local = 01:18:56Z):

- `01:02:36Z` list item "Refresh the Studio-vs-vidIQ audit doc"
  (`20260807010236-0a0akx`) auto-activated; continuation sends rearm
  (streak 19 → 25 → 35) while pi held the provider retry.
- `01:18:01Z` `main_model_recovery_wait` `{retryAt: 01:33:01, attempts: 1,
  reason: "main model quota: 429 rate limit: pi held the provider retry
  with no stream activity"}` + `quota_prompt_scheduled {fireAt: 02:00:00Z}`
  (the v0.34.58 hourly prompter DID schedule at :00 — that part worked).
- `01:18:06Z` user quit pi → fresh process → blank `startup` (load barrier
  pends: `session_waiting_for_load`) → `resume` at 01:18:17Z.
- **The resume was silently DROPPED.** The ledger ends at
  `session_rebound {reason: "startup"}` — no `session_rebound` for
  "resume", no `rebind_resume`, no probe at 01:33:01, no probe ever.
  Durable state still showed `retryAt: 01:33:01, attempts: 1` days later.
  The card rendered the frozen countdown forever; only a manual
  `/list resume` recovered the item.

## Root cause (reproduced in the harness, `tests/recovery-restore-after-restart.test.ts`)

The session_start foreign gate:

    const sameOwnerStart = ownerSession !== null && ctx.sessionManager === ownerSession;
    ...
    if (foreignRecordedSession && !hostLifecycleStart) return;

pi delivers the resumed session with a NEW SessionManager OBJECT (quit →
fresh pi → blank startup claimed the plane with manager A → resume arrives
with manager B). Object identity fails; `isHostSuccessorCtx` (file-backed
check via `getSessionFile()`) can also fail when pi delivers the manager
before its session file is set. The lifecycle event was then refused as
foreign — even though this process was EXPLICITLY waiting on the load
barrier (`initialSessionLoadPending`) for exactly that session.

## The fix (v0.34.63)

1. **Barrier-completing resume** (`extensions/loops/goal.ts`, session_start
   gate): while the load barrier is pending AND the event carries a
   lifecycle reason AND the cwd matches the recorded owner AND
   `sameSessionIdentity` (equal `getSessionId` — new helper, fail-closed
   for in-memory/unknown managers) — the event IS the load completing.
   Accepted before the foreign gate. Different session ids (worker, or a
   different session file) stay refused.
2. **Hour-aligned probes** (`extensions/main-model-recovery.ts`):
   `mainModelFailureDelayMs` now returns the delay to the next :00 of the
   LOCAL clock hour instead of the 15m→30m→1h… ladder (which from a 01:18
   wall probed 01:33/02:03/02:33 — mid-hour every time; quota windows reset
   on the hour). Kind-independent (v0.34.51 uniform envelope preserved);
   upstream Retry-After hints still win when ≤ 5h; the attempt counter no
   longer shapes the delay. `mainModelRetryDelayMs` (the ladder) survives
   as the no-model-ref fallback + settings knob.
3. **Wall wording** (`extensions/goal-loop-display.ts`): `auto-retrying ·
   next probe in …` replaces `waiting — nothing for you to do`.

## Files

- `extensions/loops/goal.ts` — `sameSessionIdentity` + gate change.
- `extensions/main-model-recovery.ts` — `hourAlignedRetryDelayMs` +
  `mainModelFailureDelayMs` semantics (optional `nowMs` for tests).
- `extensions/goal-loop-display.ts` — countdown wording.
- `tests/recovery-restore-after-restart.test.ts` — 3 new tests (incident
  reproduction incl. probe-fire proof; different-id refusal; source guard).
- `tests/main-model-recovery.test.ts` / `tests/uniform-provider-retry.test.ts`
  / `tests/display.test.ts` — pins updated to hour-aligned semantics.

## Gates

`bun test`: 947 pass / 1 skip / 0 fail across 85 files.
`npx tsc --noEmit`: clean.

## Deployment + recovery

Runtime path is the repo symlink (see audit/DEPLOYMENT-2026-08-06.md) —
goes live on the next `/reload`. The STUCK session right now: run
`/list resume` in the dracon-platform/web tab (the item is parked with a
dead timer; resume retries immediately and starts a fresh window). After
the reload, the same quit→restart→resume sequence restores the probe
automatically and the probe fires at the next :00.
