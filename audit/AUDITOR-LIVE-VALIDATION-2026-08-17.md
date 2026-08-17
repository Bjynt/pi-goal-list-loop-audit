# Auditor/no-verdict live validation — 2026-08-17

## Objective and evidence boundary

This pass validates the six failure/lifecycle edges named by the active list
item: fresh session, reload, forbidden primary, recoverable provider error,
worker timeout, and host-handle swap. The live observations below are read
from the repository's durable `.pi-glla/active.jsonl` ledger; the focused
regressions exercise the same production paths with isolated temporary
projects. The two evidence classes are kept separate: a temporary test
ledger is not presented as a new production incident, and the historical
silent-host sequence remains labeled as correlated evidence.

The validation target is not "every failure becomes active". A truthful
surface means that a running detached worker can say LIVE only with fresh
worker activity, a stalled/no-verdict worker says quiet or blocked, and a
fresh host says resumed/rebound rather than silently dropping the durable
claim.

## Validation matrix

| Case | Exercise and raw durable evidence | Truthful UI/status projection | Regression added in this pass |
|---|---|---|---|
| **Fresh session** | Real ledger: `session_rebound {reason:"startup"}` at `2026-08-17T20:53:18.459Z`, followed by `session_waiting_for_load {reason:"startup"}` at `20:53:18.520Z`; the parked audit was reclaimed by `audit_recovery_auto_retry_claimed {trigger:"host-rebind"}` at `20:53:26.686Z` and a new `audit_started {origin:"session-recovery"}` at `20:53:26.689Z`. Focused test also proves a normal startup with no stale debt emits `0` `stale_continuation_rearm_armed` and `0` `stale_continuation_rearmed`. | A valid successor clears the stale park and resumes the stored work. The no-progress case is not painted LIVE: it remains an active/recovery state until worker evidence arrives. | `tests/host-session-lost.test.ts`: `a normal fresh session does not fabricate stale continuation debt`. |
| **Reload** | Real ledger: `session_rebound {reason:"reload"}` at `2026-08-17T20:51:06.264Z`, `rebind_resume` at `20:51:06.415Z`, then three accepted/sent/acknowledged continuation dispatches at `20:51:06.967Z`, `20:51:24.618Z`, and `20:51:35.659Z`. The explicit-boundary regression writes `session_shutdown {reason:"reload"}` and proves no `session_handle_invalidated` is emitted. | The reload handoff is a lifecycle boundary, not a silent host loss: the status remains resumable/active and does not show the stale-handle warning. | `tests/host-session-lost.test.ts`: `an explicit reload boundary is durable and does not masquerade as host loss`. |
| **Forbidden primary** | The isolated resolver fixture configured `test/forbidden` as the auditor primary and `test/fallback-1` as the fallback. The selector skipped the primary, selected the fallback, and appended one durable fixture row: `{"type":"auditor_model_fallback","value":{"configured":"test/forbidden","reason":"forbidden"}}`. No warning was emitted. The production ledger separately contains six historical `forbidden_model_switch` rows; those are not mislabeled as auditor-primary evidence. | Forbidden intent is skipped silently for execution, while the goal card can show `skipped forbidden: <ref>` and the handled fallback separately. No forbidden worker is launched and no approval/disapproval is fabricated. | `tests/auditor-fallback-unification.test.ts`: `a forbidden auditor primary is skipped before the configured fallback and remains silent`. |
| **Recoverable provider error** | Real ledger: `audit_infra_retry` occurs twice for the stored auditor claim at `2026-08-12T22:01:01.451Z` and `22:01:11.979Z`, each preserving a diagnostic and the display projection `provider infrastructure error`; the related state is `pauseKind:"wait"` with a bounded retry. Focused fallback exercise calls the same candidate twice, waits exactly `5,000 ms`, and returns `approved:false`, `disapproved:false` with the second provider error. | While retrying, the claim is shown as infrastructure recovery/parked no-verdict with an automatic retry action; it is never shown as an auditor disapproval or approval. | `tests/auditor-eager-retry.test.ts`: `eager: a second recoverable provider error remains infrastructure after the one retry`. |
| **Worker timeout** | Real ledger: attempt `audit-msxjogl9-4c1ecj` emitted `auditor_stalled` at `2026-08-17T18:23:18.596Z` with `reason:"heartbeat-no-progress"`, `heartbeatAgeMs:63`, `noProgressMs:1044292`, then `audit_inactivity_timeout` at `18:23:18.675Z`; the retry was durably scheduled with `delayMs:60000`. Across the ledger there are `11` `auditor_stalled` and `11` `audit_inactivity_timeout` rows. | Stale worker telemetry is historical: the status says `auditor quiet`, `worker activity 4m 00s ago · stale`, and `next: worker event or /goal cancel`; it does **not** render `AUDITOR · DETACHED · LIVE`. A no-verdict timeout remains infrastructure, not a semantic verdict. | `tests/display.test.ts`: `worker-timeout display demotes stale progress to quiet without claiming LIVE`. Existing `tests/auditor-process.test.ts` and `tests/auditor-error-paths.test.ts` continue to exercise child cancellation and infra classification. |
| **Host-handle swap** | Historical correlated capture in `audit/HOST-SESSION-LOST-CAPTURE-2026-08-17.md`: `session_handle_invalidated` with `reason:"silent_handle_death"` at `2026-08-16T20:06:32.281Z`, then `session_rebound` at `20:22:32.264Z`, a `959,983 ms` interruption gap, and a first post-rebind identity-mismatch event `163 ms` later. Current ledger also records the clean replacement path: `audit_recovery_pending` / `audit_worker_cancelled` at `20:53:15.622Z–623Z`, `session_rebound {reason:"startup"}` at `20:53:18.459Z`, and one `audit_recovery_started` at `20:53:26.689Z`. | Before a replacement is validated, the old handle is fenced and the UI says stale handle / wait for fresh session; after validated rebind, the stored claim is active again and the fresh auditor owns it. A replacement window must not invent a host-loss invalidation. | `tests/host-session-lost.test.ts`: `a replacement window absorbs a handle swap before invalidation`. |

