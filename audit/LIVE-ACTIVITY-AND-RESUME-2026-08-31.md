# Live activity, resume, and recovery audit — 2026-08-31

## Scope

This follow-up closes the reported GLLA symptoms:

- a successor or parked objective retaining a stale `LIVE · WORKING` surface;
- an active-but-idle objective appearing not to respond to `/glla resume`;
- detached auditor errors, including quota/insufficient-balance wording, looking
  like an immediate give-up; and
- a queued list appearing to say there is nothing left to resume.

The review is limited to GLLA. Pi core, the operating system, providers,
`pi-subagents`, and other repositories were observed where useful but were not
modified.

## Findings and fixes

### Activity is now evidence- and generation-scoped

`extensions/loops/goal-ui.ts` now treats tool activity as transient evidence,
not durable objective state. Activity is tied to the current start proof,
epoch, and goal/loop scope. Lost, late, or unmatched tool results cannot
repaint a successor as working. `clearToolActivityState()` is applied at
session handoff, successor startup, objective replacement, loop transitions,
archive completion, and terminal status changes, after the relevant refusal or
persistence gate succeeds.

The existing evidence rules remain distinct: timers, pending dispatch, host
busy state, first-turn waits, and actual tool activity are not collapsed into a
single optimistic `WORKING` flag. The subagent hang probe also carries the
last observed activity timestamp needed for honest stale-host diagnostics.

### Explicit resume is a real recovery action

`/glla resume` releases the initial session-load barrier and re-kicks an
ACTIVE-but-idle goal through the normal continuation dispatch path. It records
`resume_rekick`; it does not pretend that a queued or held item is already
running, and startup auto-resume remains consent-gated until transcript load.

A behavioral regression now exercises the real registered command with MockPi:
`tests/behavioral-orchestrator.test.ts` verifies the user-facing active-idle
message, exactly one continuation, the checkpoint payload, and the durable
`resume_rekick` ledger entry.

### Auditor recovery remains uniform and bounded

Auditor/provider wording is not used as a reason to suppress recovery. The
current fallback chain retries recoverable infrastructure failures eagerly,
including billing/insufficient-balance-style errors, while preserving ordered
candidate selection, forbidden-model filtering, cursor persistence, and the
bounded retry/exhaustion horizon. An exhausted no-verdict chain parks the
stored claim with a concrete infrastructure class and no hidden timer; an
explicit resume starts a fresh, durable retry cycle.

The prior repaint hardening and XML escaping documented in
`UI-REPAINT-AND-AUDITOR-PROMPT-2026-08-31.md` remain part of this boundary:
durable transitions force a repaint, and untrusted goal/report/contract text
cannot close the auditor's structural XML-like sections.

## `/glla resume` host-level reproduction

A fresh temporary state directory was driven through real `pi --mode rpc` with
`PI_OFFLINE=1` and a seeded active goal. The explicit `/glla resume` command
produced the expected `The goal is ACTIVE but idle — re-firing its continuation`
notification, a durable `resume_rekick` entry, and the normal `agent_start` and
`turn_start` events. No additional GLLA source defect was found in this path.

A pipe-to-PTY `script` capture was inconclusive because it did not preserve a
reliable interactive transcript. The host RPC event and ledger evidence are
sufficient for this command-level diagnosis. The unrelated warning
`No models match pattern "cline/z-ai/glm-5.3-flash:xhigh"` was observed in the
real run and belongs to model selection, not the GLLA resume path.

## Queued-list disposition

The prior screenshot-shaped queue report remains the historical baseline in
`LIST-STALL-REPRODUCTION-2026-08-29.md`. The later screenshot/report exposed a
GLLA-owned gap in that old boundary: a successful standalone goal could leave
an already-waiting list behind, and `/glla resume` did not activate a
queue-only state. `LIST-CONTINUOUS-HANDOFF-2026-09-01.md` records the fix and
behavioral evidence. Cold-load automation is still held until explicit
consent; `/glla resume` now supplies that consent for the waiting queue.

## Compatibility and scope disposition

The checked-out package uses `pi-subagents` 0.62.0 and its current GLLA
integration tests pass. No `recommend-subagents` implementation is present in
this repository, so replacing or adapting that separate extension is deferred
until its actual source/package is supplied. The planned cross-harness review
(Pi Goal X, DeepSeek, Codex, Claude, Antigravity, and Grok) is likewise a
follow-up research item, not a reason to alter GLLA's lifecycle contract now.

The legacy AgentManager child-stop integration remains conditionally skipped
because `node_modules/@tintinweb/pi-subagents/src/agent-manager.js` is absent.
The fixture is external and was not recreated or patched in this repository.

## Verification

- `bun test --parallel=1 --max-concurrency=1 --timeout=60000 tests/behavioral-orchestrator.test.ts`: **129 pass, 0 fail**.
- Focused auditor retry/fallback tests: **2 pass, 0 fail** for the exhausted no-verdict and aggressive no-verdict cases.
- Final `npm run release:check`: **1,775 pass, 2 skipped, 0 failed** across 1,777 tests in 170 files; TypeScript, Jiti state-split, offline auditor-extension loading, `npm pack --dry-run`, and packed-artifact import smoke all passed.
- The two skipped tests are the unavailable legacy AgentManager integration and the env-gated auto-committer test.
- One earlier full release-check attempt hit the two known real-timer auditor waits under machine load; the isolated retry and the subsequent complete release check passed. This was test-run timing noise, not a changed recovery result.
- Current repository state is clean on `main...origin/main`; only GLLA files and audit evidence were changed in this pass.
