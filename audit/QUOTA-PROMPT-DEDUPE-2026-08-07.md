# Never spam the chat — quota-wall prompt once per parked episode

Date: 2026-08-07 · Version: 0.34.90 · Type: field bug fix (chat spam)

## The report

User (endless-td session, Screenshot_20260807_231717): "triage is spamming in
the chat" — the chat showed **four nearly identical "Provider quota wall —
[TRIAGE-2026-08-06 findings.md:591] …" messages**, plus the triage widget card
rendered inline. Driving principle stated by the user: **"we should never spam
in the chat."** Asked what "the problem with the triage" was, the user
answered: "that the messages ended up in the chat."

## Forensics (endless-td `.pi-glla/active.jsonl`)

```
01:46:20 scheduled → 02:00 · 02:00 sent · 02:05:42 scheduled → 03:00
09:19:50 scheduled → 10:00 · 09:20:57 → 10:00 · 09:25:32 → 10:00 · 09:35:52 → 10:00   (no send — sessions died)
12:13/12:14/12:17 scheduled → 13:00
17:00:22 scheduled → 18:00 · 17:08:52 scheduled → 18:00
18:00 sent · 18:03:26 scheduled → 19:00 · 19:00 sent · 19:15:26 scheduled → 20:00
20:00 sent · 20:15:26 scheduled → 21:00 · 21:00 sent · 21:15:26 scheduled → 22:00
```

Two independent spam mechanisms:

1. **Hourly repeat within one parked episode.** The 18:03/19:15/20:15
   re-schedules are the same triage goal re-parking after an auto-recovery
   flap (probe succeeds → goal runs minutes → wall again). Each fresh park
   re-armed the next :00 prompt. The old in-memory guard
   (`quotaPromptScheduledFor !== null`) only covers one session at one
   moment; nothing was durable.
2. **Cross-session bunching.** Several pi sessions on the same project each
   park independently and each schedule their own prompt for the same :00 —
   the 09:19/09:20/09:25/09:35 quadruple and the 17:00/17:08 double.

Also found in the same screenshot: a **redundant double notification** —
pi's own complete_goal tool response ("Completion claim persisted… detached
auditor queued") immediately followed by our `ctx.ui.notify("Auditor queued
(detached worker, model: …)")` saying the same thing.

## Fix shape

### 1. Durable, cross-session, once-per-episode dedupe (the goal marker)

- `quota_prompt_scheduled` / `quota_prompt_sent` ledger events now carry
  `goalId` (or `loopTarget`) and `episodeAt` (`mainModelRecovery.firstFailureAt`).
- `scheduleQuotaResumePrompt` scans the shared ledger before scheduling:
  - a pending `quota_prompt_scheduled` for the same key **and same `fireAt`**
    → a peer session already holds this :00 slot → stand down (kills the
    bunching);
  - a `quota_prompt_sent` for the same loop key while the loop is parked →
    already prompted (loop case).
- NEW persisted Goal field **`quotaPromptedAt`** (ISO). Set when the prompt
  actually sends. While set, **no schedule is accepted for that goal — in
  any session** — even if auto-recovery flaps. Cleared ONLY by a **user
  resume**: `cmdResume`'s probe branch, the paused→active transition, and
  `manuallyResumeMainModelRecovery`. Auto-recovery success
  (`mainModelRecoverySucceeded`) does NOT clear it — that is precisely the
  flap path that produced the hourly repeat.
- `fireQuotaResumePrompt` marks the goal only when the parked goal is still
  the one captured at schedule time (`state.goal.id === goalId`).

Field replay: 18:00 send marks the goal → 18:03 flap re-park is silent →
19:00/20:00/21:00 never send → user comes back, `/list resume` clears the
marker → a wall after that gets exactly ONE prompt. Sessions 2..N see the
marker on the restored goal and schedule nothing.

### 2. One notification per state transition

- Removed the redundant `"Auditor queued (detached worker, model: …)"`
  info-notify from the complete_goal path. pi's own tool response already
  reports the durable claim + detached auditor; the widget/status line show
  `auditor: queued/running/live`. The `"Auditor model issue"` warning stays
  (unique failure info).
- The quota-wall prompt itself is now at most one message per parked episode
  per user-resumed cycle — never per hour, never per session.

## Tests

`tests/quota-prompter.test.ts` +3 (file now 9 tests):

- **hourly repeat is dead**: wall → prompt sent (marker set) → auto-recovery
  success → wall again → nothing scheduled, still exactly one message.
- **peer session same-:00 slot**: session A schedules; fresh module state
  (simulated second session) attempts the same slot → ledger scan stands it
  down; one schedule on disk, zero messages.
- **user resume re-arms**: wall → sent → flap → `/goal resume` (probe
  branch) clears the marker → hours later a fresh wall schedules exactly one
  new prompt → two messages total across the whole story.

Test-order hardening discovered during the run: the stall-brake counters
(`heartbeatNudges`, `consecutiveStalls`, `heartbeatStaleStreak`) are module
globals that leak across files in bun's single-process test run. Short
no-tool "back up" turns in earlier tests accumulated nudges and tripped a
bogus "stalled" **decision-pause** (no recovery envelope) on the resumed
goal mid-test — which then silently skipped the next park (a paused goal is
not supervising). New `__testOnlyResetStallState()` hook, called from the
file's beforeEach — same class of fix as `__testOnlyResetOwnerSession()`.

Suite: **1093 pass / 1 skip / 0 fail across 100 files**, tsc clean.

## Files touched

- `extensions/loops/goal.ts` — schedule/fire dedupe + marker, ledger fields,
  ledger scan (`quotaPromptAlreadyCovered`), clear sites (cmdResume probe
  branch, paused→active transition, manual recovery), notify removal,
  `__testOnlyResetStallState`.
- `extensions/goal-loop-core.ts` — `quotaPromptedAt?: string` on Goal.
- `tests/quota-prompter.test.ts` — 3 new tests + stall-state reset.
- `CHANGELOG.md`, `package.json` → 0.34.90.

## Left as-is (by design)

- The widget card renders in the chat via pi's own widget surface — it is a
  passive, in-place-updating panel, not a message we send; not touched.
- The `"List item #N activated (M remaining)"` notify stays for explicit
  activation (cascade auto-advance was not reported as spam; the queue is
  visible via `/list`).
- Loop re-schedules after a user `/loop resume` are allowed (sent-dedupe
  keys on the loop being parked); loops have no durable marker field.
