# pi-goal-list-loop-audit — design

This document records the architectural choices and why. v0.1.0 decisions are
below; later releases append addenda rather than rewrite history.

## Scope

| Loop | Status |
|---|---|
| Loop 1 (single ordered goal with auditor) | **shipped v0.1.0** |
| Loop 2 (list — many goals in a queue) | **shipped v0.2.0** |
| Loop 3 (loop — metric-driven forever) | **shipped v0.3.0** |
| Completion release (compaction, token guard, branch mode) | **shipped v0.4.0** |

## Addendum v0.2.0 (list + shield + drafting)

- **`/list` queue**: items are full goals (objective + contract). The active
  goal and the queue share one `State`; `setGoal`/`archiveCurrentGoal`
  preserve `state.list` explicitly (an early draft wiped it). Completing a
  list-sourced goal auto-activates the next item (v0.10.0: aborts no longer
  auto-advance — `/list next` and `list_activate` pick explicitly).
- **regression_shield**: the auditor's report must contain an `<evidence>`
  block quoting raw tool output per verification-contract item. Enforcement is
  **orchestrator-side** (`goal-loop-shield.ts`, pure): an `<approved/>`
  without complete evidence becomes a disapproval. This closes the
  "`bash true` rubber-stamp" hole pi-goal-x documented as accepted-risk.
- **Drafting**: `/goal` with no args sends a drafting prompt; the agent
  clarifies, then `propose_goal_draft` opens a real Confirm dialog. Direct
  activation stays available via `/goal "<objective>"`.
- **Inline contract extraction**: one-liner objectives
  (`Create x. Done when: grep -q ok x`) extract the contract — the
  line-start-only extractor silently disarmed the shield on every one-liner.

## Addendum v0.3.0 (metric loop + tasks + notify)

- **Loop 3 is metric-driven, not vibes-driven** (the anti-doorknob law: the
  loop only believes a number). The **orchestrator** runs the user's `measure`
  command after every `agent_end`; the agent never self-reports. Termination:
  plateau (`window` stalls), iteration cap, `/loop stop`. No auditor in
  loop 3 — the metric is the verdict. No git auto-revert: on regression the
  agent is told to undo its own change (safe with uncommitted user work).
- **`propose_task_list`** with anti-drift caps (20 tasks / 5 subtasks) —
  pi-goal-x flaw #4. Confirm dialog before the list is set.
- **`notify=<cmd>`**: fire-and-forget shell-out on goal complete / goal pause /
  loop stop, message as `$1`. Settings parser is quote-aware.

## Addendum v0.5.0–v0.29.6 (current state — the long-session era)

The v0.4.0 addendum closed the scaffold era. v0.5.0 through v0.29.6 are 25+
releases of unattended-rig hardening; the full record is CHANGELOG.md. The
architectural decisions that changed the SHAPE of the system:

- **Self-watchdog is baked in** (v0.5.0): a 15s heartbeat owns liveness —
  supervising + idle + nothing scheduled + 60s quiet → re-fire. External
  liveness plugins are retired.
- **The restore gate** (v0.26.9 tri-state; hardened v0.28.30, v0.29.4): a
  bare `pi` start HOLDS everything and paints it — nothing auto-starts from
  persisted state. In-session reload/fork/compaction continues automatically.
  `autoResume` (on → any session start resumes; off → never) is **global-only**
  (v0.29.5) after a stale per-project opt-in silently overrode the global hold.
- **Drafts and restores are decoupled** (v0.29.4): `autoAcceptDrafts` is the
  pre-consent for in-session drafts — they START immediately — and for the
  generated finding batch at the end of `/list audit`. Direct bulk imports
  remain Confirm-gated. `autoResume` gates only launch-time restore. "The
  session auto-starts in some cases ok; launching pi must not."
- **User aborts mean STOP** (v0.29.4/0.29.5): an aborted turn is exempt from
  stall accounting, stands the chain down with no auto re-fire, and the
  stand-down gates the heartbeat + post-compaction refires. The 5-abort loud
  pause is the backstop.
