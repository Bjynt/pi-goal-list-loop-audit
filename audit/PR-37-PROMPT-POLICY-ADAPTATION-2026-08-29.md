# PR #37 prompt-policy terminal outcome review

## Scope and source

This is a read-only review of PR #37, `5d8bc23c255b89006dfbfbefc46d4800ba114bc3`, against the current `main` merge base `0438246cb0658c4c69bddff49a45994700a35267`. The PR changes were inspected without checking out, editing, cherry-picking, or pushing the PR branch.

Reviewed PR files:

- `extensions/loops/goal-orchestrator.ts`
- `extensions/loops/goal-session.ts`
- `extensions/main-model-recovery.ts`
- `tests/behavioral-orchestrator.test.ts`
- `tests/main-model-recovery.test.ts`
- `tests/prompt-policy-terminal.test.ts`

## Disposition

**Adapt the intent; reject the PR implementation unchanged.** Current `main` owns lifecycle recovery across `extensions/goal-recovery.ts`, `extensions/goal-continuation.ts`, `extensions/loops/goal-activation.ts`, and `extensions/loops/goal-orchestrator.ts`. The PR's direct edits assume an older ownership layout and its terminal classifier is text-only and broad enough to turn ordinary diagnostics into a policy decision.

The applicable intent is narrow: an explicit provider prompt-policy refusal must not resend an identical prompt or enter the generic recovery ladder. It must settle through the current owner, retain bounded diagnostic evidence, preserve the objective/loop record, and provide an explicit changed-prompt resume path.

## Findings from the PR review

1. The PR's `isPromptPolicyRejection()` treats bare `content_filter`, `prompt blocked`, policy prose, and wrapped status text as authoritative. Provider text and HTTP status are diagnostics only in GLLA; ordinary tool output and project-policy prose must not select lifecycle recovery.
2. The PR persists `failure.raw` directly and places it in a lifecycle field. Current provider-boundary policy requires bounded diagnostic storage plus sanitized pause/notification copy.
3. A wrapped `HTTP 500 — Codex error event: invalid prompt` must still retain the explicit machine-event marker; status normalization must not hide it.
4. The PR's older loop/goal branch can clear dispatch/timers while an active loop remains authoritative. The adapted path explicitly stops `state.loop.active` when loop authority owns the refusal and leaves a paused goal untouched when it is only preserved context.
5. The PR has no current-main integration for an in-band provider pane. Generic repeated 429/5xx/network panes remain on the existing repeated-fingerprint recovery path; only the explicit policy marker is promoted immediately.

## Current-main adaptation

- `extensions/main-model-recovery.ts` adds the narrow `nonRecoverableReason: "prompt-policy"` marker and recognizes only the explicit Codex provider event, including a normalized status prefix. Bare invalid-prompt, filter, policy, and HTTP-status text remain generic/recoverable.
- `extensions/loops/goal-orchestrator.ts` settles the refusal at the current agent-end owner. It clears provider/continuation retry state, resets and reasserts continuation stand-down, clears loop timers, pauses an active goal with `pauseKind: "error"` and no resume timestamp, or stops an active loop, and aborts the host turn at most once. Durable diagnostics use `providerErrorPresentation(..., "main")`; user copy does not interpolate the provider payload. The terminal ledger event is `main_model_prompt_policy_terminal`.
- `extensions/loops/goal-activation.ts` forwards the explicit in-band event to that same settlement path and does not discard it as a generic non-recoverable tool result. Existing repeated generic provider-pane handling is unchanged.

## Regression evidence

- `tests/main-model-recovery.test.ts`: exact and wrapped Codex events are terminal; bare `content_filter`, `prompt blocked`, ordinary policy prose, HTTP 403/500, and stray invalid-prompt text remain recoverable.
- `tests/behavioral-orchestrator.test.ts`: an active goal is durably paused without `mainModelRecovery`, a resume timestamp, or a retry continuation; the raw event is bounded diagnostic evidence only; dispatch state is reset/stood down; abort occurs once; reload preserves the error pause.
- `tests/loop-error-exemption.test.ts`: an explicit in-band policy pane stops an active loop on its first pane, preserves the iteration boundary, emits the terminal ledger/recap, and does not create generic recovery.

## Verification run

At the time of this record:

- `npx tsc --noEmit` — passed.
- `bun test --parallel=1 --max-concurrency=1 --timeout=60000 tests/main-model-recovery.test.ts` — 11 passed, 0 failed.
- `bun test --parallel=1 --max-concurrency=1 --timeout=60000 tests/loop-error-exemption.test.ts tests/main-model-recovery.test.ts` — 22 passed, 0 failed.
- `npm run release:check` — 1,707 passed, 1 skipped, 0 failed (including the broader behavioral orchestrator run and the new terminal regressions).

This review does not claim that the separate zero-stream queued-list stall is fixed; that incident still requires reproduction and durable ledger evidence.
