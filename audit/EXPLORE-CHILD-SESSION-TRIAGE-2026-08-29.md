# Explore child-session triage — 2026-08-29

## Disposition

**A narrow GLLA-owned transcript-correlation defect was confirmed and fixed.**
The captured visual shows a Pi session-picker result marked `loadable`, but it
does not prove that this particular screenshot was caused by the defect below.
Normal session discovery/retention still belongs to Pi and pi-subagents; no
Pi core or `@tintinweb/pi-subagents` source was changed.

The defect was in GLLA's read-only `/glla agents --tail` projection: it chose
the newest transcript whose bounded contents mentioned a generic agent type or
summary. With several persisted `Explore` sessions, that could display an
unrelated child's transcript or make a valid child look unavailable. The fix
now requires the exact persisted child identity and fails closed when it is
not present.

## Captured visual evidence

Input: `/home/dracon/Pictures/Screenshots/Screenshot_20260828_063011.png`

SHA-256: `040f5835984970b7b5d737244945733550b66c317d614a82b2481748dde2cbd2`

A bounded MMX vision pass reported these visible facts:

- the UI is a `Resume Session (Current Folder)` pane;
- Explore rows are presented as loadable/done, with `Explore#...` labels and
  pagination (`1/71`);
- the visible row contains an outcome/changes summary;
- no explicit error or mismatch is shown for the Explore row;
- the surrounding status contains a planned visual probe, not a reported
  failure.

The image therefore establishes **what the UI displayed**, not who created or
retained the session records.

## GLLA-owned inspection

The existing host-boundary implementation in
`extensions/loops/goal-session.ts` and `extensions/loops/goal-activation.ts`
rejects headless worker contexts before they can claim the host state root,
restore state, repair tools, run slash commands, or become silent host
successors. The same boundary preserves the legitimate host event-bus path
for durable `subagent_session` telemetry.

The existing audit record `audit/SUBAGENT-HOST-BOUNDARY-2026-08-25.md` records
that fix and its rationale. The existing retention record
`audit/EXPLORE-SESSION-RETENTION-2026-08-19.md` separately distinguishes:

- Pi's normal saved-session discovery;
- pi-subagents' `persist_session`, `output_transcript`, and session-manager
  behavior; and
- GLLA's minimal spawn-provenance ledger.

Those are separate ownership planes. GLLA must not scan, delete, or rewrite
Pi's session store merely because Explore rows appear in a session picker.

## Confirmed GLLA defect and fix

`extensions/goal-agents-panel.ts` previously ranked `.jsonl` files by mtime and
accepted the first candidate containing `summary`, `agentType`, or `recordId`.
The first two are not child identity. The pi-subagents session runner writes
the manager id prefix into the child session name (`Explore#<prefix>`), so the
GLLA-owned projection now checks that exact identity using a bounded transcript
tail plus a bounded header read. It never falls back to a generic type or
summary; if no exact match is found, it reports the missing correlation rather
than showing a potentially wrong transcript.

`extensions/goal-commands.ts` supplies the bounded header reader. The matched
transcript is still read in full only after identity selection, preserving the
existing forensic tail formatting and bounded candidate scan.

Focused regressions in `tests/agents-panel.test.ts` cover:

- a newer unrelated `Explore` transcript sharing the target summary;
- refusing a same-type transcript without the target identity; and
- retaining the bounded-tail read contract.

## Regression evidence

Command:

```text
bun test --parallel=1 --max-concurrency=1 --timeout=60000 tests/subagent-host-boundary.test.ts tests/agents-panel.test.ts tests/subagent-hang-detection.test.ts tests/subagent-session-ledger.test.ts
```

Result: **44 pass, 0 fail** across four focused files.

The boundary tests cover first-claim prevention, foreign slash-command
refusal, persistent-worker refusal after host invalidation, legitimate host
successor admission, and preserved Explore telemetry. The panel tests now
also prove that same-type transcript collisions cannot select a wrong child.
The hang and ledger tests cover the host-owned visibility path rather than
pretending a worker transcript is a resumable host session.

## Ownership conclusion and limits

- **Confirmed GLLA behavior:** worker contexts cannot mutate the host goal,
  list, or loop plane; host telemetry remains visible and durable.
- **Confirmed GLLA defect fixed:** `/glla agents --tail` now requires the exact
  persisted child identity and fails closed instead of selecting a generic
  same-type/summary collision.
- **Not confirmed:** whether the screenshot's 71 loadable entries are saved Pi
  sessions, historical records, or a pi-subagents/UI projection. The image has
  no linked `.pi-glla/active.jsonl` sequence or session-manager record proving
  that the screenshot itself exercised the fixed path.
- **Owner of normal session-picker semantics:** Pi/pi-subagents, not GLLA.
- **Change boundary:** only GLLA's read-only transcript projection and its
  regression tests changed; no Pi core, pi-subagents source, retention setting,
  cleanup, or session-picker behavior was changed.

A future claim about the screenshot itself still requires a controlled run that
links a newly created Explore record to a saved session file and captures the
corresponding UI/ledger sequence. The confirmed fix is limited to GLLA's
transcript-correlation path.
