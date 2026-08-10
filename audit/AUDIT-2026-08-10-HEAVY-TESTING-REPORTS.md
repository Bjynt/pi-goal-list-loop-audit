# Heavy-testing field reports — audit results (2026-08-10, v0.34.122)

Source: `/home/dracon/chat/pi/note.md` findings (screenshots 105112–212014)
triaged against HEAD with three parallel subsystem audits (quota/429,
auditor lifecycle, status/session/close). Screenshots 161428/170919/212014
were captured on the old installed package / pre-fix windows where noted.

## A. Quota/429 recovery (ledger-proven)

| # | Sev | Finding | Location |
|---|---|---|---|
| A1 | P1 | Raw 429 / "Token Plan" text still pasted into chat via `ui.notify` — v0.34.92 removed only the `sendUserMessage` prompter, not the notify-with-raw-error paths. Ledger `main_model_recovery_wait` entries carry full 429 JSON in `reason`; that text reaches the banner. | quota-retry.ts:172-180, goal-recovery.ts:458, loops/goal-activation.ts:1495-1497, :1541-1542 |
| A2 | P1 | Hourly :00:30 probe ticker is cancelled by the main-model probe failure path — dead exactly for continuing walls. Ticker fires at most once per parking event. Zero `hourly_probe_scheduled/fired` ledger events despite days of parked recovery. | goal-recovery.ts:283-289, :436-441, :664-665 |
| A3 | P1 | Three conflicting hour-alignment clocks: main-model probe + auditor plan target :00:00 (which the code's own comment says races provider resets), ticker :00:30, error-brake park :01:00. Field "next probe in 52m47s" is :00:00-aligned. | goal-loop-core.ts:48-70, main-model-recovery.ts:190-196, goal-auditor-hooks.ts:527-532, goal-loop-backoff.ts:18-24 |
| A4 | P1 | No dedup/throttle for identical quota notifications (the `persistenceDegradedNotified` one-shot pattern exists but is not applied). Ledger shows byte-identical repeats. | goal-recovery.ts:458, quota-retry.ts:180, goal-activation.ts:1013 |
| A5 | P1 | `quotaRetryTimer` is a module-global single timer — every schedule cancels the previous (cross-goal/session stomp). Rebind kills it; ~50 `session_rebound` events in the field ledger. Untested (tests only pin single-schedule). | quota-retry.ts:162-180, goal-tools.ts:940, goal-auditor-hooks.ts:920, goal-orchestrator.ts:453 |
| A6 | P2 | Raw 429 text returned in `complete_goal` tool result — the agent quotes it into chat. | goal-tools.ts:919-925, :932 |
| A7 | P3 | Stale-ctx failures parked as "main model unknown" provider walls with raw text + identical repeats. | main-model-recovery.ts:116-121 |

## B. Auditor lifecycle (field: frozen / blocked – no verdict)

| # | Sev | Finding | Location |
|---|---|---|---|
| B1 | P1 | Watchdog/infra timeout parks the goal with NO automatic retry; `recoveryAt` is written but never consumed. Only `/glla resume` re-arms. Quota branch right below schedules a real retry — timeout branch doesn't. | goal-auditor-hooks.ts:854-871, goal-tools.ts:827-857, :1065-1079 |
| B2 | P1 | "blocked – no verdict" is a dead-end: `recovery-pending` claims have no watchdog/timer; heartbeat rescue requires `status==="auditing"` so parked goals are invisible to it. | goal-recovery.ts:60-90, goal-heartbeat.ts:506-531, goal-activation.ts:946-955, :1146-1166 |
| B3 | P1 | Reload strands claims: watchdog gated by in-memory `completionAuditRecoveryArmed` flag (dies on reload); `session_shutdown(reload)` stamps `hadShutdown` killing rebind consent; handoff consent fragile on identity mismatch. | goal-heartbeat.ts:513, goal-auditor-hooks.ts:389, session.ts:637-700, :739-745, :769-770, goal.ts:388 |
| B4 | P1 | Disapproval verdict text reaches chat/notify un-suppressed — `auditorSilent` never consulted in the verdict path. "Paste briefly then remove" = auto-dismissing toast. | goal-tools.ts:1104-1107, :1028-1031 |
| B5 | P2 | Quota-waiting claims auto-retried (phase `quota-waiting` + `pauseResumeAt`); recovery-pending claims not (only `recoveryAt`, unused). | goal-auditor-hooks.ts:920-926 vs :854-871 |
| B6 | P2 | Infra-error pauseReason renders as "blocked – no verdict / not evaluated" though the claim WAS evaluated (it errored). | goal-loop-display.ts:321-328 |
| B7 | P3 | Stale-session manual resume flips goal to active BEFORE retrying the claim; if retry bails, goal is active with a claim no path will audit. | goal-commands.ts:413-423 |

## C. Status / session / close

| # | Sev | Finding | Location |
|---|---|---|---|
| C1 | P1 | Pause transitions never stop pi's queued/in-flight turn, and nothing re-activates on later turn evidence — "Working…" while card says paused (162121). | goal-orchestrator.ts:390-400, goal-continuation.ts:340-355, goal-tools.ts:885-925 |
| C2 | P2 | Paused chip derives from `state.goal.status` only; never consults host activity. glla and pi can disagree indefinitely. | goal-ui.ts:615, goal-loop-display.ts:655-860, :954-983 |
| C3 | P3 | Auto-resume gates too narrow: pauseKind `error` inside recovery window never auto-resumes; quota auto-resume leaves stale `pauseResumeAt`. | goal-recovery.ts:744-760, :579-585, goal-tools.ts:915 |
| C4 | P1 | `interruptedAt` survives a fresh `session_start` under hold policy → red "host session lost" banner persists after rebind already happened (161428). | goal-activation.ts:1072-1090, goal-loop-display.ts:1026-1042 |
| C5 | P2 | Marker-clearing gates too tight for the field shape (silent swap via `session_start` with new manager falls into C4's gate). | goal-session.ts:1211-1216, :1266-1272 |
| C6 | P3 | No-turn-start variant shares the same field and clearing gates. | goal-continuation.ts:559 |
| C7 | P1 | Detached approve path can drop an approved verdict without archiving: early returns on generation/session/attemptId mismatch discard the verdict, slot stays open, goal stays `auditing` — "auditor frozen" reports. | goal-tools.ts:641-643, goal-auditor-hooks.ts:757-790 |
| C8 | P3 | Chat recap can be a wall of text; notify (chat) uncapped while notifyExternal is capped. Full text already lives in archive md. | goal-tools.ts:768-771, goal-loop-display.ts:1330-1337 |
| C9 | P1 | Registry-vs-disk mismatch (212014): pre-fix jiti binding split — FIXED in v0.34.122, pinned by tests/repro-jiti-state-split.test.mjs. | extensions/goal-state.ts |
| C10 | P1 | POST-FIX residual: archive fence is an incomplete reconciliation — unlinks goal md, nulls in-memory goal, but never touches the queue sidecar/`state.list`; fence'd item re-activates, md recreated, fence hits again (the exact "already archived/cancelled" loop in 212014, reproducible post-fix). | goal-continuation.ts:748-759 |

## Priority clusters (by field impact)

1. **Chat spam cluster** (A1, A4, A6, B4, C8): nothing raw pasted into chat; dedup identical banners; gate verdict prose behind auditorSilent; cap recaps. Highest visibility — the user sees these every session.
2. **Stuck-forever cluster** (B1, B2, B3, B5, C7): unify quota-waiting/recovery-pending under one durable bounded retry envelope; make watchdog durable-state-driven; keep approved verdicts even on generation mismatch.
3. **Truthful status cluster** (A2, A3, C1, C2, C4, C10): single hour-alignment primitive; ticker survives parked recovery; paused chip consults host activity; interruptedAt clears on real rebind; fence reconciles queue sidecar + list.
4. **Timer hygiene** (A5, A7, B7): per-goal timers; stale-ctx not parked as provider wall; stale check before mutation in cmdResume.

Clean: detached worker guards, in-flight latch finally-clear, archived-slot ordering, handoff sidecar design, v0.34.122 state fix itself.
