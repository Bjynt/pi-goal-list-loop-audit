# GitHub maintainer inventory — 2026-08-25

## Scope and method

Live authenticated inventory for `DraconDev/pi-goal-list-loop-audit`, checked
against `main` after the v0.35.64 release. Sources were:

- `gh issue list --state open --limit 100`
- `gh issue view` for the plugin-relevant issues
- `gh pr list --state open --limit 100`
- `gh pr view` for every open pull request
- current source, tests, `CHANGELOG.md`, and the v0.35.64 tag/release

At the time of the survey there were **12 open issues** (#23, #25–#35) and
**3 open pull requests** (#22, #24, #36). No issue or PR was merged, closed,
commented on, labeled, or otherwise modified by this survey.

## Open issues

### Actionable — plugin-owned

- [#23 — Detached auditor launches worker with compiled Pi executable](https://github.com/DraconDev/pi-goal-list-loop-audit/issues/23)
  — `extensions/goal-loop-auditor-process.ts` still defaults to raw
  `process.execPath`; a compiled Pi host can parse `--job-dir` itself instead
  of launching the worker. Related implementation: [PR #24](https://github.com/DraconDev/pi-goal-list-loop-audit/pull/24), which declares
  `Closes #23`.
- [#30 — 503/429 in-band tool results invisible to loop stuck detector](https://github.com/DraconDev/pi-goal-list-loop-audit/issues/30)
  — successful tool results containing provider/network failures can enter
  repetition accounting as ordinary results. The existing error-exemption
  tests do not cover this in-band path.
- [#32 — A bound-stopped loop has no restart path except the human slash bar](https://github.com/DraconDev/pi-goal-list-loop-audit/issues/32)
  — time/token-bound stops are not in the same resumable set as the existing
  plateau, stuck, metric-never-moved, and zero-stream paths. The issue also
  reports a production zero-stream recovery window requiring manual resume.
- [#34 — metricless loops have no configurable minimum inter-iteration cadence](https://github.com/DraconDev/pi-goal-list-loop-audit/issues/34)
  — metricless loops intentionally have no plateau stop, but successful idle
  cycles can be dispatched too quickly and accumulate false stuck/churn events.

### Out of scope / upstream

- [#25 — orphan-run repair depends on a live session](https://github.com/DraconDev/pi-goal-list-loop-audit/issues/25) — cites async-run tracker and stale-run reconciler code absent from this repository.
- [#26 — retryable model failure patterns miss transient codes](https://github.com/DraconDev/pi-goal-list-loop-audit/issues/26) — cites an upstream `subagent-runner.ts` classifier not present here.
- [#27 — worktree cleanup leaves orphan session files](https://github.com/DraconDev/pi-goal-list-loop-audit/issues/27) — cites upstream worktree/session-store behavior absent locally.
- [#28 — role-memory write lock](https://github.com/DraconDev/pi-goal-list-loop-audit/issues/28) — `.pi/agent-memory` is not owned or written by this plugin.
- [#29 — variant/provider model verification false positive](https://github.com/DraconDev/pi-goal-list-loop-audit/issues/29) — cited verification helpers are absent from this tree.
- [#31 — same-model turn retry ladder](https://github.com/DraconDev/pi-goal-list-loop-audit/issues/31) — cites Pi core retry internals, not the plugin fallback envelope.
- [#33 — inherited child-model verification false positive](https://github.com/DraconDev/pi-goal-list-loop-audit/issues/33) — cited child self-report verification path is absent locally.
- [#35 — `/subagents-refine` mission artifacts](https://github.com/DraconDev/pi-goal-list-loop-audit/issues/35) — cited refinement and mission-store components are absent locally.

No open issue was confirmed as already addressed or a true duplicate. Related
local fixes such as #14/#17 and v0.35.54 are narrower than the four actionable
issues above.

## Open pull requests

### Actionable / related to an actionable issue

- [PR #24 — fix(auditor): launch worker with a JavaScript runtime](https://github.com/DraconDev/pi-goal-list-loop-audit/pull/24)
  — mergeable but `UNSTABLE`, non-draft, and explicitly closes #23. It needs
  review against current `main`, current release tests, and changelog/version
  cleanup before any merge decision. It was not merged.

### Blocked by divergence/conflicts

- [PR #22 — v0.36.0 AVO-inspired goal stagnation supervisor](https://github.com/DraconDev/pi-goal-list-loop-audit/pull/22)
  — non-draft and `DIRTY`/conflicting against current main. The feature is
  distinct from PR #36 and is not present in current main, but the branch
  predates substantial state-root and lifecycle hardening.
- [PR #36 — v0.37.0 opt-in adherence watchdog](https://github.com/DraconDev/pi-goal-list-loop-audit/pull/36)
  — non-draft and `DIRTY`/conflicting against current main. The feature is
  distinct from PR #22 and is not present in current main; its 42-file diff
  overlaps recently hardened lifecycle files and its version ordering depends
  on the v0.36.0 decision.

No open PR was confirmed as already addressed, duplicate, or out of scope.
Neither #22 nor #36 should be merged wholesale; both require selective porting
and a fresh release-gate run if the maintainers choose to pursue them.

## Proposed follow-up goals

1. **Resolve the compiled-host auditor launcher (#23/#24).** Review PR #24 on
   current main, retain explicit runtime overrides, detect Node/Bun versus a
   compiled Pi executable, add Node/Bun/Windows/compiled-host regressions, and
   run the full release gate before deciding whether to merge.
2. **Classify in-band provider failures (#30).** Preserve bounded provenance
   for textual 503/429/network failures in otherwise successful tool results;
   exempt them from repetition/stuck accounting and route them through the
   existing provider-recovery envelope without exempting genuine repeated
   work failures.
3. **Define bound-stop recovery (#32).** Decide and document token/time and
   zero-stream resume/refine semantics, including budget reset behavior and
   truthful status guidance; then add persistence and behavioral regressions.
4. **Add opt-in metricless cadence (#34).** Persist and display a minimum
   inter-iteration interval/next wake for metricless loops, preserve urgent
   wakes and current defaults, and add cadence/churn/stuck-detector tests.
5. **Review PR #22 selectively.** If stagnation supervision is wanted, port it
   onto current main without losing state-root, host-boundary, or recovery
   hardening; resolve the v0.36.0 release contract and rerun all gates.
6. **Review PR #36 selectively.** If adherence supervision is wanted, port it
   after the v0.36.0 decision, preserve current lifecycle behavior, and resolve
   the v0.37.0 version ordering before any merge.

The survey itself performed no external mutations.

## Follow-up review — 2026-08-26

Local read-only maintenance work resolved the four plugin-owned issues without
changing GitHub issue/PR state:

- #23 compiled-host auditor launch: fixed and released in v0.35.66; PR #24
  remains open and unmerged.
- #30 in-band 503/429/network tool panes: fixed and released in v0.35.67.
- #32 bound-stop recovery: fixed and released in v0.35.68.
- #34 opt-in metricless cadence: fixed and released in v0.35.69.

The current authenticated review of PR #22 and PR #36 remains read-only. Both
are open, dirty/conflicting, and based on branches that overlap current
lifecycle/recovery files. PR #22 proposes the AVO-inspired goal stagnation
supervisor and claims v0.36.0; PR #36 proposes the commissar watchdog and
claims v0.37.0 while depending on the #22 version decision. Neither should be
merged wholesale. Selective porting would be a new feature decision and must
preserve current state-root, host-boundary, recovery, and release behavior.

No external issue or PR was merged, closed, commented on, labeled, or otherwise
modified during the follow-up.
