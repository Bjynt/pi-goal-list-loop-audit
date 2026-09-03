# Session visibility — recovery banner + durable verdict tally (2026-09-03)

## 0. The complaint (note.md Next, screenshots 223001/223042/090025-1)

Two related invisibilities: after a reload the session looks goal-less
(objectives "seemingly lost" — the state is on disk but the transcript is
empty, so nothing names it), and a capped/queued auditor session looks dead
("are we progressing?" — the in-memory auditor progress is gone after a
reload, so the status surfaces have nothing to say). Both are the same root
cause: **the always-on surfaces depended on live/transcript memory instead
of durable disk state.**

## 1. What v0.38.7 ships

- **Load-hold recovery banner (new):** when a consent-less cold load engages
  the load hold with pending durable state, a second notify now paints
  objective + next pending task (first non-complete, completed tasks
  skipped) + verdict tally + the resume command (`/goal` vs `/list` vs
  `/loop` by policy), all read from restored disk state. Fires exactly once
  with the fresh hold (the existing `loadHoldAt` guard); never a timer
  re-arm. Ledger `load_hold_recovery_banner` carries counts, not prose.
  (`buildLoadHoldRecoveryLines`, wired in the `session_start` hold branch.)
- **Durable verdict tally (new):** `auditorVerdictTally` classifies
  `auditHistory` through `auditVerdictLabel` — a shield-blocked approval is
  never a disapproval, an infra error is never a verdict — yielding total /
  approvals / disapprovals / last-verdict age+label. Surfaced in two
  always-on places: the auditing status-line footer
  (`· 2 verdicts · 1 disapproved · last disapproved 2h 00m ago`) and the
  `/goal status` `Audits:` line (now `Audits: 2 verdicts · … (1 approved)`).
  Silent when history is empty. After a reload this is the *only* auditor
  evidence left, and it now answers "are we progressing?".
- Untouched: the hold mechanics and hold text (consent model unchanged),
  the auditor phase machine (queued/running/quiet/blocked), the per-turn
  auditor card (detail still lives there, not the footer).

## 2. Verification

- New `tests/session-visibility.test.ts` (5 tests): tally classification
  matrix incl. shield-blocked/infra-error/bad-date, silent-empty segment,
  banner text pins + empty-state variants, auditing status-line tally pin,
  **behavioral** reload (paused goal + tasks + verdict → session_start →
  exactly one banner with objective/next/verdict/resume + ledger entry).
- `tsc --noEmit` clean; full serial suite green (1830 baseline + 5 new).
- Code diff: `goal-loop-display.ts` (tally + segment + banner builder +
  status-line suffix), `goal-commands.ts` (`Audits:` line),
  `loops/goal-activation.ts` (hold-branch banner, +1 import).
