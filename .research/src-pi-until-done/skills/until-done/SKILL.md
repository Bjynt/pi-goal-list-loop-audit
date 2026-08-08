---
name: until-done
description: How to drive Pi's `/until-done` autonomous goal loop — owning the contract, calling the four `until_done_*` tools, applying pi-config TDD discipline (ANALYSIS → BOOTSTRAP → RED → GREEN → REFACTOR), and respecting ask-before boundaries. Pi loads this skill on demand whenever a `/until-done` goal is active.
---

# /until-done — Pi-led autonomous goal pursuit

You are the agent in a Pi session where `/until-done` may be active. The
extension hands you a standing goal and lets you keep working across
turns until you declare the goal done or blocked. **You drive the
loop, but `until_done_complete` is gated by an LLM judge** — see the
"Cross-model judge" section below. You can't talk yourself into
"done"; the judge has to agree first.

## When this skill applies

- The user typed `/until-done <intent>` and the contract has not yet
  been approved → you are in **setup**.
- A `/until-done` goal is already active and you just received an
  auto-continuation message starting with
  `[Continuing toward your standing goal]` → you are in **work mode**.
- The user typed `/until-done resume` → **work mode** with a fresh
  budget.

## TDD-first execution model (from pi-config)

Every production-affecting goal MUST pass through these phases.
Declare your phase by passing `phase` to `until_done_progress`. The
extension shows the phase in the status line so the user can verify
discipline at a glance.

| Phase | Meaning |
| --- | --- |
| **ANALYSIS** | Understand the problem, scope, constraints. Read code. No production edits. |
| **BOOTSTRAP** | Ensure validation infra exists and works. Verify the `verifyCommand` runs. Skip if already in place. |
| **RED** | Write a failing production test that exercises real user behavior, a contract, or a system boundary. Run it. **Confirm it fails.** |
| **GREEN** | Smallest production change to pass the failing test. No preemptive generalization. No extra abstractions. |
| **REFACTOR** | Improve structure / readability / performance without changing externally observable behavior. Run the verify command after. |
| `none` | Goal is research-only or doc-only — no production code shipping. |

Constraints from pi-config:

- nesting depth ≤ 3
- construct ≤ 30 LOC
- file ≤ 200 LOC
- single responsibility per construct

If the goal is a bug fix or a feature addition, the path is always
`analysis → red → green → refactor`. If the goal is research, it can
stay in `analysis` and end with a written summary.

## North Star — what's locked vs. mutable

`until_done_set` locks five things into a **North Star** that **cannot
change** for the lifetime of the goal:

1. `goal` — the destination
2. `doneCriteria` — what counts as arriving
3. `verifyCommand` — the one shell command that proves arrival
4. `askBefore` — boundaries the user controls
5. `judgeModel` / `sameModelJudge` — who verifies the "I'm done" claim
   (see "Cross-model judge" below)

If any of those four were drafted wrong, the user must
`/until-done cancel` and start a new setup. **Do not work around
the North Star.** Don't pretend a different verifyCommand is fine.
Don't widen done-criteria to be easier to hit. Don't drop ask-before
items "because the user obviously meant…". The user can read
`/until-done northstar` at any time to verify the contract is intact.

Everything else — the **task list**, current task, learnings,
gotchas, ci commands per task, guardrails, even `phase` and
`maxTurns` — is **mutable**. Use `until_done_replan` to restructure
when reality diverges. Each replan must include a `reason` and gets
logged to `/until-done replan-log`.

## Setup mode

You execute setup as **two locked deliverables presented together for
one approval**: the contract (North Star) and the YAML task list.

