# Parked ideas — pi-goal-list-loop-audit

Not scheduled; captured so they survive session compaction. Add freely; promote to a goal when wanted.

## Drafter model setting (noted 2026-07-28, regression-scan contract item 6)

A dedicated **drafter model** — like `auditorModel` but for the drafting/planning path (goal interviews, draft proposal quality, task-list decomposition). Rationale: keep the session model as the cheap default worker, but get better-quality plans/contracts by routing the drafting turns to a stronger model. Would be set in `/glla` (settings menu + `key=value` headless, alongside auditorModel). Open design question: pi extensions can't easily swap the model for selected turns mid-session — needs investigation of what pi's API allows (per-turn model override vs. a drafting subagent with a fixed model, which `subagentModelOverrides` already half-covers).

## Also parked

- Naming-enforcement prompt (rig naming discipline in the continuation prompt — currently only in AGENTS.md)
- `session_start` auto-activate unit test (behavioral harness covers restore-gate branches; the auto-activate path itself is unpinned)
- Negative-grep regression checks scoped to `extensions/` only (convention, not enforced)
- Sub-goal tree — HOLD for v0.29+ (needs a real design pass, not a patch)

- **Auto-resume at `pauseResumeAt`** (parked 2026-07-29, from the v0.28.22
  wait-pause work): a wait-pause declares when it lifts (quota retry, the
  60s flake resume already self-schedule). Extend to AGENT-declared waits
  (e.g. dracon-utilities' janitor "re-check after 06:40 UTC" time-gate):
  a timer that fires /goal resume at resumeAt. Deliberate exception to the
  v0.28.21 "session loads never auto-start" rule — the resume time is
  declared at pause time, not inferred at load. Needs: timer wiring,
  ledger entry, guard against resumeAt-in-the-past storms.

## `/loop polish` — strict audit⇄execute alternation (parked 2026-07-30, user brainstorm)

User: "a feature for the loop — polish or whatever we call it, `/loop polish` — we
basically do an audit round where we find problems, then execution, then audit
again, then exec, and so on; similar to how spec works; not even sure if this
needs a specific rule for it, just bringing it up."

**What already exists:** `/loop audit` (v0.29.0) IS the audit→execute→audit
cycle — every iteration: fresh audit pass (Explore fan-out) → append NEW
findings to `.pi-glla/audit-loop/findings.md` → fix the top open ones → check
the box with the fix commit. Orchestrator counts open boxes as the measure;
plateau stops when the well is dry. The user's idea is ~90% shipped.

**The delta a dedicated `polish` mode would add (three options, in increasing
structure):**

1. **Alias/entry point only** — `/loop polish` as a discoverable pre-wired
   variant of the audit loop with a polish-flavored target (surface quality:
   UX rough edges, copy, consistency, dead UI) instead of the deep-bug
   default. Same findings-file machinery, same plateau. Cheap: one target
   string + command alias.
2. **Strict phase alternation** — even iterations AUDIT ONLY (no fixing),
   odd iterations EXECUTE ONLY (work findings from the previous audit, no
   hunting). Separates find-brain from fix-brain: the audit pass isn't
   contaminated by implementation context, and the fix pass can't go
   scope-hunting. Needs: phase tracking in LoopState, per-phase continuation
   guidance, measure only evaluated after audit phases. Cost: rigidity —
   the organic interleave already works and its plateau is honest.
3. **Verification rounds** — each audit phase first VERIFIES the previous
   phase's fixes (re-check the boxes it claims), catching bad fixes and
   regressions, before hunting new problems. "Clean round" (zero new
   findings + zero failed verifications) is a natural, honest stop signal.
   This is the version most like "how spec works" (implement→audit alternation
   in the spec loop's continuation guidance, goal-loop-forever.ts:386).

**RESOLVED 2026-07-30 (user): `/loop audit` already covers the intent — "that is what i meant."** No new command or rule. Options 2/3 below stay parked as field contingencies only.

~~**Open question**~~ (was the user's own): does it need a specific rule at all?
Option 1 is just docs/discoverability; options 2–3 are real loop-policy
features. Decide when promoted — likely as `/loop polish` = option 1 first,
with 2/3 as flags if the organic interleave proves sloppy in the field.
