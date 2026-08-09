# v0.34.116 — context-overflow fallback to a larger-context model

## Goal

When pi's `session_compact` cannot release the prompt (the model is smaller
than the prompt needs), glla walks the fallback chain to a larger-context
backup instead of leaving the user stuck on "Context overflow recovery
FAILED after one compact-and-retry attempt."

Bundle: (1) context-overflow classification + selector walk, (2) /reload copy
fix on the stale-handle status bar, (3) one-liner when glla observes a
session_compact failure.

## The field evidence

| timestamp | project | symptom | screenshot |
|---|---|---|---|
| 2026-08-08 19:26 | hegemion | "Context overflow recovery FAILED after one compact-and-retry attempt." | `~/Pictures/Screenshots/Screenshot_20260808_192604.png` |
| 2026-08-09 09:53 | capture-anime-girls | "Error: This extension ctx is stale after session replacement or reload. ... Auto-compaction failed" | `~/Pictures/Screenshots/Screenshot_20260809_095353.png` |

The hegemion case was the tail of the failure chain:

1. context fills up → `length_continue_deferred_context_full` fires
2. pi's `session_compact` runs, but the prompt is genuinely larger than the
   model's window
3. next agent_end is still context-starved → pi tries one compact-and-retry
4. that one attempt fails → "Context overflow recovery FAILED"
5. user has no automated recourse — only `/new` (capture-anime-girls case)

The capture-anime-girls case is the runtime-class symptom: the user has to
`/new` because the stale-ctx error persists across reload. The fix for the
runtime path is a separate copy tweak (see §2 below).

## What changed

### 1. `extensions/main-model-recovery.ts` — context-overflow classification

The legacy classifier returned `non-recoverable` for any length/context-window
string:

```ts
if (/context|output[ -]?token|max_?tokens|length limit|.../.test(text)) {
  return { kind: "non-recoverable", raw };
}
```

A length cap mid-stream MUST stay non-recoverable (the prompt-shape is the
problem, not the model). But when the caller knows the prompt survived
compaction and the model STILL cannot serve it, the model is the problem.

A new `isContextOverflow` override flips the same regex to a recoverable
`context-overflow` kind:

```ts
return opts?.isContextOverflow
  ? { kind: "context-overflow", raw }
  : { kind: "non-recoverable", raw };
```

A pure helper `isContextOverflowError(error)` exposes the same matcher
without the override gate — for the chokepoint that does not yet know the
"context-survived-compaction" signal.

The new `MainModelFailureKind` union gains `"context-overflow"`; the
ledger event names (`main_model_failover`, `model_fallback_select`,
`main_model_probe_*`) are unchanged.

### 2. `extensions/goal-recovery.ts` — `recoverFromContextOverflow` hook

Two new exports:

```ts
export function observeCompactFailure(ctx: ExtensionContext, error: string | undefined): boolean
export async function recoverFromContextOverflow(ctx: ExtensionContext, error: string | undefined): Promise<boolean>
```

`observeCompactFailure` is the one-liner surface — a single `ctx.ui.notify`
plus a `compact_failure_observed` ledger entry — and is invoked from
`recoverFromContextOverflow` before the chain walk. The recovery routes
through the same `sessionModelSelector` as `tryMainModelFallback`, so the
chain + forbidden + resolver + ledger events are the unified surface.

`tryMainModelFallback`'s gate also opens: `non-recoverable` stays the
abort-class gate, but `context-overflow` is now the one rotation kind
beyond provider failures.

### 3. `extensions/loops/goal-activation.ts` — chokepoint in agent_end

The `if (contextStarvedLength)` block in `agent_end` (v0.34.19) gains a
new pre-yield branch:

```ts
const sinceLastCompactMs = state.lastCompactionAt ? Date.now() - state.lastCompactionAt : Number.POSITIVE_INFINITY;
if (sinceLastCompactMs < COMPACTION_GRACE_MS && mainModelFallbackRefs(ctx).length > 0) {
  const overflowMessage = `output-token stop at ${contextUsage?.percent?.toFixed(1) ?? "near-full"}% after recent compaction — model is too small for the prompt; walking fallback chain`;
  const switched = await recoverFromContextOverflow(ctx, overflowMessage);
  if (switched) {
    ctx.ui.notify("glla: rotated to a larger-context backup model. The next turn will retry on the new model.", "info");
    return;
  }
}
ctx.ui.notify("glla: output-token stop was context starvation ...", "info");
return;
```