1. Read the user's intent.
2. Draft the contract (North Star — locked once you call `until_done_set`):
   - **Goal**: one-line restatement.
   - **Done when**: concrete, verifiable conditions. For
     production-code goals: must include _"all tests in <verifyCommand>
     pass"_.
   - **verifyCommand**: the single command that proves done (e.g.
     `bun test`, `mise run check`, `pytest -q`). Omit for
     research/doc.
   - **Ask before**: operations needing user approval. Be specific
     (`git push`, `rm -rf`, `npm publish`, sending mail). Empty list
     `[]` if none.
   - **Decision style**: one short sentence on how to make trade-offs
     ("favor smaller diffs", "prefer adding tests over fixing types",
     etc.).
   - **startPhase**: `analysis` for most goals; `red` if the user's
     intent already names the failing case; `none` for non-code goals.
   - **Judge mode** — REQUIRED. Pick exactly one (`until_done_set`
     refuses with `judge_unspecified` if you skip both):
     - `judgeModel: { provider, modelId }` (recommended) — a model
       **different** from the executor. Cross-model is the standard
       fix for Ralph-loop oscillation. Inspect `/until-done judge` to
       see if the user has a session default; if they have one, use
       it (or omit both fields and the extension fills it from the
       default). If the user has not configured one, ask them in the
       contract dialog: _"Which model should judge completion? Pick
       one different from the executor for strongest convergence."_
     - `sameModelJudge: true` — opt into same-model self-judge with a
       fresh, completion-focused context. Strictly weaker; use only
       when no second model is available.
3. Decompose the goal into a complete YAML task list. For each task fill in **every** field:

   ```yaml
   - id: T-001
     title: <imperative one-liner>
     phase: bootstrap | red | green | refactor | analysis | none
     status: pending
     dependencies: []          # earlier T-NNN ids
     blocks: []                 # later T-NNN ids
     prerequisites:             # things that must be true before start
       - description: ...
         cleared: false
     validationSteps:           # ordered, externally verifiable
       - ...
     ciCommands:                # lint/typecheck/test/build/deploy
       - ...
     styleguideRules:           # cite source if external
       - ...
     guardrails:                # boundaries that keep the task on track
       - ...
     learnings: []              # filled in over time
     gotchas:                   # pitfalls to avoid on restart/rewind
       - ...
     context:                   # files & URLs you'll need
       - path: src/foo.ts
         why: ...
       - url: https://...
         why: ...
   ```

   Rules: bootstrap tasks first; every code-changing task is preceded
   by a RED task; final task is verification (run `verifyCommand`,
   confirm done-criteria).

4. Show the contract **and** the YAML task list back to the user as
   plain markdown.
5. Ask explicitly: _"Approve contract + task plan? (yes/no)"_
6. Wait. **Do not call any `until_done_*` tool until the user
   confirms.**
7. After confirmation:
   a. `until_done_set` with the contract fields.
   b. `until_done_plan` with the full `tasks` array.

If the user says no, stop. Do not retry.

## Work mode

Each turn, do **one** of:

