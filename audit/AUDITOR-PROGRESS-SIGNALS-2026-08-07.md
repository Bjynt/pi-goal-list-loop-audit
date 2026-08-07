# Auditor liveness / progress signals — v0.34.86

**Date:** 2026-08-07 · **Goal:** `20260807200143-zcyblm` (queue item: auditor liveness/progress signals)

## Field finding

The auditor's report stream is muted by default (v0.34.66 — "report stream
muted — final text at verdict"), so a 5-minute audit pass shows a timer
counting up with zero visible progress. A hung worker and a working-but-silent
worker look identical. The muted line is the ONLY report surface — the prose
tail is hidden by design (note.md #4: "auditor words one by one").

## What the plumbing already had

The progress pipeline was fully wired worker → parent → goal.ts → display:

- Worker (`scripts/goal-auditor-worker.mjs`): `progress.json` snapshots with
  fine phases `starting | running | thinking | tool_executing |
  producing_report | complete`, `elapsedMs`, `lastActivityAt` (worker-side
  activity), `recentOutput` (last 8 items, ≤ 240 chars — a ring buffer, NOT
  monotonic), `toolCalls`, `currentTool(Args/StartedAt)`.
- Parent (`extensions/goal-loop-auditor-process.ts`): poll loop reads
  `progress.json`, forwards serialized change via `onProgress(asProgress(...))`.
- Display (`extensions/goal-loop-display.ts`): the coarse `AuditorDisplayPhase`
  (queued/running/quiet/blocked/awaiting-verdict) already re-derives the fine
  phase via `auditorObservedPhase` — "thinking" / "producing report" labels
  existed.

Gap: (1) the labels were jargon ("thinking"), not progress vocabulary; (2)
nothing proved the worker was ADVANCING — phase labels repeat for minutes and
`recentOutput` is a bounded ring, so a wedged worker in a long `thinking` phase
looks identical to a healthy one.

## Fix (v0.34.86)

Three layers, all gated behind a new opt-out setting `auditorProgressSignals`
(default on, independent of `auditorSilent`; off = exact pre-v0.34.86 look):

1. **Monotonic byte counter (worker → display).** The worker now counts
   `text_delta` chars into `reportBytes` and includes it in `progress.json`
   snapshots; the parent's `AuditorProgressFile`/`AuditorProgress`/`asProgress`
   pass it through; `publishDetachedAuditProgress` copies it into
   `latestAuditProgress.reportBytes`; the widget renders, in silent mode,
   `report stream muted — 12.4 KB written · final text at verdict` instead of
   the dead muted line. Bytes grow monotonically with the report stream — the
   "worker IS making progress" evidence that never reveals prose. Falls back to
   the old line when bytes are absent (older worker binaries, pre-delta
   snapshots).

2. **Objective-vocabulary phase labels.** While the coarse phase is `running`,
   the fine labels swap jargon for the audit note's vocabulary:
   `thinking` → `reading source…`, `producing_report` → `writing report…`.
   Rendered on both surfaces (status line + widget card line), e.g.
   `glla: MAIN HOST · SUPERVISING · auditor reading source…` and
   `├─ MAIN HOST · SUPERVISING · auditor: writing report…`.
   `tool_executing` keeps "tool executing" (the tool name already shows the
   activity); quiet/blocked/awaiting-verdict keep their single state labels.

3. **Opt-out.** `auditorProgressSignals: false` (settings menu + `/glla`)
   restores the plain timer-only card and the pre-v0.34.86 muted line. The
   setting travels from `goal-settings.ts` (interface, default, key list) via
   the settings menu row and the `/glla` toggle to `refreshUI` extras.

## Files

- `scripts/goal-auditor-worker.mjs` — `reportBytes` counter + progress.json field.
- `extensions/goal-loop-auditor-process.ts` — `AuditorProgressFile.reportBytes?`,
  `AuditorProgress.reportBytes?`, `asProgress` passthrough (PROTOCOL_VERSION
  unchanged — optional field, identity check unaffected).
- `extensions/goal-loop-display.ts` — `AuditDisplayProgress.reportBytes?`,
  `WidgetExtras.auditorProgressSignals?`, `auditorProgressPhaseLabel`,
  `fmtByteCount`, status/card substitution, silent-mode byte-counter line.
- `extensions/loops/goal.ts` — `publishDetachedAuditProgress` passthrough,
  `refreshUI` extras wiring, `/glla auditorProgressSignals` toggle.
- `extensions/goal-settings.ts` + `extensions/settings-menu.ts` — setting
  definition, default true, menu row.

## Tests

- `tests/display.test.ts` +4: fine phase label on card + status
  (`auditor: writing report…`, `auditor reading source…`); byte counter
  renders in silent mode (`12.4 KB written`) while the prose tail stays
  hidden; `auditorProgressSignals: false` restores the plain card and the old
  muted line; live tail (`auditorSilent: false`) unaffected.
- `tests/auditor-process.test.ts` extended: the real-worker fragment test now
  asserts the byte counter reaches the parent, is monotonic, and tracks the
  assembled report length (≥6 observed counts for 6 deltas; exact final-count
  assertion deliberately avoided — the parent synthesizes the terminal
  `phase:"complete"` progress without a byte field, so file-derived counts
  only).

## Suite

1085 pass / 1 skip / 0 fail across 100 files (was 1081/1/0). tsc clean.
