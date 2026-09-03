# TUI information-density pass — v0.38.8 (2026-09-03)

Whole-TUI glance pass: widget + status line + notify cards + settings menu.
Rule: only state GLLA already holds (tasks, verdicts, auditor phase,
holds), display-only, every new row width-safe. Captures below are
builder-rendered (no theme), i.e. exactly what the tests pin.

## 1. Widget — audits row

Before:

```
● Dense widget goal · active · total 4h 00m · 1/2 ▰▰▰▱▱ · 12.0k tok
└─ /goal status · /glla
```

After (row present iff history non-empty, truncated to width):

```
● Dense widget goal · active · total 4h 00m · 1/2 ▰▰▰▱▱ · 12.0k tok
├─ audits: 2 verdicts · 1 disapproved · last disapproved 2h 00m ago
└─ /goal status · /glla
```

## 2. Paused status — verdict tally suffix

After (all paused branches inherit via `pausedStatusSuffix`; silent when empty):

```
glla: ⏸ action needed · safely parked · owner: manual action · queue empty · last host activity not available · next: /goal resume · 2 verdicts · 1 disapproved · last disapproved 2h 00m ago
```

A parked session with disapprovals now reads as "waiting with history",
not dead — the last piece of the "are we progressing?" complaint.

## 3. Starvation ladder — one recovery per line

Before: a single ~950-char paragraph burying the (1)/(2)/(3) ladder.
After: 6 lines, same content, same pinned phrases:

```
glla: output-token stop was context starvation (tiny output at 124.5% context) — yielding to pi auto-compaction instead of re-sending.
If compaction fails or context is already over cap, in order:
(1) run /compact again — GLLA already trimmed repeat payloads to a checkpoint, so the retry may now fit;
(2) switch to a larger-context model, then /compact (GLLA auto-rotates its fallback chain after a failed compact-and-retry);
(3) /new, then /goal resume — the goal, tasks, ledger and audits are durable on disk, and the post-compact resync re-anchors the fresh session with no summarization needed.
Automatic turns stay parked until a real compaction lands.
```

## 4. Settings tabs — row counts

Before: `Keep-going  Main agent  Drafter  Auditor  Subagents  Stall brakes  Other`
After: `Keep-going (8)  Main agent (5)  Drafter (3)  Auditor (6)  Subagents (4)  Stall brakes (3)  Other (9)`
(counts illustrative — computed live from the row store; pure
`settingsTabLabel` helper, color-only tab styling unchanged.)

## 5. Verification

- New `tests/tui-density.test.ts` (5 tests): widget row present/absent,
  **widget fits 80 columns at width 80**, paused tally present/absent,
  ladder 6-line shape + phrase pins, tab-label pins.
- `tsc --noEmit` clean; full serial suite green (1835 baseline + 5 new).
- Code diff: `goal-loop-display.ts` (widget row + paused suffix),
  `loops/goal-ui.ts` (ladder reflow, no phrase changed),
  `settings-menu.ts` (`settingsTabLabel` + one call-site).
- Untouched: all automation (send/schedule/retry), hold mechanics,
  auditor phase machine, approved menu reorganization (still deferred —
  this pass is density, not restructure).
