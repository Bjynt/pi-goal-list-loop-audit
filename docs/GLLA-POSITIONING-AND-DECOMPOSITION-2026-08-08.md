# GLLA Positioning & goal.ts Decomposition — 2026-08-08

status: draft — strategy + refactor direction, not yet an implementation plan
verification: competitor source pulled to `.research/src-*` (npm tarballs, 2026-08-08); line counts below are from those tarballs and from `wc -l` on this repo; suite 1142 pass / 1 skip / 0 fail.

## 1. The external feedback

Two independent AI code-reviews of the pi.dev goal-extension ecosystem
(ChatGPT share 6a7767d3, Qwen share c724bf2d) both ranked us top-3, with
a nearly identical verdict:

- **ChatGPT (source-read pass):** GLLA #1 overall, 9.1/10 — completion
  integrity **9.8/10** (best in ecosystem), code quality **7.5/10**
  (lowest among leaders). Quote: *"Best verification architecture, worst
  maintainability among the leaders."* pi-goal-x #2 (8.9), @narumitw/pi-goal
  #3 (8.7), pi-codex-goal #4 (8.5).
- **Qwen (source-read pass):** GLLA #3 ("The Most Hardcore 'Survival'
  Hacking") — *"a monolithic beast... trades code elegance for sheer
  brute-force reliability."* pi-goal-x #1, pi-codex-goal #2.

Both cited the same primary defect: **`extensions/loops/goal.ts` is
~11,000 lines** (10,343 in the published 0.34.80 tarball; ~10,500 today).
Both said the completion/auditor machinery is the hardest in the
ecosystem to fool, and both praised: approval vs infra-failure vs
no-verdict separation; `<approved/>`-without-inspection-tool →
disapproval; orchestrator-side regression shield; watchdogs; auditor
compaction strategy; pause-not-approve on auditor failure.

## 2. Positioning — what we are, deliberately

Our stance: **maximum leverage and quality over elegance.** The
monolith is partly a cost of shipping 70+ versions in ~3 weeks with a
detached-auditor loop, but it is also a deliberate trade:

- We integrate machinery no other goal plugin has:
  - **Detached, extension-less auditor** (subagent/process) with raw
    evidence requirements — verified by reviewers as the strongest
    completion gate in the ecosystem.
  - **pi-subagents integration** (9 source files mention subagents) —
    hang detection (v0.34.85/102/105), session ledger (v0.34.71),
    background work. **No other goal plugin does this** — pi-goal-x:
    zero subagent code; pi-codex-goal / pi-until-done: zero; narumitw:
    comments only; pi-better-goal: pid-based runs, no pi-subagents.
    Subagents were the original inspiration for this project.
  - Main-model quota recovery, hourly probes, forbidden-model gate,
    zombie-twin session handoff, continuation dispatch sidecar,
    regression shield, list queue with auto-advance, /loop metric &
    spec loops, review/confirm machinery.
- pi-goal-x is our closest competitor (thin installer, 30 modules,
  ledger-driven, clean UI model). Note: pi-goal-x went quiet for ~a
  month after we started (we saw it frozen), but it resumed — 0.26.0
  Aug 7, 0.26.1 Aug 8, 2026. **They are active again; the race is on.**
