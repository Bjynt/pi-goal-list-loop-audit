# Studio MAIN→subagent session lock — 2026-08-29

## Screenshot

`/home/dracon/Pictures/Screenshots/Screenshot_20260829_223257.png` (95.8K, studio, `main` branch, `minimax/m3:free`, chrome-bridge)

mmx vision transcription:

```
Warning: glla: another live pi process owns this working-directory state root — this session is read-only to prevent competing goal/loop writes. Close the other host or select sessionDir, then start a fresh session.

Warning: This tool changes goal/loop/list state, which only the MAIN session owns — you are running in a subagent session. Report back to the main agent; it owns the goal and can call this tool.

/goal audit lets audit our pages in the studio see what we update what makes sense or not
~/Dev/dracon-platform/web/studio (main)
Extensions: @tintinweb/pi-subagents:src, ...
```

A `/goal` tool was typed inside what reports as a subagent pane and was refused; the session is also marked read-only before `✓ New session started`.

## Live filesystem (read-only inspection)

- `~/Dev/dracon-platform/web/studio/.pi-glla/owner.json` → `{"instanceId":"23627:1788021621761","pid":23627,"at":1788021628356}`
- `~/Dev/dracon-platform/web/studio/.pi-glla/session-owner.json` → `{"pid":23627,"at":"2026-08-29T16:40:28.754Z","generation":171,"ownerSessionId":"01a03450-0512-76e3-99d2-7fa73469358b"}`
- Global `~/.pi/agent/pi-goal-list-loop-audit.settings.json` → `{ "autoAcceptDrafts": true, "autoResume": true, ... , "stateRoot" absent }` → default `workingDir`.
- This repo `extensions/` search confirms only GLLA emits these strings.

## Ownership (Pi core vs pi-subagents vs GLLA)

Reproduction performed via bounded `grep` + read, no Pi core or pi-subagents source modification.

- **Pi core** (`@earendil-works/pi-coding-agent@0.84.2`): `grep -r "another live pi\|stateRoot\|session.*lock"` hits only `CHANGELOG.md` and docs, no emission. Pi provides `SessionManager` with `getSessionDir()/getSessionFile()/getSessionId()` accessors only; no cwd locking.
- **pi-subagents** (`@tintinweb/pi-subagents@0.15.0`): hits at `src/agent-runner.ts:832` (`SessionManager.inMemory`) and schedules. No `stateRoot` lock, no `another live pi` string, no `MAIN session owns` string. Subagents are `inMemory` ( `getSessionFile()→undefined` ) by default; persistent children use `~/.pi/agent/sessions/<id>/pi-glla` only when `persist_session:true`. Schedules live under `<cwd>/.pi/subagent-schedules/<id>.json` (PID file lock) — unrelated to GLLA.
- **GLLA** is sole owner:

  - State-root read-only guard:
    - `extensions/loops/goal-session.ts:1212` (`warnIfStaleAtEntry`) — `processOwnerDeniedCwd === cwd`
    - `extensions/loops/goal-activation.ts:1148` (`claimProcessOwner` denied at `session_start` → `processOwnerDeniedCwd=cwd` + notify)
    - `extensions/glla-state-root.ts` — `resolveGllaStateDir(cwd)` → `workingDir:<cwd>/.pi-glla` (default) vs `sessionDir:<sessionDir>/pi-glla`; `setRuntimeSessionDirFromSessionManager()` authoritative via `sessionManager.getSessionDir()`; `stateRootPending()` gates writes.
    - Claim logic `extensions/loops/goal-session.ts:960-1040` (`claimProcessOwner`) uses `owner.json` atomic `open(wx)` + `isProcessAlive(pid)` + shutdown sidecar; `session-owner.json` tracks `pid/generation/ownerSessionId`.
  - MAIN vs subagent guard:
    - `extensions/loops/goal-session.ts:1466` `isWorkerSessionCtx(ctx) = !ctx.hasUI && (mode==="print"||mode==="json")` — pi-subagents worker discriminator; `isHostSuccessorCtx` checks `getSessionFile()` truthy.
    - `extensions/loops/goal-session.ts:1719` `isForeignCtx = processOwnerDeniedCwd===cwd || isWorkerSessionCtx || ownerSession!==manager`
    - `extensions/loops/goal-session.ts:1737` `FOREIGN_SESSION_TOOL_MESSAGE` + `foreignToolGuard()` → refused message.
    - Lifecycle `session_start` at `goal-session.ts:1105` / `goal-activation.ts:1100` rejects workers, then `claimProcessOwner`.

