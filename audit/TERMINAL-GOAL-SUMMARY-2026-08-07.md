# Terminal-goal summary line — v0.34.89 (Screenshot_20260807_231205 / 231236)

Field: the user asked (with two screenshots) whether completed goals should be
closed or shown differently. The screenshots showed the plugin's own surfaces
after a batch finished: the widget still rendered the full completion CARD —
`✓ <objective> · ✓ complete · took 39m 45s` with a `└─ auditor approved (…)`
sub-line — and the status line kept the loud `glla: ✓ complete · took 39m 45s`
in success color. Both stayed forever (until the next goal started), so a
finished item read like still-active work. User's answer to the design
question: *"do we need to keep around the widget? we should just do a summary
no?"* → no card, one summary.

## Design

1. **Widget** — `completedGoalLines` (extensions/goal-loop-display.ts) now
   returns exactly ONE dim line:

   ```
   ─ ✓ done · Fix audit finding: 'AUDIT.md:893' … · took 4h 38m
   ```

   Aborted keeps the reason: `─ ✗ aborted · <objective> · <short reason> ·
   took 28m`. The v0.34.65 trace guarantee is preserved ("what ran + how
   long") — just not as a second active-looking surface.

2. **Status line** — the terminal branch is dimmed and compact:

   ```
   glla: ✓ done · 4h 38m        (complete, dim)
   glla: ✗ aborted · 28m        (aborted, dim)
   ```

3. **Where the detail lives** — the verdict/reason stays in the archive
   (`.pi-glla/goals/*.md` + audits.jsonl) and `/goal status` (Audits: N (M
   approved)); the summary never fabricates a verdict for a goal without one.

4. `completionSummary()` and the now-unused `auditVerdictLabel` import were
   removed.

## Files

- `extensions/goal-loop-display.ts` — status branch, `completedGoalLines`,
  comment updates, import cleanup.
- `tests/display.test.ts` — 4 v0.34.65 card tests rewritten for the summary
  (single line, verdict absent from the widget, no fabricated verdict for
  verdict-less goals), held-loop suffix test updated to `✓ done`.

## Verification

- Suite: **1090 pass / 1 skip / 0 fail across 100 files** (same count — the
  four card tests were rewritten, not added).
- `tsc --noEmit` clean.
