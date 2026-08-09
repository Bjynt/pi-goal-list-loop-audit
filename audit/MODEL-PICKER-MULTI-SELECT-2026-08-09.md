# Multi-select model picker + unified model-selector (v0.34.115)

Date: 2026-08-09
Version: v0.34.115
Scope: UX fix + unified fallback selector

## What changed

Three coupled improvements ship together in v0.34.115:

### 1. `extensions/multi-model-picker.ts` — multi-select picker

A new picker component mirrors the existing `ModelPickerComponent` UX
(fuzzy search, ↑/↓ navigate, type-to-filter) but lets the user build an
ordered selection with Space (toggle) and confirm with Enter or Tab.

The component reuses `buildModelPickItems` from `extensions/model-picker.ts`
— one source of truth for the model list shape. `session` and `manual`
rows render but are not toggleable; only `kind === "model"` rows count.

Selection order = order items were toggled ON. `initialSelected` populates
the selection on open (refs are defensively filtered — stale refs that
aren't in the current registry are silently dropped, never leaked into
the result).

### 2. `extensions/model-selector.ts` — unified scope-aware selector

A scope-aware model-fallback selector:

```ts
type ModelScope =
  | { kind: "session" }
  | { kind: "subagent"; agentName: string };
```

Same chain mechanics for both scopes. The selector composes the existing
helpers in `extensions/main-model-recovery.ts` (`nextUntriedModelRef`,
`classifyMainModelFailure`, `mainModelFailureDelayMs`) so the classification
and cadence math stays in one place; the selector adds:

- `chainFor(scope)` — read the configured chain from caller-supplied deps.
- `selectNext(scope, current, attempted)` — next untried ref (raw).
- `selectNextValid(scope, current, attempted)` — walk past forbidden and
  unregistered entries; record every ref visited; return `{ref, model}`
  on hit or `{reason: "exhausted"}` on no hit. This is the v0.34.93
  lesson baked into a class: silent skip + clear ledger event for every
  skipped ref, no wasted setModel call on a forbidden ref.
- `retryDelayMs(scope, failure, attempt, nowMs?)` — scope-agnostic for
  now; the param exists so per-scope cadences can land later without
  breaking the API.
- `record(...)` — emits the unified `model_fallback_select` ledger event
  with `{scope, fromRef, toRef, reason}`.

### 3. Settings UI rewired to the picker

Three editor cases now drive the multi-select picker instead of
`ctx.ui.input` (free-form text dump):

- `mainModelFallbacks` — ordered backup chain for the main session.
- `forbiddenModels` — explicit allow-list (NOT a default ban list).
- `subagentFallbacks:<agentName>` — per-agent fallback chain (NEW
  setting key, exposed for Explore / Plan / general-purpose).

The default `forbiddenModels` list is now **empty** — the previous
`["gpt-5.5", "sonnet", "opus"]` shipped as opinionated policy and
banned models that other users' rigs may rely on (Anthropic-only rigs,
OpenRouter-budget rigs, local rigs that run sonnet fine). The
`blockForbiddenModelSwitches` gate is still ON by default; users who
want the previous safety net add the refs explicitly via the picker.
Tests that depended on the old default now seed an explicit forbidden
list in their per-test settings.

`goal-loop-subagents.ts` consults the selector at sync time: when
`subagentFallbacks[name]` is set, the FIRST eligible ref in the chain
is written as the override model. When unset, behavior is byte-identical
to v0.34.114 (per-type pin / inherit-parent / agent-default).

## Files

| File | Change |
|---|---|
| `extensions/multi-model-picker.ts` | NEW — multi-select picker |
| `tests/multi-model-picker.test.ts` | NEW — 15 tests |
| `extensions/model-selector.ts` | NEW — unified selector |
| `tests/model-selector.test.ts` | NEW — 20 tests |
| `extensions/goal-recovery.ts` | refactor — `tryMainModelFallback` uses selector |
| `extensions/goal-loop-subagents.ts` | add `resolveSubagentOverrideRef`; chain resolution |
| `extensions/goal-loop-core.ts` | `DEFAULT_FORBIDDEN_MODELS = []` |
| `extensions/goal-settings.ts` | add `subagentFallbacks?: Record<string, string[]>` |
| `extensions/settings-menu.ts` | add `subagentFallbacks:<name>` rows |
| `extensions/loops/goal-settings-ui.ts` | wire editors to picker; add `promptModelRefs` |
| `extensions/loops/goal-activation.ts` | subagent sync uses `resolveSubagentOverrideRef` |
| `extensions/loops/goal-runtime-globals.ts` | add `promptModelRefs` global |
| `tests/model-switch.test.ts` | update default-dependent assertions |
| `tests/vision-assist.test.ts` | seed explicit forbidden list per test |

## Verification

```bash
npx tsc --noEmit
timeout 180 bun test
```

Results:

- TypeScript: no errors.
- Tests: **1181 pass / 1 skip / 0 fail** across 105 files (up from
  1146; new 35 tests cover the picker + selector).
- `wc -l extensions/loops/goal.ts`: 387 (≤700 contract preserved).

## Ledger event surface

- `model_fallback_select` (NEW, unified) — `{scope, fromRef, toRef, reason}`
  where reason is one of `ok | forbidden | unregistered | exhausted`.
- `main_model_failover` — preserved (existing event for the actual switch).
- `forbidden_model_fallback_blocked` — REPLACED by `model_fallback_select`
  with `reason: "forbidden"`. The old event still exists for ledger
  parsers that consume it but no new writes land.
- `main_model_fallback_unavailable` — preserved for the no-configured-auth
  case (different semantic from "not in registry").

## Out of scope

- Mid-spawn subagent model rotation (subagent fallback applies at next
  spawn; pi-subagents reads the override .md once per agent session,
  not dynamically).
- Adding new agents to `KNOWN_PINNED_DEFAULT_AGENTS` beyond Explore.
- Splitting the selector into its own package.
