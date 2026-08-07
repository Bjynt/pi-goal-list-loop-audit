# Host session lost — timeline, root cause, diagnostics, pi-side finding

**2026-08-07** · v0.34.75 · note.md recurring · 13 screenshots 08-05 → 08-07

## The complaint

"host session lost" (note.md 08-05, 08-05 22:52 "still happenings", 08-06,
08-07). The goal-loop prints:

> "pi invalidated this session's extension handle without delivering a
> replacement session. glla stopped stale sends and kept the work safe in
> .pi-glla/. A fresh session_start will resume it…"

13 screenshots document the recurrence:
`Screenshot_20260805_{075011,075534,210913,225218,225654}`,
`Screenshot_20260806_{081938,115901,115858,202231,223602,224030,224133}`,
`Screenshot_20260807_093742`.

## Timeline reconstruction (from `.pi-glla/active.jsonl`)

Swept every ledger under `~/Dev` for the session-lifecycle event family
(`session_handle_invalidated`, `extension_api_stale`, `session_shutdown`,
`session_rebound`, `stale_self_healed`, `zombie_stood_down`) across
08-05T00:00 → 08-08T00:00:

| measure | count |
|---|---|
| `session_shutdown` / `session_rebound` pairs | 515 / 522 (healthy lifecycle cycles) |
| `extension_api_stale` (the terminal entry) | 164 across ~14 projects |
| `session_handle_invalidated` (v0.34.57+ structured event) | 23 — **ALL on 08-07** (deploy day), **all `reason: "unknown"`** |

### Pattern 1 — host-wide bursts align with session cycles

Clustering the stale/invalidated events into distinct minutes gives ~45
host-wide bursts over the 3 days. **Every burst with ≥3 simultaneous events
across projects sits within ~2 minutes of a `session_shutdown` +
`session_rebound` pair** (quit/reload/resume/new). Example (08-05 morning):
`03:47, 04:07, 04:19, 04:49, 04:54, 05:04, 05:34, 06:28, 07:10` — each next
to `session_shutdown:reload` / `session_shutdown:quit` events. These are the
tails of the user's rapid session cycling, not silent losses — the loop was
correctly going terminal on handles whose sessions were being replaced.

### Pattern 2 — single-project silent deaths (the real losses)

The same-second multi-project events are the symlinked node_modules copies;
the distinct signal is a project whose OWN ledger has an invalidate with NO
preceding shutdown. Verified case (deathrun, 08-07T01:02:54):

```
01:02:54.066 extension_api_stale {"where":"heartbeat probe"}
01:02:54.067 session_handle_invalidated {"where":"heartbeat probe","reason":"unknown"}
```

— no `session_shutdown` in deathrun's ledger before it (the 00:58
shutdown/rebound pairs were other projects). The handle died silently; the
loop declared the loss; the user saw the warning.

### Pattern 3 — orphan gaps

The worst field cases are orphans: the 08-05T17:41:23 stale in ai-auto-writer
with an **11-hour gap** before the next session event, and the hegemon
08-06T20:06 case (in the code comments): a single heartbeat probe failure
latched the terminal and held the session in "handing off to a fresh pi
context" for ~5h with NO `session_start` ever arriving (compaction emits only
`session_compact`) — the only recovery was a restart.

## Root cause (pi-side, with glla-side classification)

- **pi-side**: pi invalidates the extension handle without delivering either a
  replacement `session_start` (rebind) or a `session_shutdown` lifecycle event
  for the affected session. From the extension's perspective the handle just
  dies; the generic stale error carries no cause. The 08-05 11h orphan and the
  hegemon 5h hang are the two worst instances.
- **glla-side (pre-v0.34.75)**: `goStaleTerminal` wrote
  `session_handle_invalidated` with a hardcoded `reason: "unknown"` (v0.34.57)
  — the ledger could not separate "proper session cycle tail" from "genuine
  host loss", so every recurrence looked identical and the pi-side finding
  could not be quantified.

## The diagnostics change (v0.34.75)

`session_handle_invalidated` now carries a reason **classified at emission**
from what the loop already knows:

```ts
reason: classifySessionHandleInvalidation({
  sessionHandoffPending,          // clearSessionOwnedTimers ran → lifecycle shutdown
  mainModelRecoveryActive: mainModelRecoveryActive(),  // provider wall mid-flight
})
// → "session_shutdown" | "provider_disconnect" | "silent_handle_death"
```

Verified behaviorally:
- **Proper shutdown** (`session_shutdown` → `clearSessionOwnedTimers` nulls
  `lastCtx`): the heartbeat cannot and does not fire the terminal at all —
  the loop trusts the announced replacement; the next `session_start` consumes
  the handoff debt. No loss event. The `session_shutdown` branch only guards
  the rare race where a send-path stale error beats the shutdown handler's
  cleanup.
- **Silent death** (no shutdown): the terminal fires and the event says
  `silent_handle_death` — the ONLY class that emits in practice, i.e. exactly
  the signal the user's complaint is about.

Post-fix, the ledger separates the classes empirically: proper cycles → no
event; provider walls → `provider_disconnect`; genuine losses →
`silent_handle_death`. The 23 historical events stay `unknown` (pre-fix);
every future incident is classified.

## Pi-side finding (filed)

**File:** `audit/HOST-SESSION-LOST-2026-08-07.md` (this doc), cross-ref added
under note.md "host session lost".

1. When pi invalidates an extension handle, deliver a **replacement
   `session_start`** (rebind) or a **`session_shutdown` lifecycle event** for
   that session — "invalidated without delivering a replacement" should be
   impossible from the extension's perspective. Field cost: 11h orphan
   (ai-auto-writer 08-05) and ~5h hang (hegemon 08-06).
2. Compaction (`session_compact`) is emitted without a `session_start`
   sibling in some paths — a compaction that leaves the session handle stale
   must still deliver a session boundary event, or the loop cannot distinguish
   "compacting" from "lost".
3. The handle invalidation is host-wide (multiple project sessions invalidated
   at the same second) — when the host restarts, all extension handles should
   either die with the process (clean) or be re-created uniformly; the mixed
   state (some sessions rebound, some orphaned) is what produces the
   single-project silent deaths.

## Evidence

- `tests/host-session-lost.test.ts` (5 tests): pure classifier pins
  (session_shutdown | provider_disconnect | silent_handle_death + priority);
  behavioral silent-death (`invalidateHostSession` + `__testOnlyHeartbeatTick`
  → `reason: "silent_handle_death"`); behavioral shutdown-suppression (proper
  shutdown → NO loss event, shutdown recorded); source pins (emission uses the
  classifier, hardcoded `unknown` gone, enum exported).
- New test-only hook `__testOnlySetSessionReplacementUntil` (grace-window
  backdate), consistent with `__testOnlySetHeartbeatStaleDebounce`.
- Full suite green, `tsc` clean.
- Timeline data: `python3` sweeps of all `~/Dev/**/.pi-glla/active.jsonl`;
  screenshots read with the mmx vision CLI (v0.34.72 routing).
