# Wait / Duration Estimation — Antigravity-style Adaptive Polling (2026-08-27)

**Goal:** `20260827203924-m13p3a` — replace fixed long sleeps with adaptive duration recording and polling.

## Investigation

- **Antigravity pattern:** does not sleep for a guessed duration; it tight-loops `check-if-done` on durable state (ledger, file, count) with increasing backoff. Result: fast when done early, still bounded when slow. No guess required. (`note.md` line 40-43, screenshot 20260826_000412.png)
- **Codex pattern:** explicit `thread/start|resume|fork` durable checkpoint, not poll loop (`audit/CONTINUATION-APPROACH-COMPARISON-2026-08-15.md`). Lesson reused as explicit resume boundary, not as wait guess.
- **Existing telemetry (reused):**
  - `extensions/goal-loop-core.ts:computeListDepth` — avg item duration from last 10 archived `policy:list` goals (`updatedAt-createdAt`, `avgDurationMs`, `fmtAge`). Displayed as `queue depth … avg duration …`.
  - `scripts/durable-wait.mjs:waitForDurableEvent` — every wait returns `{ok, elapsedMs, checks, terminalReason}`; smoke helper prints it. `audits.jsonl` stores `durationMs`.
  - No new store needed; median of recent `elapsedMs` / `avgDurationMs` gives the estimate.
- **Fixed-sleep inventory (14 rows in `audit/WAIT-POLL-2026-08-27.md`):** smoke `wait_for` was `for i in 1..t; sleep 1` (fixed 1s); `sleep 3` after `pi started`, etc. `durable-wait` already used absolute-deadline polling with 250ms base.

## Change

- **`scripts/durable-wait.mjs`:** exported `estimateDurationFromHistory(durations, fallbackMs)` (median + 20% headroom, bounded 0.5×–4× fallback) and `nextPollMs(attempt, base=250, cap=1000)` (250→500→1000). Callers can derive `timeoutMs` from history and `pollIntervalMs` per attempt.
- **`scripts/smoke.sh:wait_for`:** replaced `for seq 1 t; sleep 1` with deadline-bounded adaptive loop: start `poll_ms=250`, double each iteration capped at 1000, check `tmux capture-pane` with `-F` literal and `before` vs `current` staleness guard. Absolute deadline prevents late visibility becoming success.
- **Durable waits keep 250ms base** (smoke `wait_for_durable`/`wait_for_archive_count` at 1000ms could be tightened to 250ms next pass; 1s is already bounded and not a long guess).

## Tests

- `tests/adaptive-wait.test.mjs` — `estimateDurationFromHistory` median/headroom/bounds, `nextPollMs` exponential, `waitForDurableEvent` with adaptive interval list.
- Existing `tests/durable-wait.test.mjs` still covers late-completion-after-deadline as timeout.

## Verification

- `npx tsc --noEmit` clean, `npm run test:all` green.