- Our release gap is a real operational issue: npm `latest` is 0.34.80
  while the repo is 0.34.105. Reviewers noticed ("pi.dev showing
  0.34.80, repo already 0.34.103"). Publishing cadence is a separate
  decision, but the mismatch is visible externally.

## 3. What competitors do better — the steal list

| Capability | Who | Why it matters | Steal? |
|---|---|---|---|
| Thin installer + 30 small modules | pi-goal-x | `goal.ts` entry is ~30 lines; every concern in its own file | **YES — this is our refactor target** |
| Ledger-driven state (goal-ledger.ts) | pi-goal-x | every transition emits to JSONL ledger; state mutation is replayable | Partially — we have active.jsonl ledger already; study their event shape |
| Native pi state via customEntries | pi-codex-goal | goals follow resume/fork/compaction naturally; no parallel DB | Maybe — our .pi-glla files are deliberately inspectable; customEntries is opaque to the user. Trade-off doc'd below |
| Stale-queued-work guard modules | pi-codex-goal | dedicated modules (stale-queued-work-reducer.ts, -obligations.ts) kill ghost continuations after compaction | We have generation-bound dispatch sidecar; compare semantics |
| Recovery state machine as own module | pi-codex-goal | recovery-machine.ts / recovery-phase.ts / recovery-runtime.ts | We have main-model-recovery.ts (pure) + goal.ts wiring; **extract the wiring** |
| ≤200 lines/file structural constraint | pi-until-done | CI-enforced; forces decomposition | Not literally (we're 10k lines) — but as a north star for the refactor |
| Verdict parser: only final non-empty line counts as approval | pi-goal-x | prevents prose "I would output <approved/> if…" from passing | Check our parser for the same property |
| Auditor failure keeps goal open | pi-goal-x | failure/rejection does not close the goal; executor can continue | We pause-on-infra-failure; compare UX |

**What NOT to steal:**
- pi-until-done's **fail-open judge** (`verdict === "continue"` → reject,
  everything else → complete) — both reviewers flagged this as a defect.
  Our audit state machine stays fail-closed: approval requires positive
  evidence.
- pi-codex-goal's weaker independent verification (no detached auditor) —
  our core differentiator stays.

## 4. The refactor: decompose goal.ts (the plan skeleton)

Current state: `extensions/loops/goal.ts` ≈ 10.5K lines, 189 top-level
functions, covering at least these domains (grep counts):

```
continuation 190 · recovery 209 · auditor 221 · loop 631 · subagent 103
watchdog 43 · ledger 73 · heartbeat 97 · display 75
```

Note: the file is *already* one level decomposed — display, core,
auditor-process, settings, shield, reviewer, dispatch, backoff,
repetition, forever, subagents already live in sibling modules. The
remaining monolith is the *orchestrator itself*: state, continuation
state machine, watchdog timers, command handlers, event handlers,
tool registration, recovery wiring, heartbeat, drafting, list queue.

### Target module map (draft)

```
extensions/loops/
  goal.ts                     → thin installer (~300-500 lines): activate(),
                                event→handler wiring, tool registration,
                                command registration
  goal-state.ts               → state shape, load/persist, mutations,
                                revision bumps (moved from goal.ts)
  goal-continuation.ts        → scheduleContinuation/sendContinuation,
                                dispatch sidecar, rearm, stand-downs,
                                continuation watchdog (v0.34.88/104)
  goal-recovery.ts            → main-model recovery wiring (uses pure
                                main-model-recovery.ts), hourly probe,
                                forbidden gate, parking, restart restore
  goal-heartbeat.ts           → heartbeatTick + all watchdogs (stale,
                                orphan, zombie, subagent hang v0.34.85/105,
                                stranded audit, unanswered continuation)
  goal-watchdogs.ts           → (or fold into heartbeat; keep ≤2 files)
  goal-subagents.ts           → already exists (subagent-session ledger,
                                hang probes) — pull remaining bits out
  goal-commands.ts            → /goal /list /loop command handlers
  goal-tools.ts               → complete_goal + other tool registrations
  goal-auditor-hooks.ts       → beginCompletionAudit, verdict apply,
                                regression shield calls
  goal-list-queue.ts          → list.jsonl ops, auto-advance, settle
                                window (v0.34.104)
```

### Invariants for the refactor (non-negotiable)

1. **Zero behavior change.** The 1142-test suite (incl. literal source
   pins) is the safety net; every extraction keeps tests green without
   editing test expectations (except import-path rewrites).
2. **Single mutable state object** stays owned by one module
   (`goal-state.ts`) — module boundaries must not create a second
   source of truth. Cross-module communication via function imports,
   not a new event bus (unless the extraction is impossible otherwise).
3. **Module-level mutable flags stay in the module that owns them.**
   No flag duplication across files (the v0.34.104 settle flag and
   v0.34.105 scan-ordering bug showed exactly how fragile these are).
4. **The completion path (executor → audit → regression shield →
   verdict apply) stays the most-reviewed code in the repo.** It gets
   extracted last, and with dedicated tests per extraction step.
5. **No behavior-dependent literals in module headers** — the audit
   docs' `verification:` markers and test-name literals (contract
   compliance) bind the *tests*, not the module layout.
