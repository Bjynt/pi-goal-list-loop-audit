# Human end-of-objective briefing — v0.38.14 (2026-09-04)

Follow-up to v0.38.13: the six-line block was still a *record*, not a
*briefing*. The user-facing rule from here on: **the chat notify informs
the human at a glance; the durable archive keeps the audit record.**

## The shape (every `✓ done`, all three approve paths)

```
✓ done — <Outcome in its own words, ~140 chars>
<Changed|Evidence|Tests|Unresolved|Next>: <value, ~120 chars>   (only informing labels)
— auditor <model> approved[.]/— completed without audit (your choice).
```

- Filler never renders: `none`, `none.`, `none for this objective`,
  `N/A`, `not recorded` (including the system `not recorded — <reason>`
  placeholders) and empties are dropped by `briefValueContent`.
- Agent habit `none — <real content>` keeps just the content
  (`Next: none — queued follow-ups…` → `Next: queued follow-ups…`).
- Word-boundary cuts everywhere (`clipSummaryValue`, v0.38.13).
- External notifies + TUI widget card keep the compact single line.

## Bugs found on the way

1. **Post-archive null crash (v0.38.13 first cut):** the block was
   computed after `archiveCurrentGoal` clears `state.goal` — the builder
   threw, the archive had landed, the notify never fired. Restated rule:
   terminal text is computed pre-archive.
2. **Over-eager prefix strip:** the first `briefValueContent` stripped
   *both* `none —` and `not recorded —`, turning system placeholders
   into pseudo-content. Now: `not recorded*` always drops whole;
   only `none —` strips to its content.

## Verification

- `tests/completion-summary-lines.test.ts` (10 tests): filler matrix,
  prefix rules, briefing order/content, terminal parity, call-site pins.
- Behavioral fallout repaired, not waived: v0.34.22 (exact-once
  `✓ done — <outcome>` voice), v0.34.91 (outcome-led header, informing
  labels kept / filler dropped, `…` bound), v0.36.0 no-audit (objective-led
  header, no-audit trailer, zero `not recorded` leakage).
- Full gate: **1893 pass, 0 fail**, `tsc` clean.
