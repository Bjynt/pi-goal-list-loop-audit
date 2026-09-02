
# Now

*Closed 2026-09-02 in v0.38.3 (1816 pass):*
- `audit ended between loops, and the ui disappeared after reload` (Screenshot_20260902_121313) — fixed: long `Main/Auditor fallback models` titles crashed pi (`Rendered line N exceeds terminal width`) and hid the `glla: [LIVE]` widget between iterations/after reload; now truncated via `truncateToWidth` in `ModelPicker`/`MultiModelPicker`/`SettingsMenu` (PR #41)
- `PR #41 fix(tui): truncate picker and settings titles` — merged (truncate `title` in all three components, regression test at 140 cols)
- `release` — shipped as v0.38.3

# Next

*empty — promote Later or add new*


# Later

## Review NVIDIA AVO

Assess whether the related PRs are complete and relevant after the higher-
priority GLLA work:

https://github.com/DraconDev/pi-goal-list-loop-audit/pulls

Assess whether the related PRs are complete and relevant after the higher-
priority GLLA work:

https://github.com/DraconDev/pi-goal-list-loop-audit/pulls
