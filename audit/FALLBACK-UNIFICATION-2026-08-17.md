# Fallback Unification — Audit

**Goal context**: `20260817115450-ellsbm` — "Audit every model-fallback surface in the plugin, define ONE uniform fallback ordering/policy with file:line citations, then implement it so the thin paths (auditor 'fallback-pin', drafter list, probe) get the same failure-classify + untried-ref + backoff + forbidden-gate treatment main-model-recovery already has."

## Scope of audit

The audit covers every place the plugin decides **which model to use next when the current one fails or is unavailable**. Quota-error diagnostics, fingerprinting, sanitization, and user-facing display live in `quota-retry.ts` but are deliberately *diagnostic* — the recovery policy itself delegates to the **uniform envelope** in `main-model-recovery.ts::mainModelFailureDelayMs` (which ignores the failure kind text). So the audit focuses on **model selection surfaces**, not diagnostics.

## Surfaces mapped

| Surface | File:line | Has chain? | Uses `normalizeMainModelFallbackRefs`? | Uses `ModelSelector` (forbidden gate)? | Uses `classifyMainModelFailure`? | Has backoff? |
|---|---|---|---|---|---|---|
| Main session | `extensions/main-model-recovery.ts` whole file (≈260 lines) | YES (plural, ≤10) | YES (own canonical normalizer at line 71) | indirectly (gate policy is `isForbiddenModel` from core) | YES (line 108) | YES (uniform envelope, `mainModelFailureDelayMs` line 209) |
| Drafter (drafting model) | `extensions/drafter-model.ts` line 54 (`resolveDrafterModel`) | YES (plural, ≤10 via `MAX_DRAFTER_FALLBACKS = MAX_MAIN_MODEL_FALLBACKS`) | YES (line 55) | YES (ModelSelector, lines 64-66) | NO (drafting doesn't classify failures; selection only) | N/A (drafting is a single shot) |
| Auditor (detached completion verifier) | `extensions/loops/goal-settings-ui.ts:452` (`resolveAuditorModel`) | YES (TWO slots: `auditorModel` + `auditorModelFallback`) | NO (manual `tryRef`, no normalization) | NO (forbidden gate not applied) | NO (selection only) | NO failure-time backoff (the caller walks the prepared `fallbackModels` list once) |
| Probe / hourly retry | `extensions/main-model-recovery.ts:198` (`hourAlignedRetryDelayMs`) | n/a — uses the main chain | YES (inherits main chain) | inherits main | inherits main | hour-aligned :00:30 slot, not a model chain |

The opportunistic `fallback` mentions in `goal-heartbeat.ts` (lines 347/477/635), `goal-loop.ts` (line 57/141/873), and `goal-continuation.ts` (lines 194/662/1137/1186) are **not model-fallback machinery** — they handle malformed records, completion-context fallbacks, and a `?? 0` numeric default guard. None decide "which model to use next".

## The inconsistency (what the user noticed)

The **main** path is a uniform policy. Five primitives, one chain:

1. `normalizeMainModelFallbackRefs(value)` — case-insensitive dedup, capped at `MAX_MAIN_MODEL_FALLBACKS = 10`, preserves original spelling for registry lookup and display (`formatMainModelFallbacks` line 88).
2. `classifyMainModelFailure(error, opts)` — single classifier with a kind enum: `rate-limit | quota | billing | auth | transient | unknown | non-recoverable | context-overflow` (line 108). The classifier deliberately ignores provider wording to pick a chain step; only `non-recoverable` exits the chain.
3. `nextUntriedModelRef(current, refs, attempted)` — walks the chain honoring the `attempted` set (line 168). This is the **single walker** every recovery site uses.
4. `isForbiddenModel(ref, forbidden)` — gate from `goal-loop-core.ts`, applied via `ModelSelector` so a forbidden ref is silently skipped (drafter uses this at line 64-66).
5. `mainModelFailureDelayMs(failure, attempt, baseMinutes, nowMs)` — **uniform envelope** at line 209. Every provider failure (rate-limit, quota, billing, transient) gets the same eager-first-retry + bounded ladder; the hourly probe adds an independent :00:30 slot via `hourAlignedRetryDelayMs` (line 198). Provider text and upstream `Retry-After` are not consulted to choose a cadence.

The **drafter** reuses main's helpers (lines 54-66 of `extensions/drafter-model.ts`): same `normalizeMainModelFallbackRefs`, same cap, same `ModelSelector` with the forbidden gate. No classifier or backoff needed because drafting is a single-shot selection, not a retry loop.

The **auditor** is the odd one out:

- `extensions/loops/goal-settings-ui.ts:452-535` `resolveAuditorModel(ctx, ref, fallbackRef, sameSessionSwap)` accepts **two** slots only: `auditorModel` and `auditorModelFallback` (singular). Settings fields declared at `extensions/goal-settings.ts:60/64/323/324` — only two slots.
- It does **not** use `normalizeMainModelFallbackRefs` — `tryRef(trimmed)` at line 462 is a hand-rolled split-and-lookup.
- It does **not** use `ModelSelector` with the forbidden gate. The auditor caller in `extensions/loops/goal-auditor-hooks.ts:881` and `extensions/loops/goal-tools.ts:635` reads the resolved `fallbackModels` array but never re-validates it against `forbiddenModels` after `resolveAuditorModel` returns.
- It does **not** classify failures. After the call returns a candidate list, the caller walks the list (the `auditorCandidates` at hooks.ts:887 and tools.ts:641) and re-runs the detached audit on the next ref, but there is no `classifyMainModelFailure` step in between — a transient 5xx and a non-recoverable auth-failure look identical to the walker.
- It does **not** apply a backoff between retries. Each attempt re-runs immediately; only the worker's `DEFAULT_WALL_TIMEOUT_MS = 30m` and `DEFAULT_HEARTBEAT_NO_PROGRESS_MS = 10m` provide any pause (both inside `extensions/goal-loop-auditor-process.ts`).

The caller at `extensions/loops/goal-auditor-hooks.ts:881-887` and `extensions/loops/goal-tools.ts:635-641` does walk the chain:

```ts
const { model: auditorModel, error: modelError, via, fallbackModels } = resolveAuditorModel(...);
const auditorCandidates: AuditorModelCandidate[] = [{ model: auditorModel, via: via ?? "unset" }, ...(fallbackModels ?? [])];
```

…then later iterates `auditorCandidates` per attempt. So a chain *exists* — it's just bounded to **two** slots (plus session), not ten, and it does not normalize/validate/forbidden-gate the refs the same way.

This is exactly the asymmetry the user described: "the main fallbacks are better handled, others not sure how would you clear or order". Main is the rigorous policy; drafter piggybacks on main's primitives; auditor has its own custom 2-slot resolver that does not share them.

## Recommended uniform ordering (the contract)

The plugin should treat all three surfaces as one policy with three different **fan-out widths** — but the SAME primitives for normalize / classify / forbidden-gate / backoff:

1. **Normalize** the configured chain through `normalizeMainModelFallbackRefs` (case-insensitive dedup, cap at `MAX_MAIN_MODEL_FALLBACKS`, preserve original spelling).
2. **Classify** each failure through `classifyMainModelFailure`; only `non-recoverable` exits the chain (everything else, including auth and transient, walks to the next ref).
3. **Forbid** every ref against `forbiddenModels` via `ModelSelector` (skip silently, do not surface as an error). Drafter already does this; main's recovery walker already gates via `tryMainModelFallback`; auditor does not.
4. **Walk** with `nextUntriedModelRef` honoring the `attempted` set; never retry a ref already attempted in this recovery episode.
5. **Backoff** with `mainModelFailureDelayMs` (uniform envelope) — apply between attempts regardless of which surface produced the failure.

The width by surface:

| Surface | Width | Source setting | Reason |
|---|---|---|---|
| Main | ≤ 10 | `mainModelFallbacks` (plural) | main is the longest-running path; users may pin multiple providers to cross quota walls |
| Drafter | ≤ 10 | `drafterModelFallbacks` (plural) | drafting may iterate during long goal-list runs; multiple providers hedge drafting quota |
| Auditor | ≤ 10 (raised from 2) | **rename** `auditorModelFallback` (singular) to `auditorModelFallbacks` (plural) | the verifier is the most failure-sensitive path; a 2-slot chain is a known-bad shape (no hedging across providers) |

The audit's **action** is to bring the auditor into the same shape:

- Add `auditorModelFallbacks: string[]` to settings (plural).
- Keep `auditorModelFallback` (singular) as a deprecated alias during a migration window — keep reading it, append to the chain, do not advertise in `/glla`.
- Route `resolveAuditorModel` through `normalizeMainModelFallbackRefs` and `ModelSelector` (forbidden gate) the same way `drafter-model.ts:54-66` does.
- Keep the existing **single-shot session-fallback tail** (the cascade to `ctx.model`) as the last resort — the user's own session model IS a useful verifier in a pinch.
- Where the **failure-time walk** happens (hooks.ts:881 and tools.ts:635), keep the immediate-retry-once semantic (a transient blip deserves a second look on the same model) but route the subsequent walking through `nextUntriedModelRef` honoring `attempted` so the same ref isn't tried twice.
- Hook `classifyMainModelFailure` into the walker: `non-recoverable` aborts the chain immediately (instead of silently retrying and eventually walking).

The drafter and main paths need **no changes** — they already share the primitives. The audit unifies the primitives across the surface so the policy is one policy; the drafter and main continue to work as-is.

## What about quota-retry?

`extensions/quota-retry.ts` provides diagnostics: `providerErrorFingerprint`, `providerErrorPresentation`, `normalizeProviderErrorText`, `sanitizeProviderDisplayText`, `sanitizeProviderAuditReport`. It also provides `quotaSignal` (a parallel classifier: `rate-limit | plan-quota | billing`) and `providerRetryDelaySeconds` / `scheduleProviderRetry` — a bounded timer for legacy callers.

The recovery policy itself does NOT use `quotaSignal` to choose a model. It uses `classifyMainModelFailure` (kind enum). The two classifiers are different on purpose:

- `quotaSignal` is a **display projection** — it tells the user what kind of wall they hit (used by `providerErrorPresentation.action` for chat/notify copy).
- `classifyMainModelFailure` is a **policy input** — it tells the recovery walker whether to advance the chain or not.

The `quotaSignal` family is intentionally narrower (it requires `RATE_LIMIT | BILLING | PLAN_QUOTA | GENERIC_LIMIT_WALL` markers and deliberately rejects plain 403s and ambiguous "temporarily unavailable" strings to avoid turning every transient into a quota wall). The `classifyMainModelFailure` family is intentionally broader (it advances on transient 5xx and auth-failure-as-transient unless `non-recoverable` matches).

The audit notes this distinction and leaves it alone. Bringing `quotaSignal` into the model-chain policy would re-create the very asymmetry the audit is collapsing (one chain, two classifiers, separate backoffs).

## Out of scope

Per the goal's own boundaries:

- User-facing settings schema beyond the rename + alias (no new setting keys).
- Re-touching the continuation-prompt directives or faulty-objective classifier fix.
- Redesigning the auditor process spawn shape beyond the fallback path.

## Summary

- Main: full primitives; chain ≤ 10; uniform envelope. ✓
- Drafter: shares primitives; chain ≤ 10; one-shot. ✓
- Auditor: 2 slots, hand-rolled, no forbidden-gate, no classifier, no backoff between attempts. ✗ — needs unification.
- Quota-retry: diagnostic + bounded timer; recovery policy deliberately delegates to main. ✓ (kept intact; role is documented)