# Loop auditor + resumable inspection — live verification (2026-09-10)

Branch: `feat/auditor-inspection-resume-and-loop-audit` (commits `e95b8e31`, `ad99f1ea`).
Live loop: `auditLoop=1`, `auditorInspection=true`, subject
`loop:2026-09-10T09:30:07.733Z`. All evidence below is durable in
`.pi-glla/active.jsonl` and `.pi-glla/audit-jobs/`.

| Contract | Live evidence |
| --- | --- |
| Trigger every N iterations | loop audits fired at iterations 1–6 across three host generations |
| Hash fix (`ad99f1ea`) | pre-fix hosts died with worker-side hash mismatch (reproduced via snapshot-race + manual worker run); post-fix request.json self-verifies and pi spawns |
| Inspection session persists | `mtvjhsok-…/session.jsonl` grew live (tailable mid-audit, valid `{"type":"session"}` header) |
| Infra ≠ evidence | auditor pi died with "Connection error." → `result.json ok:false`, no verdict applied; consumed audits 1–3 ledgered `verdict=infra`, disapproval streak stayed 0 |
| In-flight guard | exactly one `loop_audit_skipped_in_flight` ledger event while an audit ran |
| Resume (Feature 1, loop path) | `mtw6nx4i-…/request.json` carries `inspectionResumedFrom: "mtvjhsok-…"`; its `session.jsonl` begins with the predecessor's exact 23,681 bytes (prefix-verified byte-identical), then extends with the resumed turn |

Known accepted edge: an audit whose host dies mid-run leaves its
`result.json` unconsumed (no verdict applied). Harmless for infra
failures; a semantic orphan verdict would surface at next-host health
review via the retained job dir.

Gate at fix commit: 2079 pass / 0 fail, tsc clean, offline
auditor-extensions verified, pack smoke OK.

Final verdict (2026-09-11T00:54:47Z): the resumed audit `mtw6nx4i-…`
returned `<approved/>` — ledgered `loop_audit iter 6 verdict=approved`.
The approval came FROM a resumed session, so Features 1 and 2 are
verified jointly in one live event. Target satisfied; the loop ends at
`/loop stop` (operator-only by contract — no agent-side lever exists
for metricless loops, confirmed against goal-tools.ts `pause_goal` and
goal-loop.ts stop routes).

## Post-merge bounded-chain demo (2026-09-11, merged tree e4e5620b)

`repro/loop-audit-resume-bound-demo.mjs` — real worker + model in a scratch cwd:
A fresh → B resumedFrom=demo-a (prefix intact) → B bloated past the 65536-byte cap
→ C skipped B and resumed demo-a (older small hop). Cap exported and honored.
("no verdict marker" on all three = throwaway prompt lacking complete-form;
mechanism — resolver, seeds, lock/hash path — fully exercised.)

## Review pass on live failure classes (2026-09-11, tree c7052b40)

Two hypotheses tested against code, both clear:
1. Permanent dead slot from stall-cancel orphans — REFUTED. Both stall returns in
   goal-loop-auditor-process.ts (tool-timeout ~L1762, heartbeat-no-progress ~L1802)
   `await terminateWorker(child)` (TERM→KILL on the process group) before returning
   infra; failed jobs' dirs self-delete, so findActiveSameSubjectAudit never sees a
   phantom live-pid lock. Worst-case kill race self-heals via pid liveness.
2. no-verdict class from weak prompt contract — REFUTED. buildLoopAuditorPrompt
   asserts the verdict form twice at the tail; iter-19's `no verdict marker` on a
   ~200 KB bloated session matches the size-collapse pattern (aborts clustered at
   50/54/81 KB seeds), which the 64 KiB resume cap addresses at the root.

## Production run under the merged stack (host generation 2026-09-15)

First loop audit dispatched by the fixed code: job `loop-audit-30-mu38p69d`
(named-attempt signature), inspection on, **resumedFrom: mtwbqxg5-…** — the
resolver picked a 55,658-byte seed (under the 65,536 cap) over newer oversized
jobs: skip-bloated/fall-back-to-older-small-hop semantics, live. Session grew
past the cap mid-run (69 KB+ at snapshot) — per design, the NEXT audit skips
this seed and resumes the newest qualifying smaller hop or starts fresh; the
chain cannot grow unboundedly again. audits.jsonl record appends at verdict
consumption (job still live at snapshot: lock + progress.json, no result yet).

