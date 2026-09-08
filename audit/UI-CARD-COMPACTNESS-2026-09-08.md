# Active-card compactness — 2026-09-08

## Finding

The active `belowEditor` card repeated the same main-model recovery episode in
three forms: a full recovery block, a primary/current provenance row, and a
long status-footer suffix. Durable-vs-defer plaque prose also used the whole
terminal width, and Markdown wrappers in user objectives leaked into the
headline. On a short viewport this pushed the card into pi-tui's
`widget truncated` boundary before the user could see the selected judgment.

## Decision

Keep the glance surface compact and keep the detailed report durable:

- active recovery is one row (`recovery: ...`) with phase, selected rung,
  current model, attempt count, and skipped count;
- a settled recovery marker is shown as one `model: ... · primary` row;
- the status footer remains the liveness/actionability surface and does not
  concatenate the full recovery report;
- `/goal status` remains the complete recovery surface with ordered chain,
  timestamps, and skip reasons;
- durable/defer plaques retain semantic order, recommendation, and selected
  choice, but cap explanatory prose for the glance card;
- objective Markdown wrappers are stripped only in the display projection;
  persisted objectives and prompts are untouched;
- a judgment-only tail closes with `└─` rather than a dangling branch glyph.

This changes presentation only; recovery scheduling, persistence, ownership,
and lifecycle fences are unchanged.

## Evidence

- `extensions/goal-loop-display.ts` contains the compact recovery projection,
  bounded plaque bodies, plain-text objective projection, footer de-duplication,
  and judgment-tail closure.
- `tests/goal-loop-display.test.ts` pins compact active recovery, duplicate
  suppression, settled-model display, and Markdown cleanup.
- `tests/display.test.ts` pins the status/card surface split and recovery
  diagnostics remaining out of the active footer.
- `tests/durable-defer-ui-fixture.test.ts` and
  `tests/durable-defer-production-ui.test.ts` retain durable-first plaque
  ordering and the selected-choice marker.

## Verification

Targeted display suite: 136 pass, 0 fail (including agent-panel and durable
judgment production fixtures).

`npx tsc --noEmit`: pass.

The release gate is run separately after the version bump; its result is added
here without replacing this append-only finding.
