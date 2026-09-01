# Cross-harness review — pi Goal X / DeepSeek / Codex / Claude / Antigravity / Grok — 2026-09-01

## Scope

Read-only comparison of 6 local harnesses in `.research/` (`src-pi-goal-x`, `src-pi-dgoal`, `src-pi-until-done`, `src-pi-codex-goal`, `src-pi-goal`, `src-pi-better-goal`) plus the Codex / Claude / DeepSeek host harnesses from `audit/CONTINUATION-APPROACH-COMPARISON-2026-08-15.md` against GLLA v0.36.1 (`docs/DESIGN.md` v0.36.3, `docs/DESIGN-long-running-supervision.md` v0.36.0). No DeepSeek/Codex/Claude/Antigravity/Grok npm package exists locally or in `~/.npm-global/lib/node_modules`; their host lessons remain observation-only per AGENTS.md scope boundary (GLLA may observe/contain, not repair pi core / pi-subagents / OS / providers).

Method: inspected DESIGN docs, `extensions/goal-loop-core.ts` State/PendingCompletion, `extensions/goal-loop-auditor-process.ts` + `scripts/goal-auditor-worker.mjs`, heartbeat/recovery, ledger, `.pi-glla/active.jsonl`, `package.json` 0.36.1 pinned `pi-subagents@0.62.0`, `.research/comparison.md` host-session matrix, `audit/PI-GOAL-X-COMPARISON-2026-08-27.md` fresh `59826ec`, and continuation-approach doc. No source files modified for this review.

## Verdict

GLLA is the strongest of the 7 on detached-auditor isolation, durable recovery, ownership fencing, and persistence integrity. PR #39 (714b9662, `auditorToolTimeoutMs`/`auditorStallMs` + adaptive escalation + reportBytes progress) already closes the field qwen27b stall. Remaining transferable gaps are bounded checkpoint hygiene, payload escaping, in-memory drafting, and observability — not host or provider behavior.

## Per-harness signal (one row per harness)

| Harness | Persistence | Detached worker | State / Queue | Supervision | Notable lesson |
|---|---|---|---|---|---|
| GLLA | Event-driven + 250ms→cadence adaptive poll, ledger rotation 8 MiB + archive-intent | `spawn(pi --mode rpc, detached:true, stdio:"ignore", unref)` + group kill | `.pi-glla/active.jsonl` + segments + sidecars atomic | `ContinuousSupervisor` + heartbeat, `continuation-dispatch.json` proof | Baseline — pays session-growth cost |
| pi-goal-x | `agent_end` → `armFocusedContinuation` → `sendUserMessage` | None (0 spawn) | `.pi-goal-x/` + caches, typed revision `storage/goal-lock.ts` | Host event only | ≤160-char marker + once at `before_agent_start`; typed conflicts |
| pi-dgoal | Timers + `isolated-pi` runner | `spawn(pi --mode rpc --no-session --no-extensions, detached, stdio:pipe)` | `.dgoal/` | Isolated-pi adapter | `pipe` observability vs `ignore` |
| pi-until-done | `agent_end` predicate + tiny interval | Only CI runner awaited | Session-entry reconstruct | Session ledger | Pure reconstruct cannot stall |
| pi-codex-goal | `controller.onAgentEnd` → `sendUserMessage({deliverAs:"followUp"})` | None (clipboard only) | On-disk + reconstruct | Controller | Explicit `followUp` + compact prompt |
| pi-goal / pi-better-goal | 16× `sendUserMessage` / idle timer `setInterval`×2 | None | Ephemeral / settings+replay | Service / timer | Minimal baseline |
| Codex / Claude / DeepSeek | App-server `thread/*` / local transcripts / Cordis seams | Host-managed | Thread/store/transcript | Host | Host protocol — not extension API |
| Antigravity / Grok | No package found | — | — | — | Gap — no actionable delta |

## Actionable GLLA-owned deltas (scope boundary: GLLA only)

Severity = production impact if deferred.

- **A1 high — auditor payload escaping + verdict terminal-line** (`extensions/goal-loop-auditor.ts`, `extensions/goal-loop-shield.ts`, `scripts/goal-auditor-worker.mjs`). GLLA interpolates `<goal>`/`<completion_summary>`/`<verification_contract>` without escaping XML delimiters; pi-goal-x escapes at `goal-auditor.ts:50-70`. Verdict parser uses last block with tag not final line (`tests/audit-verdict.test.ts` LAST block). PR #39 did not touch this — verify Unreleased "payload blocks now escape" covers it, else file scoped goal. Retain.