## Full consumption cycle in production (loop-audit-30, host 2026-09-15)

First loop audit under the merged stack COMPLETED and every surface fired:
- result.json -> verdict approved; ledger loop_audit iter 30 (streak 0).
- audits.jsonl record: at 2026-09-15T23:41:27Z, goalId loop:<run>, resumedFrom
  mtwbqxg5-..., sessionPath present, durationMs 4597109 (~77 min).
- LoopState stamped at CONSUMPTION: lastLoopAuditIteration=30,
  lastLoopAuditVerdict="approved", streak 0 -> /loop status renders
  "Loop audit: iter 30 -> approved".
Cost data point supporting the cap: resuming a 55 KB seed ran ~77 min. The
cap keeps any single resume hop bounded so no future audit can inherit an
unbounded conversation.

## 2026-10-10 — configurable stop threshold verified in production

Host reloaded 2026-10-10 14:49 onto the post-`2aea7614` tree (auditLoopStopStreak shipped). The operator then set the new setting in the global file (`~/.pi/agent/pi-goal-list-loop-audit.settings.json`):

```json
"auditLoop": 1,
"auditLoopStopStreak": 5
```

Live state (`.pi-glla/active.jsonl`) after the next consumed verdict:

```
"lastLoopAuditIteration": 43
"lastLoopAuditVerdict": "approved"
"loopAuditStopStreak": 5
```

i.e. the full chain works end-to-end in production: setting → normalization → dispatch → verdict consumption → threshold stamped on loop state (the value `/loop status` and the widget render as the `N/M` denominator). Audits 41, 42, 43 and 46 all approved (`loop_audit` ledger events, `consecutiveDisapprovals: 0`) — four consecutive full production cycles on the current tree (44/45 slots skipped in-flight, as designed), and the operator's stated preference ("higher than 2") is now live with no code change.

## 2026-10-10 — inspection deliberately OFF (operator decision)

The global settings file was edited 2026-10-10 09:08 (when `auditLoopStopStreak: 5` was set) and carries **no `auditorInspection` key** — inspection is off. Confirmed with the operator that this was deliberate (not a dropped key). Consequences, all expected in off mode:

- Audits 43, 46, 48, 50 (and later) run `--no-session`: no `session.jsonl` in the job dirs, `inspectionResumedFrom` absent from `request.json` — the chain simply doesn't start.
- The loop target text ("inspectable, so should resume previous audit session") is stale relative to this decision; the target's core ask ("ensure the branch works as intended") stands.
- Resume remains verified by the 2026-09-15 production evidence above, the offline repro (`repro/loop-audit-resume-bound-demo.mjs`), and the unit suites — it is a one-key re-enable (`auditorInspection: true`) away whenever wanted.

## 2026-10-10 — failure paths untriggered in production; off-mode cost data

Observed across the 2026-10-10 host (reloaded 14:49, inspection off, `auditLoopStopStreak: 5`):

- **Durable same-subject guard**: zero `loop_audit_skipped_active_prior` events — no audit was orphaned by a host replacement (the 14:49 reload caught no in-flight audit). The guard remains verified by unit tests only.
- **Worker fatal log**: zero `worker.error.log` files in any job dir — no worker has crashed in production. The self-diagnosis path remains verified by the integration test (poisoned-hash spawn) only.
- **Off-mode durations** (fresh `--no-session` audits, model `paro-vllm/Qwen3.8-PA`): 61, 61, 18, 53 min for the four 2026-10-10 audits — comparable to the resumed era's 34, 71, 6, 10 min on a *different* model (`allamacpp/qwen-flash`), so the model change dominates; the 64 KiB resume cap's cost argument (quadratic growth within a chain, aborts clustering at 50–81 KB seeds) is unaffected.
- Verdicts: 43, 46, 48, 50 all approved; streak 0 throughout.