The signal is "compaction already happened within `COMPACTION_GRACE_MS`
(180s) and the prompt is STILL over the window". That is the precise
shape where rotation is the right response.

### 4. `extensions/goal-loop-display.ts:652` — /reload copy

The stale-handle status-bar text was:

```
⚠ interrupted — stale handle · fresh session_start resumes
```

It is now:

```
⚠ interrupted — stale handle · /reload (or a fresh session_start) rebinds
```

`/reload` rebinds in HEAD (the `claimSessionOwnerAndDetectRebind` path
returns `rebind: true` when `previous.pid === process.pid && !hadShutdown`),
so the user-facing copy now matches the implementation. The refresh-icon
screenshot in the note (`Screenshot_20260808_213325.png`) is a separate
visual-spacing item and stays open.

## Verification

- `npx tsc --noEmit` → clean
- `bun test` → **1188 pass / 1 skip / 0 fail** (up from 1181)
- `tests/context-overflow-recovery.test.ts` → 7 new tests, all pass
- `tests/stale-interrupt-resume.test.ts` → updated for the new copy
- `tests/length-continue.test.ts` → window bumped from 3400 to 5000 chars
  (the new context-overflow branch added ~1100 chars inside the
  `contextStarvedLength` block; the inner `if (lastA?.stopReason === "length")`
  contract is unchanged)
- `extensions/loops/goal.ts` ≤ 700 lines (still 387)
- No `extensions/loops/goal-runtime.ts` monolith
- `extensions/model-selector.ts` consumed unchanged (the selector's
  `selectNextValid` already handles the chain walk)

## Files touched

| file | change |
|---|---|
| `extensions/main-model-recovery.ts` | +`context-overflow` kind, +`isContextOverflowError()` helper, `classifyMainModelFailure` takes `opts: { isContextOverflow? }` |
| `extensions/goal-recovery.ts` | +`observeCompactFailure()`, +`recoverFromContextOverflow()`, `tryMainModelFallback` opens context-overflow (was: only non-recoverable gate) |
| `extensions/loops/goal-activation.ts` | `agent_end` context-starved branch detects recent compaction and calls `recoverFromContextOverflow` |
| `extensions/goal-loop-display.ts` | stale-handle copy: `/reload (or a fresh session_start) rebinds` |
| `tests/context-overflow-recovery.test.ts` | new — 7 source-pin tests |
| `tests/length-continue.test.ts` | window bumped 3400 → 5000 |
| `tests/stale-interrupt-resume.test.ts` | updated for the new copy |
| `CHANGELOG.md` | v0.34.116 entry |
| `audit/INDEX.md` | this file's INDEX entry |
| `package.json` | version → 0.34.116 |

## What stays open

- **Issue #8 (refresh icon spacing)** — separate visual-spacing bug, not a
  v0.34.116 candidate.
- **Issue #11 (`/glla cancel` semantics)** — design decision pending:
  cancel-the-active vs. cancel-the-objective. Single-line toggle, not a
  release blocker.
- **Issue #7 (external reviews)** — `chat.qwen.ai` and `chatgpt.com`
  links from `~/chat/pi/note.md` were not fetched in this session; the
  bundles were scoped to the original 3 fixes.
- **Issue #2 (better completion summaries)** — `renderGoalMarkdown`
  already rich; the "weak finish" UX was a list-item transition, not a
  summary-content problem.
- **Issue #3 (auditor tool-name spam)** — curator already strips
  code spans/markdown; tool-name spam in the screenshots was the widget
  footer, not the auditor report.
- **Issue #10 ("goals never close")** — the screenshot showed a
  correctly-closed goal with a "📌 carried" sub-row. The terminal state
  is durable; the user's confusion is a label-clutter issue, not a
  closure bug.
