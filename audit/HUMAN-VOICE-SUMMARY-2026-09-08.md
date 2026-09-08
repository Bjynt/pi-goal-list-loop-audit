# Human-voice terminal summaries (field 2026-09-08 223522/223523)

## Diagnosis

Two screenshots from consumer-repo goals (vidpro-extension, new-tab) showed
the v0.38.34 summary pipeline working but reading like a machine receipt:

1. Mid-word-looking cuts on nearly every line (`playlist auto-add,…`,
   `EnginePicker…`, `BYOK key in…`). Root cause: `clipSummaryValue` cut at
   the last space, which strands dangling punctuation — a word-boundary cut
   that still reads as clipping.
2. Raw run stats in user chat (`— run: 1 turns · 58 file writes ·
   100 bash calls · auditor approved`). Process metrics, not information.
3. The AUDIT PENDING tool result spoke in agent imperatives ("Do not claim
   completion… Do not wait or poll") in user-visible chat.

## Research (same session, evidence-only)

- **Codex** (3 verbatim closings from `~/.codex/sessions`): outcome-first
  line, 4–6 bullets of one verifiable result each with proof inline,
  closes with a caveat + one next action, states what was deliberately
  *not* done. No truncation, ~8–16 lines.
- **agy/Antigravity** (`agy` binary strings + 20+ real `walkthrough.md`
  under `~/.gemini/antigravity/brain/`): walkthrough artifact — Changes
  made / What was tested / Validation results + `## What to Verify`;
  chat reply points at the artifact, never re-summarizes.
- User decision: **Codex-style chat summary** (fits pi chat, no new
  surface), pending notice rewritten in **plain voice**, verified by
  **tests + full gate**.

## Disapproval 2026-09-08T23:36Z — answered in v0.38.37

The detached auditor correctly rejected v0.38.36: clause cuts and
verdict-only counts shipped, but the render was still `Label: value`
lines (no bullets) and the deliberate non-do was waived instead of
built. Fixed for real:

- `buildApprovalChatLines` + `transcriptLines` bullet every informing
detail (`• Changed: …`) on the two posted surfaces; recap/archive
untouched (archive format unchanged per contract).
- New optional `complete_goal` `leftOut` parameter (maxLength 500) →
stored on the pending claim → rendered as the closing
`• Left out: …` bullet on all three approval sites (fresh approval,
detached retry, Esc-complete-anyway). Absent stays absent — the
normalizer preserves the field, the filler filter drops `none`.
- Pinned: bullet count ≤ 6 with inline evidence (render unit),
present/absent/filler non-do (render unit), end-to-end `leftOut`
claim → posted `[goal-event]` bullet (MockPi).
- Visual: no fresh screenshot exists in this loop; the shape is proven
by the render-unit + MockPi pins above, not by pixels.

## New behavior (v0.38.36)

- `clipSummaryValue` cuts at the last clause boundary (`, ; : · — – ( [`)
  past a floor so the cut reads intentional (`…append/replace Apply…`
  instead of `…playlist auto-add,…`); trailing punctuation stripped before
  the ellipsis. Word-break then hard-cut fallbacks kept for long tokens.
- `buildAuditCountsLine` is verdict-only (`— audit: auditor approved
  (1 verdict).`). Telemetry stays in the six-label archive record.
- Pending text states facts, not orders: claim stored, detached auditor
  settling, summary posts after verify, rejection resumes work, ending the
  turn is correct. The strict rules stay in
  `prompts/goal-loop-continuation.md` (agent-facing), which additionally
  teaches the Codex shape for agent-written completion summaries.
- The `— record:` pointer remains the single next action; no facts
  invented (a deliberate-non-do line would require facts we don't store).

## Checked evidence

- New pins: clause cut + punctuation strip (`completion-summary-lines`),
  verdict-only counts (`terminal-approval-render`), no-imperative pending
  (`completion-communication`).
- Retired pins updated deliberately: `— run:` telemetry assertions,
  `/detached auditor queued/` wordings, continuation-payload byte fixtures
  (+344/payload, growth exactly linear — same deliberate-refresh policy as
  the +543 completion-communication refresh).
- Full `TMPDIR=/var/tmp npm run release:check`: 2038 pass / 2 skip /
  0 fail across 204 files; `tsc --noEmit` clean.

## Limits

- `/goal status` labels (`detached auditor queued/running`) untouched —
  terse status surface, out of contract scope.
- No walkthrough-artifact surface built (user chose chat-only); revisit if
  summaries outgrow chat.
