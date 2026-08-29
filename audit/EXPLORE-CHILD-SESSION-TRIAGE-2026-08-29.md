# Explore child-session triage — 2026-08-29

## Disposition

**No new GLLA runtime fix is justified.** The captured visual shows a Pi
session-picker result marked `loadable`, but no error or ownership failure is
visible. The GLLA-owned host/worker boundary is already fail-closed and is
covered by focused regressions. Normal session discovery/retention belongs to
Pi and pi-subagents; the screenshot does not provide the durable correlation
needed to attribute those rows to GLLA.

This is an explicit **external/unknown ownership disposition**, not a claim
that the screenshot's underlying retention behavior has been fixed.

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

## Regression evidence

Command:

```text
bun test --parallel=1 --max-concurrency=1 --timeout=60000 tests/subagent-host-boundary.test.ts tests/agents-panel.test.ts tests/subagent-hang-detection.test.ts tests/subagent-session-ledger.test.ts
```

Result: **42 pass, 0 fail** across four focused files.

The boundary tests cover first-claim prevention, foreign slash-command
refusal, persistent-worker refusal after host invalidation, legitimate host
successor admission, and preserved Explore telemetry. The panel, hang, and
ledger tests cover the host-owned visibility path rather than pretending a
worker transcript is a resumable host session.

## Ownership conclusion and limits

- **Confirmed GLLA behavior:** worker contexts cannot mutate the host goal,
  list, or loop plane; host telemetry remains visible and durable.
- **Not confirmed:** whether the screenshot's 71 loadable entries are saved Pi
  sessions, historical records, or a pi-subagents/UI projection. The image has
  no linked `.pi-glla/active.jsonl` sequence or session-manager record proving
  that correlation.
- **Owner of normal session-picker semantics:** Pi/pi-subagents, not GLLA.
- **Change made for this item:** this evidence/disposition record only. No Pi
  core or `@tintinweb/pi-subagents` source was changed, and no speculative GLLA
  retention setting or cleanup was added.

A future runtime change requires a controlled run that links a newly created
Explore record to a saved session file and demonstrates a GLLA-owned retention
or host-ownership violation. Until then, the safe result is to preserve the
existing boundary and record the diagnostic gap.
