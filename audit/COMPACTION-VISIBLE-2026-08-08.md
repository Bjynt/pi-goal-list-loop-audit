# v0.34.97 — Compaction-not-visible-until-reload: '⏳ compacting…' chip paints while the grace window is open

## Why

Field evidence (Screenshot_20260808_003007/003024 ai-auto-writer):
222,368 tokens compacted mid-turn. The user only saw `[compaction]`
AFTER a reload — the session_compact event fired in-process but no
in-process UI surface told the user what just happened.

The root cause:
1. The `session_compact` handler in `extensions/loops/goal.ts:9858`
   does the right mechanical work (resets streaks, opens grace
   window, persists via the `session_compact` ledger event), but it
   NEVER calls `ctx.ui.notify` — the user has no chat signal.
2. The widget's status line had no `lastCompactionAt` field on
   `State` to surface — the chip couldn't be drawn even if the
   handler wanted to.
3. After a reload, the in-memory `compactionGraceUntil` and
   `lastCompactionAt` are GONE — the compaction is forgotten. The
   user re-reads the chat history and sees "[compaction]" without
   context.

## What changed

### State field `lastCompactionAt` (`extensions/goal-loop-core.ts:684`)

```ts
lastCompactionAt?: number;
```

Persisted via `persistState` (called by `session_compact` handler).
The chip's "X ago" timestamp survives reload.

### `session_compact` handler notify (`extensions/loops/goal.ts:9877`)

```ts
state = { ...state, lastCompactionAt };
persistState(ctx);
try {
  ctx.ui.notify(`glla: session compacting — stall counter reset, grace timer started. The widget will show ⏳ compacting… for the next 3 minutes.`, "info");
} catch {
  /* stale ctx best-effort */
}
```

The notify fires on EVERY session_compact event. If the ctx is
stale (post-replacement race), the try/catch swallows it — the
ledger event is the durable record.

### Status-line chip (`extensions/goal-loop-display.ts:668`)

When `state.lastCompactionAt` is within the last 180_000 ms (matches
`COMPACTION_GRACE_MS = 3 minutes`):

```
glla: ⏳ compacting… (30s ago)
```

The chip is rendered at the top of the active branch — it outranks
activity states. After the grace window, the chip disappears; the
session is back to normal.

## Safety analysis

| Concern | Mitigation |
|---|---|
| Spam on every compaction (a long session may compact many times) | The chip is single-line, single-frame — it REPLACES the activity badge for 3 minutes, not adds. The user sees one chip per compaction, not one per heartbeat tick. The notify is also single-fire (one notification per state transition, per the never-spam principle). |
| Stale ctx on the notify (post-replacement race) | Wrapped in try/catch; the durable `session_compact` ledger event captures the same information. |
| Reload during a compact (the chip vanishes) | `lastCompactionAt` is persisted on State — the chip reappears on reload with the correct "X ago" timestamp. |
| The chip confuses with a real activity badge | The chip uses ⏳ (hourglass) instead of the ⏸ (pause) or ● (active) glyphs. The label "compacting…" is explicit. Color: warning (amber), not success or error. |
| Multiple compactions in quick succession | Each compaction updates `lastCompactionAt` to `Date.now()`, so the chip's "X ago" resets to 0s. No compounding. |
| Grace window mismatch (display.ts has its own constant vs goal.ts's COMPACTION_GRACE_MS) | Both use 180_000 ms / 3 minutes. If goal.ts's constant changes, display.ts needs to be updated too — a follow-up could expose `COMPACTION_GRACE_MS` from goal-loop-core and import it in display.ts. Out of scope for v0.34.97. |

## Verification

| Check | Command | Result |
|---|---|---|
| Suite | `bun test` | **1114 pass / 1 skip / 0 fail** across 100 files |
| Types | `npx tsc --noEmit` | **exit 0** |
| Chip renders within grace | `bun test tests/display.test.ts` (v0.34.97 tests) | 3/3 pass |
| Chip vanishes past grace | (same) | pass |
| No chip without lastCompactionAt | (same) | pass |
| State field persisted | `grep -n 'lastCompactionAt' extensions/goal-loop-core.ts` | matches |
| Handler notifies | `grep -n 'session compacting' extensions/loops/goal.ts` | matches |
| CHANGELOG entry present | `grep -A2 '### 0.34.97' CHANGELOG.md` | matches |
| package.json bumped | `grep version package.json` | `0.34.97` |

## Files touched

- `extensions/loops/goal.ts` — notify + state persist (+12 LOC).
- `extensions/goal-loop-core.ts` — State field (+7 LOC).
- `extensions/goal-loop-display.ts` — chip render (+9 LOC).
- `tests/display.test.ts` — 3 new tests (+37 LOC).
- `package.json` — 0.34.96 → 0.34.97.
- `CHANGELOG.md` — 0.34.97 entry.
- `audit/COMPACTION-VISIBLE-2026-08-08.md` — this doc.