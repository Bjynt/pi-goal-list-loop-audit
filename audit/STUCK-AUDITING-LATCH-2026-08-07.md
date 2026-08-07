# Stuck "auditing" after a completed verdict — the stale-latch drop

2026-08-07 · field incident: the "are we stuck" freeze · v0.34.80

## Incident (the screenshot the user asked about)

The 4-item note.md batch queue froze at item 2 (GitHub #4) for 30+ minutes
with zero ledger activity while the detached auditor's verdict sat complete
on disk. The user's read was exact: we were stuck.

Chain (all ledger-verified):

1. **13:36:07** — item 1 approved/archived; item 2 created; continuation
   re-arm storm (streak 24 over 7 min) — sends can't deliver while the
   agent is mid-turn; benign but loud.
2. **13:38:41** — three consecutive heartbeat-probe failures (transient —
   the session was alive) tripped `goStaleTerminal`: `extensionApiStale`
   latched, `staleTerminalDone` set, `extension_api_stale` +
   `session_handle_invalidated` ledgered. The latch is in-memory and only a
   session rebind clears it.
3. **13:43:06** — `complete_goal`'s tool handler uses the raw tool ctx
   (bypasses `freshCtxForGeneration`), so it dispatched the detached audit
   anyway: status → auditing, worker spawned.
4. **13:50:08** — the worker finished: **DISAPPROVED** (a legitimate
   finding — see CONFIRM-DRAFT-MARKDOWN-2026-08-07.md §rework) and wrote
   result.json.
5. **13:50:08+** — the apply path's gate `freshCtxForGeneration(generation)`
   returned **null** (extensionApiStale latched) → the verdict was **silently
   dropped** (bare `return`, no ledger, no state write).
6. **Forever** — heartbeatTick returns at the `extensionApiStale` branch
   before reaching the v0.29.1 stranded-audit recovery (which needs
   `!completionAuditInFlight` — true after the finally — and 90s silence);
   `session_shutdown`'s park never ran (no shutdown — the session was
   alive). Goal frozen in "auditing", queue blocked, no in-flight audit,
   no events. The v0.34.62 debounce (3 strikes) exists but a burst of 3
   real failures still latches a live session — that is by design (fail
   closed), but the verdict-drop afterwards was not.

## Root cause

**A completed auditor verdict can be dropped silently when the stale latch
is held by a live session.** The apply gate nulls out (correctly — the
handle is suspect), but "suspect" was treated as "abandon the verdict"
instead of "defer it durably". And the recovery backstop is unreachable
below the same latch.

## Fixes (v0.34.80)

- **Fix A — apply-gate honesty** (retryStoredCompletionAudit): when the
  gate nulls out on an auditing goal whose claim is still the current
  attempt, the verdict is NOT dropped silently: ledger
  `audit_verdict_deferred` (reason: stale-latch-apply-gate) and
  `markCompletionAuditRecoveryPending(lastCtx, "verdict-apply-gate")` — the
  claim parks phase `recovery-pending` durably so a fresh session's
  recovery path surfaces "completion audit blocked — no verdict" and
  /goal resume re-runs the stored claim. The legit-supersede case (a newer
  attempt owns the claim) stays silent.
- **Fix B — heartbeat ordering** (heartbeatTick): a stale-latch variant of
  the stranded-audit park runs BEFORE the `extensionApiStale` early return,
  via the kept last context (`stranded_audit_recovered` with
  `via: "stale-latch"` + `markCompletionAuditRecoveryPending(knownCtx,
  "stale-latch-recovery")`), guarded by the exact stuck signature (auditing,
  no in-flight, claim present, 90s silence). A heartbeat still never
  launches another worker — the park is the explicit-resume gate.

With both fixes, the observed freeze now ends in either a loud park
(heartbeat, ≤90s after the drop) or a durable deferral that the next
session recovers — never an unbounded silent "auditing".

## Operational unstick for the incident

A restart (fresh session_start) clears the in-memory latch; the recovery
path parks the claim and /goal resume re-runs the auditor with the stored
claim. The disapproval's required fixes were implemented as v0.34.80
(confirm-draft RPC rework) so the re-audit has the corrected evidence.

## Evidence

- `tests/stuck-audit-latch.test.ts` (3, new): Fix A gate text
  (audit_verdict_deferred + recovery-pending park + the newer-attempt
  silent case); Fix B ordering (park index < stale-branch index) + kept-
  last-ctx park + no dispatch in the pre-branch; the stuck signature.
- `tests/confirm-draft.test.ts`: +2 real-RPC-stub tests.
- Full suite: **1045 pass / 1 skip / 0 fail across 97 files**, tsc clean.
