# Session invalidation guard audit — 2026-08-14

## Bounded scope

Audit only the regression fix for recurring false `session_handle_invalidated`
warnings after the goal plane is already complete, paused, or held. The fix
must continue probing live goals/loops, detached audits, stale-recovery debt,
and tracked subagents, while not probing a retained handle when no live work
owns the host. Release publication is intentionally out of scope for this
bounded audit; the package remains `0.34.138` until approval.

## Implementation evidence

`extensions/goal-heartbeat.ts` now computes `staleRecoveryDebt` from durable
`extension api stale` interruption/loop markers and returns before the raw
ExtensionAPI probe when all of these are false:

- the goal is not `active` or `auditing`;
- no loop is active;
- no stale-recovery debt exists;
- no **live** tracked subagent exists.

Ended subagent probes remain available briefly for HUD/final-state reads, but
`hasLiveSubagentHangProbes()` ignores them for host ownership and prunes them
after the existing one-hour retention window. Terminal `complete`/`aborted`
goals cannot re-arm stale-recovery probing merely because an old interruption
marker remains. The raw probe remains in place for live/recoverable work, so a
genuinely lost host handle cannot silently strand active work.

## Follow-up to detached disapproval

The first detached verdict was `<disapproved/>` because the prior regression
seeded `goal: null`/`list: []` rather than explicit completed, paused, and held
states, and because an ended subagent probe still made `subagentHangProbes`
nonempty until pruning. The required raw objection was:

```text
Ignore ended subagent probes in the idle heartbeat guard (or remove them on completion), and add a regression reproducing the disposed-handle case.
Add explicit completed, paused, held, and stale-recovery-debt behavioral tests.
```

Both objections are now addressed. `tests/host-session-lost.test.ts` covers:

```text
(pass) completed idle state does not probe a disposed session handle
(pass) paused idle state does not probe a disposed session handle
(pass) held loop does not probe a disposed session handle
(pass) ended subagent probes do not keep idle state probing a disposed handle
(pass) stale-recovery debt still probes for same-process self-heal
```

## Focused regression evidence

Command:

```text
bun test --parallel=1 --max-concurrency=1 --timeout=20000 tests/stale-self-heal.test.ts tests/host-session-lost.test.ts tests/stale-api-terminal.test.ts tests/lifecycle-recovery.test.ts tests/subagent-hang-detection.test.ts
```

Raw result:

```text
53 pass
0 fail
Ran 53 tests across 5 files.
```

The existing active-work protections remain green, including genuine silent
host-loss classification, stale self-heal, stale terminal fencing, lifecycle
handoff recovery, and live/ended subagent watchdog behavior.

## Full validation evidence

The bounded follow-up validation also reports:

```text
npm run release:check
1349 pass
1 skip
0 fail
Ran 1350 tests across 112 files.
jiti: 1 pass, 0 fail
npx tsc --noEmit: exit 0 (TypeScript: No errors found)
npm pack --dry-run: pi-goal-list-loop-audit@0.34.138
git diff --check: exit 0
```

The release check passed without changing the package version or publishing.

## Release boundary

Current pre-release state after the follow-up:

```text
version=0.34.138
implementation_commits=b3a64945be61481a571f175fad65c8b4428da4e2,11646602,dde31f14
HEAD_tags=
release_tag=8e83f127889c8d54a7b0342afd4c6d273c64e762
```

No package version, release tag, or npm publication was changed by this
bounded audit.

## Conclusion

The false invalidation loop is now covered by explicit terminal/paused/held,
ended-subagent, stale-debt, and active-work evidence. This report is ready for
the final full-suite gate and independent detached approval before the patch
version is updated.
