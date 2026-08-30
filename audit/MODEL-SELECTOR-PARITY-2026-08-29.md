# Model selector parity — 2026-08-29

**Status:** historical audit, refreshed for the 0.36.0 ordered auditor-chain
follow-up.

## Claim

Ensure model selectors are as good as the main model selector with fallbacks — parity and fallback strategy.

## Audit comparison

* **Main selector** (`extensions/model-selector.ts` `ModelSelector` session scope + `extensions/main-model-recovery.ts` `normalizeMainModelFallbackRefs` + `nextUntriedModelRef`): chain is `loadGlobalSettings().mainModelFallbacks` normalized case-insensitive dedup, capped `MAX_MAIN_MODEL_FALLBACKS=10`, original order retained; walk skips `isForbiddenModel` then `resolveMainModel` check, emits `model_fallback_select` per visited ref, `selectNextValid` walks until `ok`/`exhausted`.

* **Drafter** (`extensions/drafter-model.ts:54` `resolveDrafterModel`): already uses same `normalizeMainModelFallbackRefs` for `drafterModel`+`drafterModelFallbacks` capped 10, same `ModelSelector` drafter scope, same `isForbiddenModel` gate, same `resolveDrafterModelRef`. No drift; parity kept.

* **Auditor** (the resolver and `auditorModelFallbacks` editor): builds the
  ordered configured chain with `normalizeMainModelFallbackRefs` capped at 10,
  uses the same `ModelSelector` auditor scope, the same `isForbiddenModel`
  gate, and the same registry-resolution edge. The session model remains the
  final fallback; durable candidate state has the independent 12-entry bound.
  The deprecated singular `auditorModelFallback` is migration-only and is not
  newly persisted.

* **Subagent** (`extensions/goal-recovery.ts:525` `sessionModelSelector` + `extensions/goal-settings.ts`): **drift found** — `subagentFallbacks[agent]` was stored and read RAW (no `normalizeMainModelFallbackRefs`). Consequences: duplicates case-insensitively counted twice, chains >10 not capped, hand-edited files with `"openai/gpt-4o, OpenAI/GPT-4o"` would walk duplicated entry, ordering ledger diverged from main's deterministic `1. a → 2. b` display.

## Fix

The original subagent normalization fix remains in force. The subsequent
0.36.0 auditor follow-up also widened the configured auditor list from the old
single fallback alias to the ordered ten-ref chain while keeping runtime
candidate state independently bounded at 12 entries:

* `extensions/goal-settings.ts:318-329` — `normalizeLoadedSettings` now normalizes every `subagentFallbacks[agent]` via `normalizeMainModelFallbackRefs` (dedup case-insensitive, cap 10, order retained); empty chains deleted.
* `extensions/goal-settings.ts:545-554` — `saveSettings` normalizes `subagentFallbacks` same way (`mainModelFallbacks`/`drafterModelFallbacks` already did); writing a chain with duplicates/cap overflow now persists the normalized value.
* `extensions/goal-recovery.ts:529` — `sessionModelSelector` `getChain` for `subagent` now returns `normalizeMainModelFallbackRefs(...)` so in-memory walks are bounded even when settings file predates the fix.
* `extensions/goal-loop-auditor-process.ts` — candidate normalization preserves
  the pinned primary, ten configured auditor refs, and session fallback across
  restarts without revisiting attempted refs.

Ordering, forbidden gate, resolve check, and ledger `model_fallback_select` remain unified via `ModelSelector.selectNextValid` for session/drafter/auditor/subagent — no per-scope walk duplication.

## Verification

* `npx tsc --noEmit` 0.
* `bun test tests/model-selector.test.ts tests/main-model-recovery.test.ts tests/model-selector-parity.test.ts` 33 pass (model-selector  + main-recovery + parity 2).
* New focused test `tests/model-selector-parity.test.ts` covers caps/dedup/order and cross-scope `selectNextValid` parity (forbidden/unregistered skip, same `lastVisitedRefs`, same valid ordering) for session/drafter/auditor.
* The 0.36.0 focused settings/auditor-picker tests cover ordered auditor refs,
  legacy migration, the ten-ref UI cap, and the twelve-entry durable bound.
* `forbiddenModels` default stays `[]` (`goal-loop-core.ts:1644`),
  `isForbiddenModel` substring case-insensitive, `blockForbiddenModelSwitches`
  ON — gate intact, no bypass.
