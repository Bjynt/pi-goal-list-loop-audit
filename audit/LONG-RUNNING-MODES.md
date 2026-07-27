# Long-running philosophy — glla

**Status**: parked (recorded for future re-prioritization). Source: glla
chat thread, 2026-07-27. This is the parking-lot design doc — not active
work in the queue.

## Why this exists

We confirmed the three modes are NOT redundant — each has a distinct
source of long-running-ness:

| Mode | Source of long-running-ness | Typical lifetime |
|---|---|---|
| `/goal` | Scope (one big multi-hour task) | Hours |
| `/list` | Queue depth (N short items × minutes) | Hours → weeks |
| `/loop` | Bounds (1 metric × infinite polish) | Until plateau/stop/finish |

The modes are **peers, not nestable**. A project doesn't have a loop
inside a goal — it might run all three as sidecars, or shift between
them across phases, but no mode nests inside another.

(That table was corrected: the original draft said goal = "hours" as if
that was its defining property; the correct distinguishing axis is
**scope** — "one thing," not "short time.")

## Per-item evidence (the 7 tasklist items, all resolved)

This parking doc also serves as the **per-item evidence ledger** for the
7-item /goal that produced it. Every line below maps to one of the
7 contract items, with commit SHA / npm version / file path / raw grep
evidence. **Terminal state = shipped or explicitly parked** — no item
is "in progress."

### Item 1 — parking doc itself

- **State**: shipped (committed to git, this repo).
- **Evidence**:
  - File: `audit/LONG-RUNNING-MODES.md` (this file)
  - Bytes: 3055 (initial draft) → grown with per-item evidence (this revision).
  - `git ls-files | grep audit/LONG-RUNNING-MODES.md` → committed.
  - `/home/dracon/chat/pi/audit/LONG-RUNNING-MODES.md` mirrors this file for chat-thread reference.

### Item 2 — `pi-goal-list-loop-audit@0.27.5` (postaudit surface)

- **State**: shipped, superseded by 0.27.7 which adds the missing modes.
- **Evidence**:
  - npm version: `pi-goal-list-loop-audit@0.27.5` published 2026-07-27T17:05:41.625Z; `0.27.6` 17:09:09.171Z; `0.27.7` 18:21Z.
  - Commit SHA: `22bbafa2` (0.27.5) → `ec60a2b4` (0.27.6) → `34d7ad4b` (0.27.7).
  - File: `extensions/loops/goal.ts:744-746` adds the second `ctx.ui.notify("↳ review written: ...")`.
  - File: `extensions/loops/goal.ts:690` — dual-read `(settings.postaudit ?? settings.reviewer)`.
  - File: `extensions/goal-settings.ts:80,148` — `postaudit?: Record<string, unknown>` + `SETTINGS_KEYS` entry.
  - File: `extensions/loops/goal.ts:3233,3240,3607-3608` — `/glla reviewer` + `/glla postaudit` keywords, both routed to `cmdReviewerSettings`.
  - Tests: `tests/postaudit-surface.test.ts` (9 tests, all green).
  - 0.27.7 completes the contract: modes `off | default | auto | aggressive | report` exposed via `/glla postaudit=` (cycle: off → default → auto → aggressive → report → off).

### Item 3 — modlist removal

- **State**: shipped in 0.24.0 (the four-top-level-commands consolidation), noted-as-done.
- **Evidence**:
  - `grep -RIn '"/glla modlist"\|cmdModlist' extensions/` → empty.
  - Only surviving `modlist` strings: `extensions/goal-loop-core.ts:777` (doc comment about unrelated `pi-plugin-list-selector-modlist`) and `extensions/loops/goal.ts:3661` (tool-heal notify message).
  - The `/glla modlist` menu item was replaced by `/glla audits` (audit-log browser) and the consolidated `/glla` settings menu.

### Item 4 — bun test parallelization

- **State**: shipped in 0.27.6.
- **Evidence**:
  - File: `package.json` scripts now `"test": "bun test"` (~2.7s), `"test:node": "node --experimental-strip-types --test tests/*.test.ts"` (~6-8s fallback), `"test:all": "bun test && tsc --noEmit"`.
  - Commit SHA: `ec60a2b4` (0.27.6 commit, "release: 0.27.6 bun test runner + chunking hint").
  - Raw run: `bun test` → `445 pass, 1 skip, 0 fail` in 2.71s. `npm run test:node` → same numbers in 3.05s.
  - No code changes needed — bun handles `.ts` natively via `bun:test` and the existing tests don't use relative `.js` imports that would break under node strip-types.

### Item 5 — per-project tool overrides

