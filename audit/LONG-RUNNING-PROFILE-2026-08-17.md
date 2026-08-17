# Long-running session resource profile

Capture date: 2026-08-17

## Target and provenance

This is a historical, correlated profile of one real unattended goal rather
than a synthetic timer test. The target was goal
`20260815203823-c21fxc` (the full-project audit), owned by the real Pi session
`01a00725-7370-7da6-8660-760e67fddeaa`. The interval is taken from the
append-only `.pi-glla/active.jsonl` goal state and ends at the durable
`goal_archived` event; no claim is made that every process event was preserved
in the ledger.

| Field | Raw value |
|---|---:|
| Window start (UTC) | `2026-08-15T20:38:23.099Z` |
| Window end (UTC) | `2026-08-16T05:47:11.890Z` |
| Wall duration | `32,928.791 s` / `9.1469 h` |
| Goal status changes | `17` (active/paused/auditing/complete, after duplicate states were collapsed) |
| Ledger entries in the window | `133` goal-correlated or window events |
| Final goal telemetry | `1` turn, `30` file writes, `307` bash calls |

## Runtime counters and cadence accounting

The runtime does not append one ledger row per heartbeat or UI repaint. The
following separates observed ledger events from cadence-derived upper bounds;
this avoids presenting an inferred timer slot as an observed callback count.
Source constants are `HEARTBEAT_INTERVAL_MS = 15_000` in
`extensions/goal-loop-backoff.ts`, and the UI ticker is a `1_000 ms`
`setInterval` in `extensions/loops/goal-ui.ts`.

| Surface | Observed raw evidence | Count / derived value |
|---|---|---:|
| Heartbeat refire/escalation | `heartbeat_refire` events in the target window | `0` |
| Heartbeat timer slots while status was active/auditing | `24,451.551 s` supervising time ÷ `15 s` | `~1,630` slots |
| UI ticker refresh slots while status was active/auditing | `24,451.551 s` supervising time ÷ `1 s` | `~24,451` slots |
| Continuation dispatches prepared/accepted | `continuation_dispatch_prepared` / `continuation_dispatch_accepted` | `5` / `5` |
| Goal continuation sends | `goal_continuation_sent` | `5` |
| Continuation starts acknowledged | `continuation_start_acknowledged` | `5` |
| Compaction events | `session_compact` | `0` |
| Provider-turn frequency | final telemetry `turns = 1` ÷ `9.1469 h` | `0.109 turns/h` |

The supervising-time calculation uses the collapsed state sequence from the
same ledger: active/auditing intervals total `24,451.551 s`; paused intervals
are excluded. The heartbeat and ticker rows are therefore cadence-derived
capacity estimates, while the refire and continuation rows are observed
ledger counts.

## Detached workers, fallback/recovery, and child activity

| Surface | Raw ledger evidence | Count / bound |
|---|---|---:|
| Detached completion-audit launches | `audit_started` | `3` |
| Audit recovery relaunches | `audit_recovery_started` | `1` |
| Auditor wall timeout | `audit_wall_timeout` | `1` (configured worker wall bound: `30 min`) |
| Retry scheduling/due/claim | `audit_recovery_retry_scheduled` / `audit_recovery_retry_due` / `audit_recovery_auto_retry_claimed` | `1` / `1` / `1` |
| Explore child sessions | `subagent_session` in the window | `5` |
| Main-model probe/ticker events | `main_model_probe`, `hourly_probe_fired`, `hourly_probe_scheduled` | `0` / `0` / `0` |
| Host-wide Pi processes during live sample | `ps` sample, six samples | `25` each sample |
| Owner PID direct child count | `pgrep -P 877529` after sample | `0` |

Detached auditor job directories are cleaned after settlement, so exact
per-worker exit timestamps are not retained for this historical interval. The
ledger does retain the relevant lifecycle bound: the timed-out attempt was
reported with “Auditor exceeded its 30m wall-clock bound and was aborted,” and
the recovery attempt started one minute after the retry became due. The five
Explore starts have no matching end event in this ledger, so they are reported
as starts, not fabricated lifetimes.

## Live memory/child snapshot

A bounded six-sample process snapshot was taken from the current real owner
PID `877529` at five-second intervals. RSS is the owner `pi` process only;
the host-wide process count includes other Pi sessions and must not be
attributed to this goal.

```text
sample_utc,pid_rss_kb,pi_processes,detached_auditor_processes
2026-08-17T20:34:13+00:00,307304,25,1
2026-08-17T20:34:18+00:00,306908,25,1
2026-08-17T20:34:23+00:00,306908,25,1
2026-08-17T20:34:28+00:00,303916,25,1
2026-08-17T20:34:33+00:00,287700,25,1
2026-08-17T20:34:38+00:00,287708,25,1
```

Owner RSS range: `287,700–307,304 kB` (mean `300,074 kB`, spread
`19,604 kB`). The one matching detached-auditor process in this host-wide
snapshot was not attributable to PID `877529`; it is retained as a host-wide
observation, not claimed as this goal's worker.

## Read

Across 9.15 hours the real goal spent about 6.79 hours in active/auditing
states, with roughly 1,630 heartbeat slots and 24,451 UI-refresh slots implied
by the production cadences but no observed `heartbeat_refire` storm. The
resource pressure was dominated by long unattended audit/recovery waiting: 3
audit launches, 1 wall-timeout, 1 recovery relaunch, and 5 Explore starts,
while only one provider turn was recorded (`0.109/h`). The live owner RSS
samples stayed within a 19.6 MB band, so this evidence does not show a memory
leak; it does show that the ledger lacks per-tick/per-worker-exit counters, and
those counters should be added before optimizing timers or concurrency.
