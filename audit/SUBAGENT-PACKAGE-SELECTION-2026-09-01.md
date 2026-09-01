# Subagent package selection — power-max audit 2026-09-01

## Decision

Keep and pin **`pi-subagents@0.62.0`** as GLLA's orchestration companion. It is
the power-max choice for best automation and quality. Do not stack a second
orchestrator in the same session.

User priority for this pass: **power / best automation and quality** over
minimalism. The prior comparison therefore re-weighed the five candidates on
parallel/sequential workflows, isolation, structured verification, model
routing, and durable recovery — not on install size or ceremony.

## What was examined

Live npm + installed source + unpacked tarballs (2026-08-31):

| Package | npm | Tarball | Unpacked | TS lines | Notable surface |
|---|---|---|---|---|---|
| `pi-subagents` | 0.62.0 (2026-08-31) | 1.1M | 5.5M / 292 files | 93,585 (248 src) | `runs.all` / `runs.lanes` / `runs.host` / `runs.steer` / worktree isolation / `outputSchema` / `acceptance` / missions / schedules / durable `status.json` + versioned stop RPC |
| `@tintinweb/pi-subagents` | 0.19.0 (2026-08-27) | 672.7K | 2.8M | 20,982 (56 src) | `subagents:started/completed/failed/compacted/steered/ready/scheduled` events, per-agent `persist_session` |
| `@narumitw/pi-subagents` | 3.0.1 (2026-08-31) | 90.3K | 444K / 13 files | 3,005 | Minimal `subagent_spawn/subagent_wait`, `MAX_TASK_BYTES 50 KiB`, `MAX_TOOLS 64`, no durable status artifact, README states “v3 not yet on npm” contradicting npm 3.0.1 |
| `@quintinshaw/pi-dynamic-workflows` | 3.10.0 (2026-08-30) | 789.9K | 2.7M / 49 src | 20,430 | `workflow()` nests 1 deep, `verify`/`judgePanel`/`loopUntilDry`/`completenessCheck` (LLM votes), no default timeout/budget, up to 16 concurrent / 1000 total |
| `@juicesharp/rpiv-advisor` | 2.8.0 (2026-08-29) | 26.8K | 144K | — | Second-opinion reviewer hook, composes, does not replace |

GLLA integration surface checked: `subagent:async-started` + durable `status.json`
+ provider RPC (`subagents:rpc:v1:*`), `extensions/goal-heartbeat.ts`
supervision, `extensions/loops/goal-activation.ts` ledger,
`extensions/goal-loop-subagents.ts` model overrides, `docs/workflows.md` /
`docs/configuration.md` / `docs/agents.md`, `skills/pi-subagents/SKILL.md`.

## Verdict

- **`pi-subagents@0.62.0` — keep, pin exact.** Best lifecycle/recovery/workflow/
  RPC/GLLA compatibility at the power ceiling. 0.x rapid releases and large
  surface (93k lines) justify an exact pin and a compatibility canary on upgrade
  (`subagent:async-started` + durable status + RPC). Operating model:
  `runs.all` parallel, `runs.lanes` worker→review→fix, `runs.host` gated,
  worktree isolation, `outputSchema`/`acceptance.report`, explicit `timeoutMs`/
  `tokenBudget`/`maxAgents`, fresh-context reviewers, deterministic host gates.
- **`@tintinweb/pi-subagents` 0.19.0 — skip / adapter required.** Legacy
  provider; no lanes/worktree/outputSchema parity. Do not run alongside
  `pi-subagents` (colliding provider RPC).
- **`@narumitw/pi-subagents` 3.0.1 — watch, not replacement.** Promising
  minimalism, but no durable status/workflow parity and README/npm contradiction;
  revisit when persistence/workflow added.
- **`@quintinshaw/pi-dynamic-workflows` 3.10.0 — complement only.** Quality
  helpers are LLM votes, not bounded verifiers. Do not stack with GLLA as a
  second orchestrator (duplicate tools/events, ambiguous ownership). Use via
  isolated `workflow()` only when needed.
- **`@juicesharp/rpiv-advisor` 2.8.0 — second-opinion only.** Keep as
  complementary reviewer; not an orchestration replacement.

## Recommendation updates

- `README.md` “Recommended pi extensions”: promoted `pi-subagents` from
  “Optional parallel workers” to “Recommended for power — parallel
  orchestration” with pinned `0.62.0`, full power-model description, and
  anti-stacking guidance for `pi-dynamic-workflows`.
- `package.json` already pinned `pi-subagents: 0.62.0` (devDependency); no
  change required.
- External audit at `/home/dracon/chat/pi/audit/pi-extension-recommendations.md`
  §2.2 updated to **add** `pi-subagents@0.62.0` and demote `@tintinweb` to skip.

## Evidence

- `npm view` + `npm pack --dry-run` + tarball inspection for all five packages
- `docs/workflows.md` recommended `clarify→scout→worker→fresh reviewers→worker`
  with `runs.lanes` + `workflowScript` validate; `docs/tool-reference.md`;
  `docs/configuration.md` (`subagents.defaultModel`/`agentOverrides`/`modelScope`);
  `docs/agents.md` (builtin → installed → user → project priority)
- `src/index.ts` events, `src/subagents.ts` `BROKER_CREDENTIAL_FD`,
  `src/tools.ts` `SpawnParameters`/`InspectParameters`/`CancelParameters`

## Follow-up

- On `pi-subagents` upgrades, run compatibility canary against
  `subagent:async-started` + durable status + RPC before bumping the pin.
- Track `@narumitw` README/npm fix and persistence/workflow parity before
  reconsidering it as a replacement.