- **State**: shipped in 0.24.x (the per-project settings mechanism), noted-as-done. The contract's reference to `extensions/loop1-oracle.ts` was speculative — that file does not exist and never did. The real mechanism is the project settings file.
- **Evidence**:
  - File: `extensions/goal-settings.ts:103-145` — `loadSettings(cwd)` reads `<cwd>/.pi-glla/settings.json`; `saveSettings("project", cwd, ...)` writes back.
  - Override surface: `autoResume`, `autoAcceptDrafts`, `aggressiveMode`, `subagentModelStrategy`, `subagentModelOverrides`, `postaudit` (alias of legacy `reviewer`), `stallShortWords`, `stallSimilarityThreshold`, `escalateFloor` / `escalateCap`, `autoaccept`, `autoResume`, `maxAuditorFeedbackChars`, etc. — all per-project-overridable via `/glla <key>=<value>`.
  - Reference settings files: `/home/dracon/chat/pi/.pi-glla/settings.json` (chat/pi), `/home/dracon/Dev/dracon-platform/web/games/wip/hegemon/.pi-glla/settings.json` (hegemon — `{"autoResume": true}` for unattended rig).
  - Existing tool-restoration mechanism (the closest the code comes to "per-tool config"): `extensions/loops/goal.ts:3656` (`pi.setActiveTools([...active, ...missing])`) auto-reactivates glla tools when an external allowlist hides them. Not a writer, but the read-side mechanism for project tool behavior.

### Item 6 — paused widget "no work started" → "saved · resumes exactly here"

- **State**: shipped in 0.27.1, regression-pinned in `tests/pause-informativeness.test.ts`.
- **Evidence**:
  - File: `extensions/goal-loop-display.ts:239` — `const savedLine = `saved${spent.length > 0 ? ` — ${spent.join(" · ")}` : ""} · resumes exactly here`;`
  - File: `extensions/goal-loop-display.ts:236` — `if (tokUsed > 0) spent.push(`${fmtTokens(tokUsed)} tok spent`);`
  - Rendered output (with telemetry): `saved — 41.2k tok spent · 3 audits · resumes exactly here`.
  - Rendered output (no telemetry yet): `saved · resumes exactly here` (NOT "no work started").
  - Test: `tests/pause-informativeness.test.ts:49` asserts the with-telemetry line; line 51 asserts the bare line.
  - The strings "no work started" and "awaiting first turn" do NOT exist in any current source.

### Item 7 — chunk-near-context-full hint

- **State**: shipped in 0.27.6.
- **Evidence**:
  - File: `prompts/goal-loop-continuation.md:55` — new bullet "Chunk output near context-full" under EXECUTION DISCIPLINE.
  - Commit SHA: `ec60a2b4` (0.27.6).
  - Test: `tests/postaudit-surface.test.ts` (chunk-hint test, line 78+) — asserts the hint sits in the same paragraph as the auto-continue reference.

## Parked cards (not shipped, not forgotten)

These were discussed and deferred. Re-prioritize when a project outgrows
the modes' current scope.

### Sub-goal tree (parent + children) — HOLD for v0.29+

A goal can own N child goals. Each child has its own lifecycle / audit /
objective. Parent completes when its contract holds AND all required
children are terminal. Optional / replacing semantics to follow.

**Minimum viable v0.29**: parent + children data model + `/goal status`
tree view + a `decisions.md` carry-over (parent has one, every child
reads it on activate, post-audit appends to it). No focus/unfocus yet,
no nested children.

### Spec evolution under long goals — HOLD

Two-layer spec: **axioms** (hard, never change — e.g. "make Half-Life 3
in three.js") and **claims** (soft, evolve by reviewer/auditor-decision
— e.g. "the tone is X" can shift to "the tone is Y" if 30 sessions of
work reveal X doesn't fit). Reviewer can propose spec amendments;
user accepts / rejects / amends. Decision trail needed (git history of
SPEC.md plus inline annotations on each amendment).

### Post-audit modes — PARTIALLY SHIPPED (item 2 / 0.27.7)

Reframed the existing "reviewer" as a **post-completion auditor** that
fires after goal/list terminates. Modes:

- `off` ✅ — no post-audit (0.27.7)
- `default` ✅ — Confirm-gated cascade (existed since 0.26.0, renamed to default in 0.27.7)
- `auto` ✅ — on + auto-enqueue any tasks it produces into `/list` (existed since 0.26.2, kept)
- `aggressive` ✅ — auto + auto-relaunch goal if it proposes one (0.27.7)
- `report` ✅ — write report only, no cascade (existed since 0.26.2, kept)

Five-mode cycle: off → default → auto → aggressive → report → off.
On-by-default surfacing shipped in 0.27.5 (silent reviewer → notify).

## Open threads

- Spec evolution needs YAML frontmatter or section markers for axiom/claim distinction — open question.
- Sub-goals: does a child ever inherit a parent's audit-suppression state, or does each child get a fresh auditor? Open.
- "List abuse for staged work" — currently some users (not you, yet) push multi-stage project work into lists because there's no sub-goal tree. Once v0.29 ships, lists should re-grill those seeds.
- Aggressive postaudit is a footgun — unattended rigs with `mode: aggressive` will never idle, which is exactly what the user wants but needs an opt-in gate. Consider requiring `aggressive = true` AND `autoAcceptDrafts = true` AND `autoResume = true` to all be on before the relaunch fires. Park for v0.28.
