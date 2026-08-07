# Status-surface separation: paused list item vs active session — v0.34.87

**Date:** 2026-08-07 · **Goal:** `20260807201658-22jhek` (queue item: status-surface separation)

## Field finding

note.md # "pause state shows while working" — Screenshots 161659/161718:

- `∴ Working…` (session-level, pi's own turn indicator) shown alongside
  `list item · paused · 1h 31m` (goal-level) and `⏵ auditor: blocked — no
  verdict`.
- The glla status line claimed `glla: MAIN HOST · SUPERVISING · auditor
  blocked — no verdict` while the same card read `paused`.
- `complete_goal` answered `No active goal.` while the widget clearly held a
  paused item.

The status bar mixed session-level activity (active) with goal-level state
(paused) — two contradictory surfaces at once.

## Boundary of what glla controls

`∴ Working…` / `⏵ working…` is pi CORE's own session indicator (rendered
while a turn generates). A plugin cannot and should not hide it — the session
IS generating. The fix is on glla's side: no glla surface may claim goal
activity while the item is parked. After this change, any pi "Working…" reads
as session-generation, never as goal work — glla's own surfaces say
"paused · … · /list resume" ("session idle, awaiting /list resume" in glla's
voice).

## Fix (v0.34.87) — three surfaces

1. **Status line — paused + audit-no-verdict** (`extensions/goal-loop-display.ts`,
   `isCompletionAuditNoVerdict` branch): was `glla: MAIN HOST · SUPERVISING ·
   auditor blocked — no verdict` (host-bearing, claimed supervision). Now:
   `glla: ⏸ paused · auditor parked — no verdict · /list resume` (goal
   policy) / `/goal resume` (goal policy), plus ` · N queued` when the queue
   is non-empty. A parked item is deliberately NOT host-bearing anymore —
   the v0.34.57 `MAIN_HOST_LABEL` guard still covers host-bearing states
   (auditing); the paused state renders no host label at all.

2. **Widget card** (same branch): `auditor: blocked — no verdict` →
   `auditor: parked — no verdict`; `MAIN host remains attached; the
   completion claim was not evaluated` → `the stored completion claim was
   not evaluated — the audit waits while the item is paused`; the fallback
   action line gains the "exactly one fresh auditor" wording it already had
   when a suggested action was present. "Parked" is the surface-separation
   vocabulary: the auditor is NOT failing, it is parked with the stored
   claim — "blocked" read as live failure next to `⏸ paused`.

3. **`complete_goal` response on a paused goal** (`extensions/loops/goal.ts`
   complete_goal handler): the flat `No active goal.` (which read as if the
   paused card were nothing at all) becomes, for a paused goal:
   `No active goal — the goal is paused; /goal resume reactivates it
   (complete_goal only runs on an active item).` (list policy names
   `/list resume` + "list item"). Other non-active statuses get
   `No active goal — it is <status>.` The no-goal case keeps the flat text.

## Files

- `extensions/goal-loop-display.ts` — status line + widget card parked
  rendering (`isCompletionAuditNoVerdict` branches).
- `extensions/loops/goal.ts` — complete_goal paused response.
- `tests/display.test.ts` — the old "released auditor no-verdict state names
  the attached MAIN host" test rewritten to parked semantics (+ list-policy
  variant with queue count); the v0.34.57 MAIN_HOST_LABEL guard test's
  no-verdict case updated (paused = not host-bearing; the guard invariant
  still iterates the host-bearing auditing renderings).
- `tests/mode-command-guidance.test.ts` — fallback action wording pinned
  ("exactly one fresh auditor").
- `tests/behavioral-orchestrator.test.ts` — cold-start hold test pins the
  parked card; +1 new MockPi test: complete_goal on a paused goal names the
  pause + resume verb and leaves the parked goal untouched.

## Suite

1087 pass / 1 skip / 0 fail across 100 files (was 1085/1/0). tsc clean.
