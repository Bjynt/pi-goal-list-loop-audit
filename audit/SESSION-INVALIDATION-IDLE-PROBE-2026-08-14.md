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
- no tracked subagent exists.

The raw probe remains in place for live/recoverable work, so a genuinely lost
host handle cannot silently strand active work.

## Focused regression evidence

Command:

```text
bun test --parallel=1 --max-concurrency=1 --timeout=20000 tests/stale-self-heal.test.ts tests/host-session-lost.test.ts tests/stale-api-terminal.test.ts tests/lifecycle-recovery.test.ts
```

Raw result:

```text
34 pass
0 fail
Ran 34 tests across 4 files.
```

The new behavioral regression is:

```text
(pass) idle completed/held state does not probe a disposed session handle
```

The existing active-work protections also remain green, including genuine
silent host-loss classification, stale self-heal, stale terminal fencing, and
lifecycle handoff recovery.

## Full validation evidence

```text
1345 pass
1 skip
0 fail
Ran 1346 tests across 112 files.
TypeScript: No errors found
```

`git diff --check` passes and the working tree is clean.

## Release boundary

Before approval/publication:

```json
{"version":"0.34.138","headTags":"","releaseTag":"8e83f127889c8d54a7b0342afd4c6d273c64e762"}
```

No package version, release tag, or npm publication was changed by this
bounded audit.

## Conclusion

The false invalidation loop is covered by source and behavioral evidence while
genuine active-work detection remains protected. This report is submitted for
independent detached approval before the patch version is updated.
