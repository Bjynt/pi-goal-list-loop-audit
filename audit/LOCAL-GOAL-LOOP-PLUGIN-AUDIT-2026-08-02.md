# Local goal/loop plugin audit — 2026-08-02

## Scope and live-load check

Inspected the installed packages under `/home/dracon/.pi/agent/npm/node_modules`, checked-out plugin sources/snapshots under `/home/dracon/Dev`, and the current glla checkout. The active global package list is `/home/dracon/.pi/agent/settings.json`.

Only these goal/loop-adjacent packages are currently loaded globally:

- `npm:pi-goal-list-loop-audit`
- `npm:@tintinweb/pi-subagents` (delegation, not a goal loop)

The other installed goal/loop packages are not loaded by the current settings, so they cannot be competing lifecycle handlers in the screenshot's session.

Important deployment finding: the active installed glla copy currently reports **0.34.20** and has no `goal-loop-auditor-process.ts`; the checkout contains the detached-auditor work and is now **0.34.23**. A local npm override was reverted by the package-manager state still pinned to the old npm package, so the detached fix is not active until the package source/pin is changed and pi is reloaded.

## Comparison against the failure modes

| Local plugin | Accepted-but-no-start proof | Replacement/stale handling | Durable state | Completion/quality gate | Verdict |
|---|---|---|---|---|---|
| `pi-goal-list-loop-audit` | Detects unanswered/refired continuations, but `triggerTurn` itself is not an acknowledgement | Strong generation/handoff logic; v0.34.23 fixes host replacement with a new `SessionManager` | `.pi-glla` JSONL, goals, lists, loops, audit claims | Detached extensionless auditor in checkout; old installed 0.34.20 still uses an in-process auditor | Best fit, but needs the live package upgrade and the pi trigger gap remains upstream |
| `pi-continue` 0.7.1 | **Best direct match**: persists a pending dispatch and times out unless the next run starts | Handles continuation shutdown/failure; not a general replacement owner | Structured continuation proof/ledger | Verifies handoff mechanics, not task correctness | Borrow its start-ack/proof state machine; not a goal replacement |
| `pi-dgoal` 0.7.7 | Idle/pending polling and failure clearing, but no post-send `agent_start` proof | Session-start/tree/compact resync, generation-bound continuation and audit results | Session custom entries | Revision/session-generation-aware `phase_check`/`goal_check` | Strongest goal-oriented alternative; still does not prove a trigger started |
| `pi-goal-x` / `@capyup/pi-goal` | Idle/pending guards, no start acknowledgement | Disk reconciliation and stale checkpoint guards | Disk goal files | Separate auditor in the implementation | Useful auditor/state ideas; continuation remains trigger-assumption based |
| `pi-codex-goal` 0.1.37 | Deduplicated `triggerTurn`, no demonstrated start watchdog | Session-start/tree/shutdown reconstruction | Session custom entries | Tool/prompt contract, no independent semantic verifier | Good recovery structure, weaker completion proof |
| `pi-until-done` 0.2.2 | Follow-up dispatch from `agent_end`, no start proof | Reload/compaction reconstruction, no replacement-specific fresh-handle protocol | Session state plus task file | Evidence command and optional judge; judge can fail open | Good bounded contract loop, not a stale-host solution |
| `pi-autoresearch` 1.4.0 | Delayed/bounded auto-resume, no start proof | Reload/tree reconstruction, no explicit stale generation protocol | Experiment JSONL/markdown | Checks, rollback, failure caps | Strong metric optimization loop, not semantic goal completion |
| Ralph variants (`@tmustier/pi-ralph-wiggum`, `@pi-unipi/ralph`, `@lnilluv/pi-ralph-loop`) | Prompt/follow-up driven; no start proof | Some reload/state rehydration and iteration bounds | `.ralph`/plugin state files | Usually model completion marker or prompt contract | Useful bounded patterns, not independent verification/lifecycle ownership |
| `pi-review-loop` 0.4.4 | Follow-up after `agent_end`, no start proof | In-memory review state only | No durable goal state | Phrase/heuristic “no issues found” | Narrow review loop, not a goal runner |
| `pi-invisible-continue` 0.3.3 | Bypasses `triggerTurn` with `Agent.prompt([])` | No replacement rebind; prototype monkey-patch | None | None | Avoids this trigger path but is manual, non-durable, and unsafe as the goal engine |
| `@badliveware/pi-compaction-continue` 0.1.5 / checked-out `pi-length-continue` | Bounded nudge watchdog, no start proof | Compaction-focused only | No goal ledger | None | Watchdogs, not goal engines |
| `@tintinweb/pi-subagents` 0.14.3 | Per-agent notifications use `triggerTurn`; not a parent goal supervisor | Rebinds its own agent sessions | Optional agent persistence | No completion gate | Not a solution to the parent host-session failure |

Other installed goal packages (`pi-goal-loop-audit`, `@fractaal/pi-goal-x`, `@narumitw/pi-goal`, `@misunders2d/pi-goal`, `@capyup/pi-goal`, and `pi-codex-goal`) are older alternatives or variants. Historical registry snapshots include pattern-only, review-only, DAG, and incomplete Ralph packages; they do not provide a better combination of host lifecycle, durable list state, and independent verification.

## Attribution

### Confirmed glla-side issue

The old ownership guard rejected *every* `session_start` whose `SessionManager` differed from the stored owner. That is correct for a subagent `startup`, but incorrect for host `/new`, `/resume`, `/fork`, or `/reload` when pi supplies a new manager and omits `session_shutdown`. The handler returned before rebinding, leaving the old owner and timers in place.

This is fixed in the checkout as v0.34.23. The regression test proves both sides: a replacement manager rebinds and a normal foreign `startup` still cannot steal ownership.

### Not a glla disposal bug

The checkout has no call that disposes, reloads, forks, or replaces the host session. Its current auditor is a detached worker and only the worker process is terminated. The installed 0.34.20 auditor is in-process and shares the parent model runtime, so it has unnecessary coupling; it does not directly call host `dispose`, but it is the wrong isolation boundary for this failure class.

### Remaining upstream pi gap

`sendMessage(..., { triggerTurn: true })` can resolve while no turn starts. glla detects this and fails closed rather than injecting terminal input or retrying forever. That is honest and safe, but it cannot make an invalidated pi host create a replacement `session_start`. `pi-continue` has the best reusable design for this one subproblem: pending dispatch, explicit start observation, timeout, and durable failure state. No local competitor combines that proof with glla's list/audit semantics.

## Recommended conclusion

1. Keep glla as the goal/list/loop layer.
2. Activate the detached glla package from a stable local source or a published pinned release; the currently loaded 0.34.20 copy is not the audited checkout.
3. Retain the v0.34.23 replacement-manager fix.
4. Add a `triggerTurn` start-acknowledgement state machine modeled on `pi-continue`, without adopting its manual/non-goal behavior.
5. Do not load another full goal plugin alongside glla; the current settings already avoid that collision.