6. **Ledger event names unchanged** (`appendLedger` keys are a public
   contract for forensics; moving call sites must not rename events).

### Sequencing (each step ships as its own version)

1. Extract `goal-state.ts` (state shape + persistence) — lowest risk,
   highest clarity gain. Tests: existing + new source-pin updates.
2. Extract `goal-commands.ts` (pure command handlers) — mechanical.
3. Extract `goal-recovery.ts` wiring — moves ~200 recovery references.
4. Extract `goal-heartbeat.ts` — the watchdog cluster; includes the
   subagent-hang scan (recently fixed — pin it first).
5. Extract `goal-continuation.ts` — the trickiest (timer ownership,
   dispatch sidecar); do last-ish.
6. Thin `goal.ts` installer last, when everything is proven stable.
7. Re-run full suite + tsc + a live-session smoke (goal → audit →
   complete) before each tag.

### Explicit non-goals

- NOT converting state to pi customEntries (we keep .pi-glla files:
  user-inspectable, greppable, diffable — reviewers noted our
  persistence as inspectable; the parallel-DB criticism is valid but
  the trade favors us for a project whose whole point is auditable
  honesty).
- NOT adding a second event bus or reactive framework.
- NOT splitting every file to ≤200 lines (pi-until-done's constraint) —
  target ≤2,000 lines/file, single-purpose modules.

## 5. Open questions / decisions needed

1. **Release cadence**: publish 0.34.81→0.34.105 to npm now (the gap is
   externally visible and pi-goal-x is shipping daily again), or after
   the refactor's step 1-2?
2. **Refactor priority**: decomposition first, or release + a couple of
   high-value steaples (pi-goal-x verdict-parser hardening, auditor
   fail-open check) first?
3. **Subagent story**: should the subagent integration get promoted
   (docs/README: "the goal loop with subagent supervision") as our
   public differentiator?
4. Scope of this doc's next iteration: turn §4 into a per-module
   extraction checklist with concrete function inventories.

## 6. Appendix — competitor source inventory (pulled 2026-08-08)

```
pi-goal-x 0.26.1      extensions/goal.ts thin; 30+ modules (state 1038,
                      service 762, questionnaire 746, dashboard 657,
                      events 476, auditor 469, ledger 465, completion 414)
@narumitw/pi-goal
  0.49.7              main goal.ts 49 lines; runtime.ts 1278, lifecycle
                      673, state 603, run-protocol 380, service 310,
                      verification 255; dedicated test suites per concern
pi-codex-goal 0.2.0   state.ts 443, stale-queued-work-reducer 416,
                      goal-transition 402, obligations 269, continuation
                      scheduler 255, recovery-machine 199; customEntries
                      persistence
pi-until-done 0.3.1   ~196-line max files; event-sourced custom entries;
                      judge fail-open (decideJudge "unavailable" →
                      completeWithApproval) — the flagged defect
pi-dgoal 0.8.1        runtime/index.ts 6,471 lines (same monolith disease);
                      task/phase/goal plan tiers
pi-better-goal 0.1.17 index.ts 665; pid-based subagent runs (not
                      pi-subagents); background-aware continuation
@misunders2d/pi-goal
  1.0.19              index.ts 1,943; authority/capability model for bash
                      (metachar rejection, path boundaries, typed authority)
@zhushanwen/pi-goal
  0.7.0               未评分 by ChatGPT (no repo link on pi.dev); not pulled
```

Subagent support matrix (grep -ril subagent on non-test source):
GLLA **9 files** · pi-better-goal 2 (own pid model) · narumitw 2
(comments only) · pi-dgoal 1 (comment) · pi-goal-x 0 · pi-codex-goal 0 ·
pi-until-done 0.
