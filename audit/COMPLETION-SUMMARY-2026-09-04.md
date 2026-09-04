# Good completion summary — v0.38.13 (2026-09-04)

Field complaint (note.md Next, `Screenshot_20260903_204003/204005` from the
new-tab and vidpro sessions): the `✓ done` notify mashed all six labels
into one line with every value hard-sliced **mid-word** (`0 o…`, `qu…`,
`belo…`) — and repeated the agent's prose paragraph sitting above it.

## What changed

- The `✓ done` **chat** notify now carries the six-label block — one
  `Label: value` line per label, values cut at word boundaries (240-char
  budget): `✓ done — auditor <model> approved.\nOutcome: …\nChanged: …\n…`.
  Three paths: detached-approval settle (`goal-auditor-hooks.ts`), and the
  no-audit + manual-verify approvals (`goal-tools.ts`, whose tool-result
  text uses the block too).
- New `clipSummaryValue` (cut at the last space in budget, hard-cut only
  for spaceless long tokens like hashes) backs both the block and the
  single-line projection — the old mid-word slice is gone everywhere.
- The single-line projection is **kept** where width demands it: the TUI
  widget card (`goal-loop-display.ts`) and `notifyExternal` (pager/sound
  safe) still get the compact line, now word-cut.

## The bug found on the way

The first cut computed the block *after* `archiveCurrentGoal`, which
clears `state.goal` — the builder threw on `null.completionSummary`,
the archive had already landed, and the `✓ done` notify never fired.
Two behavioral tests caught it. Rule restated: **terminal text is
computed pre-archive, from the same facts as the compact recap.**

## Verification

- New `tests/completion-summary-lines.test.ts` (7 tests): word-boundary
  clip, long-token hard-cut, six-line order/shape, missing→`not recorded`,
  compact stays single-line but word-cut, terminal-lines parity with the
  compact path, call-site pins (block in chat, compact in external).
- `behavioral-orchestrator` v0.34.22/v0.34.91 pins moved to the block
  shape (exact-once decisive voice, per-label lines, `…` bound, full
  20×-repetition recap still flattened).
- Full gate: **1890 pass, 0 fail**, `tsc` clean.
