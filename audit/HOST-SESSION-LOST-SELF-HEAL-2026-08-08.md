# v0.34.94 — Host-session-lost self-heal: heartbeat re-binds when raw probe says pi is fresh

## Why

Field evidence (Screenshot_20260808_080109, 080230, 080248 darklord /
hegemon): pi invalidated the extension handle WITHOUT delivering a
replacement session. The session_handle_invalidated ledger event was
emitted with `reason: "silent_handle_death"`. The plugin sat with
`staleTerminalDone=true` and `extensionApiStale=true` forever. The
only recovery was a manual pi restart.

### What "silent_handle_death" means

The v0.34.75 classifySessionHandleInvalidation helper classifies a
handle invalidation by what the loop knows at the moment of failure:

- `session_shutdown` — a lifecycle shutdown was pending
  (`sessionHandoffPending=true`). pi was about to deliver a fresh
  session_start; the invalidation is the tail of a proper session
  replacement. Recovery: consume the session-handoff.json in the new
  session.
- `provider_disconnect` — main-model provider recovery was active
  (`mainModelRecoveryActive()`). pi may have crashed the handle while
  the provider was failing. Recovery: the bounded envelope handles it.
- `silent_handle_death` — neither: pi invalidated the handle WITHOUT
  recording a shutdown AND WITHOUT delivering a replacement
  session_start. The plugin has no in-memory `ctx` to bind to and no
  `session-handoff.json` to consume. **This is the gap the user
  observed.**

The plugin's existing recovery flow waits for the next event from a
fresh ctx (`session_start`, `message_start`, `tool_call`, `agent_end`,
`tool_result`, `session_compact`). Each of those handlers calls
`tryAbsorbHostSuccessor(ctx, via)`, which checks `isHostSuccessorContact`
and absorbs the new ctx if it satisfies the conditions (file-backed
ctx, different session manager, recorded owner is dead or in
stale-terminal).

The gap: if pi delivers **no events** after the stale-terminal — the
user is sitting at a fresh prompt waiting, but pi isn't firing events
because no tool calls or messages are happening — the plugin never
gets a fresh ctx to absorb. The heartbeat tick is the only thing
running, and it returns immediately after `goStaleTerminal(...)`
because `extensionApiStale=true` blocks `freshCtx()`.

### Why the heartbeat's raw probe is the right evidence

`probeExtensionApiStaleRaw()` calls `extensionApi.getSessionName()`
and catches `isStaleApiError(err)`. When pi has internally replaced
the handle, `getSessionName()` either:
1. Throws the stale signature — probe returns true, heartbeat stays
   in stale-terminal (correct: don't self-heal a still-stale plugin).
2. Returns a fresh session name — probe returns false, the heartbeat
   proceeds (correct: pi recovered, unblock the plugin).

The probe is the ONLY signal glla has that doesn't require an event
from a fresh ctx. The heartbeat runs every `HEARTBEAT_INTERVAL_MS`
(15 seconds in production). So when pi recovers silently, the
heartbeat will know within ~15s.

## What changed

### `heartbeatTick` self-heal block (`extensions/loops/goal.ts:2091`)

After the raw probe returns false (pi is fresh) but `staleTerminalDone`
is still latched:

```ts
if (staleTerminalDone && knownCtx) {
  appendLedger(knownCtx.cwd, "stale_terminal_recovered_via_probe", { via: "heartbeat-self-heal" });
  staleTerminalDone = false;
  extensionApiStale = false;
  zombieStoodDown = false;
  sessionHandoffPending = false;
  try {
    knownCtx.ui.notify("glla: pi recovered after a stale-handle terminal — self-healing in-memory state (no /reload needed).", "info");
  } catch { /* ledger is durable; notify is best-effort */ }
  if (tryAbsorbHostSuccessor(knownCtx, "heartbeat-self-heal")) return;
}
```

The block:

1. **Records the self-heal** as a `stale_terminal_recovered_via_probe`
   ledger event so the recovery is observable in `.pi-glla/active.jsonl`
   even if the notify fails.
2. **Clears the stale flags** so `freshCtx()` can return a non-null
   ctx on the next call. `extensionApiStale=false` is the gate; without
   it, every downstream probe returns early.
3. **Tries to absorb** the host successor. If the recorded owner
   matches the knownCtx's sessionManager, the absorb is a no-op (the
   same session, no replacement happened). If they differ, the absorb
   succeeds and re-binds the goal plane to the new session.
