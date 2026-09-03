# Delta-only goal continuation — stop resending the full 23k prompt (2026-09-03)

## 0. Problem

Every live goal turn sent `resync + continuationPrompt(goal)` — the full
`prompts/goal-loop-continuation.md` template rendered (~23,015 chars / ~5.7k
tokens, pinned in `tests/context-growth-measurement.test.ts`). For an ongoing
conversation this is pure cost: history already holds the T0 objective,
contract, task list, and every `complete_task` delta. Ten idle wake-ups cost
~50k tokens of repeats (O(n²) growth), and the `DYNAMIC_DIRECTIVES` flicker
lowers the provider prefix-cache hit rate. The user call: "it's an ongoing
conversation — no need to re-send the summary every turn."

## 1. Decision (user-confirmed 2026-09-03)

- Scope: **delta-only continuation**.
- Steady-state payload: **marker-only 45 chars** (`[GOAL CHECKPOINT goalId=…]`).
- Release: **v0.38.5 patch + tests**.
- Out of scope: paired `before_agent_start` systemPrompt injection (pi-goal-x
  pattern) stays `Later` conditional per `audit/CACHE-CRITICAL-ADDENDUM-2026-09-03.md`
  §0–8 — naked markers are correct for *live* turns (history holds state) and
  resync covers *compacted* turns; no system injection is needed for this slice.

## 2. Design (`extensions/goal-continuation.ts`)

- `buildMarkerContent(goalId)` — the 45-char wake-up marker; still carries the
  dispatch marker so `before_agent_start` start-proof matching
  (`dispatchPromptMatches`: `prompt.includes(record.marker)`) keeps working.
  The `agent_start`/`turn_start` fallback (v0.37.3, issue #40) needs no prompt.
- `needsFullContinuation(goal)` — full 23k sends **only** for dynamic deltas
  the model has not seen: `repairTarget`, `autoResumedAt`, auditor `pendingTasks`,
  latest-audit `report`, stale-approval revision mismatch, plus the rare
  designer-role / aggressive full-audit paths (preserved verbatim in v1).
  Stable guidance (vision, discipline) stays clean — it was in the first send.
- `buildContinuationContent(goal, { resync, firstSend })` — pure builder:
  - `firstSend` (per-process `lastContinuationSentAt === 0`) → full, so the
    discipline is taught once (also covers fresh restarts where history is gone).
  - `resync` (post-compact) + clean → `resync + marker` (~250 chars).
  - clean steady-state → marker-only.
  - dirty → `resync + full` (unchanged behavior for repair/recovery/audit).
- `sendContinuation` uses the builder; ledger `goal_continuation_sent` gains
  `kind` (`full` / `full+resync` / `resync` / `marker`) + `payloadChars`.
  All lifecycle fences unchanged (generation/owner/foreign/consent/supervisor).
- Loop path (`extensions/goal-loop.ts` `sendLoopTurn`) unchanged — loop prompts
  vary per iteration (measure values, intervention directives).

## 3. Cache note

No system-prompt change, so no cache-authority change. Live marker-only turns
*improve* prefix reuse (shorter new blocks, stable history prefix). Compacted
turns use the bounded `buildPostCompactResync()` re-anchor (pi-goal-x #5),
not a from-memory summary. `continuationPrompt()` itself is untouched, so the
23015-char fixture stays green — the win is sends avoided, not template shrunk.

## 4. Verification

- New `tests/delta-only-continuation.test.ts` (4 tests): marker shape/size,
  `needsFullContinuation` clean-vs-dirty matrix, builder
  marker/resync/full branches, send-path wiring (`buildContinuationContent` +
  `kind, payloadChars` ledger).
- `npx tsc --noEmit` clean.
- `bun test --parallel=1 --max-concurrency=1 --timeout=60000`: **1824 pass,
  2 skip, 0 fail** (baseline 1820 + 4 new). NOTE: bare `bun test` without the
  repo's serial flags shows order-dependent failures (shared singleton state) —
  always use the `npm run test:all` flags.
- `git diff --stat` for the code slice: only `extensions/goal-continuation.ts`
  + `tests/delta-only-continuation.test.ts` (docs/version files separate).

## 5. Token economics

Per steady-state wake-up: 23,015 → ~45 chars (~500× smaller). Ten idle turns:
~230k chars of repeats → ~450 chars. Full still sends exactly when the model
needs new information (first sight, compact, repair, recovery, audit) — one
full per information event, markers everywhere else.