- **One active thing, auto-arbitrated** (v0.28.21 guards; v0.29.6 load-time
  arbitration): at most one live artifact. Dirty stacked states at load are
  resolved deterministically — most recent activity keeps the slot, the loser
  is archived (recoverable), no picker. `/glla wipe` (v0.28.31) is the manual,
  Confirm-gated clean slate.
- **The completion lifecycle owns its pauses** (v0.29.1): storm/stall
  escalation never pauses `auditing` goals; a stranded `auditing` state (no
  live auditor; lifecycle rebinds retry stored claims immediately (the 90s
  heartbeat path is only a fallback); send/pause/notify storms
  rearm once per cycle; the provider-error brake (v0.28.13) keeps cross-cycle
  memory and parks after 6 consecutive errors.
- **The audit loop is the project reviewer** (v0.29.0): `/loop audit` runs
  fresh audit passes every iteration, appends findings to
  `.pi-glla/audit-loop/findings.md`, fixes the top open ones; the orchestrator
  counts open boxes as the measure and the plateau stop ends it. The
  reviewer's reflexive fire-audit-on-clean cascade is opt-in (it paid for
  verification twice and was hydra fuel).
- **Git discipline is prompt-law** (v0.29.2): continuation/draft prompts
  forbid inventing git identities or branches (field incidents: agents
  committing as `phase-e-agent <phase-e@local>`).
- **Reviewer = strategist, not verifier** (v0.24.6–v0.29.0): the reviewer
  scans sources and proposes list items through the standard drafting +
  Confirm path; it never audits work — the isolated auditor is the only
  verifier.

## Addendum v0.34.16 (lifecycle handoff)

- **Recovery crosses pi's lifecycle, never the terminal**: `session_shutdown`
  persists fresh same-process continuation debt in
  `.pi-glla/session-handoff.json`, records the shutdown reason, and clears all
  session-owned timers. A fresh `session_start` consumes matching debt and
  continues from its new context. No stale callback is allowed to use the old
  `ctx` or `pi` reference.
- **Quit is not implicit resume consent**: a shutdown with `reason: "quit"`
  removes any handoff debt, records `session_handoff_suppressed`, and marks
  the owner sidecar so the next same-pid startup is not mistaken for a
  replacement rebind. The global `autoResume` policy remains independent and
  explicit.
- **True orphans stay honest**: once pi invalidates an extension without a
  fresh lifecycle event, the extension cannot repair its host. glla stops
  stale work, preserves the artifact, and tells the user to restart pi only
  when no replacement arrives. `autoReloadOnStale` and `autoRecovery` remain
  deprecated deserialization compatibility fields; they do not select a
  transport.

## Addendum v0.34.21 (completion-audit lifecycle observability)

- **The durable claim owns recovery state**: `pendingCompletion.phase` is
  `running`, `recovery-pending`, or `quota-waiting`. Missing phase is legacy
  state and is treated as recovery-pending after a fresh lifecycle event.
  The isolated attempt id and wall deadline prevent an old generation from
  finalizing a newer attempt.
- **Rebind recovery is immediate but consent-aware**: a replacement
  `session_start` converts an old running claim to recovery-pending and
  retries it immediately when the lifecycle handoff or global `autoResume`
  supplies consent. A cold startup with autoResume off paints the pending
  claim and waits for `/goal resume`.
- **Auditor bounds have two layers**: no-event inactivity aborts after 10m
  only when no read-only tool is active; a live verification tool may finish,
  but the complete isolated run has a 30m wall-clock cap. Both outcomes are
  infrastructure failures, never verdicts, and the stored claim remains
  retryable.

## Addendum v0.34.22 (detached completion auditor)

- **Completion verification is process-isolated, not nested**: `complete_goal`
  persists the claim and job request, then returns immediately. A detached
  extension-less worker launches `pi --mode rpc` with only `read`, `grep`,
  `find`, `ls`, and `bash`; it never receives the parent `ExtensionContext`,
  never loads glla extensions or project context files, and never writes goal
  state. This removes the previous nested `AgentSession` from the main pi
  process and prevents a provider stall in the auditor from occupying the
  executor's turn.
