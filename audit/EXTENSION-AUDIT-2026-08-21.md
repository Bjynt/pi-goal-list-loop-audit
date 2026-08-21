# Extension audit — 2026-08-21

## Scope and method

This was a read-only survey of the package/runtime surface, goal/list/loop
lifecycle, prompts and trust boundaries, tests/release operations, and the
published package contract. Four independent Explore passes were cross-checked
against the current source and existing regression suite. The audit found real
correctness and security gaps; v0.35.14 fixes the bounded, high-confidence
ones below and records the remaining architectural work instead of treating
an opportunity as closed by prose.

## Findings and disposition

### Fixed in v0.35.14

1. **High — child extension factories could replace the host API.**
   `extensions/loops/goal.ts` previously captured every factory's `ExtensionAPI`
   and started timers before host ownership existed. A pi-subagents child can
   load the extension and overwrite the API used by main-session continuation.
   Factory evaluation is now registration-only; the admitted host
   `session_start` claims the API, resets session state, and starts resources.
   Regression: `tests/stale-api-terminal.test.ts`.

2. **High — mechanical verification commands crossed an arbitrary-shell
   boundary.** `extractMechanicalCheckCommands` accepted shell metacharacters
   after a trusted-looking prefix and `execSync` ran the whole string. The
   runner now accepts one executable plus literal arguments, uses `execFileSync`
   with the existing timeout, and rejects unsafe syntax. Regression:
   `tests/regression-shield.test.ts`.

3. **High — evidence references were not bound to `<evidence>`.** The shield
   searched the entire auditor report, allowing contract prose outside the
   evidence block to satisfy an approval. Matching is now limited to the
   evidence payload. Regression: `tests/regression-shield.test.ts`.

4. **Medium — contradictory auditor verdict tags could approve.** The parser
   now treats only the final nonblank line as authoritative, normalizing the
   escaped-newline representation used by the RPC fixture. A contradictory
   pair therefore cannot set `approved=true`. Regression:
   `tests/audit-verdict.test.ts`.

5. **High — approved completion could report success after archive failure.**
   Both detached-audit approval paths now check `archiveCurrentGoal`; on
   failure they preserve the objective in a blocked paused state and emit a
   recovery ledger event instead of `✓ done`.

6. **Medium — deterministic pre-audit failures could leave the in-flight
   latch set.** Mechanical fast-fail and detached-worker execution now share
   one unconditional cleanup `finally` path.

7. **Medium — persisted IDs had no runtime path-component boundary.** State
   hydration rejects invalid goal IDs; queue hydration skips them; write/delete
   helpers refuse unsafe IDs and path helpers keep invalid direct calls inside
   `.pi-glla/goals/`. Regression: `tests/persistence-hardening.test.ts`.

8. **High — branch-mode loop resume could commit on the user's branch.**
   `/loop resume` now verifies `HEAD` is the recorded scratch branch and
   refuses with an explicit recovery instruction otherwise. Regression:
   `tests/loop-finish.test.ts`.

9. **Medium — `/list pause|resume|clear|cancel <text>` violated exact-match
   semantics.** These verbs now act only when no trailing text exists; text
   falls through to objective routing.

10. **Medium — task completion status could bypass milestone checks.**
    `update_task_status(..., complete)` now shares the same mechanical
    verification gate as `complete_task`.

11. **Medium — auditor reports were re-injected without a data boundary, and
    the auditor prompt accepted executor-authored scope shifts.** Reports are
    now explicitly delimited as untrusted evidence data, and scope changes
    require the durable `newObjective` transition already supported by the
    tool rather than a claim in `completion_summary`.

12. **Release contract — shipped documentation and workflow gaps.** The npm
    package now includes the linked planning documents, the broken historical
    audit link was replaced with the shipped design overview, Node/npm versions
    are pinned, and the workflow runs `npm run release:check` on pushes and
    pull requests. `package.json` declares Node `>=22.19.0`. The live
    command-routing diagnostic now uses a process-scoped temp artifact rather
    than rewriting tracked `audit/` state.

### Confirmed, deferred architectural work

These are real findings, but larger than the bounded v0.35.14 hardening pass:

- **High — archive lifecycle is not transactional.** The archive markdown is
  created, active markdown is deleted, and the state/ledger terminal snapshot
  follows. A crash between those steps can leave an archive plus an active
  state with no active markdown. Add a durable archive intent/commit marker and
  startup reconciliation before changing this sequence.
- **High — queue-sidecar deletion and archive recovery are not tombstoned.** A
  failed sidecar deletion can resurrect a completed list item after restart;
  fan-out dedupe also calculates eligibility before hydrating disk sidecars.
  Add an append-only terminal queue index/tombstone and hydrate under a
  per-project mutation lock.
- **High — ownership is advisory across processes.** `owner.json` and
  `session-owner.json` have no OS lock/lease epoch, so two pi processes can
  supervise one project. Add an exclusive project lock plus epoch checks on
  every delayed mutation.
- **Medium — generic `pause_goal` wait timestamps repaint but do not have a
  general durable resume scheduler.** Wire ordinary wait pauses into the same
  restart-safe timer abstraction used by provider/auditor recovery, preserving
  explicit user pauses.
- **High — detached auditor power is intentionally unsandboxed.** It inherits
  environment and repository access and exposes `bash`; repository prompt
  injection can write files or inspect inherited secrets. Treat this as a
  documented deployment limitation until an OS/container sandbox and reduced
  environment are available.
- **Medium — SDK boundaries use `any` and pi-subagents private registry/event
  shapes.** Introduce typed event adapters and a capability/version adapter
  with absent/changed-registry tests.
- **Release/test opportunities:** add a tarball extraction/import smoke test,
  crawl relative Markdown links in the actual npm package, run the smoke
  harness in controlled CI, and add multi-process/concurrency coverage. The
  live routing diagnostic is already isolated from the tracked tree. The current
  serial suite is deliberate for shared mock state, but it does not test the
  cross-process ownership risk above.

## Verification evidence

- `timeout 120 npx tsc --noEmit` — pass.
- `timeout 120 bun test tests/regression-shield.test.ts tests/audit-verdict.test.ts tests/persistence-hardening.test.ts tests/stale-api-terminal.test.ts` — **59 pass, 0 fail**.
- `timeout 120 bun test tests/release-contract.test.ts tests/loop-finish.test.ts tests/retry-bounds.test.ts` — **21 pass, 0 fail**.
- `timeout 240 bun test tests/behavioral-orchestrator.test.ts` — **117 pass, 0 fail**.
- `timeout 360 npm test` — **1413 pass, 1 intentional environment skip, 0 fail** across 118 files.
- `npm pack --dry-run` is exercised by `tests/release-contract.test.ts`; the
  release-contract test passed with `PLAN.md` and `LIST-PHILOSOPHY.md` present.

The remaining deferred findings are explicit follow-up work, not claims that
this audit found no further opportunities.