4. **Notifies the user** with an `info` (not `warning`) — a self-heal
   is good news, not a problem.

### No blind queue storm risk

The self-heal block does **not** call `scheduleContinuation`,
`sendMessage`, or any send path. It only resets in-memory state. The
heartbeat's normal continuation/loop scheduling happens later in the
tick (and only when `isSupervising()` is true, which is gated by the
goal/loop status). A transient false-negative on the raw probe (pi
stutters the handle for one tick) lands in this branch and clears the
stale flag — but no sends are scheduled, so the queue doesn't spin.

The next heartbeat tick would re-probe; if the raw probe still says
fresh, the heartbeat continues normally. If pi stutters again, the
next probe goes stale-terminal again — and the user sees the normal
"stale handle" warning, not a queue storm.

### Why this is better than the alternatives

- **Simulated session_start** — would require calling
  `pi.on("session_start", ...)` handlers with a synthetic event from
  a fresh ctx we don't have. Not implementable: the plugin doesn't
  have access to pi's internal event dispatch from inside an
  extension.
- **Auto-reload** — would require calling `cmdReload` or similar to
  force a session replacement. Not implementable: glla doesn't have
  access to pi's command palette, and `extensionApiStale=true` means
  any pi call would throw.
- **Louder escalation** (re-notify) — would require calling
  `ctx.ui.notify()` from a stale ctx (throws). The notification has
  to come from a fresh ctx, which we don't have until pi delivers an
  event.

The self-heal block is the realistic middle ground: when the heartbeat
detects pi has recovered via the raw probe, it resets state so future
events from a fresh ctx land correctly. The user-facing outcome: the
plugin resumes responding to events within ~15s of pi's silent
recovery, with no manual restart needed.

## Safety analysis

| Concern | Mitigation |
|---|---|
| Raw probe false negative on transient miss | The next heartbeat tick re-probes; if pi stutters again, the heartbeat re-enters stale-terminal. The user sees the standard "stale handle" warning. No sends spin. |
| Raw probe false positive on a session that ACTUALLY is dead | `probeExtensionApiStaleRaw()` calls `extensionApi.getSessionName()`. If pi has invalidated the handle, this throws the stale signature. The probe only returns false when pi actually responds to the call. |
| Clearing `extensionApiStale=false` while the api is actually stale | If the next event delivery fails (stale signature), `extensionApiStale=true` is set again by the next probe or by `isStaleApiError` catches in the send paths. The flag is a state machine, not a one-way switch. |
| Self-heal absorbs a foreign ctx that shouldn't be absorbed | `tryAbsorbHostSuccessor` requires `isHostSuccessorContact(ctx)` — file-backed ctx, different session manager, recorded owner is dead or in stale-terminal, same cwd. All four conditions must hold. |
| The user sees a stale-terminal notification, then a self-heal notification, then ANOTHER stale-terminal notification as pi stutters | That's the correct user-facing behavior: each notification reflects a real state transition. The user knows the plugin is alive and trying. |

## Verification

| Check | Command | Result |
|---|---|---|
| Suite | `bun test` | **1105 pass / 1 skip / 0 fail** across 100 files |
| Types | `npx tsc --noEmit` | **exit 0** |
| Self-heal block present | `grep -A6 'stale_terminal_recovered_via_probe' extensions/loops/goal.ts` | matches |
| New test passes | `bun test tests/stale-api-terminal.test.ts` | **14 pass / 0 fail** (was 13) |
| Queue-storm guard test | the new test asserts the self-heal region contains NO `scheduleContinuation` / `sendMessage` | passes |
| `audit/HOST-SESSION-LOST-SELF-HEAL-2026-08-08.md` exists | `ls audit/HOST-SESSION-LOST-SELF-HEAL-2026-08-08.md` | matches |
| CHANGELOG entry present | `grep -A2 '### 0.34.94' CHANGELOG.md` | matches |
| package.json bumped | `grep version package.json` | `0.34.94` |

## Files touched

- `extensions/loops/goal.ts` — self-heal block in `heartbeatTick`
  (+18 LOC).
- `tests/stale-api-terminal.test.ts` — new test for the self-heal
  path (+24 LOC).
- `package.json` — 0.34.93 → 0.34.94.
- `CHANGELOG.md` — 0.34.94 entry.
- `audit/HOST-SESSION-LOST-SELF-HEAL-2026-08-08.md` — this doc.
verification: contract-literal marker — the checks below are the verification evidence for this version.
