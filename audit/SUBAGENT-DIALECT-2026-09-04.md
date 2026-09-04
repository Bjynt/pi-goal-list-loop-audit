# Subagent dialect fix — v0.38.16 (2026-09-04)

Field complaint: the current `pi-subagents` package "seems to do less" than the old
`@tintinweb/pi-subagents`. Compared both live from npm; the package is fine — **GLLA's
prompts were speaking a dead dialect**.

## Verdicts

- **Do NOT go back to tintinweb (`0.19.0`, untouched since 2026-08-27).** Ships raw TS
  with no `main`/`exports` and `.js`-suffixed imports — the recorded missing
  `src/agent-manager.js` is this fragility, still present. Legacy provider model, and it
  collides with pi-subagents' provider RPC.
- **Stay on `pi-subagents` (pinned `0.62.0`; `0.65.0` out 2026-09-04).** One `subagent`
  tool, 9 roles, orchestrator skill. Heads-up: 0.65 runs children as native in-process
  sessions instead of separate processes — separate canary'd upgrade evaluation, not a
  drive-by bump.
- **The "does less" was GLLA-owned.** Since the 08-31 switch, prompts said *"Use the
  `Agent` tool"* — a tool that does not exist (pi-subagents registers `subagent`).
  Transcript proof (new-tab, 2.5 days): **23× `subagent`, 0× `Agent`**. The model found
  the real tool alone; all fan-out/Designer/ROI guidance named the dead one.

## Changes (v0.38.16)

- `prompts/goal-loop-forever.md`, `goal-loop-forever-metricless.md`, `goal-loop-draft.md`:
  `Agent` → `subagent` tool (+ article typo `an scout`).
- `prompts/goal-loop-continuation.md`: Designer checkpoint + tool list use `subagent`;
  settle guidance `get_subagent_result` → `bg_wait`. Research fan-out roles (`scout`,
  `worker`) and the `` `Agent: Designer` `` objective syntax unchanged — both live.
- `extensions/goal-continuation.ts` (Designer injection text), `goal-agents-panel.ts`
  (empty-panel hint), `goal-heartbeat.ts` (wedge hint): same rename. The heartbeat's
  legacy-name match set is intentional (old transcripts) and stays.
- **Functional:** `isSubagentProviderFailure` (`quota-retry.ts`) now matches
  `subagent`/`subagent_wait` — failed spawns previously missed the provider-retry path
  entirely (goal-activation.ts:1102).

## Verification

- `tests/subagent-polish.test.ts`: +2 tests (provider-failure for the live tool names;
  dialect grep over prompts + panel + Designer text).
- `tests/prompt-subagent-guidance.test.ts`: pin now requires `` `subagent` `` (allows the
  `Agent: Designer` task syntax).
- Template byte pins refreshed for the −20-char shrinkage
  (`context-checkpoint` 25833→25813; growth-measurement rows likewise; linearity
  invariants hold).
- `TMPDIR=/var/tmp npm run release:check`: **1899 pass, 0 fail**; `tsc` clean.
