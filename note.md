# Now

## Current state — 2026-08-30

- **Runtime:** authoritative active goal/list are empty; continuation dispatch is absent.
- **Audit boundary:** no reproducible GLLA-owned transition was found for the separate queued-list stall report. Do not turn that report into implementation work without a confirmed transition.
- **PR queue:** PR #38 is merged; PR #37 is closed because its intent was addressed by the narrowed current-main adaptation. AVO-related PRs #22 and #36 remain open for later review.

## Open work / candidate next focus

1. **Subagent fallback semantics:** decide whether `pi-subagents` needs true runtime fallback. It currently selects one startup override; child provider failures log `subagent_provider_error` but do not advance the chain. If runtime failover is required, design bounded retry/respawn and `hasConfiguredAuth` coverage.
2. **Full-suite triage:** reproduce or explicitly disposition the unrelated context-growth fixture and auditor timing failures without weakening the durable/order evidence.
3. **Live evidence:** obtain a genuine live Pi TUI capture if the environment permits; otherwise preserve the projection-vs-TUI distinction.
4. **Summary/start UX:** investigate the remaining note items about incomplete end-of-objective summaries and visibly showing objective creation/audit work instead of appearing laggy or frozen.

# Done / verified

## Durable over defer

The three-defer plaque-collision report is addressed. Safe durable work remains `inline`; only an explicit unsafe/impossible/blocked fact selects `deferred`. The decision is ledgered, persisted on the goal, and rendered durable-first.

Evidence: `tests/durable-defer-production-ui.test.ts`, `schemas/goal.schema.json`, `audit/DEFER-DURABLE-GUIDANCE-2026-08-30.jpeg`, and `.pi-glla/archive/20260829224747-dc4q1h.md`. The committed image is a fresh browser render of exact production widget output, not a live Pi TUI capture.

## Lifecycle and auditor hardening

- Auditor scope is bounded: outside findings are informational and cannot become Required fixes or auto-queued work.
- Proactive draft pre-read is bounded and fail-closed.
- PR #38 was reviewed and merged: https://github.com/DraconDev/pi-goal-list-loop-audit/pull/38
- PR #37 was closed on 2026-08-30 because its older implementation was not merged unchanged; the intent is covered by the current-main adaptation. See `audit/PR-37-PROMPT-POLICY-ADAPTATION-2026-08-29.md`.
- The default loop cap remains `maxIterations: 50` pending p90 evidence.

## Model selection

Shared picker/selector policy is covered by regression tests: case-insensitive deduplication, order retention, forbidden/unregistered filtering, and bounded fallback caps. The detached auditor now uses the same ordered, deselectable ten-slot fallback picker as the main agent (`auditorModelFallbacks`); the old singular setting migrates compatibly. An unset auditor thinking level follows the parent session dial, including `max`, while explicit overrides remain available. Runtime behavior remains role-specific: main and detached auditor paths walk candidates at runtime; drafter walks its temporary chain; `pi-subagents` is startup-only as described above.

## Visual routing

Visual work now prefers the native image capability of the current main/auditor model. MMX or another external provider is optional and must be explicitly confirmed; no external tool is assumed. If neither native vision nor a confirmed provider is available, visual evidence is unavailable rather than invented. Focused vision, visual-auditor, proactive-pre-read, settings, and model-switch coverage passed (83 tests); `npx tsc --noEmit` is clean.

# Later

## Cross-harness and extension review

Review other harnesses and goal extensions, notably pi goal x, DeepSeek, Codex, Claude, Antigravity, and Grok harnesses.

## NVIDIA AVO

There are related PRs, but they may be incomplete. Revisit after the current GLLA-owned work is prioritized:
https://github.com/DraconDev/pi-goal-list-loop-audit/pulls

# Idea
