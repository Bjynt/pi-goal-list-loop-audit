# Open issues & ideas — 2026-08-06

**Scope:** master tracking doc for active bugs (from `/home/dracon/chat/pi/note.md`
plus the five screenshots on 2026-08-05/06) and ideas drawn from other goal
extensions (`audit/GOAL-PLUGINS-AND-CLIS-2026-07-31.md`,
`audit/HOW-THEY-WORK.md`, etc.). Sibling doc to `audit/PARKED-IDEAS.md` —
this one is **active**; that one is deferred.

**Sources:**

- `/home/dracon/chat/pi/note.md` — the original note file with screenshot refs.
- `/home/dracon/Pictures/Screenshots/Screenshot_20260805–06_*.png` — 5 new
  screenshots read in this session (vision path = minimax-m3).
- `/home/dracon/chat/pi/audit/DETACHED-WORKER-HUD-RECONCILIATION-2026-08-05.md`
  — the reconciliation matrix that prescribes the HUD fix.
- `/home/dracon/chat/pi/audit/CONTINUATION-SIDECAR-RECONCILIATION-2026-08-05.md`
  — the sidecar/ledger-gap reconciliation (revision 2).
- `/home/dracon/chat/pi/audit/AUDIT-WORKER-FREEZE-2026-08-03.md` (+LEADING-EDGE).
- `/home/dracon/chat/pi/audit/GOAL-PLUGINS-AND-CLIS-2026-07-31.md` — the
  ranked steal list (§5, 20 items, source-verified).
