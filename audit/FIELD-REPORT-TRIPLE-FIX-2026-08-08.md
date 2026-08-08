# FIELD-REPORT TRIPLE FIX — 2026-08-08 (v0.34.102)

Three field reports from pully/dracon-platform sessions (screenshots
090206/090343/091828) investigated to root cause and fixed as one batch.

verification: bun test tests/subagent-hang-detection.test.ts tests/display.test.ts tests/retry-bounds.test.ts → 116 pass / 0 fail; full suite 1125 pass / 1 skip / 0 fail; npx tsc --noEmit clean; version 0.34.102.

## Report 1 (090206, pully) — "auditor says executing but seems stuck"

Ledger forensics: subagent `aac4ab1e-6ec4-46b` (general-purpose, "W161
rehearsal verification") spawned 08:15:33, wedged the parent 118 minutes
until the user manually quit at 10:13:31. `zombie_run_suspected` fired every
10m (streamSilentMs 20m → 110m, `pending:false`), `wedge_alert` at 30/60/90m
(`subagentWait:true`) — but `subagent_hang_detected` fired ZERO times.

Root cause: `classifyHungSubagents` (goal.ts:2029) skipped probes when
`getRecord(id)` returned undefined (`if (!rec) continue` — comment at
goal.ts:1968 claimed "falls back to event-only evidence", but no such
fallback existed). The pinned test subagent-hang-detection.test.ts:136
("vanished record is skipped (no false positive)") encoded the blind spot.

Fix (goal.ts):
- `SUBAGENT_HANG_EVENT_ONLY_MS = 20 * 60_000` — longer than the 5m
  record-frozen threshold so healthy children without a pollable record
  aren't false-positived, but wedged children with zero event evidence
  are caught.
- When the manager record is unreachable, classify on the probe's own
  event-derived `lastProgressAt` (spawn seed + compacted/steered refresh)
  against the 20m window. Ended probes are still skipped.
- Hang alerts/ledger distinguish `evidence: "record-frozen"` (record still
  pollable) vs `"event-only"` (record unreachable), with matching wording.
- Detection-only preserved (v0.34.85 design): the main session decides
  whether to abort; the watchdog never auto-kills.

Tests: updated the pinned vanished-record test to expect event-only
classification; added threshold coverage (stale = hung, young = not,
ended-with-no-record = skipped) and an integration test asserting the
`evidence: "event-only"` ledger + warning wording.

## Report 2 (090343, dracon-platform) — "working while displaying paused"

Field shape: goal parked on `main_model_recovery_wait` (retryAt 10:00,
attempts 2) while the rearm storm (streak 19) was actively firing. The
widget head chip rendered `⏸ paused` — contradicting the status line's
`⏳ auto-retrying`.

Fix (goal-loop-display.ts):
- New `recovering` detection: paused + `state.mainModelRecovery.retryAt`.
- Widget head chip: `⏳` + "recovering" (dim) instead of `⏸ paused`.
- Card body: "parked on provider wall — no turns until quota reset at
  HH:MM" (mirrors the v0.34.95 queued-envelope wording so both surfaces
  agree).
- Status line parked branch: replaces the "auto-retrying" promise (which
  read as a live retry) with "⏳ parked on provider wall — no turns until
  quota reset at HH:MM". Plain wait pauses WITHOUT mainModelRecovery keep
  the uniform v0.34.64 auto-retrying shape.

## Report 3 (091828, dracon-platform) — "pi did not start a turn"

Field shape: `send_rearm_start` 09:00:01 → storm streak 19 at 09:02:26 →
escalated 09:03:26 → NO `continuation_dispatch_accepted` until 10:11:33
(68 minutes). `continuation_unanswered` never fired because it requires
`lastContinuationSentAt > 0` (goal.ts:2220) — never set while the send
path is quota-gated by the recovery park.

Fix (goal.ts, `accountSendRearm` storm milestone):
- Detect no-accepted-dispatch since the storm began
  (`lastContinuationSentAt === 0 || lastContinuationSentAt <
  continuationRearmSince`) and surface `rearm_no_turn_started` (ledger +
  notify), throttled per storm milestone window (2m/5m/10m) via
  `lastNoTurnStartedNotifiedAt`.
- Message names the provider wall and the automatic recovery probe, so the
  68-minute silence is explained instead of looking like a bug.
- SRC-pin added in retry-bounds.test.ts (E3).

## Ship

- version 0.34.102, CHANGELOG entry, tag v0.34.102, symlink
  v0.34.102-FIELD-REPORT-TRIPLE-FIX.md → FIELD-REPORT-TRIPLE-FIX-2026-08-08.md,
  this doc carries the literal `verification:` marker.
- Full suite: 1125 pass / 1 skip / 0 fail (100 files); tsc clean.
