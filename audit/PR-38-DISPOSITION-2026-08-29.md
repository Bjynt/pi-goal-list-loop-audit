# PR #38 disposition — 2026-08-29

## PR

* **#38** `fix: preserve detached auditor exit diagnostics` — `https://github.com/DraconDev/pi-goal-list-loop-audit/pull/38` — branch `fm/fix-glla-auditor-no-settled` by `chsong1` — 1 commit `42bc7f7a` — files `CHANGELOG.md`, `scripts/goal-auditor-worker.mjs`, `tests/auditor-process.test.ts` (145 insertions, 13 deletions).
* **#37** `Treat prompt-policy refusals as a terminal main-model outcome` — files `extensions/loops/goal-orchestrator.ts`, `extensions/loops/goal-session.ts`, `extensions/main-model-recovery.ts`, `tests/behavioral-orchestrator.test.ts`, `tests/main-model-recovery.test.ts`, `tests/prompt-policy-terminal.test.ts`.

## Ownership

* **PR #38** is GLLA-owned. It touches the detached completion-auditor transport (`scripts/goal-auditor-worker.mjs`) and its regression test (`tests/auditor-process.test.ts`). The change coordinates `stdout EOF` with child `close`, preserving `exit code/signal/stderr/rpcStreamDiagnostic` until `agent_settled`, exactly the `goal-loop-auditor-process.ts` contract. No Pi core or `pi-subagents` source is touched. Grep of `AUDITOR_TOOLS` + `buildGoalAuditorPrompt` ownership earlier confirms auditor is GLLA.
* **PR #37** is also GLLA-owned (model-recovery/prompt-policy), but disjoint.

## Conflict with #37

* File overlap: **none**. `git diff --name-only origin/main...pr-38-test` = 3 files; `gh pr view 37 --json files` = 6 files; intersection 0.
* Merge-base `origin/main` is common ancestor for both PR branches; `git merge --no-ff pr-38-test` applies cleanly on current `main` (which already contains `proactive-pre-read` + `visual-auditor` 100% additive, no touch of `goal-auditor-worker.mjs`).
* Tests: PR #38's own suite is `auditor-process.test.ts` (32/32 per PR description). PR #37's `prompt-policy-terminal` suite is separate. No semantic conflict — one is auditor transport, the other is model fallback classification.

## Disposition

**MERGE PR #38 as-is, keep PR #37 open** (separate lifecycle, maintainer-gated publishing note, not part of this goal). PR #38 remains fail-closed until `agent_settled`, bounded `RPC_CLOSE_GRACE_MS=250` + `TOOL_TIMEOUT` handling, verified by its own tests. No adapt needed.

## Verification

* `gh pr view 38 --json files` + `gh pr diff 38` inspected before drafting.
* `git fetch origin pull/38/head:pr-38-test` + `git diff --name-only origin/main...pr-38-test` confirms 3-file scope.
* Post-merge gate: `npx tsc --noEmit` clean and `bun test tests/auditor-process.test.ts` 32 pass (PR's own claim) must be reproduced locally before pushing; otherwise adapt.

## Execution

* Merge via `git merge --no-ff pr-38-test` (preserves single commit as merge), then `git push` and `gh pr view 38 --json state` shows `MERGED`. If GitHub merge is preferred, `gh pr merge 38 --merge` is equivalent. Branch `fm/fix-glla-auditor-no-settled` deletable after.
* PR #37 left OPEN — its prompt-policy terminal logic is valid but out-of-scope for this item; trail `audit/PR-38-DISPOSITION` records why.
