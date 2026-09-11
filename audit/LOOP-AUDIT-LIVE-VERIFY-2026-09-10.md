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
