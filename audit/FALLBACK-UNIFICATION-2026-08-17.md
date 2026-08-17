# Fallback Unification — Audit

**Goal context**: `20260817115450-ellsbm` — audit every model-fallback surface, define one ordering/policy, and make the thin auditor, drafter, and probe paths use the same recovery primitives without changing the settings schema, continuation directives, faulty-objective handling, or detached spawn shape.

## Scope and method

The audit follows every place the plugin can choose a different model after a configured model is missing or a provider attempt fails. `quota-retry.ts` is included as a diagnostic surface because it fingerprints and presents provider errors, but its quota family is not allowed to choose the model chain. The `fallback` occurrences in heartbeat, loop, and continuation code were also checked; they are data/default fallbacks, not model selection.

## Surface and inconsistency table

| Surface | File:line | Ordered refs | Normalization / forbidden gate | Failure classification | Backoff |
|---|---|---|---|---|---|
| Main session recovery | `extensions/main-model-recovery.ts:71-84,108-129,168-176,209-215` | `mainModelFallbacks`, capped at `MAX_MAIN_MODEL_FALLBACKS` | canonical normalizer; runtime selector/gate in `extensions/model-selector.ts:112-153` and `goal-recovery.ts:899-1016` | `classifyMainModelFailure` | `mainModelFailureDelayMs` (5s first, bounded configured ladder thereafter) |
| Drafter | `extensions/drafter-model.ts:44-82` | `drafterModel` then `drafterModelFallbacks`, session last resort | canonical normalizer at lines 43-50; `ModelSelector({ kind: "drafter" })` at lines 54-67; forbidden refs are skipped | selection-only; no provider retry loop in this resolver | N/A for one-shot selection; any caller retry must use the shared runtime envelope |
| Auditor resolution | `extensions/loops/goal-settings-ui.ts:452-574` | existing `auditorModel`, singular `auditorModelFallback`, session last resort | now uses `normalizeMainModelFallbackRefs` and `ModelSelector({ kind: "auditor" })`; forbidden entries are ledgered and silently skipped | resolution does not classify an error; runtime does | runtime walker, not resolver |
| Auditor detached retry/fallback | `extensions/goal-loop-auditor-process.ts:77-246`; called by `extensions/loops/goal-auditor-hooks.ts:726-752` and the complete-goal path in `extensions/loops/goal-tools.ts:680-704` | resolved candidates in configured order; attempted refs are not revisited | `runAuditorFallbackWithPolicy` uses the selector and receives `forbiddenRefs` from both callers | classifies every provider result; non-recoverable or non-retriable infrastructure errors stop | same-model retry uses `mainModelFailureDelayMs`; the next untried candidate uses the next bounded delay |
| Main-model delayed/hourly probe | `extensions/goal-recovery.ts:878-1088`; helper cadence `extensions/main-model-recovery.ts:198-215` | primary + configured main fallback chain; durable `attempted` cursor | `sessionModelSelector` and `isForbiddenModel`; visited refs are persisted to recovery state | `classifyMainModelFailure` in the switch failure path at `goal-recovery.ts:1057-1078` | shared bounded recovery timer plus optional hour-aligned probe |
| Quota diagnostics | `extensions/quota-retry.ts:1-260` | no model chain | `quotaSignal` is presentation/diagnostic metadata | intentionally separate from the recovery classifier | legacy diagnostic scheduling only; does not override main-model recovery cadence |

The opportunistic `fallback` references in `extensions/goal-heartbeat.ts`, `extensions/goal-loop.ts`, and `extensions/goal-continuation.ts` were inspected. They handle missing records, continuation payload defaults, or numeric defaults; none chooses a provider/model and therefore none belongs in the model-fallback walker.

## Policy

All model chains follow this order:

1. **Normalize** at the settings boundary with `normalizeMainModelFallbackRefs`: trim, ignore unset values, deduplicate case-insensitively, preserve first-seen spelling, and cap the walk at `MAX_MAIN_MODEL_FALLBACKS`.
2. **Select only an untried ref** with `nextUntriedModelRef`; `ModelSelector.selectNextValid` composes that cursor with registry resolution and the forbidden gate. A forbidden ref is skipped silently for the user but recorded for forensics.
3. **Run the selected model.** The session model is a final last resort where the existing surface already promises one; it is not invented as a new configured pin.
4. **Classify failures** with `classifyMainModelFailure`. A semantic verdict is returned immediately. A non-recoverable classification, missing-model error, or non-retriable infrastructure result stops the walk. Recoverable provider failures may retry the current ref once, then advance only to the next untried ref.
5. **Back off uniformly** with `mainModelFailureDelayMs`. Error-family wording, quota presentation, and upstream `Retry-After` hints do not select a different cadence. The first retry is bounded at 5 seconds; later attempts use the configured exponential ladder, capped by `MAIN_MODEL_MAX_RETRY_DELAY_MS`. The main recovery's optional hourly probe remains an additional scheduled slot, not a second classifier.

The surface widths remain intentionally different and **the settings schema is unchanged**:

| Surface | Existing width | Existing setting |
|---|---:|---|
| Main | up to 10 | `mainModelFallbacks` |
| Drafter | up to 10 | `drafterModelFallbacks` |
| Auditor | primary + one fallback + session last resort | `auditorModelFallback` (singular) |

This goal does not rename or add auditor settings. The auditor's two configured slots are normalized and gated just like the larger main/drafter chains; the runtime policy is shared without widening the user-facing contract.

## Implementation decisions

- `extensions/model-selector.ts:31-177` remains the pure scope-aware chain walker and now accepts the `{ kind: "auditor" }` scope. It composes `nextUntriedModelRef`, the forbidden gate, registry resolution, and the shared retry-delay helper without owning runtime state.
- `extensions/loops/goal-settings-ui.ts:452-574` now routes the existing auditor primary/fallback pins through that selector. It retains the same-session swap and session-last-resort behavior, and forbidden refs are skipped without an unavailable-model warning.
- `extensions/goal-loop-auditor-process.ts:77-246` owns the shared detached-attempt policy. It keeps the worker request, attempt identity, timeouts, and process lifecycle unchanged; only the parent-side candidate cursor/retry timing is centralized. It calls `classifyMainModelFailure`, `nextUntriedModelRef`, `mainModelFailureDelayMs`, and `ModelSelector` directly.
- `extensions/loops/goal-auditor-hooks.ts:726-752` keeps the compatibility wrapper exported through `goal.ts`; both detached dispatch sites pass `settings.forbiddenModels` into the policy helper. This preserves existing ledger and lifecycle callbacks.
- `extensions/drafter-model.ts:44-82` already satisfies the selection half of the policy and needs no redesign.
- `extensions/goal-recovery.ts:899-1078` already satisfies the probe half, including durable attempted/skipped refs and shared failure delay; it is documented here rather than duplicated.
- `extensions/quota-retry.ts` remains diagnostic. Changing its provider-family presentation would not improve model selection and would reintroduce two competing retry policies.

## Regression coverage

`tests/auditor-fallback-unification.test.ts` covers:

- existing primary → singular fallback → session ordering and canonical case-insensitive normalization;
- forbidden-ref skipping without a user-facing warning;
- duplicate/untried cursor behavior and retry ordering;
- the 5-second first retry and bounded later backoff before a fallback;
- non-recoverable termination without a second worker; and
- source-level wiring for the auditor process, hooks wrapper, and drafter selector.

The test fixture restores `GLLA_GLOBAL_SETTINGS_PATH` and removes its temporary directory in `finally`, so resolver tests cannot leak settings state into the suite.
