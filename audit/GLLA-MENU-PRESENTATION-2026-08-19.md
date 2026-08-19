# /glla menu presentation review — 2026-08-19

**Status:** UX review of the existing settings menu; no source change is
supported by this review. The current surface already does the right thing in
most places; the proposal below tightens a few presentation rules and lists
candidate tab additions for the next feature pass.

## Note on the Designer subagent

The Designer is an opt-in read-only subagent (`Agent(designer)`), not a
default step. This review is based on direct inspection of the menu source
and the existing regression tests; Designer is not invoked here and its
considerations are advisory only. The proposal stands on the existing code.

## Current implementation

The TUI table lives in `extensions/settings-menu.ts`. The legacy flat
`/glla` selector (no `ctx.ui.custom` shard) is a fallback in
`extensions/loops/goal-settings-ui.ts`. The seven current tabs are:

| Tab id         | Label          | Examples                                                |
|----------------|----------------|---------------------------------------------------------|
| `keep-going`   | Keep-going     | autoResume, decisionPopup, carryover, autoAcceptDrafts, aggressiveMode, visionAssist, forbiddenModels, blockForbiddenModelSwitches |
| `main-agent`   | Main agent     | mainAgent (current), mainModelFallbacks, mainModelRetryMinutes, hourlyRetryProbe |
| `drafter`      | Drafter        | drafterModel, drafterThinkingLevel, drafterModelFallbacks |
| `auditor`      | Auditor        | auditorModel, auditorThinkingLevel, auditorModelFallback, auditorSameSessionSwap, auditorSilent, auditorProgressSignals, auditCap, auditFeedbackChars |
| `subagents`    | Subagents      | subagentFallbacks:<name>, subagentModelStrategy, subagentModelOverrides.<name>, subagentResolved |
| `stall-brakes` | Stall brakes   | wedgeAlertMinutes, stuckMaxInterventions, stallEscalationRefires, stallShortWords, stallSimilarityThreshold |
| `other`        | Other          | notifyCmd, tokenLimit, toolOverrides, postaudit (sub-menu) |

Every row is `KEY | VALUE | SOURCE | DESCRIPTION` with the description column
hidden by default and toggled with `d`. Widths are computed across all rows
(not per-section) so the grid does not reflow on tab switch
(`extensions/settings-menu.ts:widths`). Long values are truncated to
`MAX_VALUE_W=24` and long keys to `MAX_KEY_W=32`. The select-fallback
lists rows as `[section] label — value [source] — description`.

## Pain points observed

1. **Per-tab column resizing leaves KEY too wide for short content.**
   `widths()` measures every row's label across all sections and then clamps
   to `MAX_KEY_W=32`. The "Other" tab has short keys ("Notify command",
   "Postaudit"), so the KEY column is visibly padded. Cosmetic only; harmless.
2. **`postaudit` row says `open sub-menu` in VALUE and `—` in SOURCE.**
   This is intentional (sub-menus do not bind a setting value), but
   newcomers read it as a missing value. The row could read `→ sub-menu`
   with SOURCE = `runtime` to make the affordance explicit.
3. **`auditorModel` VALUE echoes the session model when no override is set.**
   `modelThinkingText(auditorRef, auditorThinking, subagent)` substitutes
   `sessionRef` when `settings.auditorModel` is unset. That is correct, but
   the VALUE column then reads as if the user picked the auditor model
   themselves. The user feedback ("show `session model` as a category")
   applies here: rows whose value is inherited should say so.
4. **`subagentResolved` is a runtime row with `sourceText: "runtime"` and a
   composite VALUE** that can mix per-agent resolutions into one line. It is
   useful but the column padding makes it the widest row in the menu, which
   forces `MAX_KEY_W=32` even on narrow tabs.
5. **`drafterFallbacks` and `auditorFallbacks` chains render the full
   chain on one line** (`valueText: chain.join(" → ")`). When the chain is
   long, the value column hits the `MAX_VALUE_W` cap and silently truncates
   with `…`, hiding the tail of the chain. A `Enter opens editor` hint
   could land in SOURCE/DESCRIPTION.
6. **The `[section] label — value [source] — description` fallback row
   duplicates section + label.** It is parsed back to a row by matching
   `v.startsWith(\`[${r.section}] ${r.label} —\`)`, but with section labels
   like "Other" (4 chars) and label "Postaudit" (8 chars), there is no
   ambiguity today. Fine; the format string is the right shape.
7. **`description` text is a long sentence per row**, not a noun phrase.
   That is intentional (each editor uses the description as the question
   copy), but the column is hidden by default and `d` toggles it. Users
   who never press `d` see only truncated values, and `d` is undocumented
   beyond the footer line `←/→ tab · ↑/↓ move · d details off · enter drill-in · esc exit`.

## User feedback captured

- "Show `session model` as a category, not the literal ref."
  → Applies to every row whose effective value is the session model
    (current main agent, drafter when no override, auditor when no override,
    subagent pins when `inherit-parent`). The literal `provider/id` should
    appear ONLY when the user explicitly set the override.
