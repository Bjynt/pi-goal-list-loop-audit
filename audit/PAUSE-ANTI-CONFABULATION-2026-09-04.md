# Pause anti-confabulation — v0.38.15 (2026-09-04)

Field incident (new-tab, `Screenshot_20260904_142010`): goal
`20260904102702-lsh1g5` did the whole audit (19 FIX, 3 DECIDEs, 1042
tests, tsc clean) then paused with *"this session has no complete_goal
tool"* — plus *"the reviewer-subagent runner is broken"*, minutes after
the reviewer wrote its report. Forensics (transcript + ledger):

- Zero tool errors anywhere; `complete_goal` succeeded earlier in the
  SAME session; the reviewer ran fine at 13:07.
- The session is 2.5 days old with 5 compactions — the model misread
  its post-compaction tool list and confabulated, twice in one breath.

## Guard (GLLA-owned, bounded)

`pause_goal` now refuses a pause whose blocker *names a missing GLLA
tool* (`claimedMissingGllaTool`: absence language required, ordinary
mentions never match) — because the pause call itself dispatching
proves the registration batch (with `complete_goal` first in it)
landed. The refusal tells the model to call the tool now, with an
escape hatch: quoting pi's own `Tool X not found` error
(`PI_TOOL_NOT_FOUND_QUOTE`) is genuine-outage evidence and the pause
is accepted. Refusals ledger `pause_refused_tool_present`.

## Verification

- `tests/pause-anti-confabulation.test.ts` (4 tests): absence-language
  matrix incl. non-matches, refusal keeps the goal active + ledgered,
  quoted-error pauses normally, ordinary pauses untouched.
- Full gate: **1897 pass, 0 fail**, `tsc` clean.

## For the stuck new-tab session (runs pre-fix code — needs `/reload`)

`/reload`, then `/goal resume`, then `complete_goal`. Both infra
claims in its pause text are disproven; the work itself is complete.
