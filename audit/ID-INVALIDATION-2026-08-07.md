# ID Invalidation — repro attempt + the `id_invalidation` ledger event

**2026-08-07** · v0.34.73 · OPEN-ISSUES 1.12 · `Screenshot_20260805_121634.png`

## The symptom

The screenshot's warning (this is the field-observed incident behind OPEN-ISSUES
1.12):

> "Warning: glla: pi invalidated this session's extension handle without
> delivering a replacement session. glla stopped stale sends and kept the
> work safe in .pi-glla/. A fresh session_start will resume it; if pi does
> not create one, restart pi normally and glla will restore the saved work."

That is `goStaleTerminal` (extensions/loops/goal.ts). The invalidated identity
is the **session id** — `ctx.sessionManager.getSessionId()` (real pi ids are
UUIDs, e.g. `019fd67d-737b-782b-b135-0809ee55e248`). The user's note ("invalidated
id") + issue text ("a goal/list id was invalidated mid-flow, likely by a
session-handoff or a forced rewrite") both point at this mechanism. The
diagnostic gap: **the old session id was never recorded anywhere**, so when the
invalidation happened you could not tell which session was replaced by which.

## Repro attempt from active.jsonl history

Searched every `.pi-glla/active.jsonl` under `~/Dev` for the invalidation
event family (`extension_api_stale`, `session_handle_invalidated`,
`session_shutdown`, `session_rebound`, `rebind_resume`,
`session_rebind_via_live_ctx`, `zombie_stood_down`, `stale_self_healed`).

### ai-auto-writer (10 stale events, 2026-07-27 → 2026-08-05)

```
2026-07-27T10:25:39Z extension_api_stale {"where":"sendContinuation"}
2026-07-28T09:52:34Z extension_api_stale {"where":"sendContinuation"}
2026-07-30T06:45:09Z extension_api_stale {"where":"sendContinuation"}
2026-08-03T02:17:39Z extension_api_stale {"where":"heartbeat probe"}
2026-08-03T06:13:43Z extension_api_stale {"where":"heartbeat probe"}
2026-08-03T10:26:50Z extension_api_stale {"where":"heartbeat probe"}
2026-08-03T14:24:16Z extension_api_stale {"where":"heartbeat probe"}
2026-08-03T20:08:09Z extension_api_stale {"where":"heartbeat probe"}
2026-08-04T21:24:20Z extension_api_stale {"where":"heartbeat probe"}
2026-08-05T17:41:23Z extension_api_stale {"where":"heartbeat probe"}   ← screenshot day
```

The last one is the incident's day. The surrounding ledger confirms the
pattern: the stale handle is followed by **no replacement `session_start`** —
only a later user action closes the gap:

```
2026-08-05T17:41:23 extension_api_stale   (handle invalidated, orphaned)
  … ~11h of silence …
2026-08-06T04:41:29 session_shutdown quit
2026-08-06T04:41:32 session_rebound startup
2026-08-06T04:41:34 session_shutdown resume
2026-08-06T04:41:35 session_rebound resume
```

**Finding:** the invalidation mechanism reproduces cleanly from history — 10+
occurrences, each `extension_api_stale` (heartbeat probe / sendContinuation)
→ orphan → rebind on a later user action. The goal id was stable throughout
(`20260803020433-gbb7xn`, complete) — **the invalidated id is the session id,
not the goal id**.

**Gap confirmed:** no `session_handle_invalidated` (v0.34.57+) and no
`id_invalidation` exist in any ledger, and the owner sidecar
(`.pi-glla/session-owner.json`) holds only the CURRENT owner id
(`ownerSessionId: 019fd67d-…`). For PAST incidents the old/new pair is
unrecoverable — exactly the missing data the issue asked for.

### dracon-platform (21+ stale events)

Same shape: 21 `extension_api_stale` entries 2026-07-31 → 2026-08-02, all
`heartbeat probe` / `sendContinuation` / `entry probe (/list)`, each orphaned
until a later user-driven rebind.

## The fix: `id_invalidation` ledger event (v0.34.73)

On the next forced rewrite/handoff, the pair is recorded so a repro from
history becomes possible:

```
id_invalidation {
  oldId,             // the invalidated session id (owner sidecar previous id,
                     // or the recorded in-memory owner's id)
  newId,             // the fresh session id
  reason,            // which mechanism invalidated the handle
  shutdownReason?,   // raw sidecar shutdown reason ("quit", …) when clean
  goalId?,           // correlation — the active goal id when one exists
  at,
}
```

- **Emission point 1 — `session_start` rebind**: after
  `claimSessionOwnerAndDetectRebind` reads the owner sidecar, when the
  previous owner's recorded id differs from the fresh session's id. The
  reason comes from `classifyIdInvalidationReason`:
  `stale_terminal` | `zombie_stood_down` | `rebind_without_shutdown` |
  `session_shutdown` | `forced_rewrite` (a new process took over with NO
  shutdown record — the crash/kill/orphan case) | `session_handoff`.
- **Emission point 2 — successor absorption** (`tryAbsorbHostSuccessor`):
  the silent-swap handoff (live file-backed successor, no session_start)
  records `reason: "successor_absorption"` when the id changed.
- **Fail closed**: both ids must be real and differ. A plain `/reload` keeps
  the same session id → no event. `unknown-session` (no `getSessionId`) is
  never recorded. First boot (no sidecar) → no event.

The audit trail now reads: old ledger has `extension_api_stale` +
`session_handle_invalidated` (at terminal) → new ledger has `id_invalidation
{oldId, newId, reason}` (at rebind) → the full story reconstructs from disk.

## Evidence

- `tests/id-invalidation.test.ts` (7 tests): reason classifier pins; the
  forced-rewrite repro (sidecar with foreign pid, no shutdown record →
  `forced_rewrite` + goalId correlation); clean shutdown →
  `session_shutdown` + raw `shutdownReason`; same-id reload → no event;
  first boot → no event; absorption source pin; unknown-session fail-closed.
- Suite: 992 → (see final count) pass, 0 fail; `tsc` clean.
- The mmx vision CLI (v0.34.72's routing) was used to read the screenshot —
  the workflow this issue's fix enables.
