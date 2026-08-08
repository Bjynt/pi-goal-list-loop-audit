# v0.34.95 — Status transparency when parked on quota: '[QUEUED] 12m 26s · N queued' → '… · waiting for quota reset at HH:MM'

## Why

Field evidence (Screenshot_20260808_014303 darklord LIST-AUDIT-COLLECT):
the status line rendered `[QUEUED] 12m 26s` with no WHY — the user
couldn't tell whether the queue was stalled on quota, on a slow
provider, or just idle. The user's complaint was the queue state being
opaque: 12 minutes is a long time to wait without knowing what's
blocking.

The state shape that produces this output:
- `state.goal.status === "active"` (the goal plane is supervising)
- `activity === "queued"` (pi's session has a pending message but
  hasn't started a turn — usually because a continuation was just
  sent and the watchdog hasn't seen a turn-start event yet)
- `state.mainModelRecovery` is set (the bounded envelope is parked
  on a recoverable failure — typically quota)

The third state is the one the user can't tell apart from the other
two by looking at the status line.

## What changed

### `buildStatusText` quota suffix (`extensions/goal-loop-display.ts:698`)

When `activity === "queued"` AND `state.mainModelRecovery.retryAt` is
set, the status line appends `· waiting for quota reset at HH:MM` after
the queue depth:

```
glla: [QUEUED] 12m 26s · 5 queued · waiting for quota reset at 14:30
```

The new `formatClockTime(epochMs)` helper formats an absolute epoch
into local HH:MM (timezone-aware via `Date#getHours` / `getMinutes`).
The bounded envelope records `retryAt` as ISO; converting to local
HH:MM keeps the surface readable without inventing a relative-time
view (the existing `fmtElapsed()` covers live countdowns).

### When the suffix renders

Both conditions must hold:
- `activity === "queued"` — the user can't see that work is happening.
  If the badge is LIVE · WORKING or ACTIVE, the live state already
  names the work; showing quota text on top would be noise.
- `state.mainModelRecovery.retryAt` is set — the envelope is parked
  with a known next-probe time. If `retryAt` is missing (e.g., manual
  resume required), the suffix doesn't render.

### Why this is better than the alternatives

- **Chat prompt**: the v0.34.92 reversal removed the quota prompt
  entirely. We can't reliably detect quota shape from provider error
  text, and the chat message didn't earn its keep (Screenshot
  Screenshot_20260807_231717: 4 identical "Provider quota wall"
  messages from peer sessions).
- **Widget card rewrite**: the widget card already names the goal
  state, the activity state, and the queue depth. Adding a quota
  block to the widget would duplicate what's now on the status line
  AND clutter the card. The status line is the right surface because
  it's always visible, even when the card is hidden.
- **Status line emoji**: an emoji like ⏳ would say "waiting" but not
  WHEN. The user's actual question is "when does this unblock?" — the
  HH:MM answer is the high-value bit.

## Safety analysis

| Concern | Mitigation |
|---|---|
| `retryAt` is in the past (recovery has expired) | The status line just shows the past time. The user can read the queue depth (5 queued) and infer that the envelope needs `/list resume`. The bounded envelope handles this case via `setMainModelRecoveryPause` which updates `retryAt` on each pause. |
| `retryAt` is set but the envelope has cleared recovery | The `state.mainModelRecovery` check is on the live state — if the envelope cleared recovery, the field is undefined and the suffix doesn't render. |
| `formatClockTime` returns the wrong hour (timezone confusion) | The helper uses `Date#getHours` / `getMinutes` which returns LOCAL time. The user reading their terminal sees local time. Match is guaranteed. |
| The status line becomes too long with the suffix | The line is already truncated by pi's status-bar renderer; an extra ~25 chars stays within the typical 80-100 char budget. |
| A goal with no recovery gets the suffix (false signal) | The test `queued WITHOUT a parked recovery does NOT show quota text` pins this case. The suffix is gated on `state.mainModelRecovery?.retryAt`. |

## Verification

| Check | Command | Result |
|---|---|---|
| Suite | `bun test` | **1108 pass / 1 skip / 0 fail** across 100 files |
| Types | `npx tsc --noEmit` | **exit 0** |
| `formatClockTime` exists and is exported | `grep -n 'export function formatClockTime' extensions/goal-loop-display.ts` | matches |
| Queued + recovery → suffix renders | `bun test tests/display.test.ts` (v0.34.95 tests) | 3/3 pass |
| Queued without recovery → no suffix | (same) | pass |
| LIVE/WORKING with recovery → no suffix | (same) | pass |
| CHANGELOG entry present | `grep -A2 '### 0.34.95' CHANGELOG.md` | matches |
| package.json bumped | `grep version package.json` | `0.34.95` |

## Files touched

- `extensions/goal-loop-display.ts` — `formatClockTime` helper (+12
  LOC) + the `blockedByQuota` / `quotaSuffix` block in
  `buildStatusText` (+16 LOC).
- `tests/display.test.ts` — 3 new tests (+60 LOC).
- `package.json` — 0.34.94 → 0.34.95.
- `CHANGELOG.md` — 0.34.95 entry.
- `audit/STATUS-TRANSPARENCY-2026-08-08.md` — this doc.