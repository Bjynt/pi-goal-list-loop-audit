# Stale-ctx auto-recovery — v0.34.117

Field-observed in `capture-anime-girls` 2026-08-09 09:53 (`/home/dracon/Pictures/Screenshots/Screenshot_20260809_095353.png`) and `ai-auto-writer` 2026-08-09 (~17:30). Symptom: pi's compact subsystem throws `This extension ctx is stale after session replacement or reload` on every sendMessage in-process. `/reload` does not help (same ctx cache); only `/new` (fresh ctx) clears it. Until v0.34.117, the user had to type `/new` by hand every time the wedge fired.

## Root cause (pi 0.82.x, `agent-session-runtime.js`)

The compaction path reaches `teardownCurrent → dispose → invalidate`. Once the runtime is invalidated, every `sendMessage` against the captured ctx throws forever in-process — there is no self-heal. Pi's error message is explicit:

> "Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload()."

The terminal park (`goStaleTerminal`) was the only escape — but it left the user with a parked goal and a manual `/new`. The user prefers to keep the same session (pi preserves conversation history in the session tree).

## Fix shape

`extensions/goal-recovery.ts::attemptFreshSessionRecovery(ctx, where: string)`:

1. Reads `flags.extensionApi` (set by `createGoalRecovery`, so the import is one-way and the runtime contract is unchanged).
2. Guards against `typeof flags === "undefined"` (a module-load-time probe before `goal.ts` reaches its factory call).
3. Calls `api.newSession()` if available — programmatic equivalent of `/new`. Result is fire-and-forget (the new `session_start` events arrive async); we don't await because the calling send has already raised the stale error.
4. Returns `true` so the caller skips the legacy terminal park.
5. Falls back to `false` when the entrypoint is missing (older pi builds), the entrypoint threw (caught + ledgered), or the factory has not initialized yet. The caller then runs `goStaleTerminal` as the legacy fallback.

Ledger events:

- `fresh_session_recovery_triggered` — fired, session_start will rehydrate from disk.
- `fresh_session_recovery_skipped` — entrypoint missing OR factory uninitialized (caller will fall back).
- `fresh_session_recovery_failed` — entrypoint threw (caller still falls back, but the error is captured for field triage).

User-facing notify: `glla: detected a stale ctx — auto-recovering with a fresh session (no /new needed).`

## Call sites (5)

All 5 `isStaleApiError` catch sites in the codebase:

| Site | File | Behavior |
|---|---|---|
| `retryContinuationDispatch` | `extensions/goal-continuation.ts:601` | auto-recover, fallback to terminal |
| `sendContinuation` | `extensions/goal-continuation.ts:769` | auto-recover, fallback to terminal |
| `sendStallEscalation` | `extensions/goal-continuation.ts:808` | auto-recover, fallback to terminal |
| `sendLengthContinue` | `extensions/goal-continuation.ts:838` | auto-recover, fallback to terminal |
| `sendLoopTurn` | `extensions/goal-loop.ts:372` | auto-recover, fallback to terminal |

Each follows the same pattern:

```ts
if (isStaleApiError(err)) {
  if (!attemptFreshSessionRecovery(ctx, "<where>")) goStaleTerminal(ctx, "<where>");
}
```

## Why not `ctx.reload()`?

Pi's error is explicit: "For reload, do not use the old ctx after await ctx.reload()". `/reload` shares the same cached ctx that just went stale — it's the exact wrong tool. `ctx.newSession()` is the only documented way to get a fresh ctx that the in-flight sends can use.

## Why not await `newSession()`?

The calling send has already raised the stale error — there is no `await` to cancel. We fire the call and return immediately so the terminal park is skipped. The session_start handler in `extensions/loops/goal-activation.ts` rehydrates the goal from `.pi-glla/goals/` automatically (same code path as a manual `/new`).

## Why not also call `await ctx.newSession()` in the catch?

Because the goal handler can fire on the new session_start before the catch's await resolves — that would re-bind a goal that the stale-ctx caught was about to park. Fire-and-forget is the safer ordering.

## Why not keep `goStaleTerminal` as the primary path?

User feedback: the terminal park + manual `/new` is exactly the UX wedge that the field report captured. The auto-recovery runs the same `session_start` rehydrate as a manual `/new` would, with no user intervention. The terminal park stays as the fallback when the `newSession` entrypoint is missing (older pi builds, future pi API changes).

## Tests

- New `tests/fresh-session-auto-recovery.test.ts` (4 source-pin tests): helper exported, factory-flags invariant, fallback semantics, all 5 call sites wired, notify text.
- `tests/stale-api-terminal.test.ts`: `both autonomous send paths detect staleness and auto-recover before terminal` (was: `go terminal`).
- `tests/length-continue.test.ts`: stale-api assertion updated to pin the auto-recovery pattern.

All 1192 tests pass (up from 1188 in v0.34.116), 0 fail, 1 skip.

## Out of scope (deferred)

- `attemptFreshSessionRecovery` does NOT call `ctx.reload()` — see "Why not `ctx.reload()`?" above.
- The terminal park is unchanged; the auto-recovery only adds a non-blocking path before it.
- `goStaleTerminal` itself is unchanged. Future work could add a "last-resort session replacement" sub-mode for when `newSession` is missing AND the user is on a known-new-enough pi — not part of v0.34.117.

## Diff summary

- `extensions/goal-recovery.ts` — +`attemptFreshSessionRecovery` (~50 lines incl. comments).
- `extensions/goal-continuation.ts` — 4 `isStaleApiError` sites updated to auto-recover-then-terminal; +1 import.
- `extensions/goal-loop.ts` — 1 `isStaleApiError` site updated; +1 import.
- `tests/fresh-session-auto-recovery.test.ts` — new file (4 tests).
- `tests/stale-api-terminal.test.ts` — 1 test renamed + updated to pin new pattern.
- `tests/length-continue.test.ts` — 1 assertion updated to pin new pattern.
- `CHANGELOG.md`, `package.json` — version bump to 0.34.117.