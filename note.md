# Next

## Resolved in v0.35.0

The provider-recovery policy is now intentionally blind: it does not query or
infer quota availability, classify quota-shaped wording, honor `Retry-After`,
or gate model fallback on a guessed provider state. Recoverable failures use
one generic retry envelope, with a 5-second eager retry and an extra
`hourlyRetryProbe` at `:00:30` after each hour starts. The existing bounded
attempt/window safety limits remain. Old quota-named state is compatibility
data only and cannot change the runtime policy.

## Resolved in v0.35.1 (2026-08-15)

The drafter controls now behave like the regular model controls: selecting a
drafter immediately offers the thinking levels supported by that agent, and a
standalone Drafter thinking row edits the same setting. The default is an
explicit `session — inherit current session level` choice, so a saved thinking
level can be cleared without editing JSON. The temporary drafter lease applies
the requested level across fallback agents and restores the original model and
thinking level after drafting.

The former **Backups** settings section is now **Agents**. Main, drafter,
auditor, and subagent entries are described as agents with optional fallback
agents/models; persisted keys and command behavior remain compatible.

## Current triage — v0.35.1 (2026-08-15)

The screenshots and observations below are historical captures. Their current
status is recorded here so this note stays useful as a backlog rather than
looking like every incident is still open.

| Finding | Status | Current disposition |
|---|---|---|
| Draft accepted but did not auto-start | **Resolved / clarified** | In-session confirmed or auto-accepted drafts start immediately. Fresh-session restore intentionally holds by default unless `autoResume` is enabled; queued list items also wait behind active work. |
| No provider activity / give up too eagerly | **Resolved within bounds** | Recoverable failures retry eagerly after 5 seconds, use the generic bounded ladder, and receive an extra `:00:30` hourly retry. The safety envelope remains finite: main recovery is horizon-bounded and auditor recovery is capped; this is not infinite retry. |
| Pi accepted work but did not start a turn | **Resolved within plugin boundary** | The dispatch has a 30-second start-proof window plus one verbatim retry with backoff, then durable recovery guidance. The plugin does not blind-loop forever when Pi never acknowledges a turn. |
| Restart/resume was needed to get moving | **Mostly resolved** | Generation-bound dispatch, lifecycle handoff, rebind, and same-process self-healing are covered. A true stale host context still depends on Pi delivering a fresh lifecycle boundary. |
| Auditor timed out | **Resolved handling; root cause remains observable** | Timeout and inactivity are treated as infrastructure failures, the completion claim is retained, and the auditor is retried. A genuinely hung verification command can still time out; it no longer loses the claim or becomes a verdict. |
| Auditor parked with no verdict and stopped | **Resolved within bounds** | No-verdict claims use the same durable generic retry plan. Aggressive mode keeps retrying inside its bounded window; after the cap, explicit resume starts a fresh window. |
| Quota checking / waiting for a reset | **Resolved in v0.35.0** | Live recovery does not query, infer, or classify quota availability and does not use `Retry-After` or quota wording to choose a path. |
| Host session lost / resume could not recover it | **Partly resolved; Pi limitation remains** | The plugin preserves work, classifies stale handles honestly, rebinds when Pi supplies a replacement, and points to `/new` when the cached event context cannot be repaired. Automatic session creation is not available from Pi's public event context. |
| Total time spent / UI review | **Resolved** | Goal, loop, queue, auditor, and terminal surfaces expose elapsed or duration information; focused display and philosophy tests pass. |
| Long-term-minded vs opportunistic fixes / unnecessary questions | **Resolved in v0.35.0** | Drafting and continuation now state the durable-fix preference, safe-workaround conditions, unattended fallback, and genuine decision boundaries for questions. This is policy guidance, not a new user preference, by design. |
| Designer subagent with fallback | **Resolved in v0.35.0** | Explicit role declarations persist on goals, queue items, and task plans; the managed read-only Designer has routing, settings, status/prompt surfaces, provider/model fallback, and inline fallback behavior. |
| Dedicated drafter model with fallbacks | **Resolved in v0.35.1** | Drafting has a separate temporary primary/fallback chain, model-specific thinking selection with session-level inheritance, generic existing-interview recovery, serialized restore of model and thinking, session last resort, settings UI, and focused tests. Main and auditor chains are untouched. |
| External continuation research | **Resolved as documented no-change** | Codex, Claude Code, and DeepSeek Harness confirm the durable checkpoint/resume direction and produce a concrete Pi host-session API request; no provider-specific retry redesign is needed. |

Focused evidence for this triage: 229 relevant tests passed before the v0.35.0
implementation, and the new policy/designer/drafter slice adds 36 focused
passing tests. The final release check below is clean: 1,357 passed, 1 skipped
(the environment-gated daemon test), and 0 failed across 1,358 tests; TypeScript
type-checking, the Jiti state-split regression, and `npm pack --dry-run` for
`pi-goal-list-loop-audit@0.35.1` also pass. The only remaining dependency is Pi
itself: event-safe host session replacement is documented but cannot be
implemented inside this plugin.

## Remaining tasklist — v0.35.1

The previous leftovers are now closed or explicitly handed to the host. The
checkboxes remain as an auditable record of the decisions and implementation.