- **Durable job protocol**: request, progress, lock, and result files live
  under `.pi-glla/audit-jobs/<attemptId>/`. Requests and results are hashed and
  atomically written. The parent validates attempt/request identity, verdict
  markers, read-tool use, and `regression_shield` before applying any result.
  A result from a stale generation is ignored; fresh lifecycle recovery creates
  a new attempt. Cancellation clears the pending claim and best-effort stops
  the worker.
- **Truthful asynchronous UI**: `auditor queued`, `auditor running`, and
  `audit recovery pending` are distinct. The main session can continue
  rendering and accepting input while the worker audits; completion/archive or
  disapproval/continuation happens only after durable result consumption.
- **Bounded worker liveness**: no session event for 10 minutes while no
  read-only tool is active aborts the worker; a 30-minute wall-clock bound
  always wins. Both are infrastructure failures, never verdicts, and the claim
  remains retryable.

## Addendum v0.34.24 (dispatch proof and display projection safety)

- **Accepted is not started**: every automated follow-up records a versioned,
  generation/owner-bound dispatch in `.pi-glla/continuation-dispatch.json`
  before calling `sendMessage({ triggerTurn: true })`. `before_agent_start`
  with the matching marker is the strongest proof; compatible low-level start
  events are accepted for older pi builds. The sidecar is cleared only after
  proof or an explicit terminal send outcome.
- **No blind trigger storm**: an accepted dispatch has one bounded start-proof
  timer. If no start event arrives, glla records an unresolved dispatch, keeps
  the goal/list item durable, stands down automatic sends, and tells the user
  how to use a fresh lifecycle or explicit resume. It does not inject terminal
  input, restart pi, or treat a successful API return as a turn.
- **Generation-safe recovery**: replacement/shutdown clears in-memory pending
  state; a new session records and clears any old sidecar, then the existing
  restore/autoResume consent rules decide whether to retry. Late foreign or
  old-generation events cannot acknowledge a new dispatch.
- **Display-only sanitization**: terminal/ANSI/OSC, bidi, and zero-width
  controls are removed from status, widget, notification, confirmation, and
  status-tool projections. Persisted objectives, contracts, prompts, ledger
  values, and auditor inputs remain unchanged.

## Addendum v0.34.31 (main-session model recovery)

- **Ordered global backups**: `mainModelFallbacks` is an explicit ordered list
  of `provider/model` references. A provider/quota error can rotate the MAIN
  session through authenticated candidates; the detached auditor's model
  cascade remains a separate subsystem.
- **No accepted-send inference**: model rotation occurs only after a provider
  failure is observed (or after a 15-minute, five-minute-silent provider-held
  retry storm). A successful `sendMessage()` return is never treated as a
  started turn.
- **Durable recovery instead of abandonment**: when all candidates fail,
  `.pi-glla/active.jsonl` stores the primary, active candidate, attempted set,
  retry time, and supervisor kind. Recovery probes back off 15m → 30m →
  hourly forever (configurable base), while a paused goal/held loop remains
  resumable. A fresh startup obeys the existing `autoResume` consent gate.
- **Successful-turn reset**: a real non-error agent end clears the recovery
  cycle. Manual model selection cancels it; goal/list/loop cancellation clears
  its timer and durable state.

## Addendum v0.34.57 (quota walls engage recovery fast)

- **Knowledge-window escalation**: a surfaced long-lived failure (quota /
  billing / auth) records a 30-minute knowledge window. A send-rearm storm
  inside that window escalates into the recovery envelope after 3 minutes of
  failed sends (plus the unchanged 5-minute activity silence gate) instead of
  the generic 15 minutes — a wedge right after a quota wall is almost always
  the same wall, and blind re-sends into it are pure waste.
- **Transient failures stay fast**: 5xx/stream/network failures are
  short-lived by definition and never record the knowledge signal; they keep
  the 5s→3m error ladder and the pi-core retry budget.
- **Armed by configuration**: the envelope is inert without
  `mainModelFallbacks` (rotation) — an empty list means "park and probe the
  same model" instead of switching pools.

## Addendum v0.4.0 (completion)

