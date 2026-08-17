# Host-session-lost capture — 2026-08-17

## Result

A real `silent_handle_death` sequence was correlated from the durable
`.pi-glla/active.jsonl` ledger. The capture is recorded as the appended
`host_session_capture` event in that ledger. The capture event is explicitly
marked `source: correlated-existing-ledger`: it does not pretend that a new
runtime failure was manufactured during this documentation pass.

## Captured sequence

| Fact | Evidence |
|---|---|
| Goal being supervised | `20260816155656-s02lqi` (`.pi-glla/active.jsonl:3901-3903`, state + `audit_started`) |
| Host invalidation | `.pi-glla/active.jsonl:3906-3907`, `extension_api_stale` followed by `session_handle_invalidated` |
| Invalidation reason | `silent_handle_death` at `2026-08-16T20:06:32.281Z` |
| Owner/session identity | `ownerSessionId=01a00725-7370-7da6-8660-760e67fddeaa`, present on the continuation dispatches around `.pi-glla/active.jsonl:3874-3877` and in `.pi-glla/session-owner.json` |
| Goal after invalidation | `.pi-glla/active.jsonl:3908`, the same goal is paused and `audit_recovery_pending` follows at `3909` |
| Rebind | `.pi-glla/active.jsonl:3911-3913`, reload shutdown/handoff followed by `session_rebound` at `2026-08-16T20:22:32.264Z` |
| Interruption gap | `959,983 ms` (`15m 59.983s`) from invalidation to `session_rebound` |
| First event after rebind | `.pi-glla/active.jsonl:3914`, `session_handoff_rejected` at `2026-08-16T20:22:32.427Z`, reason `identity-mismatch` |
| First-event delay | `163 ms` after `session_rebound` |
| Recovery response | `.pi-glla/active.jsonl:3915-3918`, host-rebind audit recovery claim, fresh `auditing` state, and a new `audit_started` attempt |

The appended capture record preserves these correlations in one machine-readable
ledger entry, including the source line numbers, goal id, owner session id,
timestamps, gap, and first post-rebind event.

## What this proves

1. The heartbeat stale probe produced a durable `silent_handle_death` event.
2. The affected goal was parked with an audit recovery claim rather than
   silently disappearing.
3. A later reload/rebind produced a new recovery attempt for the same goal.
4. The captured gap is long enough to be user-visible, and the first event
   after rebind was an identity-mismatch rejection before the recovery claim.

## What this does not prove

This is one correlated historical sequence, not a controlled reproduction of
Pi's silent host swap. It does not establish that the detached auditor caused
the invalidation; the cross-plugin analysis in `.research/comparison.md`
argues against that hypothesis. The next item should test whether a fresh
rebind can re-arm continuation without leaving the goal parked, while keeping
the invalidation and recovery ledger evidence.
