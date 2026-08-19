# Remaining focus

## 1. Host lifecycle and session handoff

**Category:** upstream/API boundary  
**Status:** glla has a safe fallback; full automatic replacement belongs in Pi.

A stale extension event context cannot safely create or switch the host session. Focus on either a Pi guarantee that every replacement emits the normal `session_shutdown` → `session_start` lifecycle, or a host-owned event-safe replacement API. Keep the current durable parking, stale-callback fencing, and honest `/new`/restart guidance in glla. The accepted-but-no-turn-start investigation is recorded in `audit/CONTINUATION-DISPATCH-RELIABILITY-2026-08-19.md`; any remaining live failure after the bounded retry is an upstream Pi concern.

Evidence:
- `/home/dracon/Pictures/Screenshots/Screenshot_20260818_053538.png`
- `/home/dracon/Pictures/Screenshots/Screenshot_20260818_054102.png`
- `/home/dracon/Pictures/Screenshots/Screenshot_20260818_173242.png`
- `/home/dracon/Pictures/Screenshots/Screenshot_20260818_173824.png`

## 2. Buggy and previous-version objectives

**Category:** local robustness

Design a safer objective-integrity path for malformed, stale, or version-drifted objectives: preserve the original text, make repair explicit and reviewable, and prefer defer/decision over silently changing the requested work.

## 3. Explore-session retention

**Category:** session/history UX

Decide whether Explore workers should remain as ordinary saved sessions, be hidden from the main history, or be automatically archived with a compact report and retention policy.

## 4. Completion summaries

**Category:** completion UX

Provide a concise structured summary when an objective ends: what changed, evidence collected, tests run, unresolved items, and the next useful focus. Keep it separate from the auditor's durable verdict.

## 5. Long-term preferences

**Category:** settings/personalization

Define how an agent preference is declared, scoped, persisted, surfaced in prompts, updated, and reset without allowing an old preference to override a newer explicit instruction.

## 6. Audit policy controls

**Category:** settings/policy

Support an explicit audit cadence:
- no audit;
- audit only on completion;
- audit every N tasks; or
- audit periodically.

Define defaults, list/goal/loop interactions, and what happens when an audit is unavailable.

## Not a focus

The main-session versus subagent-session distinction is expected `SessionManager` behavior, not a confirmed defect. Queue persistence, packaging/schema parity, stale completion recovery, and verification parsing were completed and are intentionally omitted from this working note.
