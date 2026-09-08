# Closed card + smart summary (field 2026-09-08 220808)

## Diagnosis

The active below-chat card read as cut off — "like we would have more but
just cut off". Three causes combined on one card:

1. The objective died mid-sentence (`…and restyle the …`). The head budget
   gives the status segments priority and the objective gets the leftover
   cells cut at a raw character boundary — a bare `…` reads as clipping,
   not summarizing.
2. The `model: primary X · inherited from session` row restated pi's own
   status line two rows below (`(opencode-go) muse-spark-… · xhigh`) for
   zero new information, deepening the tree for nothing.
3. The tree never closed: with an empty queue there is no footer, so the
   card ended on its action row (`├─ ✓ bash …`) — the `├─` glyph literally
   promises continuation rows that never come.

## New behavior (chosen: closed card + smart summary)

- `truncateObjective` cuts the head objective at the last clause boundary
  (`: ; · — – ( [`) inside the budget, so the head reads as an intentional
  summary (`…PremiumSidebar pattern…`); character cut remains the fallback
  when no boundary clears the floor. Display-only.
- The steady-state inherited model row is dropped — pi's status line
  already names the session model. The block still renders on any news: a
  pinned selection, fallbacks, skips, or a failover that handled work.
  `/goal status` keeps the full chain regardless.
- Every card closes: the final `├─`/`│` row becomes `└─` whatever built it
  (active action row, lone orphan worker row). Already-closed cards
  (auditing/paused/interrupted footers) are untouched; prefixes are
  literal so the close holds themed too.

## Checked evidence

- `tests/goal-loop-display.test.ts`: clause cut at the parenthetical +
  tighter-budget colon cut, character fallback, floor guard, untouched
  short text, steady-state row dropped, action row closes the card.
- Retired pins updated deliberately, purpose preserved: the v0.33.0
  slim-card `├─` tail, the v0.38.28 lone-row close, the loop-kind test's
  incidental model assertion, the narrow-width inner-truncation fixture
  (now on a pinned row), the worker-before-footer invariant (detail never
  lands *after* a footer; the single detail row *is* the footer).
- Full `TMPDIR=/var/tmp npm run release:check`: 2037 pass / 2 skip /
  0 fail across 204 files; `tsc --noEmit` clean.

## Limits

- The bottom `● Chrome Bridge (indefinite) glla: [WORKING]` line in the
  field screenshot is not rendered by this repo (no such string in
  extensions/) — likely a tmux/statusline integration. Untouched.
- Incidental: `bun test <files>` without the repo's `--parallel=1
  --max-concurrency=1` flags can flake three display tests — parallel
  files race on the process-global cold-restore auditor-suppression flag
  (a session_start-firing file suppresses while display.test.ts reads).
  Pre-existing, unrelated to this change; the repo runner serializes.
- `tests/auditor-process.test.ts` "parent abort escalates…" flaked once
  in the full gate (TERM-race timing) and passed alone and on re-run.
