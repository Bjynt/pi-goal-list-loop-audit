# Subagent Hang Detection — no-progress watchdog for subagent sessions

**Version:** v0.34.85
**Date:** 2026-08-07
**Goal:** list item "Subagent hang detection" (note.md Screenshots 161019/161032)

## Complaint

Subagents froze at 10697s (3h) with 0 stream activity; "BUSY with zero stream
activity" warnings repeated at 22/31/41 min. The auditor's detached worker has
a heartbeat-without-progress watchdog (extensions/goal-loop-auditor-process.ts
~:498, 10m default) that fails fast on a wedged worker; subagent sessions had
NO equivalent — a hung subagent burns parent tokens for hours before the user
notices. (The `extensions/goal-loop-subagents.ts` module, which the note calls
out, is the model-override SYNC — it has no session monitoring at all; the
watchdog belongs in the goal plane where the heartbeat and the subagent
lifecycle events already live.)

## Fix

A per-subagent no-progress watchdog in the main session (extensions/loops/goal.ts):

1. **Probe registry** — `subagentHangProbes: Map<recordId, SubagentHangProbe>`
   tracking `lastProgressAt`, last-polled `toolUses` / `lifetimeUsage.output`,
   spawn time, hang-alert throttle, end time.
2. **Registration + evidence** — the existing `subagents:started` listener now
   also seeds a probe; `subagents:compacted` / `subagents:steered` refresh the
   streak (secondary evidence); `subagents:completed` / `subagents:failed` end
   the watch.
3. **Progress join** — the scan polls each running subagent's live record via
   the cross-package registry `Symbol.for("pi-subagents:manager")` →
   `getRecord(id)` (pi-subagents' agent-manager.ts). The record exposes LIVE
   `toolUses` (incremented per tool activity end) and `lifetimeUsage.output`
   (accumulated at every assistant message_end) — the exact "new tool call or
   output" signal the auditor watchdog uses, without any cross-extension
   stream event. The poller is defensive: absent registry / unknown record →
   no false positive (event-only evidence still counts).
4. **Threshold** — `SUBAGENT_HANG_NO_PROGRESS_MS = 5m`, SHORTER than the
   auditor's 10m: a hung subagent costs parent tokens on every turn and blocks
   the parent's tool/agent budget, so it fails faster.
5. **Action** — on the streak, `ui.notify` + `notifyExternal` ("…shows no
   progress for Nm — still running with no new tool calls or output…") and
   ledger `subagent_hang_detected` with recordId / agentType / summary /
   silentMs / spawn. **Detection + guidance only** — the main session decides
   to abort; never an auto-kill. Re-alerts throttled at 5m; ended probes pruned
   after 1h.

The scan runs in `heartbeatTick` (guarded by `subagentHangProbes.size > 0`), is
goal-independent (a hung ad-hoc subagent is a problem with or without a goal),
and is skipped while the session is in a stale/handoff state (existing gates).

## Files

- `extensions/loops/goal.ts` — constants + probe registry + helpers +
  `classifyHungSubagents` (exported pure), heartbeatTick scan block, probe
  seeding in the `subagents:started` listener, 4 new `subagents:*` listeners,
  `__testOnlySubagentHangProbes` / `__testOnlyClearSubagentHangProbes`.
- `tests/subagent-hang-detection.test.ts` — 11 tests (5 pure classify + 6
  integration via MockPi emitBus + `__testOnlyHeartbeatTick` with a faked
  `Symbol.for("pi-subagents:manager")`).
- `CHANGELOG.md` — Unreleased v0.34.85 entry. `package.json` → 0.34.85.

## What it does NOT change

- No auto-abort/auto-kill of subagents — surfacing only (the objective's
  "so the main session can decide to abort").
- The auditor's own heartbeat watchdog, the main session's zombie-run watchdog
  (20m BUSY-silent), and the stall watchdog are untouched.
- The `goal-loop-subagents.ts` model-override sync is untouched.
- No new pi-subagents dependency: the Symbol.for registry is optional and
  polled defensively; all event channels used already exist.

## Evidence

- `timeout 90 bun test tests/subagent-hang-detection.test.ts` → 11 pass / 0 fail.
- Full suite: 1081 pass / 1 skip / 0 fail across 100 files (was 1070/1/0).
- `npx tsc --noEmit` → exit 0.
