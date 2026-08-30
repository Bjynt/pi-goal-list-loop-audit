# Now

## GLLA status — 2026-08-30

- **Complete:** the durable-vs-defer guidance goal is archived after the detached auditor approved it at `2026-08-30T00:54:53Z`.
- **Shipped:** bounded durable/defer facts persist on `Goal` and in `durable_defer_choice`; production flows through `record_goal_judgment → refreshUI() → buildWidgetLines()`; semantic plaques keep `Durable fix` before `Defer / workaround`.
- **Evidence:** `tests/durable-defer-production-ui.test.ts`, `schemas/goal.schema.json`, `audit/DEFER-DURABLE-GUIDANCE-2026-08-30.jpeg`, and the approved archive `.pi-glla/archive/20260829224747-dc4q1h.md`.
- **Verification:** changed-path tests and schema/persistence tests pass; `npx tsc --noEmit`, offline auditor-extension checks, and `npm pack --dry-run` pass. The full suite still has unrelated context-growth fixture and auditor timing failures, which remain disclosed rather than suppressed.
- **Visual caveat:** the committed image is a fresh browser render of exact production widget output, not a live Pi TUI capture. A genuine live-TUI capture remains unavailable.
- **State:** authoritative active state has no current goal/list item, continuation dispatch is absent, and the working tree is clean.

## No confirmed GLLA-owned transition was found

This remains a separate unresolved report. Do not turn it into implementation work without a reproducible GLLA-owned runtime transition.

## Investigated

PR #38 was reviewed/merged as part of the lifecycle and auditor hardening work:
https://github.com/DraconDev/pi-goal-list-loop-audit/pull/38

PR #37 was closed on 2026-08-30 because its intent is addressed by the narrowed current-main adaptation; its older implementation was not merged unchanged. See `audit/PR-37-PROMPT-POLICY-ADAPTATION-2026-08-29.md`. AVO-related PRs #22 and #36 remain open for later review.

The default loop cap remains `maxIterations: 50`; change it only after p90 evidence supports a safer default.

/home/dracon/Pictures/Screenshots/Screenshot_20260828_232807.png 

## Model-selector parity — selection policy complete, runtime behavior differs

The shared picker/selector policy is covered by regression tests: case-insensitive deduplication, order retention, forbidden/unregistered filtering, and the bounded cap.

Runtime behavior is intentionally role-specific: main-model recovery and detached auditor recovery walk fallback candidates at runtime; drafter resolution walks its temporary candidate chain. `pi-subagents` currently uses `subagentFallbacks` only at startup, selecting one eligible override and writing one `model:` entry. A child provider failure logs `subagent_provider_error` and does not advance to the next fallback. Its startup resolver also does not preflight `hasConfiguredAuth`, so this is not full runtime/auth parity.

## Completed: auditor scope boundary

Auditors may explore outside context, but outside findings are informational and cannot become Required fixes or auto-queued work.

## Completed: proactive draft pre-read

Drafting now performs bounded proactive evidence gathering before asking avoidable questions, while retaining conservative caps and fail-closed behavior.

## Completed: durable over defer

The three-defer plaque-collision report is addressed. Safe durable work remains `inline`; only an explicit unsafe/impossible/blocked fact selects `deferred`. The decision is ledgered, persisted on the goal, and rendered durable-first.

Original evidence:
/home/dracon/Pictures/Screenshots/Screenshot_20260829_185215.png

Auditors may approve in-line fixes when the durable root-cause change is clearly the contract-preserving path.

## Visual auditor follow-up

For visual objectives, capture fresh evidence and route image inspection through MMX. The durable/defer goal now has a production-path integration test and a fresh production-widget projection; the remaining gap is obtaining an authentic live Pi TUI capture rather than a local projection.

# Next

- Decide whether `pi-subagents` needs true runtime fallback; if so, design bounded retry/respawn and auth-gate coverage rather than treating startup selection as failover.
- Reproduce or explicitly disposition the remaining unrelated full-suite failures without weakening the durable/order evidence.
- Obtain a genuine live Pi TUI capture if the environment permits; otherwise keep the projection-vs-TUI distinction explicit.

## we are still not doing perfect summaries at the end of objectives

lets look into how others do it plugins and codex/claude/agy

## when we are making up the objective during goal start or audit for example show that we are instead of jsut looking laggy and frrozen

# Later

## check out out other harnesses and goal extensions 
nottably pi goal x, deepseek harness, codex, cladue, antirgravity, grok harness

## nvidia AVO careful consideration 

we have prs too it too but apparently incomplete
https://github.com/DraconDev/pi-goal-list-loop-audit/pulls

# Idea

