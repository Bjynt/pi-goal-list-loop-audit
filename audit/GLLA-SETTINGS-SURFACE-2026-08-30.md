# `/glla` settings surface audit — 2026-08-30

**Scope:** current checkout (`package.json` 0.36.0), `buildSettingsRows`,
`handleSettingChoice`, settings persistence, and the headless `/glla` dump.
The inventory below is the original read-only audit; the follow-up disposition
records the fixes landed afterward in the same checkout.

## Inventory

`G` means the row has an interactive GLLA dispatcher and persists through the
settings layer; the scope-aware UI wrapper writes a project override when the
effective value is project-sourced and otherwise writes global settings.
`P` means it explicitly writes project settings. `E` means the row is a
runtime/external control and has no GLLA persistence. `R` means intentionally
read-only. All writes funnel through `saveSettings` in
`extensions/goal-settings.ts:553-580`; the UI wrapper also performs the stale
session admission probe (`extensions/loops/goal-settings-ui.ts:197-201`).

| Section | Visible row id(s) | Status / dispatcher |
|---|---|---|
| Keep-going | `autoResume`, `decisionPopup`, `carryover`, `autoAcceptDrafts`, `aggressiveMode`, `visionAssist` | G; cases `goal-settings-ui.ts:877-930` |
| Keep-going | `forbiddenModels`, `blockForbiddenModelSwitches` | G; cases `:1114-1141` |
| Main agent | `mainAgent` | E; case `:933-935` only explains that Pi owns the selector |
| Main agent | `mainModelFallbacks` | G; case `:937-964`; global-only recovery chain |
| Main agent | `mainModelRetryMinutes`, `hourlyRetryProbe`, `mainModelFailback`, `mainModelPrimaryProbeMinutes` | G; cases `:988-1030`; global-only recovery policy |
| Drafter | `drafterModel`, `drafterThinkingLevel`, `drafterModelFallbacks` | G; cases `:1032-1112`; global-only drafting policy |
| Subagents | `subagentFallbacks:Explore`, `:Plan`, `:general-purpose`, `:Designer` | G; shared cases `:1446-1460` |
| Subagents | `subagentModelStrategy` | G; case `:1419-1429` |
| Subagents | `subagentModelOverrides.Explore`, `.Plan`, `.general-purpose`, `.Designer` | G; shared cases `:1431-1444` |
| Subagents | `subagentResolved` | R; intentional no-op at `:1462-1465`; runtime resolution only |
| Auditor | `auditorModel`, `auditorThinkingLevel`, `auditorModelFallbacks` | G; cases `:1153-1242`; fallback chain is global-only and session model is final fallback |
| Auditor | `auditorAllowedExtensions` | G; case `:1244-1311`; global UI save; detached worker resolves entries fail-closed |
| Auditor | `auditorSameSessionSwap`, `auditorSilent`, `auditorProgressSignals` | G; cases `:1313-1319`, `:966-986` |
| Auditor | `auditCap`, `auditFeedbackChars` | G; cases `:1321-1340` |
| Stall brakes | `wedgeAlertMinutes`, `subagentHangEscalationMinutes`, `stuckMaxInterventions`, `stallEscalationRefires`, `zombieRetryMaxAttempts`, `stallShortWords`, `stallSimilarityThreshold` | G; cases `goal-settings-ui.ts:1342-1417` |
| Other | `stateRoot`, `notifyCmd`, `tokenLimit` | G; cases `:869-875`, `:1466-1479`; `stateRoot` is global-only |
| Other | `toolOverrides` | P; project editor at `:1481-1530` |
| Other | `postaudit` | P; delegates to `cmdReviewerSettings` at `:1532-1534` / `goal-commands.ts:1793-1804` |

The two loops in `settings-menu.ts:326-356` expand to eight additional
rows (four fallback-chain rows and four model-pin rows); including the 40
non-generated rows, the complete table contains 48 row instances for the four
built-in `OVERRIDABLE_AGENT_TYPES`. Every editable row has a matching switch
case; the sole intentional exception is `subagentResolved`.

## Persistence and runtime checks

- `Settings` and defaults are typed in `extensions/goal-settings.ts:47-206`.
- Provenance keys are enumerated at `:222-268`; resolution is project > global >
  default except `GLOBAL_ONLY_KEYS` at `:229-244`.
- Main/drafter/auditor fallback chains are normalized, case-insensitively
  deduplicated, and capped at 10 at read/write boundaries. Auditor durable
  candidate state separately allows 12 entries.
- Auditor launch sites consume the effective settings at
  `extensions/loops/goal-tools.ts:741-800` and
  `extensions/loops/goal-auditor-hooks.ts:986-1050`; the allowed-extension
  editor uses the same effective/project-aware settings boundary.
- The interactive TUI builds all rows from `settingsProvenance` at
  `goal-settings-ui.ts:609-630`; the emergency flat selector maps the same row
  ids by full `[section] label` prefix at `:651-688`.
- Ordinary row edits are scope-aware: a project-sourced key is written back to
  that project's settings file, while `GLOBAL_ONLY_KEYS` remains global-only.
- `mainAgent` is external to GLLA: the handler deliberately does not save a
  main model, and points to Pi's normal model/thinking selectors.

## Findings (GLLA-owned)

1. **Inherited model values are visually ambiguous.** `settings-menu.ts:294-299`
   and `:341-346` substitute the concrete session ref when `drafterModel` or
   `auditorModel` is unset, although the setting is inherited. The existing
   historical UX review calls for a `session model` category. This does not
   change runtime resolution, but can make an inherited value look pinned.

