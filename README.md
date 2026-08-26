# pi-goal-list-loop-audit

> **Long-running, high-leverage autonomy for pi.**
>
> Give pi a meaningful outcome. GLLA helps it research, plan, execute,
> recover, and prove the result over hours or days instead of treating one
> chat turn as the whole job.

`pi-goal-list-loop-audit` (GLLA) is mission control for autonomous work in
[pi](https://github.com/badlogic/pi-mono). It is for the work that is too broad,
too long, or too important to leave to a single uninterrupted prompt:
repo-wide changes, migrations, audits, research, documentation overhauls,
large refactors, and continuous improvement.

GLLA does not promise that an agent can never make a mistake. It makes the
agent's work **more effective, durable, recoverable, and difficult to declare
finished without evidence**:

- You state the outcome and what “done” means.
- The agent researches, decomposes, and executes across many turns.
- GLLA keeps durable state, supervises progress, and recovers bounded failures.
- Optional subagents can do parallel research and focused implementation work.
- A separate detached auditor checks the saved completion claim before GLLA
  accepts it.

The aim is not “run forever.” The aim is **more useful work per unit of
attention, with better evidence at the end**.

**Current package version:** `v0.37.0` — use `/glla version` to see the installed version and the command for comparing it with the registry latest. This checkout may contain unreleased changes; the npm registry is authoritative for published versions.

## Is GLLA the right tool?

Use GLLA when the work benefits from an autonomous operator that can keep
context, make progress without a prompt after every step, and return with an
evidence-backed result:

- a feature that spans several files or subsystems;
- a migration, security review, or repository audit;
- research followed by implementation;
- a documentation or test-quality overhaul;
- a backlog of independently verifiable changes;
- an improvement process that should run until a metric, specification, or
  audit cadence says to stop.

Use ordinary pi for a one-line edit, a quick question, or work where you want
to supervise every action manually. GLLA is a **supervisor for high-level
outcomes**, not a replacement for judgment or a reason to remove a human from
important decisions.

## Install

Install GLLA into pi:

Install:

```bash
pi install npm:pi-goal-list-loop-audit
```

For the intended interview and confirmation experience, also install the
structured-question companion:

```bash
pi install npm:@juicesharp/rpiv-ask-user-question
```

If pi was already open, run `/reload` in that session. GLLA works without the
question companion through plain-text fallbacks, but structured questions are
the recommended experience.

## Your first goal

Start pi in the project you want it to work on, then give it an outcome with a
verifiable finish line:

```text
/goal "Improve the login flow.

Done when:
- failed logins return a useful, safe error;
- the relevant tests cover the new behavior and pass;
- the change is documented and committed."
```

The contract is the important part. Replace the example with the result you
actually want and checks that another person—or another agent—could inspect.

For an objective that needs shaping, start with bare `/goal` and answer the
interview. GLLA will research the ambiguity, ask focused questions, and show a
Confirm dialog before activation. A complete `Done when:` clause starts
immediately. `/goal start "..."` is the explicit shortcut when skipping the
interview is intentional.

### What happens next

1. **Intake:** GLLA preserves the objective and its verification contract.
2. **Research and planning:** the agent can inspect the repository, ask for
   decisions that materially change scope, and propose bounded tasks.
3. **Execution:** the main pi session keeps working after each agent turn;
   optional subagents can handle parallel, focused work.
4. **Durability:** goals, queue items, progress, pauses, retries, and audit
   claims are written to inspectable state on disk.
5. **Recovery:** provider failures, silent turns, session replacement, and
   frozen workers are handled through bounded, visible recovery paths.
6. **Verification:** `complete_goal` saves a claim, runs mechanical checks, and
   queues a detached auditor. The goal archives only after the auditor accepts
   evidence for the contract.

The status widget and `/glla status` show whether work is active, queued,
paused, recovering, auditing, or waiting for an explicit decision. Silence is
not presented as progress.

## Choose the work surface

GLLA has three work shapes. Pick the one that matches the outcome rather than
forcing every problem into a loop.

| Surface | Use it for | Completion model |
|---|---|---|
| `/goal` | One meaningful outcome: feature, fix, audit, migration, research, or docs | The saved `Done when:` contract is independently audited |
| `/list` | Several outcomes or a backlog of independently verifiable items | Each item is worked and audited separately; the queue advances safely |
| `/loop` | Ongoing improvement with no single final item | A metric, specification, audit cadence, bound, or `/loop stop` ends the process |

### `/goal` — one outcome

```text
/goal                                      # interview + Confirm
/goal "... Done when: ..."                 # direct contract start
/goal start "..."                          # explicit no-interview start
/goal plan "..."                           # research-first extended plan
/goal status                               # inspect the current goal
/goal pause                                # pause automatic continuation
/goal resume                               # explicitly resume
/goal verify                               # audit the current claim now
/goal tweak "..."                          # revise the objective with Confirm
/goal cancel                               # cancel the active goal
```

A goal is the best default for work with a finish line. If the agent discovers
that the objective is too large, it can propose a bounded task plan instead of
quietly inventing an unbounded backlog.

### `/list` — a durable work pool

```text
/list "fix the cache. Done when: tests pass"
/list plan.md                              # import a checklist or plan file
/list                                     # show active and waiting items
/list next                                 # intentionally activate the next item
/list next <n>                             # choose a specific item
/list resume                               # explicitly retry/resume the list
/list remove <n>
/list clear
/list cancel                               # stop the active item and drop waiting items
```

Order is the default, not the law. Automatic advance normally uses the head of
the queue, while `/list next <n>` or the agent's `list_activate` tool can choose
another item. Numbering always matches `/list` output.

If a saved item is malformed or needs a repair, the repair card preserves the
full original target, explains the concrete recovery action, and permits one
bounded bootstrap turn containing `propose_task_list`. Confirm the redraft;
automatic repeats are fenced. Use `/list resume` for an intentional retry and
`/list next` when you intentionally want another queued item.

### `/loop` — an improvement process

**Zero-stream zombie abort + one bounded auto-retry (v0.35.17).** When pi stays
BUSY with zero provider stream activity for 20 minutes, glla warns; after a
10-minute grace it aborts the zombie turn and parks the work safely. Since
v0.35.17 the FIRST such silence arms exactly ONE automatic retry ~90 seconds
later (the park becomes a waystation, not a dead end — field: turns dispatched
by accepting Confirm dialogs hung this way repeatedly). If the retry also hangs,
the second consecutive silence parks permanently for manual `/goal resume` /
`/list resume`. `/glla pause` freezes the retry like every other automatic
side-effect.

## Session replacement and stale handles

Recovery crosses pi's lifecycle boundary. On `session_shutdown`, glla records
`.pi-glla/session-handoff.json` for a supervising, non-quit replacement,
ledgering the reason and stopping every session-owned timer. On the fresh
`session_start`, the new context consumes only fresh, same-process debt and
continues the saved goal or loop. Timers resolve a fresh context when they fire;
they do not retain an old `ctx` or `pi` handle.

A user quit is not continuation consent: `reason: "quit"` is ledgered as
`session_handoff_suppressed`, leaves no handoff debt, and does not receive
same-pid rebind consent. An orphan with no fresh lifecycle event is reported
honestly because an invalidated extension cannot repair its own pi host; use
`/new` (or restart pi normally) and let the saved `.pi-glla/` state restore.
`/reload` does not clear pi's cached context, and event handlers cannot create a
replacement session through the public pi API, so glla never claims automatic
stale-session replacement. There are no automatic `/reload` keystrokes and no
mux dependency. The legacy `autoReloadOnStale` and `autoRecovery` fields remain
only as deprecated settings-file compatibility fields; they are ignored.

**A stale handle never mutates** (v0.34.51–v0.34.54): every `/list` mutation
(add/remove/next/clear/cancel) and the bare `/glla` settings surface probe at
entry and refuse with the standard recovery message on a stale extension
context — a session that cannot announce or run its writes must not make them.
Mutating `/glla` actions (wipe/cancel/reviewer/postaudit/tooloverride) leave a
`settings_mutation_refused_stale` ledger trail; read-only surfaces (`/list
show`, `/goal status`) stay usable with the warning. Once the replacement
`session_start` arrives, both surfaces render cleanly with no stale residue
(the lifecycle-recovery harness proves the two-phase contract).

**User aborts mean STOP** (v0.29.4): Esc-aborting a turn stands the chain
down with a named notify (`/goal resume` to continue) — it does NOT count
toward stall warnings, does NOT auto re-fire, and the stand-down survives
the heartbeat (v0.29.5). Five consecutive aborts still pause loudly as a
backstop. A queued steer interrupt (`length`/`toolResult` races) is not an
abort and resumes normally.

## One active thing (confirmed replacement)

At most one goal/list-item/loop owns the active slot. A new same-mode start
never silently overwrites it: the user chooses **Update current objective**,
**Replace current objective**, or **Cancel new objective**. Cross-mode starts
offer explicit replacement/cancellation rather than silently converting a goal
into a loop (or vice versa). The queued list is a backlog, not a second live
thing. In headless mode, glla fails closed and asks you to resolve the existing
objective explicitly instead of guessing.

Session loads still repair dirty legacy state: if a pre-guard project persisted
a live loop AND a live goal, the most recent artifact keeps the slot and the
loser is archived (recoverable under `.pi-glla/archive/`), never silently
wiped. Legacy `complete`/`aborted` terminal slots are also cleared once their
archive exists, while the final summary remains available in history.

### Load without autostart (v0.35.23)

On startup glla RESTORES and DISPLAYS all durable state — active/paused
goal, waiting queue, loop — but holds every automatic dispatch until you
decide. The load hold freezes the same machinery as `/glla pause`
(continuation dispatch, loop ticks, heartbeat refires, recovery timers)
through one shared gate; unlike a manual pause it keeps host-loss
supervision probing, and it is released by any explicit work command:
`/goal resume`, `/list resume`, `/list next`, `/loop resume`, `/loop start`,
or starting a new goal. Every release is ledgered (`load_hold_engaged` /
`load_hold_released`). Set global **Auto-resume = on** to restore
load-time automation for unattended rigs — the consent is the raw setting,
not the aggressive-mode default. Narrow continuity exceptions keep working
without consent: validated handoffs/rebinds, same-process session
successors, re-arming of work already in flight when a host silently died,
and the single retry a parked completion claim earns when main-model
recovery heals the provider that parked it.

### Auditor context without autostart (v0.35.63)

A restored objective remains visible in the status/widget UI even when the
load hold is active, but GLLA does not add a new continuation or re-inject the
previous auditor report until continuation consent exists. `/goal resume`,
`/list resume`, `/list next`, `/glla resume`, admitted loop resumes, validated
session continuity, and global **Auto-resume = on** are consent paths. The
previous Pi transcript is historical and remains untouched; this gate controls
only newly projected auditor feedback and model context.

**Due-wait backstop (v0.35.28, issue #16).** A time-gated wait pause
(`pauseKind: "wait"` with a `pauseResumeAt`) is no longer trusted to
in-memory timers alone — agent-authored waits armed none, error-brake
cooldowns were not re-armed on reload, and every scheduled resume died with
its session. The heartbeat now compares wall time against `pauseResumeAt`
every tick and re-fires the route once the deadline lapses by more than
~90s (main-model waits probe the provider; other waits clear the park and
dispatch one fresh continuation). `/glla pause` and the load hold still
freeze it; every fire is ledgered (`wait_pause_overdue_resume`). Auto-resumed
goals carry a RECOVERY NOTICE in their next continuation prompt — "welcome
back, YOU were recovered" — so the agent continues its own work instead of
waiting for an external recovery signal that already fired.

## Completion and destructive commands

An approved objective writes its final completion summary to the archive and
shows one final `✓ done` notification, then closes its live slot automatically.
No follow-up cancel is required. `/glla cancel` stops only the active objective:
for a list-owned objective it also drops the waiting queue; an unrelated
standalone goal does not consume an unrelated list backlog. `/glla wipe` is the
Confirm-gated, idempotent all-live-state reset: it preserves archive and ledger
history, removes RAM state plus valid or orphaned queue sidecars, persists the
clean state before optional loop-branch cleanup, and completes in one
invocation. Headless `/glla wipe` refuses before changing state because the
confirmation is intentionally not bypassed.

## Config (one global place, rarely opened)

Open `/glla` to edit these settings in the table (the rows show effective values and provenance):

- Auditor model and thinking level
- Auditor fallback agent

**Auditor selection (v0.35.24):** the **Auditor model** row opens the same
`/model`-style fuzzy picker the main agent flows use — configured-auth models
only, with a session-model row and a typed escape hatch. It is at full parity
with the main selector on policy too: your forbidden-models patterns filter
the picker list AND a typed match is refused with a named warning, so a pin
saved here is one `resolveAuditorModel` will actually honor. The pick lands
in global `auditorModel` and is followed immediately by the auditor thinking
dialog for that model. The **Auditor fallback agent** row applies the same
filtering to the failure-over pin.

- Notify command, token limit, and wedge-alert minutes
- Auto-resume, auto-accept drafts, decision popup, and carryover policy
- Main-agent current model/thinking, fallback models, recovery cadence, and preferred-primary failback policy in the Main agent tab
- Drafter agent/thinking/fallback agents in the Drafter tab
- Auditor agent/thinking/fallback agent in the Auditor tab
- Forbidden model patterns and switch policy
- Audit cap/report size, aggressive mode (ON by default), retry cadence, and
  stall brakes

The argument namespace is reserved for actions such as `/glla status`, `/glla
pause`, `/glla resume`, `/glla cancel`, `/glla stats`, `/glla audits`,
`/glla tooloverride`, `/glla fallbacks clear`, and `/glla wipe`. `fallbacks clear`
atomically removes the global main-agent fallback chain and cancels any pending
fallback switch. Pause freezes every automatic supervisor side-effect (heartbeat
re-arms, recovery probes, auto-resume, continuation dispatch, loop ticks, quiet
notifications) without touching active work, and survives session restarts;
resume unfreezes. Cancel stops the active objective; wipe clears all live state
while preserving history. There is no top-level `/glla key=value` setting syntax.

Resolution per key: **project > global > defaults** — EXCEPT `autoResume` and
agent recovery settings (`mainModelFallbacks`, `mainModelRetryMinutes`,
`mainModelFailback`, `mainModelPrimaryProbeMinutes`, `drafterModel`,
`drafterThinkingLevel`, `drafterModelFallbacks`, `hourlyRetryProbe`),
which are **global-only**: per-project opt-ins from old versions
silently overrode the global hold at launch (the junk-runner incident), so
the launch-restore gate and the reviewer-enqueue gate read only the global
file now. Main-session recovery policy is likewise one global chain/cadence
for the active session. Main-agent fallback models are global and ordered (up to 10): a provider
failure selects fallback 1, then fallback 2, and so on, one supervised turn at a
time. The Main agent tab leads with the ordered-chain editor — a multi-select
picker where Space toggles membership, Tab enters order mode (↑/↓ moves a
chain row), and clearing the selection removes the global key. Forbidden,
unavailable, and unauthenticated refs are skipped. When every candidate is
down, glla stops the current send attempt and uses the configured
`base → 2×base → 4×base → 8×base → 16×base → 5h` ladder (`base` defaults to
15m). `hourlyRetryProbe=on` adds a blind :00:30 retry after each hour starts.
With `mainModelFailback=auto` (the default), a successful fallback keeps the
original primary as the preferred model and schedules a durable health probe at
the `mainModelPrimaryProbeMinutes` cadence; the primary is selected only for a
supervised probe, and a failure returns to the serving fallback. Set
`mainModelFailback=sticky` to disable this reverse probe. No provider
availability or quota check is made before any retry; all recoverable failures
walk the ordered fallbacks and then continue on the active model through the
bounded retry policy. Automatic recovery stops at 24h,
preserves the saved work, and requires an explicit
`/goal resume`, `/list resume`, or `/loop resume` to start a fresh window. A
provider becoming available within that horizon therefore resumes saved work
without manual intervention; no blind 50ms resend loop is introduced. The
detached auditor uses an explicit cascade: primary
`auditorModel` → optional fallback pin → the pi session model. If a selected
model fails after launch, the worker retries it once and then advances through
that same cascade; every candidate is still audited in a detached,
extension-less process. There is no in-process fallback into the parent
session. If the bounded cascade is exhausted, the exact completion claim is
stored and the goal pauses for `/goal resume`; infrastructure is never treated
as a verdict.

On disapproval, the executor receives the full auditor report by default
(`auditFeedbackChars=0`, since v0.24.9 — a truncated report loses exactly the
actionable tail of multi-item `<evidence>` blocks). Set a positive
`auditFeedbackChars` to cap it. The complete report is always stored in audit
history and is available through `/goal status` regardless.

`autoaccept=on` skips BOTH the Confirm dialog and the drafting interview
floor — every `propose_*` draft (goal, list batch, loop, task list)
activates the moment the agent proposes it, and a completed `/list audit`
fan-out queues its generated finding items without a second confirmation.
Both paths notify loudly; auto-accept is never silent. The seed carries the
intent. Since v0.29.4 auto-accepted drafts **start immediately**
— the draft path is decoupled from `autoResume`, which gates ONLY
launch-time restore of persisted state ("load it but don't auto-start it").
For fully unattended rigs you typically want both on; for attended rigs,
`autoaccept=on` + `autoresume=off` is the sweet spot (new drafts go, old
state holds).

## Subagents

glla's guarantees here come from glla itself (session-handle
discrimination), not from any specific subagent plugin — any Agent-tool
provider gets them. Subagent sessions bind extensions too, so glla loads
there — by design the **main session owns the goal/loop/list; subagents
are workers** (v0.23.8):

- A subagent session never clobbers the loop's session handle, never runs
  the restore gate, and never drives continuation — so the heartbeat,
  wedge alert, and auto-resume machinery always act on the main session.
  Headless `print`/`json` child contexts are rejected before root
  registration, restore, owner claims, or command/tool mutation; this also
  covers persistent children, not only the usual in-memory workers.
- Subagent tool activity counts as activity for the wedge clock — a long
  productive child run is work, not a hang. If a tracked top-level child stops
  changing its tool-use/output counters, glla warns at the short detection
  threshold and can request one child-specific abort after
  `subagentHangEscalationMinutes` (default 30; `0` = warning-only). The main
  host still records lifecycle, action state, and partial output for
  `/glla agents` through the event bus.
- With `@tintinweb/pi-subagents` specifically (the one we test against):
  read-only agents (Explore, Plan) get no glla tools; general-purpose
  agents see them but state-mutating calls (`complete_goal`, `propose_*`,
  `list_add`, `pause_goal`, …) and foreign slash commands are refused with
  "report back to the main agent".

## Token guard

Every goal tracks real token usage; crossing the budget pauses the goal.
Off by default (opt-in) — set Token limit in the `/glla` settings table. A
high value like 10000000 is a runaway threshold, not a big-goal threshold
(real research/feature goals legitimately burn 2-4M). Loop 3 doesn't need
this cap — it has its own brakes
(max iterations + plateau).

## Wedge alert

The turn-based watchdogs can't see one failure shape: the session is busy
but silent for a long stretch because ONE unbounded command (a test suite
that never exits, a dev server) is holding the whole goal hostage. The
heartbeat watches the wall clock: busy + no activity for 30 minutes →
in-session warning + your configured notify push, once per interval while
it persists. Tune Wedge alert minutes in the `/glla` settings table (0 = off).

Every other wait is bounded too: continuation retries are milliseconds,
nudge accounting counts consecutive unproductive turns (substantive text
or tool calls reset the counter) and pauses the goal / stops the loop after
3 — provider-error and user-abort turns are exempt (v0.27.3+). Measure
commands get a 10m
hard timeout, and the detached auditor aborts after 10m with no activity while no
an auditor tool is running. A long-running verification tool is allowed to
finish, but each tool has an independent five-minute ceiling and the worker
has a 30m wall-clock safety cap. Both paths are infrastructure errors, never
verdicts; interrupted claims remain stored for a direct retry after `/goal resume`.

## Commissar watchdog (adherence, opt-in)

A goal can run for hours; nothing watched whether the executor stays HONEST
about it — the completion auditor only sees the end claim. The commissar is
an independent detached worker (the same hardened transport as the
completion auditor) that periodically judges ADHERENCE and PROGRESS, not
completion: it reads the glla ledger, git history, and repository evidence,
then returns `<adherent/>` or `<wanting>reason</wanting>`.

Off by default. Turn it on in `/glla settings → Commissar`: enable flag,
interval minutes (default 20), and the wanting threshold (default 2). At
two consecutive WANTING verdicts the commissar TERMINATES the main run and
restarts a fresh one on the SAME objective — the next continuation carries
a COMMISSAR RESTART directive quoting the finding as untrusted evidence.
One WANTING never terminates anything; infrastructure failures (model down,
worker wedged, no verdict marker, no tool evidence) are ledgered as noise
and never count toward termination.

## Compatibility (what goes well, what conflicts)

**The Two-Driver Rule**: any plugin that drives agent turns on `agent_end`
conflicts — two supervisors scheduling continuations into one session produce
contradictory turns. One driver at a time:

- **Hard conflicts** (do not install together): `pi-codex-goal`, `pi-loop-mode`,
  `pi-goal-x`, `pi-goal*`, `ralphi`, `pi-ralph*`, `pi-autoresearch` (active).
- **Overlap**: `@badliveware/pi-compaction-continue` — our heartbeat covers
  stalls while a goal/list/loop is active; both installed may double-nudge.
- **Installed-but-don't-run-simultaneously**: `@tmustier/pi-ralph-wiggum` —
  fine to keep, never run a ralph loop while a goal/list/loop is active.

**Goes well with it**: see **Recommended companions** above. `pi-chrome` too
(the research/search path for goals — logged-in browsing with no extra
services; standalone search skills like `mmx-cli`/`pi-search-skill` are
optional conveniences for bulk queries, not requirements).

**Overlaps — pick one**: `@tintinweb/pi-tasks` is a second task list next to
`/list`, and in practice the glla list *is* the task list (queue, statuses,
per-item audit trail) while the todos end up the weaker copy. We ran both
and removed pi-tasks. If you truly need session-wide dependency DAGs beyond
one ordered queue, it exists — but installing both is not the ideal combo.

**Two footnotes**: (1) extension-registered providers work in the main session
but not the auditor's extension-less session — if audits fail auth, choose
an auditor model in `/glla` settings. (2) `pi-notify-agent` notifies on every
turn; glla pushes fire only where there is something to DO (pauses, verdicts,
storms, wedge) and work out of the box — with no notify command configured glla
auto-detects `notify-send`/`osascript`; `notify=off` silences, `notify='<cmd>'`
customizes.

## Files

Post-decomposition layout (the v0.34.x monolith is gone — `loops/goal.ts` is
a thin activation/wiring installer):

```
extensions/  (34 files — all of them, grouped by concern)
  # command + UI surface
  goal-commands.ts             # /goal + /list command surface, drafting, wipe/stats
  settings-menu.ts             # /glla settings menu sections + rows
  goal-agents-panel.ts         # tracked-subagent panel (/glla agents) + widget line
  confirm-draft.ts             # Confirm-card markdown builder
  vision-assist.ts             # mmx vision routing + model-switch gate
  glla-version.ts              # version info for /glla version (source + npm)
  # state, types, pure helpers
  goal-loop-core.ts            # types, JSONL state reader, pure helpers
  goal-state.ts                # disk writer (persistStateLine serialization)
  goal-settings.ts             # settings load/save + global/project paths
  faulty-objective-recovery.ts # suspicious-objective classification + repair derivation
  goal-objective-conflict.ts   # live-objective conflict resolution on start/tweak
  goal-loop-shield.ts          # regression_shield (pure, dependency-free)
  goal-loop-display.ts         # widget/status rendering (incl. last-outcome retention)
  # continuation + recovery
  goal-continuation.ts         # continuation scheduling/dispatch + prompt templates
  goal-loop-dispatch.ts        # generation-bound dispatch records
  length-continue.ts           # stop_reason=length auto-continue policy
  goal-heartbeat.ts            # heartbeat self-watchdog, subagent probes, due-wait backstop
  goal-recovery.ts             # main-model recovery + completion-audit recovery
  main-model-recovery.ts       # pure model-fallback/probe scheduling helpers
  quota-retry.ts               # provider diagnostics + bounded retry windows
  # loop machinery (Loop 3)
  goal-loop.ts                 # /loop tick engine, git finish
  goal-loop-forever.ts         # /loop measure/parse/plateau helpers
  goal-loop-backoff.ts         # scheduling constants + stall/wedge/pending-latch decisions
  goal-loop-repetition.ts      # anti-repetition detectors (stuck ladder, v0.24.0)
  goal-loop-stats.ts           # ledger rollups + premature-success detection
  goal-loop-subagents.ts       # subagent markers + pinned-agent knowledge
  reviewer.ts                  # archived-goal re-review config + classification
  # auditor machinery
  goal-loop-auditor.ts         # auditor prompt + legacy in-process helper
  goal-loop-auditor-process.ts # detached worker protocol + shield revalidation
  auditor-extensions.ts        # auditor-session extension discovery + allowlist
  # model pickers
  drafter-model.ts             # drafting-only model resolution + fallbacks
  model-picker.ts              # single-model picker items
  multi-model-picker.ts        # multi-model picker UI
  model-selector.ts            # scope-aware fallback selector composition
loops/
  goal.ts                      # public activation/wiring installer (thin)
  goal-activation.ts           # event wiring, command registration, session lifecycle
  goal-tools.ts                # agent tools (complete_goal, pause_goal, list_*, loop drafts)
  goal-orchestrator.ts         # goal lifecycle: create/archive/advance, reviewer
  goal-list-queue.ts           # /list queue: enqueue/advance/drain, list drafting
  goal-auditor-hooks.ts        # completion-audit claim/recovery machinery
  goal-session.ts              # session-scoped runtime globals + lifecycle state
  goal-runtime-globals.ts      # ambient declarations for those globals
  goal-settings-ui.ts          # settings editors + model pickers
  goal-ui.ts                   # shared UI helpers (drafting state reset, notify wrappers)
prompts/  (7 — one per prompt surface; edited as .md, read at runtime)
  goal-loop-continuation.md    # continuation prompt template
  goal-loop-draft.md           # /goal + /list drafting interview
  goal-loop-plan.md            # extended plan draft — goal/list (v0.35.33)
  goal-loop-plan-loop.md       # extended plan draft — loop (v0.35.33)
  goal-loop-forever.md         # /loop driver prompt
  goal-loop-forever-draft.md   # /loop drafting interview
  goal-loop-forever-metricless.md  # metricless-/loop drafting variant
scripts/
  goal-auditor-worker.mjs      # extension-less RPC auditor child process
  goal-auditor-launch.mjs      # Windows-safe spawn spec builder (gate-before-quote)
  auditor-extension-fixture.mjs       # hermetic provider fixture for the auditor gate
  verify-auditor-extensions-offline.mjs  # mandatory gate: resolved allowlist loads offline
  smoke.sh                     # live integration harness (tmux + real models)
tests/                         # current test count is reported by `bun test`; no live pi required for the suite
docs/DESIGN.md                 # architectural decisions
PLAN.md                        # milestones, decisions, gates
```

There are three loop styles:

- **Metric:** a bounded command prints one number that honestly represents
  progress, such as test failures or bundle size. GLLA test-runs the measure
  before you confirm it and stops on plateau or a configured bound.
- **Metricless specification:** no honest number exists, so the loop advances
  a specification or checklist. It ends at its time/token/iteration bound or
  `/loop stop`; it has no fake plateau metric. Add optional
  `cadence=<seconds>` to put a minimum gap between successful automatic
  iterations; explicit starts/resumes remain urgent and `/loop status` shows
  the armed cadence.
- **Project audit:** each iteration looks for the next important finding,
  appends evidence to the audit ledger, and works through the findings.

If the work has a finish line, use `/goal`, not an endless loop.

## The autonomy model

GLLA is designed for **high-level autonomy with low-level accountability**.
You provide direction and acceptance criteria; the agent owns the ordinary
research and implementation decisions; GLLA owns continuity, state, recovery,
and verification.

### What produces better results

1. **Name the outcome, not a list of keystrokes.** Say what should be true
   when the work is finished.
2. **Make “done” inspectable.** Include tests, files, behavior, or user-visible
   checks in the contract.
3. **Give broad work room to research.** `/goal plan` is useful for greenfield
   or ambiguous work; it researches before asking its deeper interview.
4. **Let the agent decompose, but keep bounds.** Task plans have confirmation
   and bounded task/subtask counts. A list item remains one auditable unit.
5. **Use subagents for parallel leverage, not ceremony.** Spawn workers when
   independent research or implementation can happen concurrently.
6. **Treat the auditor as a gate, not as decoration.** A completion message is
   a claim; acceptance requires evidence tied to the contract.

Autonomy is intentionally not blind: Confirm dialogs, decision pauses,
explicit resume paths, bounded retries, and durable status keep important
control points visible.

### What GLLA verifies

When the agent calls `complete_goal`, GLLA:

1. runs the contract's mechanical checks when a release or command check is
   specified;
2. writes an identity-bound completion claim;
3. starts a detached, fresh pi RPC worker for the audit;
4. asks the worker to inspect the repository and run bounded checks;
5. requires raw evidence for each verification-contract item through the
   orchestrator-side regression shield;
6. keeps the goal open on infrastructure failure, missing evidence, or
   disapproval instead of silently archiving it.

The auditor is intentionally isolated from the implementing conversation and
GLLA extension state. By default it runs without extensions, skills, prompt
templates, themes, or context files, so its model must be usable in a plain pi
session. It is independent verification, not an OS sandbox: the auditor's
`bash` tool can still change files if a prompt or verifier tells it to. Keep
verification commands bounded and treat repository permissions accordingly.

## Recommended pi extensions

GLLA is the supervisor. These companions add capabilities around it:

### Recommended for almost everyone

- **`@juicesharp/rpiv-ask-user-question`** — structured questions, multi-select,
  previews, and Confirm dialogs for drafting and decisions. GLLA has a prose
  fallback, but this is the intended UX.

### Optional parallel workers

- **`@tintinweb/pi-subagents`** — recommended when a goal has independent work
  that can genuinely run in parallel. It gives the main agent Explore, Plan,
  and general-purpose workers for research and focused implementation. It is
  not required for GLLA's main continuation, queue, recovery, or detached
  auditor; a short or mostly sequential goal is often better without the
  extra worker overhead.

  The main pi session remains the owner of the goal/list/loop; subagents are
  workers and cannot silently replace the parent's objective.

Install it when parallelism will pay for its coordination and model usage:

```bash
pi install npm:@tintinweb/pi-subagents
```

GLLA supervises the parent and tracks worker activity, partial output, and
confirmed frozen-child recovery. It also defaults Explore agents toward the
parent model strategy so a hidden provider pin does not unexpectedly consume a
different quota pool.

### Useful, but optional

- **`@pi-unipi/notify`** — Telegram, Gotify, or ntfy delivery when you need
  alerts away from the desktop. GLLA's local notifications work without it;
  when no command is configured, it auto-detects `notify-send`/`osascript`;
  `notify=off` silences notifications.
- **`pi-chrome`** — logged-in browser research and interaction when a goal needs
  a real web session. It is not required for repository-only work.

### What not to combine with GLLA

These are coexistence rules, not a ranking of other projects:

- Do **not** run a second extension that also drives agent turns on
  `agent_end` while GLLA owns the session. Two supervisors can schedule
  contradictory continuations. Choose one driver for a session.
- Do not run a second task/queue extension for the same work. GLLA's `/list`
  already provides durable queue state, statuses, auto-advance, and an audit
  trail. Keep a separate task manager only when you specifically need a
  dependency DAG or another workflow outside GLLA.
- Avoid overlapping compaction, retry, or watchdog supervisors while a GLLA
  goal/list/loop is active; duplicate nudges make liveness harder to reason
  about.
- A ralph-style loop can remain installed, but do not run it simultaneously
  with a GLLA-driven loop or goal in the same pi session.

## State, recovery, and user control

### State roots

By default, GLLA stores state in:

```text
<working-directory>/.pi-glla/
```

`/glla` offers an opt-in **State root → sessionDir** setting that uses pi's
canonical top-level session directory. The session root must be admitted by
the host lifecycle first. If it is unresolved, GLLA fails closed rather than
recreating ambiguous state under whichever directory happens to be current.
Changing the root does not silently migrate or delete the old working-directory
tree.

The state is inspectable: active JSONL, goal markdown, queue state, audit jobs,
ledger history, and archived goals are kept under `.pi-glla/` (or the selected
session root). Repository audit findings remain repository-only; the npm package
ships the user-facing docs, not local audit history.

### Recovery behavior

Long-running work encounters provider outages, context compaction, process
replacement, slow tools, and workers that stop making progress. GLLA records
these as state transitions and uses bounded recovery rather than pretending
that silence means success. Error text is **not trusted** to pick a retry policy;
failure wording is retained as bounded diagnostics, not interpreted as
proof of a quota or billing state.

- automatic retries are bounded and visible;
- `/goal resume`, `/list resume`, and `/loop resume` are explicit recovery
  paths;
- a user abort means stop, not “try again behind my back”;
- a loaded objective can be displayed without injecting stale auditor context
  until continuation consent exists;
- frozen tracked subagents receive warning telemetry first and, after the
  configured long threshold, at most one child-specific abort; the parent goal
  is not aborted;
- interrupted completion claims remain available for retry and inspection.

Use `/glla pause` to freeze supervisor automation without killing active work,
`/glla resume` to release it, and `/glla status` or `/goal status` to inspect
what happened.

### Settings worth knowing

Open `/glla` for the settings table. The most important choices are:

- **Auditor model / thinking level:** the verifier's model and depth;
- **Main-agent fallback models:** an ordered recovery chain for provider
  failures;
- **Auto-resume:** whether persisted work may restart automatically after a
  session loads; explicit resume commands are always available;
- **State root:** `workingDir` by default, opt-in `sessionDir`;
- **Aggressive mode:** long-running keep-going defaults; explicit per-setting
  choices win;
- **Subagent hang escalation:** warning-only at `0`, or one child-specific
  action after a confirmed frozen interval;
- **Audit cap and retry cadence:** bounds for repeated objections and
  infrastructure recovery.

For an attended first run, keep the default confirmation and inspect the
status surfaces. For an unattended machine, configure auto-resume and notify
behavior deliberately rather than assuming a terminal left open is a
supervisor.

## Model and auditor requirements

The main agent may use the model/provider you normally use in pi. The detached
auditor starts a fresh extension-less pi process by default, so its selected
model must authenticate and work without an extension-registered provider.
Choose an auditor model in `/glla` if the session model depends on a provider
extension.

The worker inherits normal pi provider configuration and resolves `pi` from
`PATH`. If needed, set:

```bash
GLLA_PI_BINARY=/absolute/path/to/pi
```

Credentials are not written into `.pi-glla/audit-jobs/` or command arguments.
The isolated worker is an evidence checker, not a second implementation agent.

## From source and maintainer checks

Prerequisites: Node `22.19.0+`, [Bun](https://bun.sh/) for the test runner,
pi-coding-agent, and TypeScript `5.9+`.

```bash
git clone https://github.com/DraconDev/pi-goal-list-loop-audit.git
cd pi-goal-list-loop-audit
pi install .
```

Try the local extension without installing it globally:

```bash
pi -e /absolute/path/to/pi-goal-list-loop-audit
```

Run the checks used for a release:

```bash
npm test
npm run check
npm run release:check
```

`npm run release:check` runs the serialized Bun suite, TypeScript, the jiti
reproduction, offline auditor-extension validation, and npm pack. The test
count changes as regressions are added; the useful result is `0 fail`.

For design rationale, see [`docs/DESIGN.md`](docs/DESIGN.md). For the shipped
document index, see [`docs/INDEX.md`](docs/INDEX.md). For publishing, see
[`docs/RELEASING.md`](docs/RELEASING.md).

### Maintainer source map

The implementation is intentionally split by lifecycle concern. Start here
when tracing behavior:

| Area | Entry points |
|---|---|
| Commands and UI | `extensions/goal-commands.ts`, `extensions/goal-loop-display.ts` |
| State and roots | `extensions/goal-state.ts`, `extensions/glla-state-root.ts` |
| Continuation and recovery | `extensions/goal-continuation.ts`, `extensions/goal-heartbeat.ts`, `extensions/goal-recovery.ts` |
| Queue and lifecycle | `extensions/loops/goal-list-queue.ts`, `extensions/loops/goal-orchestrator.ts` |
| Completion audit | `extensions/goal-loop-auditor-process.ts`, `extensions/loops/goal-auditor-hooks.ts`, `extensions/loops/goal-auditor-surface.ts` |
| Auditor launcher | `scripts/goal-auditor-worker.mjs`, `scripts/goal-auditor-launch.d.mts` |
| Safety boundaries | `extensions/payload-guard.ts`, `extensions/context-hygiene.ts` |
| Tests and design | `tests/`, `docs/DESIGN.md`, `PLAN.md` |

The package contains the extension entry point
`extensions/loops/goal.ts`, prompt templates, schemas, scripts, docs, examples,
and the full test suite. `audit/` and `.research/` are repository material, not
first-use package content.

## License

GNU Affero General Public License v3.0-only — see [LICENSE](LICENSE).
