# Open PR review: NVIDIA AVO-related work — 2026-09-01

## Disposition

Do **not** merge PR #22 or PR #36 as-is. Both branches are substantially
behind the released baseline `v0.37.2` and report `CONFLICTING` merge state.
PR #22 is the closer AVO adaptation and is a selective-port candidate after a
lifecycle/measurement redesign. PR #36 is primarily an opt-in LLM adherence
watchdog; only its small human-input zombie-standdown fix is a good independent
port candidate.

Baseline: `v0.37.2`, commit `32da1b4e40fd45b6256bd4f96903dff1c4a226c7`.

## Evidence

- PR #22: head `2b026a6f186d5c0a7d3ed86c007ef6fb8168d416`; the PR is 5 commits
  ahead and 1,075 commits behind the current baseline. Its quality and
  GitGuardian checks passed, but that is not integration evidence against the
  released tree.
- PR #36: head `9810f8795c7d6e43b6a7128a4c82baec10fc1ab4`; the PR is 19 commits
  ahead and 904 commits behind the current baseline. Quality run
  [32975121445](https://github.com/DraconDev/pi-goal-list-loop-audit/actions/runs/32975121445)
  ran 1,660 tests with 1 skip and 0 test failures, then failed `tsc` with
  three `TS2352` errors at `tests/commissar-terminate.test.ts:82-84`
  (casting the `ExtensionContext` fixture directly to `Record<string, unknown>`).
- Both publish checks were skipped; GitGuardian passed. No submitted reviews
  or issue comments were present at review time.

## PR #22 — AVO-inspired stagnation supervisor

### What is good

The pure `recordTurnObservation` design is easy to test and the feature maps
AVO's monitor-stagnation/conditional-intervention idea to bounded exhaustion
and repeated-output detectors. It preserves the existing provider-error and
abort exemptions and injects non-prescriptive strategy framing rather than an
automatic kill action.

### Findings

1. **P1 — raw HEAD movement is not goal-owned progress.**
   `goal-activation.ts` treats any `git rev-parse HEAD` change as one goal
   commit. This includes unrelated commits and the repository's
   `dracon-sync` daemon commits, including commits caused by GLLA ledger/state
   writes. It can therefore clear a real stagnation episode without agent
   progress. A commit must be attributed to the goal (or raw HEAD must not be
   used as the progress signal).

2. **P1 — objective/lifecycle fencing is missing.**
   `noteGoalStagnationTurn` awaits the host `exec` probe after capturing the
   active goal, then mutates/persists without checking goal id, revision,
   session generation, or current status. `/goal tweak` preserves the same
   `Goal.stagnation` object while bumping the objective revision, so the new
   objective can inherit the old streak, recent replies, and directive. A
   late `agent_end` can also write stale lineage into the successor state.

3. **P1 — cycling bypasses the bounded-injection cap.**
   `recordTurnObservation` creates a fresh cycling directive with
   `injections: 0` whenever the three-reply cycle fires. On continued cycling,
   the directive is replaced before the increment path, so the
   `maxConsecutiveInjections` stand-down is never reached. The tests verify
   that cycling fires, but do not verify repeated cycling reaches the cap.

4. **P2 — first-turn and attribution gaps.**
   The first observation establishes the HEAD baseline after the turn and
   records no vector, so work committed in that first turn is invisible. The
   activity delta counts only writes and bash calls despite the vector's
   `toolCalls` description claiming all tools. These choices need an explicit
   activation-time baseline and a documented ownership model.

The arXiv paper [2603.24517](https://arxiv.org/abs/2603.24517) supports the
high-level supervisor/stagnation pattern. The PR description's ARC-AGI/RHAE
performance claim was not found in that paper, and the cited NVIDIA blog URL
returned 404; those claims should be removed or separately cited.

### Disposition

Rebase onto `v0.37.2`, retain the pure detector only after fixing the cycle
state machine, reset/fencing lineage on objective revision, and replace raw
HEAD movement with attributable progress. Keep it non-terminating and
feature-gated until behavioral MockPi coverage proves stale `agent_end`,
objective tweak, daemon/unrelated commit, and repeated-cycle cases.

## PR #36 — commissar watchdog plus human-input zombie stand-down

### What is good

The commissar is opt-in, single-flight, has an evidence-tool floor, treats
infrastructure failures as non-verdicts, and uses an untrusted-evidence
restart directive. The `USER_INPUT_WAIT_TOOL_NAMES` carve-out is directly
relevant to the current zombie-watchdog problem: a real user dialog should not
be aborted merely because provider stream activity is silent.

### Findings

1. **P1 — detached verdicts capture revisions but the hook ignores them.**
   The transport carries `goalRevision`, but `applyCommissarResult` accepts
   only a goal id. A result from before `/goal tweak` can therefore increment
   the WANTING streak or terminate the revised objective. The special loop
   id is the constant string `"loop"`, so a result from an old loop can apply
   to a newly active loop. Both paths need a target identity plus revision and
   session-generation fence.

2. **P1 — WANTING streak/cadence are process-global.**
   `wantingStreak` and `lastCheckAt` are shared across goals, loops, and
   working directories. A stale result or one WANTING on goal A can become
   the first/second consecutive WANTING for goal B. Runtime state must be
   keyed by cwd and stable goal/loop identity, and abandoned in-flight work
   must be invalidated rather than merely clearing a boolean.

3. **P1 — loop new-session ownership is incomplete.**
   `terminateMainRunForDereliction` arms `newSessionArmed`, but
   `terminateLoopForDereliction` does not. On a host that supplies
   `newSession`, the old loop's aborted handler can dispatch alongside the
   successor restore gate, defeating the claimed double-fire barrier.

4. **P1 — the new-session path is not available on the current event API.**
   The current SDK exposes `newSession()` on command contexts, not the
   `ExtensionContext` received by event handlers, so the advertised force-new-
   session path is only exercised by a synthetic test fixture and normally
   falls back to same-session abort. In addition, the PR's recovery helper
   returns success before an async `newSession()` rejection and touches the old
   context after invoking it, which can strand the durable marker without a
   successor.

5. **P2 — persisted loop state is not schema-covered.**
   The PR adds `LoopState.commissarRestart`, but only
   `Goal.commissarRestart` is added to `schemas/goal.schema.json`. The loop
   marker needs the same persistence/schema contract or an explicit rationale.

6. **P1 policy risk — automatic LLM termination is a separate high-risk
   control plane.**
   Subjective WANTING criteria include dismissal of goal achievability. Even
   with the default-off setting and a two-verdict threshold, a model can
   terminate valid blocked/diagnostic work. This should not be described as
   the AVO implementation; if retained, add dry-run telemetry and a clearly
   bounded operator-approved termination policy.

### Disposition

Do not merge the commissar feature from this stale branch. Port the zombie
human-input stand-down independently onto current `main`, with a behavioral
heartbeat test that holds a real in-flight user-input tool and separately
proves a no-tool hung stream still aborts. Reconsider commissar only after a
fresh design supplies per-target lifecycle fences, loop identity/schema
coverage, reliable restart ownership, and an explicit operator-safety policy.

## Recommended order

1. Port and test the small zombie stand-down fix.
2. Rework PR #22's measurement and lifecycle model; then evaluate its pure
   detector as an opt-in, non-terminating AVO-inspired strategy nudge.
3. Keep PR #36's commissar out of the AVO path unless the termination policy is
   separately approved and fully fenced.