- "We can have more tabs if that is clearer."
  → Tab count is reasonable at seven. The next split that helps is between
    policy (long-lived) and runtime (read-only snapshots). See below.
- "Description text is truncated to fit" is already honored for VALUE
  (`MAX_VALUE_W`) and KEY (`MAX_KEY_W`); DESCRIPTION is not truncated and
  the column is hidden by default.

## Proposed next-feature tab structure

The current seven tabs cover the surface well. A single split is worth
considering: separate the **read-only runtime snapshot** rows from the
**persistent settings** rows. The snapshot is what most users check first
("which model am I on right now?"); settings are what they edit. Mixing
them in the same tab is what produces the "show the literal ref" noise.

Two new tabs keep the menu discoverable:

| Tab id (proposed) | Label            | Contents                                                              |
|-------------------|------------------|-----------------------------------------------------------------------|
| `status`          | Status (read)    | current main agent, auditor model, drafter model, subagentResolved    |
| `about`           | About            | package version, schema version, settings file paths, last compile    |

The Status tab is read-only; pressing Enter on a row is a no-op or opens a
"no edit" notify. It is the natural home for `subagentResolved` and any
future "what is the rig doing right now" data. The existing `other` tab
keeps `notifyCmd`, `tokenLimit`, `toolOverrides`, and `postaudit`.

Adding two tabs keeps the navigation discoverable. More than two new tabs
is unnecessary: keep aggressive growth out of the menu surface and route
new knobs through Status if they are read-only or through the existing
domain tabs if they are persistent.

## Presentation rules (proposed for the next source pass)

1. **Inherited rows say so in VALUE.** When `settings.<k> === undefined`,
   VALUE should read `session model` (or `inherit session`, `inherit high`),
   not the literal `provider/id`. The literal ref appears only after an
   explicit override.
2. **SOURCE column for inherited rows reads `runtime`** (the existing
   precedent for `mainAgent` and `subagentResolved`). Project / global /
   default stay reserved for persisted keys.
3. **Composite values (chains, resolved agents) wrap to a multi-line
   representation** with an "Enter drills into the editor" hint. The grid
   widths stop being dictated by the longest chain.
4. **`postaudit` row reads `→ sub-menu` in VALUE** with SOURCE = `runtime`
   so the affordance is obvious.
5. **`d` toggle key gets a one-line help card** the first time the user
   opens the menu (`/glla` → "Press d for descriptions" card; cleared on
   Esc or any Enter). The current footer already names `d details off` but
   it is one of seven items in a footer line.
6. **Widths are computed per active section** for KEY (clamped to
   `MAX_KEY_W=32`), keeping the global clamp for VALUE/SOURCE so the grid
   does not reflow. The seven-section width measurement is over-cautious
   for the 8-of-7 short-key tabs.
7. **Headless fallback keeps the `[section] label — value [source] —
   description` format** unchanged; the proposal does not affect the
   tmux/cron path.

## Tests to add (proposed, not implemented here)

The proposal is a review; tests are scoped for the future feature work
that lands it. A focused regression set would cover:

- `valueText` substitutes `session model` / `inherit …` for every
  row whose effective value is inherited (per section).
- SOURCE = `runtime` for every read-only row, including the new
  `postaudit` value.
- Composite chains longer than `MAX_VALUE_W` include an "Enter opens
  editor" hint and never silently truncate.
- Headless fallback still matches `[section] label —` uniquely.
- The new `status` tab is read-only (Enter yields a "no edit" notify).

## Evidence reviewed

- `extensions/settings-menu.ts` — the TUI table, tab list, column widths,
  row builder, and renderer.
- `extensions/loops/goal-settings-ui.ts` — `promptSettingsMenu`, the
  headless fallback path, and the `custom`-stub fallback that records
  `settings_menu_fallback_select` in the ledger.
- `extensions/goal-commands.ts` — `/glla` routes the bare command to
  `openSettingsUI(ctx)`; `/glla postaudit` / `/glla reviewer` open the
  reviewer sub-menu; `/glla stats`, `/glla audits`, `/glla log`,
  `/glla switchlog`, `/glla wipe`, `/glla cancel`, `/glla resume` are
  separate actions.
- `extensions/goal-settings.ts` — the persisted Settings keys and the
  `SETTINGS_KEYS` array used by provenance.
- `tests/settings-menu-complete.test.ts` — pin row counts, source
  provenance per row, the `postaudit` sub-menu affordance, and the
  resolved subagent row.
- `tests/settings-editors.test.ts` — pin per-editor validation and the
  loud-fail behavior on bad input.

**Conclusion:** the menu's information architecture is correct and the
existing presentation rules already honor the user's "truncate to fit" and
"show SOURCE" expectations. The two concrete fixes worth landing are (1)
replace the literal session-model ref with `session model` on inherited
rows, and (2) surface the Status tab proposal as the next-pass UX win.
Neither requires modifying the public command surface or the persisted
settings schema.