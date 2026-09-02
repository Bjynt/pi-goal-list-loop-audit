
# Now

*Closed 2026-09-02 — shipped in v0.38.0–v0.38.2 (1815 pass):*
- `looks stuck` (Screenshot_20260902_030205) — addressed: `👁 MONITORING` vs `⏳ QUEUED` visuals + display-only monitor badge in v0.37.2/v0.38.0
- `keep checking instead of waiting` — addressed: event-driven `ContinuousSupervisor` 250ms→15s adaptive fallback polls every plane in v0.38.0 (deprecated `GLLA_MONITOR_INTERVAL_MS`)
- `cut down on questions mid-execution` — addressed: drafting batches 2–4 upfront in one `ask_user_question` via `buildSeedGrillMessage` + `LONG_RUNNING_JUDGMENT_POLICY` zero mid-run in v0.38.0, thinking now with model pick in v0.38.2

# Next

## audit ended between loops, and the ui disappeared, this is after reload

/home/dracon/Pictures/Screenshots/Screenshot_20260902_121313.png 

# Later

## Review NVIDIA AVO

Assess whether the related PRs are complete and relevant after the higher-
priority GLLA work:

https://github.com/DraconDev/pi-goal-list-loop-audit/pulls

Assess whether the related PRs are complete and relevant after the higher-
priority GLLA work:

https://github.com/DraconDev/pi-goal-list-loop-audit/pulls