- [x] **Decide the long-running judgment policy.** Durable root-cause fixes are
  preferred; safe/reversible/testable in-scope workarounds are allowed when
  useful; unattended runs ask only at genuine decision boundaries and otherwise
  take the safest contract-preserving path.
- [x] **Design the designer role.** Explicit `Agent: Designer` / `Role:
  designer` / `Designer: yes` declarations route a read-only architecture,
  risk, affected-file, and verification checkpoint; unavailable Designer
  capability falls back inline.
- [x] **Implement and test the designer role.** Persistence, settings, managed
  agent provisioning, prompt routing, status/markdown surfaces, fallback, and
  focused tests are shipped in v0.35.0.
- [x] **Design and implement a drafter model chain.** Dedicated primary and
  ordered fallback settings resolve without provider requests, retry the
  existing interview generically, use a bounded session last resort, serialize
  model restoration, and leave main/auditor recovery unchanged.
- [x] **Coordinate the Pi host-session API gap.** The exact SDK boundary and
  event-safe replacement contract are documented in
  `audit/PI-HOST-SESSION-REPLACEMENT-REQUEST-2026-08-15.md`; `/new` remains
  truthful until Pi supplies the capability.
- [x] **Compare continuation approaches.** The official Codex, Claude Code, and
  DeepSeek Harness comparison is recorded in
  `audit/CONTINUATION-APPROACH-COMPARISON-2026-08-15.md`; decision: retain
  durable glla checkpoints and request a host replacement seam, with no quota
  inference or provider-specific retry redesign.
- [x] **Align drafter controls and agent terminology.** The drafter exposes
  model-specific thinking with an explicit session-level inheritance choice;
  the temporary lease reapplies it through fallbacks and restores the session
  state. The Backups menu is now Agents, while persisted keys stay compatible.

##
/home/dracon/Pictures/Screenshots/Screenshot_20260814_140543.png 
after draft we get this not even sure why
i could start it so fine but just didnt auto start

##
no provider activity was observed
maybe we are giving up too eagerly we should keep retrying hard
even if the providers is dead the right call is to keep spamming the retry so we mgiht pick back up, if we just igve up then that guanrtees it 
/home/dracon/Pictures/Screenshots/Screenshot_20260814_140947.png 

##

no turn start
/home/dracon/Pictures/Screenshots/Screenshot_20260814_164621.png 

##

very odd
/home/dracon/Pictures/Screenshots/Screenshot_20260814_165408.png 
restarting and resuming got it moving 
/home/dracon/Pictures/Screenshots/Screenshot_20260814_165458.png 

##
auditor timed out
/home/dracon/Pictures/Screenshots/Screenshot_20260814_170134.png 

we should retry the auditor really but also investigate why we timed out

##
auditor parker no verdict, we stopped
/home/dracon/Pictures/Screenshots/Screenshot_20260814_170313.png 
/home/dracon/Pictures/Screenshots/Screenshot_20260814_170627.png 

##
blocked, waiting for non quota, but we should not cheeck for quota, we jsut agressively retry, no quota checking, and extra retries after the start of every hours so lieke 15:00 , 16:00, 17:00 
/home/dracon/Pictures/Screenshots/Screenshot_20260814_170654.png 
/home/dracon/Pictures/Screenshots/Screenshot_20260814_180007.png 

##
hsot session lost
/home/dracon/Pictures/Screenshots/Screenshot_20260814_170942.png 

cant be restarted with resume either we must restart pi

##

/home/dracon/Pictures/Screenshots/Screenshot_20260814_223137.png 
/home/dracon/Pictures/Screenshots/Screenshot_20260814_223137.png 

host session lost

##

pi did not start turn

/home/dracon/Pictures/Screenshots/Screenshot_20260814_223616.png 
/home/dracon/Pictures/Screenshots/Screenshot_20260814_223616.png 

## feat

we want to show the total time spent
in fact coudl lets double check how we do the ui

# LATER

## research

codex is doing pretty good continuation without anything we seem to have we check it
we are also checking claude clode and the newest deepseek-harness too, we have all lcally

https://github.com/deepseek-ai/deepseek-harness

## idea
i wonder about a preference ai has, now generaly this can be argued to be fine but doesnt fit the long running task vibe that ai is not always long term minded
ai suggest fixes that work fine now an in cases are fine jsut to get to the next step but generally we want long term solution and esp in brownfield projects with tests ai coudl be a bit too status quo
now obviously there is right anwser here but essentily means that work stalls and hacks are promoted as primary considearations as (recommended) it is not too bad but it assumes more of hands on than 
long running automation, but its bit preference do we want to be pureist to the establish goal or more opportunistic and long term minded, so it mgiht lead toward what works now versus what works best

this also leads to more questions i think, that interrupts long running goals needlessly. now i am not against questions but if the question is some hack then no

/home/dracon/Pictures/Screenshots/Screenshot_20260812_054032.png 
/home/dracon/Pictures/Screenshots/Screenshot_20260812_054236.png 

## feat
this is soemwhat more general but still a feature we can build in cosndiering we have an auditor too
we can have a designer sub agent and when specified then tasks that are called for the designer are delegated to it 
of course this can have fallback too and if deisgner not set, or not available then we fallback
designer subagent as an option and the plan / list is made with space for it 

## feat 

drafter model with fallbacks