- **A2 high — full continuation resync → session growth** (`extensions/goal-continuation.ts:1069`, `goal-loop-dispatch.ts`, `loops/goal-activation.ts:2466`). GLLA resends full prompt each follow-up; pi-goal-x persists ≤160-char marker once at `before_agent_start`. Fix: measure growth on long lists, spec bounded marker injection shape only (preserve generation/owner/consent gates). Measure before code.

- **A3 medium — drafting in-memory only** (`extensions/loops/goal-ui.ts:375`, `loops/goal-activation.ts:1084`). Compaction/rebind clears interview; pi-goal-x persists `pi-goal-draft`. Fix: durable generation-fenced draft sidecar (confirm gate stays). Small improvement, explicit goal.

- **A4 medium — no single mutation boundary** (`extensions/goal-loop-core.ts:1514`, `loops/goal-orchestrator.ts:746`). Journaling + separate ledger allows crash window between sidecar and state. Fresh pi-goal-x orders reconcile→write→ledger→commit with typed conflicts. Fix: one typed mutation service, no format transplant. Architectural candidate — explicit goal required.

- **A5 medium — no unified health report** (`extensions/goal-loop-core.ts:ledgerFiles`, `glla-state-root.ts`, `goal-loop-auditor-process.ts:inspectAuditJobHealth`). pi-goal-x has `goal-recovery.ts:1` report vs repair with backup. Fix: `/glla health` report-only (`inspectAuditJobHealth`-style for roots/sidecars/owner/segments) first; guarded `repair` only with backup/confirm. Report-only is low-risk now.

- **A6 medium — detached auditor `stdio:"ignore"` vs `pipe`** (`extensions/goal-loop-auditor-process.ts:682`). pi-dgoal uses `pipe` + `terminateIsolatedPi`. Pipe gives stream + deterministic cleanup. Fix: `["ignore","pipe","pipe"]` capture, keep group kill. Zero protocol change.

- **A7 low — dashboard view-model + currentTaskId** (`extensions/goal-loop-display.ts:796`, `goal-loop-core.ts:TaskList`). pi-goal-x shares one model + durable pointer. GLLA derives next task per render. Fix: only if inconsistency measured.

- **A8 low — heartbeat parks as terminal** (`extensions/goal-heartbeat.ts`, `loops/goal-session.ts:464`, `goal-loop-display.ts:1122`). 53× `silent_handle_death` with no `session_shutdown` proves pi silent swap; 6/7 peers never gate. Fix: coalesce — keep ledger forensic event, let next `agent_end` re-arm continuation; heartbeat becomes diagnostic. Surgical, complements event supervision.

- **A9 low — local-provider E2E fixture** (`tests/uniform-provider-retry.test.ts`, `scripts/smoke.sh`). pi-goal-x has `tests/e2e/network-recovery-rpc.test.ts` with real 503/429. Fix: opt-in fixture, not default `npm test`.

## Non-actionable (external-only or already covered)

- pi stale-handle silent swap without `session_start` — external, observe/contain only (`audit/PI-HOST-SESSION-REPLACEMENT-REQUEST-2026-08-15.md`).
- Provider quota/billing text trust — GLLA intentionally generic 5s→ladder + hourly ticker; do not reintroduce message-based branches.
- OS / pi-subagents / Chrome / DeepSeek Cordis / Codex app-server / Claude transcript internals — host protocol, not extension API.
- pi-goal-x unconditional startup continuation & unbounded retry — GLLA's `autoResume` global-only + `loadHoldAt` is stricter, do not copy.
- Detached vs in-process auditor already superior in GLLA.
- Antigravity/Grok absent — no delta invented.

## Disposition

- **Now:** record this review (this file). Verify A1 escaping coverage; measure A2 growth.
- **Next explicit goals (one each, with contract):** A6 pipe switch (independent), A5 health report (report-only), A8 heartbeat coalesce (surgical). Others require measured goal.
- **Defer:** A4 single mutation service, A3 durable draft, A7 view-model, A9 fixture — only after measurement and scoped goal. Upstream pi fixes remain reports, not code.

Evidence: `.research/comparison.md` (53 silent_handle_death, 21h max gap), `audit/PI-GOAL-X-COMPARISON-2026-08-27.md`, `audit/CONTINUATION-APPROACH-COMPARISON-2026-08-15.md`, local harness copies, on-disk DESIGN and extensions inspected read-only.

