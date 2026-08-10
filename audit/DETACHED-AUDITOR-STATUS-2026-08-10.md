# Detached-auditor status surface — 2026-08-10

## Finding

The supplied screenshots
`/home/dracon/Pictures/Screenshots/Screenshot_20260810_044058.png` and
`/home/dracon/Pictures/Screenshots/Screenshot_20260810_044205.png` show the
completion-audit handoff rather than paused main work. The first is the
host-bearing `MAIN HOST · SUPERVISING` surface while a completion claim waits
on the detached subprocess; the second is the worker-side
`AUDITOR · DETACHED · LIVE` state with current activity. The ambiguity was
that the surface did not put the subprocess phase, evidence/freshness, and
next transition into one explicit contract, so “waiting for the verdict” was
left for the user to infer.

MMX vision was used during the screenshot review. A repeat check in this pass
was unavailable because the MMX Token Plan usage limit was reached; no visual
claim below relies on that failed repeat. The existing screenshot mapping and
prior MMX result are preserved here as evidence.

## Display contract

For `goal.status === "auditing"`, the plugin-owned projection now keeps the
main host and detached worker separate while showing:

```text
MAIN HOST · SUPERVISING · auditor: <phase> · detached worker
  <last tool/current evidence> · elapsed <duration>
  · worker activity <age> · <fresh|stale|freshness pending>
  · next: <worker completion → verdict | apply detached verdict | …>
```

The always-on status line carries the compact phase, tool/evidence summary,
elapsed time, worker-activity age, freshness classification, and next
transition. The above-editor card retains its width-aware phase line and
observations, adds an explicit detached-worker marker and protocol-safe
evidence summary, and preserves the existing current-tool vs last-observed-
tool distinction. A completed worker snapshot is rendered as
`auditor: awaiting verdict` / `waiting for detached verdict`, with the final
report and last tool identified without exposing think blocks or enabling the
live report tail.

The next transition is display-only vocabulary: queued → detached worker
start; running → worker completion → verdict; quiet/blocked → worker event or
manual cancellation; awaiting verdict → apply detached verdict. No lifecycle,
auditor protocol, ledger event, subprocess, or pi-owned transcript/reveal
behavior changed. `MAIN HOST · SUPERVISING` remains the host-bearing label;
these states do not render the main goal as paused.

## Evidence and verification

- `extensions/goal-loop-display.ts` adds pure elapsed, freshness, evidence,
  and next-transition projections; it does not mutate `Goal`, `State`, or
  auditor progress.
- `extensions/loops/goal-ui.ts` continues to pass the existing ephemeral
  `latestAuditProgress` snapshot; no persistence schema or protocol change was
  made.
- `tests/display.test.ts` adds focused live and completed-audit assertions for
  phase, tool/evidence, freshness, elapsed, explicit verdict waiting, next
  transition, detached-worker labeling, and the non-paused MAIN surface.
- Existing auditor process, unmatched-telemetry, silent-report, verdict, and
  ledger behavior tests remain the regression boundary.

```text
bun test tests/display.test.ts — 92 pass / 0 fail
bun test tests/auditor-polish.test.ts — 12 pass / 0 fail
bun test tests/auditor-process.test.ts — 14 pass / 0 fail
bun test tests/auditor-unmatched-telemetry.test.ts — 12 pass / 0 fail
npx tsc --noEmit — clean
bun test — 1213 pass / 1 skip / 0 fail across 107 files
```
