# v0.34.98 — Paused-without-draft / decision surface: long-wait pauses (> 6h) surface a tweak offer

## Why

Field evidence (Screenshot_20260808_080402 hellhunter): a goal
paused with `kind="wait"` and `resumeAt=2026-08-08T02:00:00Z`. The
user couldn't unblock without re-issuing the same objective later.
A 6+ hour wait effectively locks the user out of progress for the
entire workday.

The fix is informational: the user has the tools to unblock (run
`/goal tweak "<new text>"` to replace the objective, or `/list
tweak` for list items) — but they have to remember the long wait
exists. The plugin should surface the option to pivot RIGHT NOW,
when the pause happens, so the user doesn't have to come back later
and re-derive the situation.

## What changed

### `pause_goal` execute (`extensions/loops/goal.ts:7633`)

When `kind === "wait"` or `kind === "blocked"` AND
`resumeAt - Date.now() > 6h`, the plugin surfaces a one-shot
notify:

> "Pause scheduled for ~Nh. If the objective no longer matches your
> intent, run /goal tweak to replace it now; otherwise /goal resume
> continues automatically when the wait ends."

The notify is best-effort (try/catch); the durable record is the
`pause_long_wait_offer_tweak` ledger event which records the
pause + hours.

### Gating

- Strictly `> SIX_HOURS_MS` (6h × 60min × 60s × 1000ms = 21,600,000 ms).
  6h exactly does NOT trigger — the boundary is conservative so a
  slightly-long wait doesn't spam the user.
- `kind` is one of `wait` (time-gated) or `blocked` (generic blocked
  with a resumeAt). Decision pauses (`decision` kind) don't carry a
  `resumeAt` — they need an explicit user pick — and are excluded.
- Pauses with NO `resumeAt` at all (kind="blocked" with no
  resumeAt) are excluded — the `Number.isFinite(resumeAtMs)` check
  fails closed.

### Why "offer, not auto-apply"

The user keeps full control:
- Ignore the offer → wait as planned (resumeAt triggers automatic
  resume)
- Run `/goal tweak "<new text>"` → replace the objective with a
  pivot; the paused wait is discarded
- `/goal resume` (manual override) → resume immediately, ignore
  the wait

Auto-applying would silently change the objective. The user said
"the work is paused" — auto-applying would invalidate that contract.

## Safety analysis

| Concern | Mitigation |
|---|---|
| The user just paused for a short wait (e.g., 30 min) — no offer should fire | The `> 6h` strict gate excludes short waits. Test pins `>` not `>=`. |
| A 6h wait fires repeatedly (every heartbeat tick) | The notify is in the pause_goal EXECUTE function, not the heartbeat. It fires ONCE per pause. The ledger event is the durable record of the single fire. |
| The user is overwhelmed by many paused goals → too many notifications | The offer is per-pause, not per-goal. If the user pauses 5 goals with 6h+ waits, they get 5 offers — same count as the pauses themselves. The "one notification per state transition" principle holds. |
| A decision pause (kind="decision") gets the offer | Decision pauses carry no `resumeAt` — the `Number.isFinite(resumeAtMs)` check fails closed. Decision pauses are user-driven, the user already picked a path. |
| The user wants to keep the wait but not see the offer | The notify is best-effort; the user can dismiss it. There's no auto-action, just information. |
| The tweak command changes the objective mid-wait | That's the WHOLE POINT of the offer — the user is told they can pivot now. The offer text explicitly says "If the objective no longer matches your intent". |

## Verification

| Check | Command | Result |
|---|---|---|
| Suite | `bun test` | **1116 pass / 1 skip / 0 fail** across 100 files |
| Types | `npx tsc --noEmit` | **exit 0** |
| SIX_HOURS_MS constant | `grep -n 'SIX_HOURS_MS = 6 \* 60 \* 60 \* 1000' extensions/loops/goal.ts` | matches |
| LongWait gate | `grep -n 'const longWait' extensions/loops/goal.ts` | matches |
| Notify text | `grep -A3 'Pause scheduled for' extensions/loops/goal.ts` | matches |
| Ledger event | `grep 'pause_long_wait_offer_tweak' extensions/loops/goal.ts` | matches |
| New tests pass | `bun test tests/pause-informativeness.test.ts` | **11 pass / 0 fail** (was 9) |
| Boundary: `>` not `>=` | the new test pins `> SIX_HOURS_MS` and asserts `>=` is absent | pass |
| CHANGELOG entry present | `grep -A2 '### 0.34.98' CHANGELOG.md` | matches |
| package.json bumped | `grep version package.json` | `0.34.98` |

## Files touched

- `extensions/loops/goal.ts` — longWait block + notify + ledger
  event (+30 LOC).
- `tests/pause-informativeness.test.ts` — 2 new tests (+30 LOC).
- `package.json` — 0.34.97 → 0.34.98.
- `CHANGELOG.md` — 0.34.98 entry.
- `audit/PAUSED-DECISION-SURFACE-2026-08-08.md` — this doc.