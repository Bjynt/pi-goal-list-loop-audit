# Visual auditor fresh pictures — 2026-08-29

## Problem

Visual problems passed through approval because the detached auditor reused the stale image description from `completion_summary` / `verification_summary` instead of looking again. `note.md` Next camp and the verification contract for `20260829220718-nbd2ux` required: for goals touching UI/screenshots the auditor captures a fresh screenshot via mmx/chrome, critiques it, and feeds the critique back into the verdict, pinned by a test/fixture.

## Investigation

* `extensions/goal-loop-auditor.ts:buildGoalAuditorPrompt` told auditor to "Use read/grep/find/ls/bash … inspect real artifacts" with zero vision/mmu/chrome language (grep 0 hits). `AUDITOR_TOOLS = ["read","grep","find","ls","bash"]` in `goal-loop-auditor-process.ts:514` and worker spawn `--tools read,grep,find,ls,bash` never allowlisted chrome; `bash` is the only fresh-capture path (`mmx vision describe`).
* No classifier existed for visual goals — grep `visual|screenshot|UI goal` across auditor files returned 0. `vision-assist.ts` pure routing (`VISION_ASSIST_GUIDANCE`, `routeVisionCheck`, `visionDescribeCommand`) was executor-only, injected via `goal-continuation.ts:1254` into continuation prompts, not into the auditor.
* `.pi/chrome-screenshots/` and `audit-*/screenshots/` are gitignored; old evidence evaporates when `.pi-glla/audit-jobs/<attempt>` is removed on settle.

## Solution

`extensions/goal-loop-auditor.ts`:

* `VISUAL_GOAL_RE = /(visual|screenshot|picture|image|chrome|\bui\b|page|render)/i` and `export function isVisualGoal(goal: Goal): boolean` checks `objective + verificationContract`.
* `buildGoalAuditorPrompt` injects a conditional block when `isVisualGoal(goal)`:

```
VISUAL AUDIT — FRESH EVIDENCE REQUIRED:
This goal touches UI/screenshots. Before deciding, capture a FRESH screenshot via
`mmx vision describe --image <path> --quiet --non-interactive` (or a fresh chrome screenshot) for the current UI state,
critique what is shown versus the objective, and include that critique VERBATIM inside your <evidence> for the visual contract item.
Do NOT reuse stale image descriptions from the completion summary — the fresh capture is mandatory evidence.
Example: `mmx vision describe --image /home/dracon/Pictures/Screenshots/latest.png --prompt "Does the UI match the objective?" --quiet --non-interactive`
```

Placement is after `REGRESSION SHIELD RETRY` and before `Audit checklist:` so it is part of the prompt but does not disturb checklist numbering. Tool allowlist unchanged — fresh capture is a `bash` call (`mmx vision describe …`), already permitted.

## Verification

* `tests/visual-auditor-fresh.test.ts` 4/4:
  1. `isVisualGoal` detects visual/screenshot/UI/picture/image/chrome/page/render and rejects non-visual (loop measure, proactive gathering)
  2. visual prompt injects `VISUAL AUDIT — FRESH EVIDENCE REQUIRED` + `mmx vision describe --image` + `chrome screenshot` + `critique what is shown` + `Do NOT reuse stale…` + `<evidence>` still required
  3. non-visual prompt keeps original without fresh capture
  4. fixture pins exact `mmx vision describe --image <path> --quiet --non-interactive` flag set and example
* `npx tsc --noEmit` clean.
* No model switch — helper is pure prompt text; `grep setModel goal-loop-auditor.ts` only pre-existing export.
