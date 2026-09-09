# Codex-like terminal summary (field 2026-09-09 013733, v0.38.39)

## What the screenshot showed

The v0.38.38 `[goal-event]` block was close to the Codex shape but read
as a machine receipt with two voices:

- `•` detail bullets followed by dangling `— auditor …` / `— audit: …` /
  `— record: …` lines (approval, counts, record kept their trailer sigil).
- Every bullet trailing into `…` — including `npm version…+ latest`
  (cut inside a `+`-joined list) and `(/var/tmp/glla-….log…` (a raw
  machine path in user chat).
- No next action (`Next: reload the extension` was stripped by the total
  v0.38.20 filter), closing straight into the trailer.

## The fix (chat render only)

`extensions/completion-summary.ts`:

- `trailerBullet()` — approval/counts/record ride as `•` bullets at
  render (the `— ` sigil is stripped; input strings keep it for
  non-chat surfaces). Chat and transcript share the voice; the record
  pointer stays last. `buildAuditCountsLine` keeps its builder voice —
  it has no direct chat consumer.
- `chatSafeDetailValue()` — strips `/tmp/…`, `/var/tmp/…`, `*.tgz`
  tokens from chat bullet values, and drops a parenthesized group whole
  when nothing but tokens/receipt words (`tarball`, `log`) remains, so
  no `( tarball )` husk survives. Groups with real words
  (`(see audit/notes.md)`, `(v0.38.38)`) pass through verbatim.
  Applied in `humanCompletionBrief` before clipping, so the budget
  applies to the human text. Archive/recap keep the full text.
- `withoutStaleNext()` is selective now: audit-self-referential Next
  lines (`verdict decides`, `awaiting approval`, …) still drop, but the
  first concrete next action survives as the closing bullet ahead of
  the non-do. Cap of one preserves the Codex close.
- `clipSummaryValue()` admits `+` to the clause-boundary set.

`prompts/goal-loop-continuation.md`: claim-side guidance — each label
value ~90 chars, human-readable proof only (no machine paths), `Next:`
one concrete action or none.

Out of scope (per the confirmed contract): card, status line,
AUDIT PENDING, archive format, delivery/replay mechanics.

## Deliberate trade-off

The v0.38.37 "4–6 bullets" pin now counts informing-detail bullets
only; the three trailer bullets ride extra. The Codex bullet budget was
always about verifiable-result bullets, not chrome.

## Checked evidence

- New pins in `tests/terminal-approval-render.test.ts` (uniform voice,
  machine-path strip, `+`-boundary cut, next-action → non-do → record
  order) and `tests/approval-notify.test.ts` (selective Next filter).
- Deliberately updated: `tests/approval-notify.test.ts` (bulleted
  trailer), `tests/terminal-approval-render.test.ts` (trailer voice,
  detail-tally split), `tests/completion-communication.test.ts`
  (one-voice post, record-last), `tests/behavioral-orchestrator.test.ts`
  (bulleted counts/record/no-audit trailer).
- Full `TMPDIR=/var/tmp npm run release:check`: 2042 pass / 2 skip / 0 fail across 204 files (`/var/tmp/glla-codex-release-check2.log`, tarball `pi-goal-list-loop-audit-0.38.39.tgz`).
- `npx tsc --noEmit` clean.
- Field eyeball of the next real goal close is the owner's follow-up.
