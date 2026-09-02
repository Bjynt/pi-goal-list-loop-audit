
# Now

*Closed 2026-09-02 — AVO + zombie win shipped as `0.38.4`.* Human-input zombie fix landed (`USER_INPUT_WAIT_TOOL_NAMES` + `zombie_run_stood_down_user_input` in `extensions/goal-heartbeat.ts`): `pause_goal`/`propose_*`/`list_add`/`ask_user_question` no longer abort while awaiting your answer (only `zombie_run_stood_down_subagent_wait` did before). `tests/zombie-user-input-standdown.test.ts` pins it. `audit/AVO-DEEP-DIVE-2026-09-02.md` is the full AVO read (`Vary(Pt)=Agent(Pt,K,f)` §3.3 3-sentence supervisor, 40 versions/500 dirs in 7d B200, supervisor = conditional trajectory review → steer). PR #22 = true §3.3 but P1s (raw HEAD, no fencing, cycling-cap bypass) — not merged; PR #36 commissar = not AVO (mislabelled) — only this 10-line slice ships. Both PRs closed as not-merge-as-is; disposition stands.

# Next

*promoted from Later — pick one:*
- visual improvements ?
- analyze antigravity and codex see if we can learn something


# Later

## visual improvements ? 

## analyze antigravity and codex see if we can learn something

