# Below-chat lifesign — v0.38.23 (2026-09-07)

Field: 2026-09-06 screenshots show the GLLA card vs the native fleet
swapping slots across ticks, plus three accumulated display debts — the
`→ <objective>` header repeating the head verbatim, two-line worker rows
with ids nobody can act on in ambient view, and command-hint footers
naming our extension instead of the user's task.

## What shipped (display-only; no automation/hold/auditor changes)

1. **Forced `{ placement: "belowEditor" }`** on the `pi-glla` setWidget
   call — the same zone the fleet defaults to. Forced, not a setting:
   one stable layout, no settings row / headless display / drift pin.
2. **Footers deleted**: orphan-worker `/glla agents` pointer, card
   `/goal status · /glla` hints, overflow `· /glla agents` suffix.
   Queue depth survives as task info (`└─ N queued`); empty queue means
   no footer at all.
3. **Option-2 rows**: one glyph-first line per child
   (`▶ scout · ui-fixes · silent 2m`), age before suffixes, stalest
   first within rank (pre-existing `orderedRows`), ids only in
   `/glla agents`. The `→ ` header tolerance branch in
   `buildWidgetLines` stays (defensive) with no producer.
4. **Evidence lifesign** (`headLifesign` + `lifesignBandFor` in
   `goal-loop-core.ts`, the shared leaf — no import cycle):
   `· stream {age}` readout as the last head segment; breather frame
   from `Σ toolUses + outputTokens mod 4`, never wall-clock. Fresh
   breathes `●→◉→○→◉`, aging freezes `◉`, stale hollows `○`, a hung
   child triangles the head to `⚠`. Active-clear heads only —
   ⏸/⟡/⚠/⏳ keep their language; zero rows invents nothing.
5. **Semantic ramp on head + rows only**: success <5m, warning to 30m,
   error past it; queued caps at amber; meter stays progress-colored,
   fleet untouched. Monochrome degrades to shape + number; no-theme
   renders contain zero ANSI.

## Design notes worth keeping

- The breather's job is alive-vs-frozen across glances, not band
  identity — bands ride on color + the age number. A fresh `◉` phase
  and a frozen aging `◉` share a shape; the number (`stream 8s` vs
  `stream 12m`) plus the color separate them.
- `fmtDuration`/`bucketSilentMs` moved panel → core so the head readout
  and the rows share bucketing by construction, not convention.
- `paint` is now exported from `goal-loop-display.ts` for the panel's
  row glyphs — the only new cross-module value edge, same direction
  as the existing `truncateCells` import (no cycle).
- `agentRows` rides `WidgetExtras` from the same snapshot the rows
  render — one snapshot, two projections, never diverging.

## Coverage

- `tests/lifesign.test.ts` (7): bands incl. the queued-amber cap,
  empty/ended invents nothing, counter-derived breath (same counters +
  later clock = same frame; +1 evidence = next frame), head readout /
  hung triangle / paused-untouched / bare-no-readout, row colors +
  unpainted shape+number, 80-col fit + bucket key-stability (elapsed
  `total …` normalized — that segment still ticks wall-clock,
  pre-existing, out of scope).
- Reshaped: `display` (footer contract), `agents-panel` (single-line
  rows, orphan ends the card), `subagent-display-richness` (no header,
  stalest-first, width).
- `npx tsc --noEmit` clean; `release:check` green (see goal verdict).
