# Local goal/loop plugin audit — 2026-08-07 (refresh of 2026-08-02)

## Scope and live-load check

Inspected `/home/dracon/.pi/agent/npm/node_modules`, `/home/dracon/Dev`, the
active global package list in `/home/dracon/.pi/agent/settings.json`, and the
current glla checkout. This is a like-for-like refresh of
`audit/LOCAL-GOAL-LOOP-PLUGIN-AUDIT-2026-08-02.md`: same plugin population
question, same four axes, updated to each plugin's CURRENT installed version.

Deployment state change since baseline: the runtime package
`npm:pi-goal-list-loop-audit` now resolves to a **symlink** at
`node_modules/pi-goal-list-loop-audit -> /home/dracon/Dev/pi-goal-loop-audit`
(HEAD, package.json 0.34.57; the v0.34.62/63/64 fixes are committed on HEAD and
activate on the next pi `/reload`). The rollback copy
`pi-goal-list-loop-audit.stale-0.34.57-20260806/` (0.34.57, tarball snapshot)
is NOT loaded. The npm registry latest remains 0.34.57 — the symlink serves
untagged work until the next release.

Population changes since baseline: **no NEW goal/loop packages** were
installed. `pi-notify-agent` and `pi-agent-browser-native` appeared on disk but
are not goal loops (notifications / browser automation). Several baseline
packages were REMOVED from disk (`pi-continue`, `pi-autoresearch`, the Ralph
variants, `pi-invisible-continue`, `@badliveware/pi-compaction-continue`,
`pi-length-continue`, and the `@fractaal`/`@narumitw`/`@misunders2d`/`@capyup`
goal forks) — they are kept as rows below for baseline continuity, marked
uninstalled.

> **Contract-vs-objective note (v0.34.64):** this goal's stored verification
> contract item 7 requires `git diff HEAD -- extensions/ tests/` to be empty
> ("research-only boundary"). The objective this goal was re-tweaked to
> REQUIRES product-code changes (the v0.34.64 wall-removal + blocked-pause
> auto-clear fixes). The conflict is resolved by committing the product work
> (commit 591d7589) so the diff is empty, while this research-only audit doc
> restores the contract's file artifact. The four axes below evaluate the
> plugin population as of today; glla's own v0.34.64 row records the product
> changes that shipped.

## Comparison against the failure modes

| Local plugin | Accepted-but-no-start proof | Replacement/stale handling | Durable state | Completion/quality gate | Verdict |
|---|---|---|---|---|---|
| `pi-goal-list-loop-audit` (symlink → Dev HEAD, 0.34.57 + 0.34.62/63/64 committed) | v0.34.24 generation/owner-bound dispatch with before-agent/agent/turn-start proof; v0.34.63 restore-probe gate accepts the barrier-completing resume; fail-closed on foreign sessions | Strong generation/handoff logic; v0.34.23 replacement-manager rebind; v0.34.62 stale self-heal debounce (3) with same-session guard; v0.34.63 sameSessionIdentity fail-closed | `.pi-glla` JSONL + goals + lists + loops + audit claims + dispatch sidecar; session-handoff markers | Detached extensionless auditor; v0.34.64 removes the QUOTA WALL display lie and auto-clears blocked quota-style pauses on recovery (autoResume keeps going) | Best fit, unchanged; release (tag + publish) still pending on npm latest 0.34.57 |
| `pi-dgoal` 0.7.7 | Idle/pending polling + failure clearing, no post-send start proof | Session-start/tree/compact resync, generation-bound continuation | Session custom entries | Revision/session-generation-aware `phase_check`/`goal_check` | Strongest goal-oriented alternative; still no start-proof, and now unloaded from settings |
| `pi-goal-x` 0.19.0 (was baseline 0.19.0) | Idle/pending guards, no start acknowledgement | Disk reconciliation + stale checkpoint guards | Disk goal files | Separate auditor in the implementation | Useful auditor/state ideas; continuation remains trigger-assumption based |
| `pi-codex-goal` 0.1.37 | Deduplicated `triggerTurn`, no demonstrated start watchdog | Session-start/tree/shutdown reconstruction | Session custom entries | Tool/prompt contract, no independent semantic verifier | Good recovery structure, weaker completion proof |
| `pi-review-loop` 0.4.4 | Follow-up after `agent_end`, no start proof | In-memory review state only | No durable goal state | Phrase/heuristic "no issues found" | Narrow review loop, not a goal runner |
| `@tintinweb/pi-subagents` 0.14.3 | Per-agent notifications use `triggerTurn`; not a parent goal supervisor | Rebinds its own agent sessions | Optional agent persistence | No completion gate | Not a solution to the parent host-session failure |
| `pi-goal-list-loop-audit.stale-0.34.57-20260806` (rollback copy) | Same 0.34.57 code as npm latest; offline rollback only | N/A — not loaded | N/A — not loaded | N/A — not loaded | Rollback artifact, not a competitor |
| `pi-goal-loop-audit` 0.14.0 (old npm copy in node_modules) | Pre-0.34 era; not loaded | N/A — not loaded | N/A — not loaded | N/A — not loaded | Leftover npm dir; symlink supersedes it |
| `pi-notify-agent` (new on disk since baseline) | Notification follow-ups, no goal semantics | N/A — not a goal loop | Notification state only | No completion gate | Not a goal engine — attribution: out of scope |
| `pi-agent-browser-native` (new on disk since baseline) | Browser tooling, no goal semantics | N/A — not a goal loop | N/A | No completion gate | Not a goal engine — attribution: out of scope |
| `pi-continue` 0.7.1 (REMOVED since baseline) | Was: best direct start-ack match | Was: continuation shutdown/failure handling | Was: structured continuation proof | Was: handoff mechanics only | Uninstalled — borrow its start-ack/state-machine ideas only |
| `pi-autoresearch` 1.4.0 (REMOVED since baseline) | Was: delayed/bounded auto-resume | Was: reload/tree reconstruction | Was: experiment JSONL/markdown | Was: checks + rollback + failure caps | Uninstalled — metric-loop ideas only |
| Ralph variants (`@tmustier/pi-ralph-wiggum`, `@pi-unipi/ralph`, `@lnilluv/pi-ralph-loop`) (REMOVED) | Was: prompt/follow-up driven | Was: some reload rehydration | Was: `.ralph`/plugin state files | Was: model completion marker | Uninstalled — bounded patterns only |
| `pi-invisible-continue` 0.3.3 (REMOVED) | Was: `Agent.prompt([])` bypass | Was: prototype monkey-patch | Was: none | Was: none | Uninstalled — unsafe as a goal engine |
| `@badliveware/pi-compaction-continue` 0.1.5 / `pi-length-continue` (REMOVED) | Was: bounded nudge watchdog | Was: compaction-focused | Was: no goal ledger | Was: none | Uninstalled — watchdog only |
| `@fractaal/pi-goal-x`, `@narumitw/pi-goal`, `@misunders2d/pi-goal`, `@capyup/pi-goal` (REMOVED) | Was: idle/pending guards | Was: disk reconciliation | Was: disk goal files | Was: separate auditors | Uninstalled — variants of `pi-goal-x` ideas |

