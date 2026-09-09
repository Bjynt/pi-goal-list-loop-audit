# Elapsed-time duplication cut + PR #47 disposition (field 2026-09-09 002132)

## The duplication

The below-chat goal card head shows `active · total 12m 30s` while other
sessions' tab strips showed `● Chrome Bridge (indefinite) glla: [WORKING]
total 12m 30s` — the same elapsed time twice.

Mechanism: "Chrome Bridge" is a detached pi session name; `(indefinite)`
is pi core's runtime label. The `glla: …` tail is GLLA-owned — it is the
`ctx.ui.setStatus("pi-glla", …)` one-liner (`goal-ui.ts:836`,
`buildStatusText` in `goal-loop-display.ts`), which pi core surfaces per
session. Neither the `Chrome Bridge` label nor the `(indefinite)` framing
is GLLA code (absent from GLLA, pi core dist, and pi-chrome) — but the
duplicated `total …` inside our status text is ours to cut.

## The cut (v0.38.38)

- Removed `goalTotalText(g, now)` from the three active `setStatus`
  branches (idle / busy / working-queued-monitoring). The status line
  keeps state badge + task/queue counts + recovery/awaiting-turn signals.
- The card head (`goalLines`, `goal-loop-display.ts:1670`) keeps `total`
  unconditionally for every goal state — nothing was folded because
  nothing was missing there.
- Pinned deliberately: status assertions now expect
  `glla: [WORKING] 3 queued` (no timer) while the same test asserts the
  card head still carries `total 1m 00s`.

## PR #47 verdict (Bjynt, `fix/kv-cache-break-complete-task-goal`)

- **KV-cache checkpoint strip: complaint REAL, shape NOT portable.**
  Verified on current main: the dynamic goal-checkpoint lines are still
  there (`context-checkpoint.ts:207-222` — `Pending completion`,
  `Latest audit`, `Pending auditor TODOs`, `Task state`), and
  `complete_task`/`complete_goal` do mutate checkpoint bytes at the
  cache-prefix position. But outright removal blinds a
  resumed-after-compaction model in deep overflow (no tasks, no auditor
  TODOs, no pending claim, no forced file read — the fence only orders a
  re-read *on conflict*). Nothing mechanical parses those lines (pure
  LLM-read context; the detached auditor receives structured input, not
  checkpoint text), so the risk is model-behavioral, not mechanical.
  Safe shape: a byte-stable pointer
  (`…see .pi-glla/active.jsonl — read before acting`) instead of silent
  removal. Needs its own designed change + stability test.
- **Per-task detached audits (`auditTasks`): deliberately HELD on main**
  pending cost/settings review — will not land until that review.
- **Context-overflow-as-starvation + settings UI bits:** need focused
  PRs, not bundled.
- **Process:** unmergeable regardless — live `.pi-glla/active.jsonl`
  blob (tracked live state on main), 16 ahead / 39 behind, three bundled
  features. Same policy as #45/#46.
- Replied with per-piece verdicts + merge-based re-sync command (no
  rebase/force-push) + `git checkout origin/main -- .pi-glla/active.jsonl`
  to drop the live-state blob + invitation to split per feature. Closed.

## Proposed follow-up (not queued — needs owner go-ahead)

Checkpoint cache-stability redesign: byte-stable pointer lines for the
four dynamic fields + a render test pinning checkpoint byte-stability
across task/claim/audit mutations + a recovery test proving the resumed
model is pointed at durable files. Objective draft:
"Make the authoritative goal checkpoint byte-stable across
complete_task/complete_goal/disapproval without blinding
post-compaction recovery: replace the four dynamic blocks with stable
pointer lines, pin with stability + recovery tests, gate green."

## Checked evidence

- `tests/display.test.ts`: status-without-timer pins + card-keeps-timer
  pin; `tests/goal-loop-display.test.ts` green.
- Full `TMPDIR=/var/tmp npm run release:check`: 2040 pass / 2 skip / 0 fail across 204 files (`/var/tmp/glla-elapsed-release-check.log`, tarball `pi-goal-list-loop-audit-0.38.38.tgz`).
- `npx tsc --noEmit` clean.
- No open PRs (`gh pr list` empty after #47 close).
