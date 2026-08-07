# Spurious-stale self-heal — the "long-session park" fix (v0.34.62, 2026-08-07)

## The bug (user report + screenshot 20260807_014658)

"In longer running sessions goal and list and loop no longer works — we
would need to restart first." The screenshot shows the park message:

    glla: this session is handing off to a fresh pi context - /list will
    be handled after session_start.

## Root cause (proven with the hegemon session's own ledger)

`/home/dracon/Dev/dracon-platform/web/games/wip/hegemon/.pi-glla/active.jsonl`:

- `2026-08-06T19:46:16Z` goal archived, reviewer fired, queue empty — session idle.
- `2026-08-06T20:06:34Z` `extension_api_stale {where: "heartbeat probe"}` —
  ONE heartbeat probe failure latched `extensionApiStale` permanently and
  parked the plane (`goStaleTerminal`).
- NO `session_shutdown`, NO `session_start` after it (pi's compaction emits
  only `session_compact`; the process never restarted — verified in pi's
  own source: `dist/core/agent-session.js` `session_compact` emissions and
  `agent-session-runtime.js` teardown paths).
- `2026-08-07T00:46:52Z` (5h later) the user typed `/list` — same session,
  same process → `tryAbsorbHostSuccessor` DELIBERATELY refuses same-session
  contact (`ctx.sessionManager === recordedOwner` → not a successor) →
  `list_mutation_refused_stale` → the screenshot.

The stale latch had exactly one recovery: `session_start` or restart. The
user's report was accurate. The running module was the pre-deploy published
0.34.57 (no `session_handle_invalidated` ledger events — confirmed by grep),
but the current repo code had the identical dead-end (diff of
`warnIfStaleAtEntry`/`goStaleTerminal`/`clearSessionOwnedTimers`/absorption
between the stale install and the repo: identical).

## The fix (v0.34.62, this repo)

1. **Heartbeat probe debounce** — `HEARTBEAT_STALE_DEBOUNCE = 3`: the
   heartbeat counts consecutive RAW probe failures (`probeExtensionApiStaleRaw`,
   extracted non-caching probe) and only declares the stale terminal at the
   threshold. A single transient failure (pi mid-settle, compaction settle,
   provider pause) no longer parks a live session. Cached
   `probeExtensionApiStale()` semantics unchanged everywhere else.
2. **Same-session self-heal** — `selfHealStaleSameSession(ctx)`, wired at the
   TOP of `rememberCtx` (before successor absorption; the two are mutually
   exclusive: heal = same session, absorb = different session). Un-parks
   when: parked AND `ctx.sessionManager === (ownerSession ?? deadOwnerSession)`
   AND rebind grace expired AND the owner file shows no successor instance
   AND the fresh probe is healthy. Reclaims the plane (generation bump,
   `stale_self_healed` ledger, heartbeat + UI ticker restart) and resumes the
   interrupted goal per the autoResume gate (hold-everything keeps the
   marker + asks for explicit resume; loops stay held). Refused for zombies,
   foreign sessions, inside `SESSION_REBIND_GRACE_MS`, and dead handles.

## Files

- `extensions/loops/goal.ts` — debounce + raw probe + `selfHealStaleSameSession`
  + rememberCtx wiring + streak resets (session_start, absorb) + test hooks
  (`__testOnlyHeartbeatTickRaw`, `__testOnlySetHeartbeatStaleDebounce`;
  `__testOnlyHeartbeatTick` keeps its single-tick terminal contract).
- `tests/stale-self-heal.test.ts` — 7 new tests (all green).
- `tests/stale-api-terminal.test.ts` / `tests/stale-interrupt-resume.test.ts`
  — source guards updated to pin the new debounced probe shape.
- `CHANGELOG.md` — Unreleased → 0.34.62 milestone.

## Gates

`bun test`: 944 pass / 1 skip / 0 fail across 84 files (was 938/1/0).
`npx tsc --noEmit`: clean.

## Deployment note

The runtime path `~/.pi/agent/npm/node_modules/pi-goal-list-loop-audit` is a
symlink to this repo (see audit/DEPLOYMENT-2026-08-06.md) — the fix goes
live on the next `/reload`. Existing parked sessions (e.g. hegemon) recover
as soon as a command is typed after reload (self-heal) — no restart needed
beyond the reload that picks up the new code.