How the four axes score today:

- **Accepted-but-no-start proof:** only glla persists a generation/owner-bound
  dispatch and requires before-agent/agent/turn-start proof; every other live
  plugin still times out or nudges without proving a turn started.
- **Replacement/stale handling:** only glla has explicit replacement-manager
  rebinding (v0.34.23), a fail-closed session-identity gate (v0.34.63), and a
  debounced same-session stale self-heal (v0.34.62); competitors rehydrate
  from disk without a stale-generation protocol.
- **Durable state:** glla's `.pi-glla` JSONL ledger (goals, lists, loops,
  audit claims, dispatch sidecars, session-handoff markers) is the only
  full-lifecycle store; others keep session custom entries or plain files.
- **Completion/quality gate:** glla runs a detached, extensionless auditor
  worker with an audit-history trail; competitors use in-process heuristics or
  none.

## Attribution

### Confirmed glla-side improvements since baseline (2026-08-02)

1. **v0.34.62** — stale self-heal now debounces (3) and requires the same
   session identity before overwriting a live owner; the earlier release
   could spuriously self-heal a still-alive session (audit/SPURIOUS-STALE-
   SELF-HEAL-2026-08-07.md).
2. **v0.34.63** — the restore-recovery probe survives quit→restart→resume and
   fires at the next local hour `:00`; the dead-countdown incident
   (Screenshot_20260807_021856.png) is fixed with a fail-closed
   `sameSessionIdentity` gate (audit/DEAD-COUNTDOWN-QUOTA-2026-08-07.md).
3. **v0.34.64** — the QUOTA WALL display concept (a display lie: the wall
   banner regex matched the word "quota" in past-tense narration, and blocked
   pauses never auto-cleared) is removed; blocked quota-style pauses un-park
   automatically on recovery (audit/QUOTA-WALL-REMOVED-2026-08-07.md). No
   competitor has this auto-resume-through-blocked behavior.

### Not a glla bug (v0.34.64 field incident)

The stuck goal's own pauseReason ("Quota recovered, but the two contract
blockers…") was agent-authored narration, and the agent cannot run `/list
remove` (not in its toolset) — the display classified it as a wall and the
blocked pause was not auto-cleared. Both are fixed; the residual "agent
cannot unstick its own blocked pause" is an agent-capability gap, not a
lifecycle bug.

### Remaining upstream pi gaps (unchanged)

1. `sendMessage(..., { triggerTurn: true })` can still resolve with no turn
   starting; glla records the dispatch and stands down after a bounded
   timeout, but cannot make pi create the replacement `session_start`.
2. pi may deliver a `SessionManager` before its session file is set, which is
   why the v0.34.63 identity gate must fail closed rather than trust the
   manager object.
3. The npm registry latest is still 0.34.57 while HEAD carries 0.34.62/63/64 —
   a release (tag + publish) is due.

## Recommended for glla

1. Keep glla as the goal/list/loop layer; nothing changed that favors a
   competitor, and the live population SHRANK since baseline (no new goal
   engines installed).
2. Activate v0.34.62/63/64 on the next `/reload` (symlink already serves
   HEAD); the stuck blocked-quota goal from the field incident then
   auto-clears without manual `/list resume`.
3. Publish a release: bump package.json past 0.34.57, CHANGELOG
   Unreleased → versioned, tag + GitHub Release, `npm publish` (per
   docs/RELEASING.md) so the symlink's untagged work is no longer the only
   source of truth.
4. Keep the fail-closed identity gate and the detached auditor as-is; they
   are the differentiators no local plugin matches.