## Raw ledger counts and source pins

The following counts were obtained from the current `.pi-glla/active.jsonl`
(with no filtering that would turn a missing event into a success claim):

```text
session_rebound                         152
session_shutdown                        142
session_waiting_for_load                 62
session_handle_invalidated               55
audit_infra_retry                         2
auditor_stalled                          11
audit_inactivity_timeout                 11
audit_recovery_retry_scheduled           13
audit_recovery_started                   28
audit_recovery_auto_retry_claimed        27
audit_wall_timeout                        3
forbidden_model_switch                    6
auditor_model_fallback                    0  # no production primary-forbidden incident claimed
stale_awaiting_rebind                     0  # no production pre-rebind incident claimed
```

The `0` values are deliberate. The primary-forbidden and pre-rebind cases
were exercised in isolated regression fixtures and are not rewritten into the
live project's ledger. Production behavior is durable because the resolver
and host-session paths call `appendLedger`; the fixture assertions inspect
those rows before the temporary project is removed.

The display and timeout pins are:

- `extensions/goal-loop-display.ts`: `LIVE_ACTIVITY_MS = 15_000`,
  `AUDITOR_QUIET_MS = 3 * 60_000`, and the stale snapshot path emits
  `last tool`/`auditor quiet` rather than a current LIVE claim.
- `extensions/loops/goal-auditor-hooks.ts`: the detached `onStalled` callback
  appends `auditor_stalled` to the durable ledger before recovery scheduling.
- `extensions/loops/goal-session.ts`: `classifySessionHandleInvalidation`
  distinguishes `session_shutdown`, `provider_disconnect`, and
  `silent_handle_death`; `consumeStaleContinuationRearm` requires validated
  fresh contact.
- `extensions/goal-loop-auditor-process.ts`: infrastructure outcomes retain
  `approved:false` and `disapproved:false`; identity/hash failures and worker
  exits cannot become semantic verdicts.

## Verification commands

```text
timeout 60 bun test tests/host-session-lost.test.ts
  14 pass / 0 fail

timeout 60 bun test tests/auditor-fallback-unification.test.ts tests/auditor-eager-retry.test.ts
  16 pass / 0 fail

timeout 60 bun test tests/display.test.ts
  101 pass / 0 fail

timeout 60 npx tsc --noEmit
  clean
```

`git diff --check` is also required before closeout. The focused suites are
not a recursive invocation of the project test runner. These commands were
run in the canonical checkout with its existing installed dependencies; a
fresh isolated worktree has no `node_modules` because that directory is
ignored, so a rehearsal there can inspect the artifact but cannot rerun Bun
or TypeScript until dependencies are provisioned.

## Read

The validation confirms that the auditor and host lifecycle have a three-way
truth boundary: explicit forbidden intent is skipped and ledgered, recoverable
provider failures and worker timeouts remain infrastructure/no-verdict with a
bounded retry or cancel path, and only fresh worker activity earns the LIVE
badge. Reload and fresh-session events are durable lifecycle contacts rather
than guessed progress, while the correlated silent-host capture proves why a
handle swap must first fence the old context and then require a validated
rebind before resuming the stored claim. The only evidence intentionally not
claimed as a new production incident is the forbidden-primary and pre-rebind
fixture rows; their focused regressions prove the durable append paths without
polluting the live project's history.

## Limits

The host-loss sequence is historical correlation, not a controlled fresh Pi
reproduction, and it does not prove that the detached worker caused the
invalidation. The live ledger records lifecycle and recovery transitions, not
an independent screenshot for every state; the pure display regressions pin
those exact UI strings. The isolated forbidden-primary test uses temporary
`test/*` model refs and therefore proves policy behavior, not provider
availability.
