# PR #45 / #46 disposition — 2026-09-08 (shipped as v0.38.27)

Both PRs by Bjynt, opened 2026-09-07, CI-green (2/2), 110 commits behind
main at review time. Merge-tree check: the ONLY conflict in either PR is
`.pi-glla/active.jsonl` (live session telemetry — never mergeable). All
code files merge cleanly. Disposition: **selective native port**, both PRs
closed with credit. Rationale per item:

## Ported (v0.38.27)

1. **`/loop pause` soft-hold (#46)** — parallel to `/goal pause` and
   `/glla pause`. `cmdLoop` gains a `pause` subcommand: clears the tick
   timer + tool activity, writes
   `stopReason: "paused by user (/loop pause)"`, ledger `loop_paused`,
   NO `finishLoopGit`, NO hard-stop ledger, NO list-queue advance.
   `RESUMABLE_STOP` extended with the pause prefix so `/loop resume`
   picks it up with iteration/best/history verbatim. Completions entry
   added. Pinned by `tests/loop-pause.test.ts` (3 source-grep tests,
   ported from the PR). Lowest risk, highest value.
2. **`countDone` subtask coverage (#45)** — a closed parent counts as
   covering its subtasks (`n += 1 + subtasks.length`); mid-flight parents
   still count done subtasks independently. Field symptom: 6 real tasks
   displayed "2/24". Pinned by a new `v0.38.27` widget-count test in
   `tests/display.test.ts` (7/12 + 1/4 cases, ported from the PR).

## Held (not ported, not rejected)

3. **`auditTasks` per-task auditor (#45)** — default-OFF global setting
   firing a detached auditor (hardcoded `thinkingLevel: "max"`) on every
   `complete_task`. Sound design, 3 behavioral tests, but: per-task
   max-thinking auditor runs are a real token-cost surface; the setting
   must be fitted into the post-reorg settings menu; the `task_audit_*`
   ledger contract is new. Needs a dedicated cost/surface review goal,
   not a drive-by port.
4. **`bypassTriggered` zombie-abort shortening (#45)** — shortens the 30m
   zombie-abort window to 5m-past-bypass in lifecycle-critical code. The
   PR itself notes the full auto-abort→auto-retry round-trip is untested,
   and main has since added abort-latch send guards (v0.38.24) around the
   same abort path — interaction must be re-verified with a real
   round-trip test before this lands. Held pending that proof.

## Dropped

5. **Auditor "best solution" one-liner (#45)** — the sentence is malformed
   ("do not accept just because it is technically-correct but clearly
   inferior approach over a demonstrably better one is grounds for
   disapproval") and the content turns an evidence-contract auditor into
   a taste judge. GLLA's auditor decides contract satisfaction, not
   solution elegance. Dropped with rationale; a well-formed variant scoped
   to "weakest reasonable option among verified alternatives" could be
   re-proposed.
6. **`.pi-glla/active.jsonl` + stale version bumps** — live state must
   never merge; the 0.38.22/0.38.23 bumps are superseded by 0.38.27.

## Validation

- `npx tsc --noEmit` clean; ported pins green; full `release:check`
  gate on the port tree before tag (see CHANGELOG 0.38.27).
