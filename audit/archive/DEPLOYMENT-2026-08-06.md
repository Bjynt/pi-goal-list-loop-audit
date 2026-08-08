# Deployment gap closed — pi-goal-list-loop-audit runtime → repo (2026-08-06)

## The gap (why "the fixes aren't working" despite shipping)

All 8 OPEN-ISSUES-2026-08-06 fixes (items #1–#8) plus the v0.34.61 reviewer
superseded-disapproval curation were committed to the repo, but the RUNNING pi
loaded `~/.pi/agent/npm/node_modules/pi-goal-list-loop-audit` — a copy of the
PUBLISHED npm package installed at 2026-08-06T10:51 (when the plugin was
re-added to `~/.pi/agent/settings.json` after the OOM investigation).

- `npm view pi-goal-list-loop-audit version` → `0.34.57` (latest published).
- The repo is v0.34.57-in-name but contains unreleased delta:
  - `extensions/loops/goal.ts` — 597 diff-lines vs the stale install
    (item #1 rearm cap, #2 ledger, #5 model-switch ledger, #7 quota prompter,
    #8 contract-scoped revision)
  - `extensions/goal-loop-auditor-process.ts` — 173 diff-lines (item #4
    heartbeat no-progress watchdog — the "27h audit" fix)
  - `extensions/goal-loop-core.ts` — 200 diff-lines
  - `extensions/goal-loop-display.ts` — 33 diff-lines (item #3 clock-skew,
    item #2 MAIN_HOST_LABEL)
  - `extensions/reviewer.ts` — 24 diff-lines (curateAuditReviewSources)
- Evidence the runtime was stale: screenshots 2026-08-06 18:39–22:41 show
  `auditor blocked - no verdict`, a 27h audit finding, and repeated
  `host session lost` — all states the shipped fixes bound/improve.

## The fix

```bash
cd ~/.pi/agent/npm/node_modules
mv pi-goal-list-loop-audit pi-goal-list-loop-audit.stale-0.34.57-20260806
ln -s /home/dracon/Dev/pi-goal-loop-audit pi-goal-list-loop-audit
```

The runtime path is now a symlink to the dev repo — the SAME pattern as the
npm-global copy (`~/.npm-global/lib/node_modules/pi-goal-list-loop-audit`
was already a symlink). Stale copy preserved at
`pi-goal-list-loop-audit.stale-0.34.57-20260806/` for rollback.

Verified after linking: `curateAuditReviewSources` (reviewer.ts), 
`DEFAULT_HEARTBEAT_NO_PROGRESS_MS` (auditor-process.ts),
`quota_prompt_scheduled` (goal.ts) all present via the symlink.

## Activation

A `/reload` (or restart) is required — running sessions keep the code they
loaded at startup. All fixes listed in OPEN-ISSUES-2026-08-06.md become live
after reload.

## Hazards (read before updating)

1. **`pi update pi-goal-list-loop-audit` (or any reinstall of the npm:
   package) replaces the symlink with the registry package** — which is the
   STALE 0.34.57 until a release lands. After any pi update, re-check:
   `readlink ~/.pi/agent/npm/node_modules/pi-goal-list-loop-audit`.
2. **Release TODO**: bump `package.json` past 0.34.57, move CHANGELOG
   `## Unreleased` → versioned section, commit + tag + push, GitHub Release
   → npm publish (see docs/RELEASING.md). After the release, `pi update`
   fetching the NEW version is fine (released == current); re-symlink only
   if continuing dev-iteration on the repo.
3. The repo `package.json` version (0.34.57) does NOT reflect the delta —
   pi will not offer an update (registry says 0.34.57 == installed). This is
   expected until the release lands.

## Still-open requests (not shipped, from note.md)

- Subagent HUD text spacing/polish (screenshot 2026-08-06 22:38).
- "Vision to see if stuck" — integration of `mmx vision describe` (or a
  preapproved vision model) so the MAIN agent can visually check whether a
  worker/session is stuck; only preapproved switches allowed (ties into
  item #5's forbidden-model policy).
- Session-loss auto-recovery ergonomics: `host session lost` still requires
  manual `/reload`/`/list resume` after a pi restart in sessions that never
  receive a fresh `session_start`.
- List-with-subtasks vs goal-with-subgoals semantics question (2026-08-05
  note: "we stopped on qd" — parallelization of list items).