1. **Advance the current task.** Call `until_done_task_update` with
   `status='in_progress'` if you haven't already. Use built-in tools
   (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`). Real
   changes only.
2. **Mark task done.** Call `until_done_task_update` with
   `status='done'` and any `addLearning`/`addGotcha`/`addContext`. The
   extension auto-advances to the next ready task.
3. **Replan when reality diverges.** Call `until_done_replan` with
   `operations: [...]` and a non-empty `reason`. Common reasons:

   - **Discovered new sub-task** → `op: "insert"` after the current task
   - **Two tasks turn out to be one** → `op: "merge"`
   - **One task turns out to be three** → `op: "split"`
   - **A planned task is moot** → `op: "remove"` (must be `pending` or `blocked`)
   - **Wrong dependency order** → `op: "reorder"`
   - **Rewrite a pending task** → `op: "replace"`

   `done` tasks are immutable. Don't try to retroactively rewrite
   history. The North Star is also immutable — if the goal itself was
   wrong, tell the user, don't replan around it.

4. **Transition phase** via `until_done_progress` with `phase` set.
5. **Declare done** via `until_done_complete`. Only after the
   verifyCommand passes and you can quote its output.
6. **Block** via `until_done_block` when you need user input.

Before any operation that matches a string in the contract's "ask
before" list, _stop and ask the user_ in plain text. Do not bypass the
user's gate even if "it would obviously be fine".

### When the extension auto-prompts you

If you've marked all planned tasks done but haven't called
`until_done_complete`, the extension sends a follow-up reminder:
"either run verifyCommand and call complete, or replan with reason
'residual_work_discovered'". This is the **clean-end guarantee** —
you cannot drift indefinitely. After two such nudges in a session,
the loop pauses and waits for the user.

## Cross-model judge

Every `until_done_complete` is gated by an LLM judge. The judge sees
only the goal, done-criteria, verifyCommand, and the evidence you
cite — no executor history to bias it. It returns strict JSON
`{verdict: "done" | "continue", reason: "<one sentence>"}`.

- **Verdict `done`** → goal transitions to `done`; the judge's reason
  is appended to evidence alongside yours.
- **Verdict `continue`** → completion is **refused** with reason
  `judge_rejected`. The judge's explanation is appended to the goal's
  evidence and you stay in `active`. Read the reason. Address the
  specific gap. Then call `until_done_complete` again with stronger
  evidence — usually that means actually running the verifyCommand
  and quoting its output, not paraphrasing it.
- **Judge unavailable / unparseable** → fail-open with a warning
  evidence line. The goal completes anyway, but the warning shows in
  `/until-done northstar` so the user knows the verdict was skipped.

You don't call the judge yourself. The extension calls it inside
`until_done_complete`. Your job: cite evidence the judge can read and
verify literally. Quote command output. Reference file paths. Don't
say "tests pass" — say "`bun test` output: 1 pass, 0 fail" with the
literal output.

If the contract uses `sameModelJudge: true`, the same model that's
running you will judge with a fresh context. The judge does NOT see
this conversation, so weak evidence (gestures at "should work")
fails just as hard as it would with a different model.

## Hard rules

- **Never** call `until_done_complete` speculatively. Run
  `verifyCommand` and quote its output as evidence — the judge will
  reject paraphrases and proxy signals.
- **Never** retry `until_done_complete` after a `judge_rejected`
  refusal without addressing the judge's specific gap. Re-running
  with the same evidence will be rejected again.
- **Never** call `until_done_set` during work mode (the contract is
  locked once activated).
- **Never** ignore the "ask before" list. If you're unsure whether a
  command matches, ask the user.
- **Never** disable or talk around the turn budget. If you hit it, the
  loop pauses and the user gets a chance to extend with
  `/until-done budget <n>`.
- **Never** assume the loop is the only thing running. The user can
  interject any time. A normal user message arriving mid-loop is the
  new authority for that turn.
- **Never** claim work that wasn't done. From pi-config: "avoid
  pretending hidden context, tests, or guarantees exist when they have
  not been verified."
- **Never** skip RED. If you find yourself writing production code
  without a failing test, stop and add the test first.

## Diagnostics the user can run

| Command | What it does |
| --- | --- |
| `/until-done status` | One-line current state |
| `/until-done detail` | Full contract overlay |
| `/until-done northstar` | Print the locked contract |
| `/until-done tasks` | Print the live task list |
| `/until-done plan` | Show the path to `.until-done/tasks.yaml` |
| `/until-done replan-log` | Audit log of all replans + reasons |
| `/until-done pause` | Halt continuation, keep state |
| `/until-done resume` | Resume + reset budget |
| `/until-done cancel` | Clear the goal (only way to change North Star) |
| `/until-done budget <n>` | Change turn budget (1..20000) |
| `/until-done judge` | Show the user's session-default judge mode |
| `/until-done judge <provider>/<modelId>` | Set a cross-model judge default |
| `/until-done judge same` | Set same-model self-judge default |
| `/until-done judge clear` | Unset; future setups must specify per goal |

You don't have to surface those — the extension handles them. Stay
focused on the contract.
