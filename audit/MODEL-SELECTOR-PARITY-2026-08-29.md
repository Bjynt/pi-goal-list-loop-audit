# Model selector parity — 2026-08-29

## Claim

Ensure model selectors are as good as the main model selector with fallbacks — parity and fallback strategy.

## Audit comparison

* **Main selector** (`extensions/model-selector.ts` `ModelSelector` session scope + `extensions/main-model-recovery.ts` `normalizeMainModelFallbackRefs` + `nextUntriedModelRef`): chain is `loadGlobalSettings().mainModelFallbacks` normalized case-insensitive dedup, capped `MAX_MAIN_MODEL_FALLBACKS=10`, original order retained; walk skips `isForbiddenModel` then `resolveMainModel` check, emits `model_fallback_select` per visited ref, `selectNextValid` walks until `ok`/`exhausted`.

* **Drafter** (`extensions/drafter-model.ts:54` `resolveDrafterModel`): already uses same `normalizeMainModelFallbackRefs` for `drafterModel`+`drafterModelFallbacks` capped 10, same `ModelSelector` drafter scope, same `isForbiddenModel` gate, same `resolveDrafterModelRef`. No drift; parity kept.

* **Auditor** (`extensions/loops/goal-settings-ui.ts:475` `resolveAuditorModelCandidates`): builds `configuredRefs = normalizeMainModelFallbackRefs([auditorModel, auditorModelFallback])` capped 10, same `ModelSelector` auditor scope, same `isForbiddenModel` gate, same `resolve` edge. Chain length is intentionally 2 (primary+one pin) + session fallback, but normalization/ordering/gate already matches main. No drift requiring expansion to 10.

* **Subagent** (`extensions/goal-recovery.ts:525` `sessionModelSelector` + `extensions/goal-settings.ts`): **drift found** — `subagentFallbacks[agent]` was stored and read RAW (no `normalizeMainModelFallbackRefs`). Consequences: duplicates case-insensitively counted twice, chains >10 not capped, hand-edited files with `"openai/gpt-4o, OpenAI/GPT-4o"` would walk duplicated entry, ordering ledger diverged from main's deterministic `1. a → 2. b` display.

## Fix

Bounded change to match main selector's fallback set and ordering:

* `extensions/goal-settings.ts:318-329` — `normalizeLoadedSettings` now normalizes every `subagentFallbacks[agent]` via `normalizeMainModelFallbackRefs` (dedup case-insensitive, cap 10, order retained); empty chains deleted.
* `extensions/goal-settings.ts:545-554` — `saveSettings` normalizes `subagentFallbacks` same way (`mainModelFallbacks`/`drafterModelFallbacks` already did); writing a chain with duplicates/cap overflow now persists the normalized value.
* `extensions/goal-recovery.ts:529` — `sessionModelSelector` `getChain` for `subagent` now returns `normalizeMainModelFallbackRefs(...)` so in-memory walks are bounded even when settings file predates the fix.

Ordering, forbidden gate, resolve check, and ledger `model_fallback_select` remain unified via `ModelSelector.selectNextValid` for session/drafter/auditor/subagent — no per-scope walk duplication.

## Verification

* `npx tsc --noEmit` 0.
* `bun test tests/model-selector.test.ts tests/main-model-recovery.test.ts tests/model-selector-parity.test.ts` 33 pass (model-selector  + main-recovery + parity 2).
* New focused test `tests/model-selector-parity.test.ts` 2/2: caps/dedup/order and cross-scope `selectNextValid` parity (forbidden/unregistered skip, same `lastVisitedRefs`, same valid ordering) for session/drafter/auditor.
* `forbiddenModels` default stays `[]` (`goal-loop-core.ts:1644`), `isForbiddenModel` substring case-insensitive, `blockForbiddenModelSwitches` ON — gate intact, no bypass.
