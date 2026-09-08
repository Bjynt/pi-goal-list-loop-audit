# Completion communication: queued claim is not completion

## Diagnosis

`complete_goal` persists an `auditing` claim and returns before its detached worker settles. Ending the main API turn does not archive the objective. Approval still requires the revision/attempt/ownership gates, regression shield, and successful terminal archive.

The communication contract was wrong: tool description said “Mark ... complete”; queued-result prose invited a success-shaped acknowledgement. Approval notified before persisting its render, inferred delivery from `!isIdle()`, and separately sent a hidden follow-up asking the model to acknowledge. Replay was another ephemeral toast. None proved that a concrete final summary reached durable chat.

## New behavior

- Pending result explicitly reports `status=audit-pending`, `terminal=false`. A terminating tool-batch hint skips the acknowledgement-only model call when Pi can honor it; it does not terminalize the goal or wait for audit. Tool guidelines and continuation prompt forbid pending success claims, polling, and duplicate final summaries.
- After successful archive, enqueue one bounded outcome-first render per goal before delivering. The visible contextual custom message includes recorded changes, evidence, tests and meaningful unresolved facts, approval and archive pointer. Stale `Next:` is omitted. No second summary toast or acknowledgement-only LLM turn.
- `triggerTurn:false` delivers directly even when idle/streaming; queue advancement and its independent continuation timer are unchanged.
- Outbox acknowledgement requires the exact visible custom message (goal, content, entry ID) in the active session branch AND complete session JSONL on disk. A void API return, toast, idle probe, or in-memory append is not acknowledgement.
- Replay runs on admitted startup, agent settlement and existing explicit command contacts, retaining session/owner/generation/stand-down fences. Current settlement targets its own render so older undeliverable records cannot starve new summaries. Delivered entries deduplicate repeated settlement. Unpersisted branch entries suppress same-session duplicates while keeping the outbox pending.
- Outbox updates use temp-write/rename; undelivered records are never pruned by the delivered-history cap. Rejection continues repair without terminal summary. Archive failure emits no success summary. Outbox failure warns and leaves the archive's full recap available.

## API evidence

Read installed Pi `docs/extensions.md` and `docs/session-format.md` completely before API changes. Read-only inspection of `dist/core/agent-session.js` confirmed `sendCustomMessage` with explicit `triggerTurn:false` appends without a turn even while streaming. `sendMessage` is void and catches asynchronous failures; `SessionManager._appendEntry` mutates memory before persistence. GLLA therefore reads the documented session JSONL through `getSessionFile()` rather than treating branch presence as disk success. No upstream/session-file writes or repairs.

## Checked evidence

- `tests/completion-communication.test.ts`: actual registered tool + detached fixture worker; pending versus approved/rejected; idle/streaming concrete delivery; archive-intent failure; independent next-item dispatch after the unchanged 15s settle.
- `tests/terminal-summary-delivery.test.ts`: branch-before-write failure, later persistence, no-file session, restart/outbox replay, exact identity/content, partial/malformed JSONL, bounded-tail conservative failure, duplicate suppression.
- Existing terminal notice/render/summary tests and selected behavioral approval/queue regressions updated for visible persisted summaries rather than toast acknowledgements.
- Bounded commands and final results are recorded in the implementation acceptance report. No release/tag/package/version changes.

## Limits

Confirmation means persisted visible chat, not proof a human read it. JSONL confirmation reads at most 256 KiB per delivery/replay, never polls. A receipt older than that tail remains pending conservatively (without repeating into the same branch); recovery into another branch/session can deliver again. No-file sessions retain pending outbox entries. There is no transaction spanning Pi session persistence and GLLA outbox acknowledgement: a crash before acknowledgement can replay into a different session, while an existing matching branch suppresses duplicates. Legacy `deliveredAt` records are not retroactively reclassified. If the outbox write itself fails after archive, automatic render replay is unavailable; the warning points to the archived recap. No live `.pi-glla` edits were made by this implementation.

### Validation run

- `bun test --parallel=1 --max-concurrency=1 --timeout=30000 tests/completion-communication.test.ts`: 6 passed (`/tmp/glla-summary-behavior.log`).
- Bounded terminal-summary/notice/render, summary-lines/quality, and `audit-2026-09-08` group: 53 passed (`/tmp/glla-summary-tests.log`).
- Selected existing detached-approval and list/standalone queue regressions: 4 passed, 127 filtered (`/tmp/glla-summary-regressions.log`).
- `npm run check`: `tsc --noEmit` passed (`/tmp/glla-summary-tsc.log`). `git diff --check` passed; no staged files.
- Total targeted checks: 63 passing tests. Full release suite and live TUI/RPC exercise deferred to independent review/publication; no release command was run.

### Independent review + v0.38.34 follow-through

- Fresh-context reviewer verdict on exact diff `be27789..1412ae9`: pending/approved/rejected semantics, archive gates, delivery confirmation, fences, and SDK use all correct; no concrete production merge-blocker in the completion path. Two findings.
- **P1 (stale assertions, not regressions):** five release-gate failures — the lifted two-detail cap, three continuation-payload byte fixtures (+543/payload from the new guidance, growth exactly linear), and the no-audit toast assertion. Refreshed deliberately in v0.38.34 (see CHANGELOG); the measured-growth invariant is preserved, not weakened.
- **P2 (real bug, fixed in v0.38.34):** replay always took the oldest five pending entries, so five persistently unconfirmed receipts starved a sixth render forever. Attempted-but-undelivered entries now rotate behind the unattempted in-scope tail; six-render regression test pins it.
- Full `TMPDIR=/var/tmp npm run release:check`: **2034 pass / 2 skip / 0 fail** across 204 files (`/var/tmp/glla-completion-release-check2.log`); `tsc --noEmit` clean.