- `/home/dracon/chat/pi/audit/HOW-THEY-WORK.md` — 8 competing plugins'
  architectures and why each resists (or doesn't) drift to doorknobs.
- `/home/dracon/chat/pi/audit/LONG-RUNNING-MODES.md` — parked items,
  sub-goal HOLD, auditor cwd gotcha.
- `/home/dracon/chat/pi/audit/ADVISOR-BLOCKER-2026-08-05.md` — external
  `/advisor` unavailability (kimi-coding `expires` epoch-ms corruption,
  interactive-only gate, minimax quota wall).

**Policy reminder (recorded 2026-08-06T10:15:51.717Z in
`.pi-glla/active.jsonl`):** all model switches must be present in the glla
ledger. A `gpt-5.5` switch attempted this session (Agent-tool delegation for
screenshot OCR) was rejected; minimax-m3 is vision-capable and no switch was
required. The unauthorized-switch class is bug #14 below.

---

## 1. Bug inventory (active)

Severity legend: 🔴 observed in current 0.34.x, recurring, blocks work ·
🟠 observed, contained, needs fix · 🟡 design/state question · ⚪ cosmetic.

### 1.1 🔴 Host session lost (Chrome Bridge detached session stale)

**Screenshots:** `Screenshot_20260805_225218.png`, `075011`, `075534`
(`note.md`); the 2026-08-05 chat/pi session pasted one of these.

**Observed:** Chrome Bridge status bar reads
`▲ host session lost - waiting for fresh session,start` /
`▲ interrupted — stale handle · fresh session,start resumes`. The persistent
Chrome session is gone and the only recovery is to start a new one. The
auto-committer daemon in this repo was the workaround (work saved in
`.pi-glla/`; "if pi dies once more, restart pi normally and glla will
restore the saved work" — warning emitted in `081938`).

**Probable cause:** the detached Chrome-bridge worker (per
`DETACHED-WORKER-HUD-RECONCILIATION-2026-08-05.md`) loses its parent handle
when the main session is suspended/resumed across the 4GB V8 heap ceiling or
across long sleeps. The HUD then has no live handle to render.

**Fix path:** the reconciliation doc prescribes H-code gating
(`extensions/goal-loop-display.ts:532` already gates `currentTool` on
`phase === "running"`) and a fresh-heartbeat requirement for LIVE/BUSY
(line 430: `if (!live && phase === "running" && audit?.lastActivityAt !==
undefined && ...)`). The "host session lost" branch needs a **handle-stale
signal** plumbed from the chrome-bridge worker, plus a HUD rule that
demotes to stale-handle rather than "live" the moment the parent generation
changes.

### 1.2 🔴 Max output token limit → compaction error state

**Screenshot:** `Screenshot_20260805_225654.png` (affiliate rig).

**Observed:** a single `chrome.evaluate` returned a scraped HTML page large
enough that the model hit `maximum output token limit` mid-response. The
error banner appeared, then `[compaction] Compacted from 196,401 tokens`
fired, and the Chrome Bridge session became stale (see 1.1).

**Probable cause:** `chrome_evaluate` returns the full scraped DOM/text as
the tool's `output`; that output flows through the model as a tool result,
counts against the model's input, AND when the model quotes/cites parts of
it into its own response it counts against the **output** token limit. The
"max output" error means the model was regurgitating too much of the
scraped page.

**Fix path (steal-list #13):** extension-supplied compaction summary
(pi-autoresearch pattern in `HOW-THEY-WORK.md`) — replace the LLM compaction
call with a deterministic, disk-sourced summary derived from JSONL state.
Specifically for `chrome_evaluate`: cap the tool's `output` size (e.g.
return a structural digest + the raw payload in a sidecar file the model
can `read` on demand), so the tool result itself doesn't blow the budget.

### 1.3 🔴 Session lost / extension handle invalidated mid-list-item

**Screenshot:** `Screenshot_20260806_081938.png` (hellhunter rig).

**Observed:** warning banner reads `glla: pi invalidated this session's
extension handle without delivering a replacement session. glla stopped
state sends and kept the work safe in .pi-glla/. A fresh session,start
will resume it; if pi dies once more, restart pi normally and glla will
restore the saved work.` This fired while a list item (audit) was in
flight; the plugin preserved state but the in-flight audit was lost.

**Probable cause:** same root family as 1.1 (handle/lifecycle mismatch
during suspension or OOM). The recovery text is correct but the *cause*
should be diagnosable.

**Fix path:** `CONTINUATION-SIDECAR-RECONCILIATION-2026-08-05.md` already
documents the class ("stranded" goal + "missing verdict-log" gaps). Add a
`session_handle_invalidated` ledger event with a structured `reason`
(oom, manual-kill, provider-disconnect) so the recovery path can pick the
right strategy. The 9 missing verdict-log entries + the stranded 00xf25
orphan are the historical backlog.

### 1.4 🔴 Detached auditor stuck

**Screenshot:** `Screenshot_20260806_091021.png` (endless-td rig) — auditor
status `DETACHED · LIVE · worker activity 0s ago 15h:02% 1h50m` for an
auditing list item.

**Related `note.md` items:** "stuck but says running" (125825), "another
stall" (161528), "auditor claimed running but looks stuck" (210913),
"auditor blocked" (051501 = ADVISOR-BLOCKER).

**Probable cause:** the auditor worker can lose its heartbeat source
(`lastActivityAt` not refreshed) while the process is alive but
non-progressing. The HUD can't distinguish "alive and progressing" from
"alive and wedged on a tool call".

**Fix path (steal-list #7):** fail-fast quota on the auditor path
(Kimi 0.30) — error immediately on the first no-progress signal rather
than letting it run for 1h50m. Combined with the H-code HUD gating from
1.1, a stale `lastActivityAt` should demote the status to `stale` and
auto-cancel after a bounded quiet period. The
`AUDIT-WORKER-FREEZE-2026-08-03.md` doc is the canonical incident record.

### 1.5 🔴 Worker activity indicator is wrong

**Screenshot:** `Screenshot_20260806_091847.png` (hegemon rig) — auditor
`thinking`, list item `auditing 22m 09s`, detached worker `7m 16s`, but
the status bar reads `worker activity 0s ago 15h:04% 1h40m`.

**Observed:** the `lastActivityAt` field in the HUD is either never
updated, or it is updated to a value that resolves to "0s ago" in the
`fmtElapsed` formatter regardless of truth.

**Likely site:** `extensions/goal-loop-display.ts:386`
(`fmtElapsed(Math.max(0, now - audit.lastActivityAt))`). The
`Math.max(0, ...)` clamps negatives to zero; if `lastActivityAt` is in
the future (clock skew, generation reuse, or `now` captured before the
update) the formatter prints "0s ago" forever.

**Fix path:** this is the cheapest, most contained bug on the list and
the right place to start. Pin a test in `tests/display.test.ts` that
asserts the HUD never prints "0s ago" when `now - lastActivityAt > 0`,
and that LIVE requires a non-terminal phase AND a `lastActivityAt`
within a heartbeat window (e.g. 30s). The reconciliation doc's H-code
rule is the prescription.

### 1.6 🟠 Auditor displays words one by one (streaming UX)

**Screenshots:** `Screenshot_20260804_211341.png`, `211506.png`
(`note.md`).

**User question:** "i am not even sure we would want a different auditor
look when main, no ?" — the auditor's word-by-word stream is distinct
from the main TUI; whether that's desired or a streaming-pipeline bug is
open.

**Probable cause:** auditor runs through `completeSimple` and pi's
default stream renderer is per-token; the auditor lacks a `silent` mode
or a final-only render gate.

**Fix path:** add an `auditorSilent` toggle in settings + a
`/glla auditor` verb to flip it; the streaming-vs-final question is a
real UX choice, not just a bug.

### 1.7 🟠 List/goal drafting "disallows until we restart"

**Screenshot:** `Screenshot_20260804_212233.png` (`note.md`).

**Observed:** after some draft workflow, `/list` and `/goal draft` start
refusing actions until the session is restarted.

**Probable cause:** state corruption in the `Policy` mode (`goal`/`list`)
flag inside `state.goal`/`state.list`; likely a parse failure that
leaves the mode in an undefined state the gate rejects.

**Fix path:** in `extensions/loops/goal.ts`, find the mode-gate function
(e.g. `if (state.policy !== "list") return reject(...)`) and replace
silent reject with a self-heal that re-parses the mode from the latest
goal/list md file in `.pi-glla/goals/`. Add a regression test that calls
the gate with a corrupted `state.policy` and asserts recovery.

### 1.8 🟠 "Main shouldn't be detached"

**Screenshots:** `Screenshot_20260804_044237.png`, `122419.png`,
`123109.png` (`note.md`).

**Observed:** the host (MAIN) session itself appears with a "detached"
status badge. The user wants MAIN to always be `SUPERVISING`, never
`DETACHED`.

**Fix path:** hard-code the MAIN-host render to `SUPERVISING` regardless
of any handle state — see `DETACHED-WORKER-HUD-RECONCILIATION-2026-08-05.md`
§3 ("Current MAIN is not detached" — the reconciliation already
establishes that MAIN should never render as DETACHED). The fix is a
one-line guard in `goal-loop-display.ts`.

### 1.9 🟠 False rate-limit claim

**Screenshot:** `Screenshot_20260805_050014.png` (`note.md`).

**User note:** "perhaps this bad idea we have no way to check all just
keep retrying" — the retry loop has no positive confirmation of an
actual rate limit; it just keeps firing.

**Fix path:** distinguish `429 rate_limited` (with `Retry-After`) from
generic `provider_error` in the retry classifier; only retry the former
with backoff, and surface a `rate_limit_unverified` ledger event for the
latter so the user can intervene.

### 1.10 🟠 Auditor blocked (external `/advisor` dependency)

**Screenshots:** `Screenshot_20260805_051501.png` (`note.md`) +
`ADVISOR-BLOCKER-2026-08-05.md`.

**Observed:** `/advisor` (rpiv-advisor) cannot be reached. Three external
causes: (1) kimi-coding `expires` field encoded in epoch-ms where the
consumer expects epoch-seconds (year-58564 parse error), (2) picker
hard-gates on `ctx.hasUI`, (3) fallback providers (minimax) are 429-walled.

**Fix path:** none on the glla side — this is provider/credential.
Documented in `audit/ADVISOR-BLOCKER-2026-08-05.md`. The local review
path (isolated auditor + fresh-context subagents) is the working
substitute. **Owner action:** re-encode `expires` as epoch seconds or
replace the kimi-coding OAuth entry with a static key, then re-test
`/advisor` in an interactive session. One MiniMax plan top-up unblocks
the documented fallback providers and the three quota-paused workspaces.

### 1.11 🟡 List with subtasks vs goal with subgoals

**Screenshot:** `Screenshot_20260805_095413.png` (`note.md`) — the agent
"stopped on qd".

**User question:** "what is now the different between list with subtasks
and goal with subgoals? I guess a goal is sitll only one, while listi s
multiple" — a parallel-execution question: if we know which list items
can run in parallel, that's the next milestone; otherwise we don't have
the shape right.

**Status:** parked in `audit/LONG-RUNNING-MODES.md` ("Sub-goal tree
(parent + children) — HOLD for v0.29+"). The current proposal: minimum
viable sub-goal tree = parent + children data model + `/goal status`
tree view + a `decisions.md` carry-over. No focus/unfocus yet, no
nested children.

**Decision needed from user:** is sub-goal tree the v0.29 priority, or
do we add parallel-execution metadata to `/list` items first? The two
are different shapes.

### 1.12 🟠 Invalidated ID

**Screenshot:** `Screenshot_20260805_121634.png` (`note.md`).

**Probable cause:** a goal/list id was invalidated mid-flow (likely by a
session-handoff or a forced rewrite). Need the goal id and the
surrounding active.jsonl events to diagnose.

**Fix path:** once a repro is captured, add a `id_invalidation` ledger
event with the old/new id pair and a reason field.

### 1.13 🟠 Stuck-but-says-running (multiple instances)

**Screenshots:** `Screenshot_20260805_125825.png`, `161528.png`,
`210913.png` (`note.md`).

**Observed:** the loop/auditor reports `running` while no progress is
made. Subsumed by 1.4 (detached auditor stuck) and 1.5 (worker activity
indicator wrong); fix the HUD gate + heartbeat and these should fall
out.

### 1.14 🔴 Unauthorized model switches must be ledgered

**`note.md`:** `Screenshot_20260805_161621.png`, `161738.png` — "we
somehow switched to sonnet this is not good these kind of switches
should be disallowed". Repeated this session with a `gpt-5.5` Agent-tool
attempt (rejected: codex usage-limit + forbidden by policy; minimax-m3
is vision-capable).

**Policy:** **all model switches must be present in the glla ledger.**
Switches to expensive models (gpt-5.5, sonnet, opus) are an error state
that wastes money and disrupts the audit trail.

**Fix path:**

1. The plugin detects `provider.model` changes on each turn boundary and
   appends a `model_switch` ledger entry with `{from, to, at, reason}`.
2. A `forbiddenModels` setting in `~/.pi/agent/pi-goal-list-loop-audit.settings.json`
   defaults to `["gpt-5.5", "sonnet", "opus"]` (configurable).
3. On detecting a switch to a forbidden model, the plugin emits a
   `forbidden_model_switch` ledger entry and (configurable) blocks the
   call to `completeSimple` with a notify.
4. A `/glla switchlog` command browses recent switches.

### 1.15 🟠 No hourly quota-resume prompter

**`note.md`:** "we also want an hourly prompter of stalled sessions so
we can pick back up after quota resets, start of every hour pretty much
cause that is when the quotas refresh".

**Probable cause:** quota walls are hit mid-session; the user has to
notice the stall and re-prompt manually. The provider's quota window
resets on the hour (observed across opencode-go/minimax/quasar-alpha).

**Fix path:** add a `quotaWallPrompter` subsystem that, on detecting a
quota-wall event, schedules a `sendUserMessage` at the next `:00` clock
minute with the original turn context. Steal-list #7 (fail-fast quota)
is the complementary piece — together they form a quota-aware handoff.
This is **NOT** a self-resume (that violates consent-on-drafts); it's a
notify-then-prompt, gated on `autoResume: true`.

### 1.16 🟠 Subagents lost between restarts

**User note:** "not sure we are good at recovering subagents seemingly
they are lost between restarts".

**Probable cause:** `Agent` tool subagents (general-purpose, Explore)
spin up a fresh context that doesn't persist state to `.pi-glla/`; on
restart, the parent's reference to them is gone.

**Fix path:** audit the Agent-tool spawning code path in the glla
extension for any subagent lifecycle hooks (likely none); add a
`subagent_session` ledger event on each spawn with the subagent's
session id and a summary, so the parent can recover the reference after
restart. Cross-reference with the "lost subagent" pattern in
`audit/INCIDENT-COMPLETION-BLACKHOLE-2026-07-23.md`.

### 1.17 ⚪ Subagent result notification delivered late

**Screenshot:** `Screenshot_20260806_081938.png` — "This is a delayed
notification for the 3rd agent (837fef1b) - its result was already
retrieved via get_subagent_result(wait=true) earlier, and its 6 findings
were already consolidated into the appended findings.md section. The
goal is already complete."

**Probable cause:** race between the Agent tool's `get_subagent_result`
and the subagent's notification event — the parent called `wait=true`,
got it, appended findings, completed the goal, then the notification
arrived and was ignored. Cosmetic at this point but indicates the
notification queue isn't gated on goal-archive.

**Fix path:** in the Agent tool's notification handler, short-circuit
if the goal is already terminal (`status === "archived"`).

---

## 2. Ideas from other goal extensions (filtered)

Full ranked steal list: `audit/GOAL-PLUGINS-AND-CLIS-2026-07-31.md` §5 (20
items). Cross-referenced to OUR active bugs:

| # | Steal | Maps to | Complexity |
|---|---|---|---|
| 1 | Post-stop in-turn tool block (3 independent impls) | 1.7 (state corruption class) | SMALL |
| 2 | Mechanical verification checks in the contract | completion-side hardening | MEDIUM |
| 3 | **Revision-bound audit validity** — `/goal tweak` does NOT invalidate prior approvals | new — REAL GAP, source-verified | SMALL-MED |
| 4 | Machine-readable goal exit codes (Kimi 0/3/6) | new — scripting | SMALL |
| 5 | **Complete goal budget trio**: wall-clock + turn budgets + defaults | 1.15 (quota prompter) + long-running safety | SMALL |
| 6 | Queue hiding + no-cascade-on-block (Kimi) | new — fairness | SMALL |
| 7 | **Fail-fast quota on auditor path** | 1.4, 1.13 (stalled auditor) | SMALL |
| 8 | Multi-session advisory lease | new — fleet pinning | SMALL-MED |
| 9 | **Schema-gated tools per phase** | 1.7 (state corruption), new — kill self-sabotage | MEDIUM |
| 10 | Anti-premature-completion line + completion-contradiction lint | new — pre-hoc honesty | TINY |
| 11 | CLI-flag goal injection (`pi --goal "…"`) | new — scripting | SMALL |
| 12 | In-band intervention in `tool_result` | new — guidance delivery | SMALL |
| 13 | **Extension-supplied compaction summary** | 1.2 (max-output → compaction error) | MEDIUM |
| 14 | Audit-checkpoint reuse (fingerprint gates re-audit) | cost reduction | MEDIUM |
| 15 | Git checkpoint → revert (Codex) | new — git-dependent | MEDIUM |
| 16 | Typed pause classes + differentiated auto-resume | new — `/goal pause` richness | SMALL |
| 17 | Intra-turn tool-loop police | new — orthogonal layer | MEDIUM |
| 18 | Cross-session lessons memory | new — but prompt-rot risk | SMALL |
| 19 | Channels / external event injection | new — wait for use-case | MEDIUM |
| 20 | Temporary thread forks | new — harness territory | — |

**Architectural lessons from `HOW-THEY-WORK.md`:** the eight competing
plugins split cleanly into **structural** drift protection (PRD file,
plan file, shell exit gates, maxIterations — ralphi, pi-ralph, pi-plan-exec,
kimuson/pi-ralph) vs **behavioral** (IMPROVEMENTS.md prompt, completion
markers, score regression — pi-loop-mode, pi-ralph-wiggum, pi-autoresearch).
glla's current protection is mostly behavioral. The next structural
addition is **revision-bound audit validity** (#3 above): a `/goal tweak`
should invalidate prior approvals so an old approval can't be cited
against a new contract.

---

## 3. Reconciliation prescriptions (safe-action codes)

From `DETACHED-WORKER-HUD-RECONCILIATION-2026-08-05.md`:

- **A — settled/archive:** parent is already archived terminally. No
  action.
- **B — historical transport failure:** worker result is terminal
  infrastructure/no-verdict; preserve as history; never convert to a
  semantic verdict or blindly retry.
- **C — superseded disapproval:** retain the semantic disapproval in
  audit history; a later sibling approval settled the archived parent.
- **D — orphan parent:** worker is terminal but parent remains `auditing`
  with no archive. Do not treat the result as applied; do not resend from
  the stale worker directory. A fresh MAIN owner must use the supported
  recovery/settlement path once.
- **H — HUD residue:** same safe action as B or A, plus the UI must
  ignore `currentTool*` after `phase: complete`. **Do not claim activity
  from the residue.**

**Status rendering rule (from §3 of the reconciliation):** the HUD must
gate `LIVE`/`BUSY` on **(a) a non-terminal phase AND (b) a fresh
heartbeat within a bounded window**. Terminal `currentTool*` fields are
stale telemetry, not evidence of a live worker. This is the prescription
for bugs 1.4 and 1.5.

From `CONTINUATION-SIDECAR-RECONCILIATION-2026-08-05.md`: the 42-job
matrix partitions cleanly into 30 clean approvals, 5 "settled without
verdict", 1 disapprove→approve cycle, 5 aborted, 1 stalled. The two
state-relevant gaps (stranded vvixp8 verdict, stranded 00xf25 application)
and the 7 unlogged verdicts are all recoverable from job artifacts. The
"supported cleanup (list index 4, `20260804054224-9jsix6`)" is the
queued item that addresses all of these.

---

## 4. Starting-progress plan

Concrete, ordered, low-risk-first. Each item is independently commitable.

### First commit (this session or next): bug #5 — worker activity indicator

Pin a test in `tests/display.test.ts` that asserts the HUD never prints
"0s ago" when `now - lastActivityAt > 0`, and that `LIVE` requires a
non-terminal phase AND `lastActivityAt` within a heartbeat window.
Surface area: `extensions/goal-loop-display.ts:386` (`fmtElapsed`),
line 430 (`live` gate), line 532 (`currentTool` gate — already
phase-gated). Test-first; run `bun test tests/display.test.ts` to see
the current red; then implement the fix; commit.

### Second: bug #14 — model-switch ledger

Add a `modelSwitch(from, to, reason, at)` helper in
`extensions/goal-loop-core.ts` next to `appendLedger`. Wire it into the
turn-boundary hook so each provider/model change records an entry. Add a
`forbiddenModels` setting and a `/glla switchlog` command. Test in
`tests/model-switch.test.ts`.

### Third: bug #1.4 — fail-fast quota on auditor path (steal #7)

Detect the first no-progress signal in the auditor heartbeat (e.g. two
consecutive `lastActivityAt` snapshots with no progress and no fresh
tool call within the heartbeat window) and emit
`auditor_quota_exhausted` or `auditor_stalled`, then auto-cancel the
detached job. Closes the "1h50m auditor" class.

### Fourth: steal #3 — revision-bound audit validity

Mutating the objective/contract (via `/goal tweak` or `complete_goal`
with `newObjective`) must invalidate prior auditor approvals. Add a
`revision` counter to `Goal`; bump it on every contract change; gate
`complete_goal` on `revision` matching the latest audited revision.
Test in `tests/revision-bound-audit.test.ts`.

### Fifth: bug #3 — session-handle-invalidation classification

Add a `session_handle_invalidated` ledger event with `reason`
(`oom | manual-kill | provider-disconnect | unknown`). Plumb the
classification through the chrome-bridge and main-session handles.
Backfill the 9 missing verdict-log entries from
`CONTINUATION-SIDECAR-RECONCILIATION-2026-08-05.md` finding #3 via the
queued cleanup item (list index 4).

### Sixth: bug #1.15 — hourly quota-resume prompter

Steal-list #7 + #8 combined. Detect quota-wall events, schedule a
`sendUserMessage` at the next `:00` clock minute with the original turn
context. Gated on `autoResume: true`. NOT a self-resume — a notify then
prompt.

### Seventh: bug #1.2 — chrome_evaluate output cap (steal #13)

Cap `chrome_evaluate`'s tool output (e.g. 8KB structured digest + raw
payload sidecar). Address the max-output-token-limit → compaction error
class directly.

### Eighth: design decision — bug #1.11 (sub-goal tree vs list-subtasks)

This is a 🟡 — needs user input. Options:

- **A.** Sub-goal tree (parent + children, parked for v0.29+ in
  `LONG-RUNNING-MODES.md`).
- **B.** Parallel-execution metadata on `/list` items (declaration of
  "this item is safe to run alongside N, M").
- **C.** Both, sequenced: B first as a smaller win, then A.

---

## 5. Cross-references

- `audit/PARKED-IDEAS.md` — deferred items (sub-goal tree v0.29, spec
  evolution, aggressive postaudit gate).
- `audit/LONG-RUNNING-MODES.md` — modes are peers, not nestable;
  auditor-cwd gotcha.
- `audit/command-registration-routing.md` — auto-recorded after each
  routing-rig test run; identifies duplicate-command collisions.
- `audit/GOAL-PLUGINS-AND-CLIS-2026-07-31.md` — full steal list, §8
  claim-verification (revision-bound audit is a real gap; "no goal
  budgets" is corrected; `regression_shield` is real but lexical).
- `audit/HOW-THEY-WORK.md` — eight plugins' engines, states, and
  drift-resistance patterns.
- `audit/ADVISOR-BLOCKER-2026-08-05.md` — external blocker on
  `/advisor`; local review path is the isolated auditor.
- `.pi-glla/active.jsonl` — ledger; the gpt-5.5 switch attempt is
  recorded at `2026-08-06T10:15:51.717Z`.