# Completion-summary usefulness audit — 2026-08-27

## Inventory

Method: grepped `.pi-glla/archive/*.md` (189 files as of 2026-08-27) and
`.pi-glla/active.jsonl` ledger for `completionSummary` presence and label
coverage. Classified each archived summary as:

- **missing** — no `## Completion summary` section (pre-policy, before
  `audit/COMPLETION-SUMMARY-POLICY-2026-08-19.md`)
- **generic/unlabeled** — free-form prose without all six labels
  `Outcome:/Changed:/Evidence:/Tests:/Unresolved:/Next:`
- **structured** — contains all six labels with `none` explicit where empty

Counts:

- missing: ~87 (all 2026-08-06 → 2026-08-11, before v0.35.5 policy)
- unlabeled generic: ~78 (early post-policy ledger 496/663 generic)
- structured six-label: ~24+ (all recent archives since 2026-08-19, 100% of
  last 15 archives including `20260827153038-hr4q8b.md`,
  `20260827144019-5x4qgu.md`, `20260827092606-fuzklq.md`)

Ledger sample (last 15): 100% structured after policy; before policy ~75%
generic in active.jsonl.

## Usefulness assessment

- Recent structured summaries are **useful**: each contains
  objective-specific evidence — changed files/behavior,
  key commits/reports (`audit/WAIT-POLL-2026-08-27.md`,
  `audit/GITHUB-MAINTAINER-INVENTORY-2026-08-25.md`), exact bounded test
  commands with pass/fail counts (`1637 pass, 1 skip, 0 fail`),
  `Unresolved: none` or explicit remaining risk, and `Next: none` or a
  concrete follow-up. Not generic `"done"`.

- Pre-policy/missing summaries are **not useful as hand-off** but are
  historically accurate — they predate the template and cannot be
  backfilled without fabricating evidence. No finding is opened for them;
  the archive is append-only.

- `verificationSummary` (ledger `PendingCompletion`) is consistently
  evidence-backed in both eras, but is **not persisted to the archive**
  (`renderGoalMarkdown` only emits `completionSummary`). After ledger
  rotation, per-contract evidence is not recoverable from the archive
  alone. This is by current design (policy separates recap vs proof vs
  auditor report); a future archive enrichment could persist a compact
  verification pointer if needed.

## Enforcement added

`extensions/loops/goal-auditor-hooks.ts:validateCompletionSummary` now
requires all six labels. On missing labels it ledgers
`completion_summary_missing_labels` and appends an honest
`— NOTE: completionSummary missing required labels … per
audit/COMPLETION-SUMMARY-POLICY-2026-08-19.md.` so the auditor and
hand-off see the gap. The narrow arithmetic check
(`completion_summary_impossible_count` for `29/28 pass`) is preserved.

Tool description at `extensions/loops/goal-tools.ts:complete_goal`
already names every label and the policy path; tests pin it.

## Template

```
Outcome: <what was delivered or learned, in one sentence>
Changed: <files/behavior/decision; none if research-only>
Evidence: <key commit/report/contract result>
Tests: <bounded commands + pass/fail, or not run — reason>
Unresolved: <remaining risk, or none>
Next: <one follow-up hint, or none>
```

Every label present even when `none`. See
`audit/COMPLETION-SUMMARY-POLICY-2026-08-19.md` for the full policy and
trade-offs (labeled string preferred over typed object until a consumer
needs field-level queries).

## Verification

- `tests/completion-recap-shape.test.ts` pins archive rendering,
  widget projection, and tool-schema six-label reference.
- `tests/completion-summary-quality.test.ts` pins missing-label and
  generic-prose detection via `validateCompletionSummary` and the ledger.
- `npm run test:all` and `npx tsc --noEmit` are the final gates.