2. **Aggressive-mode defaults are contradicted by two input prompts.** The row
   builder correctly resolves `auditCap=10`, `stuckMaxInterventions=10`, and
   `wedgeAlertMinutes=0` when aggressive mode is on by default
   (`settings-menu.ts:140-143`, `goal-loop-core.ts:2550-2580`). The editors still
   say empty means default 5/30 at `goal-settings-ui.ts:1322` and `:1343`;
   `stuckMaxInterventions` correctly mentions the aggressive override at `:1365`.

3. **Auto-resume wording is stale in the table.** The row says
   `default: hold on EVERY load` at `settings-menu.ts:176-178`, while the
   dispatcher and restore gate state `default = hold on load, rebind on
   reload/fork` (`goal-settings-ui.ts:877-884`, `goal-activation.ts:1422-1438`).

4. **The headless `/glla` dump is not a complete projection.** `cmdSettings`
   (`goal-commands.ts:2600-2669`) omits visible `stateRoot`,
   `auditorAllowedExtensions`, and the read-only `mainAgent` row. Its generic
   `fmt` also renders object values such as `subagentFallbacks`,
   `subagentModelOverrides`, and `toolOverrides` as JavaScript
   `[object Object]`, so those present rows are not useful in RPC/headless
   mode. This is GLLA-owned; it is separate from Pi's external model selector.

5. **Project-sourced values can be displayed but not changed effectively by
   the normal editor.** `loadSettings` permits project overrides for most
   settings (`goal-settings.ts:396-416`), while normal row handlers always
   call `saveSettings("global", ...)`; only tool overrides and postaudit use
   project scope. If, for example, `auditorModel` is project-sourced, Enter
   writes a global value but the project value remains effective. This is a
   scope-policy/design issue, not an upstream Pi defect; the durable choice is
   either scope-aware editing or explicitly marking those rows global-only.

6. **Forbidden-model editing does not exclude every configured fallback chain.**
   The `forbiddenModels` handler excludes main and subagent chains at
   `goal-settings-ui.ts:1117-1128`, but not `drafterModelFallbacks` or
   `auditorModelFallbacks`. Their own pickers reject forbidden entries, so the
   omission can only arise when adding a forbidden pattern after an existing
   chain, but it leaves the two-way policy inconsistent.

## Follow-up disposition

All six GLLA-owned findings above are addressed:

1. **Inherited model presentation — fixed.** Unset drafter/auditor model rows
   now say `session model` (and inherited thinking is labeled as such) instead
   of presenting a concrete provider/id as a pinned override.
2. **Aggressive defaults — fixed.** Audit-cap and wedge-alert editors compute
   their current effective default from the aggressive-mode matrix; the copy
   no longer hard-codes the conservative values.
3. **Auto-resume copy — fixed.** The table and selector now distinguish a
   fresh-load hold from reload/fork rebinding and explicit `/goal resume`.
4. **Headless projection — fixed.** The no-UI `/glla` dump includes the runtime
   main-agent row, state root, allowed extensions, every persisted row, and
   per-type effective subagent resolution. Arrays/maps use JSON serialization
   rather than `[object Object]`; fallback chains retain numbered order.
5. **Project editing — fixed.** Normal edits route to the project file when
   provenance says the effective value is project-sourced. The existing
   `GLOBAL_ONLY_KEYS` filter still prevents recovery policy from acquiring a
   misleading project destination.
6. **Forbidden-chain parity — fixed.** Forbidden-model editing now excludes
   main, drafter, auditor, and all built-in subagent fallback refs, using the
   effective project/global policy. Each fallback editor applies the same
   effective policy before saving.

The context-growth fixture mismatch found during the follow-up was fixture-only:
the durable judgment guidance intentionally added to the continuation template
changed the deterministic payload from 21,863 to 22,158 characters. The pinned
measurement expectations were refreshed; checkpoint projection remains bounded.
The first `release:check` attempt also exposed a timing-sensitive auditor-process
fixture assertion (`phases.includes("thinking")`) while the worker advanced from
an event heartbeat to a tool phase between parent polls. The GLLA worker and
parent remained healthy; three isolated reruns of
`bun test --parallel=1 --max-concurrency=1 --timeout=60000 tests/auditor-process.test.ts`
passed 32/32, and the subsequent complete `release:check` passed. This is
recorded as a fixture-observation race, not a production failure. The exact
suite results are below and in the companion context-growth audit.

## External / intentional behavior

- Pi owns the active `mainAgent` model/thinking selector; GLLA only observes
  model changes and applies its own forbidden-switch policy.
- `pi-subagents` owns child spawning. GLLA's subagent rows write startup
  overrides/fallback metadata; a child provider failure is not a GLLA runtime
  respawn unless a future bounded policy is added.
- TUI rendering, `ctx.ui.custom`, RPC no-op behavior, and native model registry
  availability are Pi host capabilities. GLLA has an intentional typed-input
  fallback for unavailable custom UI.

## Verification performed

The follow-up focused settings/menu, picker, persistence, and auditor-extension
run passed **82 tests**; `npx tsc --noEmit` passed. The source inspection confirms
all 48 generated/static row instances map to dispatch cases except the
documented read-only row. The context-growth measurement and checkpoint
regressions also pass after refreshing the intentional prompt-size fixture.
The complete `npm run release:check` rerun passed: **1,757 tests passed, 1
environment-gated test skipped, 0 failed**, the Jiti smoke test passed, TypeScript
reported no errors, the offline auditor-extension check passed, and
`npm pack --dry-run` produced `pi-goal-list-loop-audit-0.36.0.tgz`. The prior
single auditor-process failure is retained above as a timing-sensitive fixture
race and was followed by three focused passes plus the green complete rerun;
no remaining failure is silently treated as green.