- **Auditor compaction enabled** (flaw #3 — the last open one). Safety:
  the shield is orchestrator-side, so compaction can only weaken the
  auditor's evidence → disapproval, never a false approval.
- **Token guard**: real accumulation from assistant-message `usage.totalTokens`
  (deduped across replayed `agent_end` history). Crossing `tokenlimit`
  (opt-in; off by default since v0.12.0) pauses the goal with a clear reason.
- **Loop 3 `branch=1`**: scratch branch `pi-glla-loop/<ts>-<slug>`; commit per
  improvement, `git reset --hard` per regression — scratch branch only.
  Refuses non-git dirs and dirty trees; returns to the original branch on
  stop with merge instructions.
- **Resumption notice** on `session_start` (replaces the impossible
  "plugin vanished" self-check: absent code cannot run).

## Scope of v0.1.0 (original)

Single loop only — **loop 1**, the single ordered goal.

**Why ship loop 1 first**: the user asked for it, it's the highest-value loop, and getting the auditor + drafting right matters more than breadth.

## Architectural decisions

### Decision 1: Anti-bamboozle via isolated auditor

The single most important property of this plugin is that the implementing agent cannot bamboozle the verifier. The way to achieve this structurally:

1. The auditor runs in a **detached pi RPC process with a fresh agent session**.
2. The auditor has **no extensions, no skills, no prompts, no themes, and no context files**.
3. The auditor has only **read-only tools**: `read`, `grep`, `find`, `ls`, `bash` (and `bash` is for re-running user's verifier scripts, not arbitrary).
4. The auditor **cannot see the implementing conversation or mutate glla state**.

This is borrowed directly from `pi-goal-x/extensions/goal-auditor.ts:148-156`. The pattern is sound; we don't improve on it in v0.1.0, we just **fork the proven source and add regression_shield**.

### Decision 2: regression_shield in v0.2.0

v0.1.0 ships the same auditor behaviour as pi-goal-x. The author of pi-goal-x documented an honest caveat (verbatim):

> "the guarantee is deliberately just 'the auditor ran at least one successful tool', not 'it inspected the right content': there is no cheap, honest way to tell a requirement-relevant `read` from `bash true`, an empty `grep`, or a read of an executor-planted file."

We accept this caveat for v0.1.0. v0.2.0 will add **regression_shield**: an explicit requirement that the auditor's report must include raw output (a `cat`, a `grep -A 5 <file>`, a `bash <user-script>`) for every item in `verificationContract`. Without that evidence, the auditor's `<approved/>` is rejected by the orchestrator.

### Decision 3: Hard 5-minute backoff cap

The #1 complaint about pi-goal-x in our audit (user-stated) was "1-hour waits". The cause is exponential backoff with no ceiling.

v0.1.0 ships a hard 5-minute cap. After 5 minutes of consecutive backoff:
1. TUI badge turns red with "Last activity: 5m+".
2. User can press `r` to force-continue or `s` to skip to next pending task.
3. Optional: configure Telegram/web push notification.

### Decision 4: No drafting phase in v0.1.0 (deferred to v0.2.0)

The user identified vague-correction as a key strength of pi-goal-x. But shipping it in v0.1.0 doubles the scope and we won't get the auditor right if we split focus.

v0.1.0 ships `/goal "<objective>"` only — same UX as pi-goal-x's `/goal-set`. v0.2.0 adds the drafting protocol with structured `goal_questionnaire` widget.

This is a deliberate trade-off. If the user wants drafting in v0.1.0, say so and I'll prioritise.

### Decision 5: One package per loop (not three packages)

Some alternatives considered:
- Three packages: `pi-goal-list-loop-audit`, `pi-goal-list-loop-audit-list`, `pi-goal-list-loop-audit-loop`.
- One package with three subcommands: `/goal`, `/list`, `/loop`.

We choose **one package with subcommands**. Reasoning:
- Single install (`pi install npm:pi-goal-list-loop-audit`).
- All three loops share state machine, schemas, scaffolding.
- v0.1.0 only ships loop 1, but the package already declares loop 2 and loop 3 as `pi.commands` so users see what is coming.

### Decision 6: Forks pi-goal-x rather than reimplements

Why not write from scratch?
- The auditor pattern is sound and small (one function: `runGoalCompletionAuditor`).
- The drafting phase logic is sound and small.
- The continuation loop is sound and small.
- The compaction discipline is battle-tested.

We fork pi-goal-x 0.19.0 source. We then **simplify by removing the broken parts** (markdown summaries, unbounded backoff) and **clean the seams** (split the single `goal.ts` file into per-loop files).

This is a **clean break** by decision of the user. We do not interop with `pi-goal-x`'s `.pi/goals/` directory.

### Decision 7: Per-loop file split (superseded)

> **Superseded by consolidation (v0.8.0).** The planned per-loop files below
> never shipped: loops 1+2 live together in `extensions/loops/goal.ts`
> (one state machine, one loop driver), loop 3's helpers in
> `extensions/loops/forever.ts`, rendering in `goal-loop-display.ts`,
> drafting inline in `goal.ts` + `prompts/`. Kept for history.

| File | Purpose | Lines |
|---|---|---|
| `extensions/loops/goal.ts` | Loops 1+2 (single goal + list of goals) | shipped |
| `extensions/loops/forever.ts` | Loop 3 (metric loop helpers) | shipped |
| `extensions/goal-loop-core.ts` | Shared state machine, types, JSONL | shipped |
| `extensions/goal-loop-auditor.ts` | Auditor prompt + compatibility helper | shipped |
| `extensions/goal-loop-auditor-process.ts` | Detached worker protocol, IPC, and shield revalidation | shipped |
| `scripts/goal-auditor-worker.mjs` | Extension-less RPC auditor child | shipped |
| `extensions/goal-loop-display.ts` | Status line + /goal status rendering | shipped |
| `prompts/goal-loop-continuation.md` | Templated continuation prompt | ~80 |
| `prompts/goal-loop-auditor.md` | Templated auditor prompt | ~80 |
| `prompts/goal-loop-draft.md` | Templated drafting prompt | v0.2.0 |
| `schemas/goal.schema.json` | JSON Schema for goal state | ~50 |

### Decision 8: Status machine

```ts
type Status =
  | "drafting"        // v0.2.0
  | "active"
  | "auditing"
  | "complete"
  | "paused"
  | "aborted";
```

States owned by the orchestrator:
- `active` → next iteration
- `auditing` → detached auditor queued/running (or recovery pending)
- `complete` → archived
- `paused` → user-resumable
- `aborted` → user-cancelled

Transitions:
```
drafting → active          (user confirms draft)
active → active            (continue work)
active → auditing          (complete_goal called)
auditing → complete        (auditor <approved/>)
auditing → active          (auditor <disapproved/>; reset iteration counter)
active → paused            (pause_goal called, or stuck > 5 min, or empty turn)
paused → active            (user /goal resume)
active → aborted           (user /goal cancel)
```

### Decision 9: JSONL state (deterministic compaction)

Goal state lives in `.pi-glla/active.jsonl`. Each line is a state transition. On compaction, the summary is rebuilt deterministically from the JSONL (autoresearch pattern).

This protects against model-generated summaries losing fidelity.

### Decision 10: Hard pause + escape hatches

| Trigger | Action |
|---|---|
| Detached auditor running | Main turn remains free; `/goal cancel` discards the pending claim and stops the worker best-effort |
| `Esc` during agent turn | Pause |
| User `/goal pause` | Pause |
| User `/goal cancel` | Abort (wipes active goal) |
| Stall watchdog (3 consecutive no-tool turns) | Pause + notify |
| Empty turn (no tool calls) | Pause (no momentum) |

## Open follow-ups (post-v0.1.0)

| Priority | Item | When |
|---|---|---|
| HIGH | Drafting phase with structured Q&A | v0.2.0 |
| HIGH | regression_shield for auditor | v0.2.0 |
| MEDIUM | Native TUI form widget | v0.2.0 |
| MEDIUM | Loop 2 (list) | v0.2.0 |
| MEDIUM | Loop 3 (loop) | v0.3.0 |
| LOW | Telegram push | v0.3.0 |
| LOW | Sub-task auto-close | v0.3.0 |

## Files

- `docs/DESIGN.md` — **this file**
- `README.md` — quickstart
- `audit/pi-name-v3-registry-based.md` — naming rationale
- `audit/pi-goal-loop-design.md` — earlier design (now superseded)
