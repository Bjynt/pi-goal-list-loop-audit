# Paused-while-working UI — 2026-08-10

## Finding

The new note screenshots show a truthful paused/recovery state, but the
lifecycle ownership and last-progress evidence were not explicit enough:

- `Screenshot_20260810_043959.png` — a LIST item is paused on an automatic
  provider/quota retry. The surface shows `30 queued`, `next probe in 20m`,
  `awaiting first turn — resumes exactly here`, and `/list resume`, but it
  does not label the recovery owner or the last real host activity.
- `Screenshot_20260810_043955.png` — the same pattern for a goal item: paused
  work is safely parked and the provider/backup retry is automatic, yet the
  elapsed pause time can be mistaken for last progress.
- `Screenshot_20260810_044058.png` — an auditing goal is waiting on a detached
  auditor verdict. This is host-bearing `MAIN HOST · SUPERVISING` work, not a
  paused item; it already exposes auditor elapsed/worker activity semantics.
- `Screenshot_20260810_044205.png` — the detached auditor is explicitly
  `AUDITOR · DETACHED · LIVE` with current worker activity. It must not be
  collapsed into the paused-main state.

MMX vision was used for all four screenshot checks. The display contract is
therefore about **paused goals/list items only**; auditor protocol and the
pi-owned transcript/reveal surface remain unchanged.

## Final display contract

For every paused goal/list item, the plugin-owned status projection now shows:

```text
<actionability/state> · safely parked · owner: <recovery owner> · <queue state>
  · last activity <elapsed|not observed|not available>
  · next: <countdown/clock/manual resume action>
```

The owner is derived from existing durable state without changing it:

- `main-model recovery` for provider/quota recovery;
- `detached auditor recovery` for a stored completion claim without a verdict;
- `glla recovery timer` for a plain timed wait;
- `user decision`, `user action`, or `manual action` for pauses requiring a
  human/model action; and
- `manual resume` for legacy unclassified pauses.

The widget adds two width-aware lifecycle lines: one for safely parked/owner/
queue state and one for last activity/next transition. Existing pause reason,
decision options, countdown, saved-work, and exact `/goal resume` or `/list
resume` action lines remain intact. A paused item never gains a LIVE or MAIN
host badge. `goal-ui.ts` now passes the existing goal-scoped last-real-activity
and last-stream timestamps through to paused display projections; no lifecycle
state or timestamp persistence schema changed.

## Verification

```text
MMX vision — 4 screenshots described above
npx tsc --noEmit — TypeScript: No errors found
bun test tests/display.test.ts — 90 pass / 0 fail
```

Focused tests cover provider recovery with queue/last-activity/next-transition
fields and a no-turn decision pause with truthful `last activity not observed`
and `/goal resume` guidance. Existing paused, quota, auditor, stale-host, and
surface-separation tests remain green.
