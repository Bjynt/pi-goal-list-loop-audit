# Completion/lifecycle field trilogy — v0.38.18 (2026-09-04)

Three field-reported defects, one audited goal (`20260904162433-qm4iq0`),
one patch release. Evidence: endless-td + neonbreak + junk-runner sessions,
screenshots `Screenshot_20260904_152601/153208/153934.png`, grilled seed
`note.md` Now (3 items), user `go` on recommended defaults.

## Track 1 — pipe-syntax checker rejection (endless-td, 152601)

The mechanical pre-audit checker 126-rejected `bun test 2>&1 | tail -n 4`
from the contract line: finished work wedged between the `complete_goal`
fast-fail and a manual `/goal tweak`. Root cause: `isSafeMechanicalCommand`
matched one argv with no pipe grammar, so a POSIX-ordinary
`2>&1 | tail` read as "complex shell (not executed)".

Fix (`extensions/goal-loop-shield.ts`): narrow pipeline support —
`parseMechanicalPipeline` (top-level `|` split outside quotes, `2>&1`
tolerated), `runMechanicalPipeline` (head via `resolveCanonicalRunnerCommand`,
filter stages `tail -n N` / `head -n N` / literal `grep` through piped stdio,
no shell, pipefail-head semantics: pass iff the head exits 0), single retry
mirrors the single-command path, `package.json` scripts hoist fixed, 126
message updated. `tee`/`-f`/`-F`/`-r`/`-i`/`-v`/`-E`/`-P`/`-m`/`--*` still
refused — filters read stdin only and cannot touch files or the network.

Tests: `tests/mechanical-pipeline.test.ts` (7: parse accept/reject,
extraction, green-head pass, head-exit-follows, 126 no-side-effect with a
`tee` probe, grep stdin-only).

## Track 2 — post-answer stall (neonbreak, 153208)

After `ask_user_question` was answered, no continuation turn started: 35
re-arms over 10m, zero-stream abort at 50m. Forensics
(`neonbreak/.pi-glla/active.jsonl`, 919 lines) reversed the blame:

- The creation turn DID start (12:57, gen 8) — `send_rearm_storm streak 35`
  with `rearm_no_turn_started` milestones at 13:02/13:07/13:12 were imprecise:
  a turn was open, it just never streamed (`observedStreamAt` frozen at
  `1788526648444`, `silentMs` growing). No continuation was ever prepared
  for gen 8 — nothing to accept while the silent turn held the session.
- The 13:43/13:45/13:47 `zombie_auto_retry_dispatched` ×3 were a hot loop:
  abort → 90s retry → instant re-detect (same frozen clock) → abort,
  each cycle a full 23k `goal_continuation_sent`. Budget exhaustion parked
  it, but only after 3 futile cycles.
- The provider (minimax free) never streamed a byte; `pi 0.85.0` + GLLA
  `0.38.17` current. Not an aborter defect — a never-streamed turn the
  retry budget should never have been spent on.

Fix (two cuts, no import cycles — `goal-activation → goal-continuation`
direction preserved):

1. `zombieRetryDecision` takes optional `turnStartAt` (default 0 = unknown
   → legacy behavior): `turnStartAt > 0 && observedStreamAt <= turnStartAt`
   returns `{retry: false, neverStreamed: true}`. `scheduleZombieAutoRetry`
   ledgers `zombie_auto_retry_refused_never_streamed` (new event) and skips
   the timer; `abortZombieRun` park copy says "never produced stream
   activity, so no automatic retry was scheduled" instead of promising
   budget retries. `lastTurnStartAt` tracked in `goal-activation.ts` on
   `agent_start`/`turn_start`, reset in `__testOnlyResetZombieAutoRetry`
   (plus `__testOnlySetTurnStartAt` for tests).
2. `dispatchStartAcknowledged` records every begin-marker in
   `lastObservedTurnStartAt` (goal-continuation side, no new imports); the
   rearm milestone reports "a turn started Nm ago but no continuation was
   accepted since (N re-arms)" with `turnOpen`/`turnOpenMinutes` ledger
   fields when a turn began after the storm started, keeping the legacy
   "no turn started" only when none did.

Tests: `tests/never-streamed-standdown.test.ts` (4: pure refuse/allow/
unknown, open-turn message, legacy message, behavioral abort-once-parks
driven through the real `turn_start` handler via `pi.fire` — no retry
scheduled, park holds through the retry window, park copy names the cause).

## Track 3 — stale waiting-verdict (junk-runner, 153934)

The screenshot shows the defect precisely, and it is NOT the widget (gated
on `status === "auditing"`, fenced correctly): the main agent answers "how
are we looking" with "waiting on the auditor's verdict for the audit-pass
goal" AFTER `goal_archived complete`. The transcript's last word was the
`complete_goal` tool result — "Completion claim persisted; detached auditor
queued… The verdict will be applied asynchronously" — and the verdict-apply
path (`goal-auditor-hooks.ts` approved branch) closed with only a toast
(`ui.notify`) + pager (`notifyExternal`). Toasts are ephemeral; the
transcript never learned the goal completed, so the agent truthfully
re-narrated stale state. In-turn paths (`goal-tools.ts` manual/no-audit)
already return the outcome as the tool result — only the detached async
settle stranded the transcript.

Fix: `sendTerminalCompletionNotice` (`goal-continuation.ts`) delivers the
`✓ done` brief INTO the conversation as a `followUp` turn — goal-null-safe
(the goal is archived when it fires), fire-once per goal via a durable
`terminal_completion_notice_sent` ledger fence (`readLedgerTail`, survives
reloads), fenced like every automatic send (pause/recovery/handoff/stale/
zombie/foreign/extensionApi). Wired into the detached-approval branch only
for async origins (`origin !== "manual"` — `/goal verify` runs inside a
turn whose command output already closes the transcript). Payload ends
with "nothing further is owed. Acknowledge briefly; start follow-up work
only if asked." so the woken turn closes, not works.

Tests: `tests/terminal-completion-notice.test.ts` (2: behavioral send-once
— `pi.sent` grows by exactly one carrying `✓ done` + outcome + closer,
second settle refused, per-goal independence — plus a source pin on the
wiring and the manual-origin skip).

## Verification

- 1 MockPi regression test per track (fail-before by construction: each
  exercises a symbol/behavior absent pre-fix — new pipeline exports, the
  `neverStreamed` decision/message/ledger event, the terminal-notice
  sender + wiring).
- `TMPDIR=/var/tmp npm run release:check` green, `npx tsc --noEmit` clean.
- `docs/INDEX.md` trail + `CHANGELOG.md` + `audit/INDEX.md` updated with
  the version bump in the same commit (v0.38.16 lesson); tag `v0.38.18`,
  publish, `npm view` verified.
