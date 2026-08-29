# Auditor scope guard — 2026-08-29

## Claim

Guard auditor scope to the project at hand — audits can explore outside but must not turn into "fix the world".

## Audit

* **Prompt** `extensions/goal-loop-auditor.ts: buildGoalAuditorPrompt` — no project-at-hand boundary; auditor was free to list any finding as Required fix and propose cascade, potentially queuing fixes for upstream deps or other repos.
* **Postaudit cascade** `extensions/reviewer.ts: runReviewer` — extracted `bug|refactor|architectural` findings were enqueued without scope filter; an outside finding (e.g. "fix the world in dracon-platform") would become a /list item auto-queued, violating the project-at-hand contract.

## Fix

* **Documentation/prompt guard** `extensions/goal-loop-auditor.ts: SCOPE GUARD — PROJECT AT HAND ONLY` — stays within the repository under review; outside findings are informational only: list under `## Outside Scope` and do NOT list under Required fixes nor propose as auto-queued follow-up. Boundary pinned by outside-cap test.

* **Cap** `extensions/reviewer.ts: OUTSIDE_SCOPE_RE = /\boutside\s+scope\b|\bfix the world\b/i` + `isOutsideScopeFinding` + `runReviewer` inScope filter: findings matching outside are recorded in `report.findings` (and in `reviewer_outside_scope` ledger with count+examples) but excluded from `bugs/architectural/strategic` auto-queue/propose paths (`enqueued/proposed` counts reflect only in-scope). Outside is informational, not auto-work.

## Verification

* `npx tsc --noEmit` 0.
* `bun test tests/auditor-scope-guard.test.ts` 2/2: prompt contains scope guard + outside findings recorded (2) but only 1 in-scope enqueued, ledger outside tracked.
