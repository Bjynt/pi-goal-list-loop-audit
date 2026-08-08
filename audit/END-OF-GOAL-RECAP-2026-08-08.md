# End-of-goal voice says WHAT HAPPENED

Date: 2026-08-08 · Version: 0.34.91 · Type: UX fix (summary content)

## The report

Three screenshots in a row, all from different projects, all calling out the
same thing:

- `Screenshot_20260808_012905` (deathrun) — terminal goal card
  `✓ <objective> ✓ complete · took 1m 22s └ auditor approved (minimax/MiniMax-M3)`
  — echoes the objective, says nothing about what happened.
- `Screenshot_20260808_013220` + `013515` (polis) — three near-identical
  boilerplate lines ("Completion claim persisted; detached auditor queued…"
  / "Auditor queued (detached worker, model: session)…" / "Completion claim
  persisted; detached auditor queued.") + a "Goal complete — auditor X
  approved" notify + the agent's own prose recap ("Goal … SHIPPED
  summary: …"). The plugin's surfaces were all process boilerplate; the one
  useful recap was agent-prose luck, not a plugin surface.

User: "another pretty much useless summary so this is systemic … another
useless complete we need good information."

## The shape of the problem

Across every terminal goal surface the plugin owned, the voice said the same
thing — *that* a goal ended, not *what happened in it*:

| Surface | Before v0.34.91 |
|---|---|
| Widget terminal line | `─ ✓ done · <objective> · took X` |
| Status bar | `glla: ✓ done · took X` |
| Detached-audit settle chat notify | `Goal complete — auditor X approved.` |
| External notify | `Goal complete (auditor approved): <objective slice>` |
| Goal `.md` archive | only the objective + verdict |
| Complete_goal tool response | "Completion claim persisted; detached auditor queued…" |

The agent's own closing prose (`Goal … SHIPPED summary: …`) was the only
surface carrying actual information — and it only appeared when the agent
chose to write one, which was inconsistent and depended on the agent's mood.

## Fix

The agent already passes a 1-paragraph `completionSummary` to `complete_goal`.
v0.34.91 makes that recap the plugin's end-of-goal voice — captured on the
goal at claim time, surfaced on every terminal surface, and written into the
archive.

- `Goal.completionSummary?: string` (extensions/goal-loop-core.ts) —
  persisted with the goal at `complete_goal` time via
  `updateGoal({ completionSummary, pendingTasks: undefined })`.
- Widget terminal line → `─ ✓ done · <recap> · took X`
  (extensions/goal-loop-display.ts `completedGoalLines`); objective only as
  fallback when no recap was captured (legacy/aborted).
- Status bar keeps `glla: ✓ done · took X` — the status bar segment budget
  can't hold a recap and the recap already lives on the widget line.
- **Fresh complete_goal detached approve** (extensions/loops/goal.ts, the
  `void (async () => { … runDetachedCompletionWithFallback … })()` IIFE,
  ~:7200) — added `ctx.ui.notify(✓ done: <recap> — auditor X approved.)`.
  Previously this path had NO chat notify at all (only the external
  notify + the tool result); the recap-carrying notify closes the gap.
- **Quota-retry / session-recovery approve** (retryStoredCompletionAudit,
  ~:4457) — changed `Goal complete — auditor X approved.` →
  `✓ done: <recap> — auditor X approved${approvalVia}.`.
- **Tool-path /goal verify approve** (~:7211) — added the same recap
  chat notify (was notifyExternal-only).
- External notifies on both paths: `displaySlice(recap, 120)` instead of
  `displaySlice(objective, 120)`.
- `renderGoalMarkdown` (extensions/goal-loop-core.ts) — new
  `## Completion summary` section between the Objective and Verification
  contract, so the durable archive .md carries the full-length recap (the
  widget shows a truncated line; the .md has the whole thing).
- Recap captured **before** `archiveCurrentGoal` (which mutates
  `state.goal`). `displaySlice(s, 110)` truncates for the chat notify;
  `displaySlice(s, 120)` for the external notify.

## Why the captured-recap design

The agent writes a 1-paragraph recap at complete_goal time as part of the
audit claim contract — it's already in the tool API (`complete_goal`'s
`completionSummary`). Persisting it on the goal means every downstream
surface (widget, notify, archive) reads the same source of truth, and the
plugin doesn't have to derive a recap from telemetry. The objective echo
remains the fallback for legacy goals and for aborted runs (where the
abort reason already carries the story).

## Tests (4 new)

- `tests/display.test.ts` v0.34.91 — completed-goal widget line shows the
  recap, not the objective echo; whitespace-only recap falls back to
  objective.
- `tests/goal-loop-core.test.ts` v0.34.91 — `renderGoalMarkdown` includes
  `## Completion summary` when the recap is set; no empty section when
  absent.
- `tests/behavioral-orchestrator.test.ts` v0.34.91 — detached-approval
  chat notify contains the recap, not the process-only line; v0.34.22
  approval test gains a recap assertion.
- `tests/revision-bound-audit.test.ts` — assertion that
  `complete_goal` persists `completionSummary` on the goal at claim time.

## Verification

- Suite: **1097 pass / 1 skip / 0 fail across 100 files** (was 1093),
  tsc clean.
- Both projects (deathrun, polis) are running installed builds ≤ 0.34.89;
  the v0.34.89 → v0.34.91 fixes are invisible until the npm release
  (0.34.82–0.34.91 are unreleased in-tree; awaiting user opt-in to
  publish + tag + `gh release create`).

## Files touched

- `extensions/goal-loop-core.ts` — Goal.completionSummary, renderGoalMarkdown
  recap section.
- `extensions/goal-loop-display.ts` — completedGoalLines uses recap.
- `extensions/loops/goal.ts` — complete_goal captures the recap; fresh
  detached approve (IIFE), quota-retry approve (retryStoredCompletionAudit),
  and manual-verify tool-path approve all notify `✓ done: <recap> …`;
  external notifies use the recap.
- `tests/display.test.ts`, `tests/goal-loop-core.test.ts`,
  `tests/behavioral-orchestrator.test.ts`, `tests/revision-bound-audit.test.ts`.
- `CHANGELOG.md`, `package.json` → 0.34.91.

## Left as-is

- The complete_goal tool response ("Completion claim persisted; detached
  auditor queued…") stays as-is — it's the tool contract returned to the
  agent, not a chat message; the recap already lands via the chat notify
  at settle and on the widget.
- The "Auditor disapproved" / "Impossible" / "Regression shield blocked"
  notifies keep their process-oriented copy — those messages exist to
  tell the user what to *do next*, not to recap what happened.
