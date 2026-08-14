# Bounded pre-`# LATER` reliability audit — 2026-08-14

## Scope

This audit covers only the four agreed reliability items before the `# LATER`
boundary:

1. pending `/list` handoff recovery;
2. held-loop successor recovery;
3. persisted Cline/DeepSeek fallback cleanup;
4. fallback persistence protection.

The ideas under `/home/dracon/chat/pi/note.md` after `# LATER` are explicitly
out of scope. No package version or tag publication is part of this audit.

## 1. Pending `/list` handoff recovery

Raw focused test evidence:

```text
(pass) v0.35.x: a mutating /list command during handoff is replayed once by the successor
(pass) v0.35.x: a mismatched handoff discards a deferred list command without replay
14 pass
0 fail
Ran 14 tests across 2 files.
```

Raw implementation evidence:

- `extensions/loops/goal-session.ts:754` defines `queuePendingListOperation()`;
  it binds the operation to the predecessor generation and checks PID, owner
  session, version, and freshness.
- `extensions/loops/goal-session.ts:808` defines one-shot
  `consumePendingListOperations()` and `:842` defines discard handling.
- `extensions/goal-commands.ts:982-984` journals a mutating stale `/list`
  command instead of silently dropping it.
- `extensions/loops/goal-activation.ts:1357-1368` replays consumed operations
  after successor state restoration and ledgeres success/failure.
- A present but rejected handoff marker is authoritative; the successor does
  not fall back to owner-shutdown replay.

## 2. Held-loop successor recovery

Raw focused test evidence:

```text
(pass) v0.35.x: a successor auto-resumes lifecycle-held loops intact but preserves deliberate stops
(pass) isLifecycleHeldLoopReason separates recoverable lifecycle holds from deliberate/safety stops
178 pass
0 fail
Ran 178 tests across 4 files.
```

Raw implementation evidence:

```text
export function isLifecycleHeldLoopReason(reason?: string): boolean {
  return reason === HELD_ON_RESTORE
    || !!reason?.startsWith("extension api stale")
    || !!reason?.startsWith("stalled: continuation refires landed no turn")
    || !!reason?.startsWith("stalled: continuation start acknowledgement timed out")
    || !!reason?.startsWith("send-retry storm:");
}
```

`extensions/loops/goal-activation.ts:1194-1203` spreads the held loop object,
sets only `active`/`stopReason`, and records `loop_auto_resumed_on_restore`;
metric, bounds, history, iteration, and progress are not reset. The heartbeat
safety reason `stalled: ... consecutive unproductive turns` is excluded.
`extensions/goal-loop.ts:947-950` makes `/loop stop` and `/loop cancel`
authoritative by overwriting a restore marker with `stopped by user`.

## 3. Persisted fallback cleanup

The supported command path was executed:

```json
{"command":"/glla fallbacks clear","notice":"Main model backups cleared globally and any pending backup switch was cancelled.","mainModelFallbacksOwnKey":false,"legacyRefsPresent":false}
```

Raw implementation evidence from `extensions/goal-commands.ts:2043-2059`:
`saveSettings("global", ctx.cwd, { mainModelFallbacks: undefined })` removes
the persisted key, resets attempted/skipped state, clears pending model switch,
and cancels the recovery timer.

The global file is `/home/dracon/.pi/agent/pi-goal-list-loop-audit.settings.json`;
its parsed JSON has no own `mainModelFallbacks` key and no Cline/DeepSeek
reference.

## 4. Fallback persistence protection

Raw focused test evidence:

```text
(pass) main-model fallback reload preserves explicit order and does not reintroduce a cleared key
36 pass
0 fail
Ran 36 tests across 2 files.
```

`tests/settings-editors.test.ts:197-211` saves
`["persisted/first", "persisted/second"]`, reloads twice and asserts the order,
clears with whitespace, asserts the raw key is absent, reloads to `[]`, and
asserts the raw key remains absent.

Raw persistence evidence:

- `extensions/loops/goal-settings-ui.ts:809-810` maps an empty selection to
  `undefined` rather than an empty persisted fallback key.
- `extensions/goal-settings.ts:424-427` deletes undefined keys and writes the
  complete settings object through atomic persistence.
- `extensions/goal-settings.ts:408-428` uses the settings lock plus temporary
  file/rename persistence, preventing stale writers from resurrecting a cleared
  fallback chain.

## Validation and release boundary

Raw validation evidence:

```text
1344 pass
1 skip
0 fail
Ran 1345 tests across 112 files.
TypeScript: No errors found
```

The release-boundary assertion reported:

```json
{"version":"0.34.138","tag":""}
```

The working tree was clean after validation. No release or tag was created.

## Local bounded-audit conclusion

All four in-scope pre-`# LATER` reliability items have concrete source,
focused-test, and persistence evidence. The `# LATER` ideas remain untouched.

<approved/>