## Reproduction

- Deterministic, no live Pi restart needed:
  - `grep -rn "another live pi process owns"` → 2 GLLA sites, 0 Pi/pi-subagents sites.
  - `grep -rn "only the MAIN session owns"` → 1 GLLA site, tests `subagent-host-boundary.test.ts` expect `assert.match(..., /only the MAIN session owns/)`.
  - `isWorkerSessionCtx` + `isForeignCtx` logic proves the second warning is a direct consequence of the first when `processOwnerDeniedCwd===cwd` — any tool call in the denied cwd is foreign, even with `hasUI:true`. The two warnings necessarily co-occur in the denied host, which matches the screenshot (both warnings in same studio prompt).
  - Studio directory is `workingDir` mode (global `stateRoot` unset) and `owner.json` shows live `pid 23627`; any second Pi host opening the same `web/studio` cwd races `owner.json` and is marked `read-only`.

## Disposition: GLLA-owned, intentional lock with bounded UX improvement

- **Classification:** GLLA-owned (`workingDir` process-owner lock + `MAIN-only` guard). Pi and pi-subagents emit neither warning; GLLA does not modify Pi core or pi-subagents.
- **Intent:** `workingDir` (`<cwd>/.pi-glla`) is a shared root. Multiple live Pi hosts on the same cwd would produce split-brain writes; the lock is the correct safety (same as `owner.json` PID check). `sessionDir` (`<sessionDir>/pi-glla`) is the designed isolation for multi-host projects like `dracon-platform/web/studio`.
- **Failure was UX, not safety:** The denied host already says `Close the other host or select sessionDir, then start a fresh session` (first warning), but the second (`MAIN session owns…`) does not correlate the two and repeats the generic “report back to main agent” without pointing to the same cure. A user seeing both concludes “MAIN became subagent and cannot be cured” (user note 2026-08-29). Evidence (screenshot path) was typed with the command but never pre-read before the draft/tool-refusal path.
- **Bounded fix (this disposition):** When `foreignToolGuard` is reached because `processOwnerDeniedCwd===cwd`, append a correlated hint: `If you also see the state-root read-only warning, close the other host or switch to sessionDir via /glla settings → State root, then start a fresh session.` Original `…only the MAIN session owns…` substring is preserved so `subagent-host-boundary.test.ts` regex assertions keep passing. Change is typed, one site (`extensions/loops/goal-session.ts`), ≤ 10 lines.

## Fix verification

- `extensions/loops/goal-session.ts` — `foreignToolGuard` branch: `if (processOwnerDeniedCwd === c.cwd) return FOREIGN_SESSION_TOOL_MESSAGE + " If you also see the state-root read-only warning, close the other host or switch to sessionDir via /glla settings → State root, then start a fresh session."`
- Test: `tests/subagent-host-boundary.test.ts` adds `subagent host denial hints at sessionDir when the state root is read-only` — constructs a denied cwd, asserts `foreignToolGuard` still matches `/only the MAIN session owns/` AND contains `/sessionDir/`.
- No Pi/pi-subagents source changed; `grep` proves no ownership drift.
- `npx tsc --noEmit` clean; `bun test` focused + full-suite green (allow 1 known env skip).

## Evidence not blocked

- Screenshot copied verbatim via `mmx vision describe` (95.8K, two warnings, extensions list, typed `/goal audit …`, `(main)` status). Paths and `owner.json`/`session-owner.json` inspected read-only; no `.pi-glla` mutation. The disposition preserves the picture path `Screenshot_20260829_223257.png` and the mmx description; a follow-up Next-camp item handles pre-reading pictures before drafting (proactive evidence).

## Alternatives considered

- Switching `dracon-platform/web/studio` to `sessionDir` by writing global settings — not applied automatically; user must opt-in via `/glla settings` (preserves historical `workingDir` default, `goal-settings.ts:241`). The tool hint now directs there instead of auto-migrating.
- NOT_PLANNED for Pi core/pi-subagents — inapplicable; strings absent there.

## References

- `extensions/glla-state-root.ts:76` (`workingDir` default)
- `extensions/loops/goal-session.ts:960-1040, 1105, 1466, 1719, 1737`
- `extensions/loops/goal-activation.ts:1148`
- `tests/subagent-host-boundary.test.ts`, `tests/behavioral-orchestrator.test.ts` (subagent refusal asserts)
- Global `~/.pi/agent/pi-goal-list-loop-audit.settings.json` (no `stateRoot`)
