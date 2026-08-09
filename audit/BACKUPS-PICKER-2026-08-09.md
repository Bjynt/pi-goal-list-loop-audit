# Backups segment + forbidden-model-aware selector — v0.34.118

## User report

During provider plan-quota walls in other projects, `/glla settings` showed:

```text
Keep-going …
Main model backups  none  global  ordered provider/model refs; quota/provider errors rotate here …
Forbidden models    none  global  policy gate …
```

The backup setting was buried in Keep-going beside auto-resume and policy controls. The multi-select picker also used the same unfiltered model registry for both backup refs and forbidden refs, so a user could pick a model that the policy explicitly blocked as a backup (or add a current backup to the forbidden list). The ordered picker displayed `session model` and `type provider/model manually…` rows that are useful for single-value overrides but are no-op rows in a multi-select list.

## Fix

### Dedicated Backups segment

`extensions/settings-menu.ts` now has six tabs:

```text
Keep-going | Backups | Auditor | Stall brakes | Subagents | Other
```

The Backups tab contains:

- `Main model backups` — ordered main-session fallback chain.
- `Main model retry minutes` — recovery cadence for quota/provider walls.
- `Explore fallback chain` (and any other glla-managed subagent chain that is present).

`Forbidden models` remains in Keep-going because it is a policy gate, not a recovery chain. Subagent model strategy/pins remain in Subagents because they select the primary subagent model rather than a recovery backup.

### Backup-specific picker

`extensions/model-picker.ts::buildModelPickItems` now supports:

- `excludeRefs` — removes exact `provider/model` refs before rows are built.
- `includeSessionRow` / `includeManualRow` — ordered-list callers can hide the no-op rows.

`promptModelRefs` in `extensions/loops/goal-settings-ui.ts` uses these options:

- Main model backups hide `forbiddenModels`.
- Subagent fallback chains hide `forbiddenModels`.
- Forbidden models hide current `mainModelFallbacks`.
- The TUI ordered picker shows only actual selectable model rows; there is no misleading session/manual row.
- The free-form/headless fallback applies the same exclusion, so typed refs cannot bypass the mutual-exclusion rule.

Existing stale saved refs are not silently mutated by opening the menu; the picker drops refs that are no longer in the available filtered model list, and saving the selection writes the clean list. This avoids silently changing settings until the user confirms.

## Why the mutual exclusion matters

A forbidden model cannot serve as a backup: the recovery selector would either skip it or record a `forbidden_model_switch`, wasting a recovery attempt. Conversely, forbidding a current backup makes the configured chain contradictory. The two editors now enforce the invariant in both the custom TUI and the headless input fallback.

## Tests

- `tests/model-picker.test.ts` — v0.34.118 test verifies excluded refs disappear and ordered pickers can omit session/manual rows.
- `tests/settings-menu-complete.test.ts` — six-tab contract + backup rows all live in `backups`.
- `tests/settings-editors.test.ts` — typed headless input cannot put a forbidden ref into backups or a backup ref into forbiddenModels.
- `tests/glla-table-menu.test.ts` — navigation and rendering updated for six tabs.

Verification for this change:

```text
npx tsc --noEmit                         clean
bun test                                 1194 pass / 1 skip / 0 fail
focused picker/settings tests            56 pass / 0 fail
```

The full suite count includes the four new v0.34.118 tests (one picker, one settings-menu, one editor, plus the existing updated contracts).

## Scope

This changes only selector UX and settings grouping. It does not alter the runtime fallback walker, quota classification, forbidden-model enforcement, or recovery backoff semantics. Plugin installation remains out of scope; the package is still installed later from a local tarball per user instruction.
