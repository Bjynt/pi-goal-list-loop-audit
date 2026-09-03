# Over-cap starvation ladder — compact first, then 5 ordered recoveries (2026-09-03)

## 0. Field picture

Three 2026-09-03 screenshots show long-running goals (108–118h, 13–17M tokens)
pinned at 119–243% of the 200k window: every turn ends `Response was truncated
before completion`, `Context overflow recovery failed: Summarization failed`,
`auto-compaction appears to be off`, and the heartbeat keeps re-firing
continuations into the same wall (`stall 1/5`). The user decision: **compact
first** — and the open question: what do we do when context is *already* over
cap, where summarization itself cannot run?

## 1. The ladder (user's 3 paths + 2 missing ones)

Ordered cheapest-first. GLLA automates what it owns (pi owns compaction and
sessions; GLLA never fights either):

1. **Trim + current-model summarize.** GLLA's deterministic context-checkpoint
   projection already strips repeat payloads to one authoritative checkpoint
   (no LLM), so a `/compact` retry may now fit. First resort, cheapest.
2. **Other model compacts.** Already shipped (v0.34.116): after a failed
   compact-and-retry inside the grace window, GLLA walks its fallback chain to
   a larger-context ref and retries there. Model switches otherwise stay
   user-approved — GLLA names the ref, the user flips it.
3. **`/new` + resume from disk.** The backstop that always works: goal, tasks,
   ledger and audits are durable in `.pi-glla/`; the post-compact resync
   re-anchors a fresh session with **no summarization needed**. Transcript is
   disposable, state is not.
4. **(missing) No-LLM projection.** The checkpoint projection needs no model
   at all — even with zero summarization budget, the next session starts from
   checkpoint + resync. This is why path 3 never loses work.
5. **(missing) Park + bounded choice.** When all automatic paths are exhausted
   the session must stop and say so (already: length-continue 3× cap parks,
   starvation refuse stops refires) instead of spinning 119%→243%.

## 2. What v0.38.6 ships

- **Compact-first nudge (new):** at ≥85% context (below the 90% starvation
  line) a one-shot-per-episode notify: run `/compact` now while summarization
  still fits. Episode resets below 80% or on a real compaction.
  (`shouldCompactFirstNudge`, `COMPACT_FIRST_NUDGE_PERCENT`, ledger
  `context_compact_first_nudge`.)
- **Ladder message (new):** the agent_end starvation yield notify now carries
  paths 1–3 + the no-summarization backstop + "automatic turns stay parked"
  instead of only the auto-compaction pointer. (`buildStarvationLadderMessage`.)
- **Send choke point (new):** `sendContinuation` refuses while
  `isContextStarvedRefused()` — every automatic path (agent_end, heartbeat
  rearm, loop tick, recovery) funnels through it, so the 223213 spin cannot
  recur. Silent ledger `continuation_send_refused_context_starved`; the
  heartbeat one-shot + yield ladder own user messaging. Explicit user commands
  (`/compact`, model switch, `/new`) need no GLLA turn, so refusing loses
  nothing.
- **Sticky refuse (fixed):** the refuse used to lapse 90s after the last yield
  even at 243% full. It now holds while the last-known percent stays ≥90%
  until a real compaction lands. (`lastContextPercent` sampled at agent_end.)
- Untouched: heartbeat refuse branch/ledger/text (pinned by existing tests),
  v0.34.116 model rotation, length-continue 3× park, resync re-anchor.

## 3. Verification

- New `tests/starvation-ladder.test.ts` (6 tests): band ordering 85<90,
  ladder text pins all paths, nudge episode machine, sticky-refuse matrix,
  send-path wiring pin, **behavioral** starved boot (streak pre-built →
  session_start auto-send refused in ledger, zero goal turns queued, goal
  stays active).
- `tsc --noEmit` clean; full serial suite green (1824 baseline + 6 new).
- Code diff: `loops/goal-ui.ts` (ladder/nudge/sticky),
  `loops/goal-runtime-globals.ts` (5 registrations), `goal-continuation.ts`
  (dep + 5-line refuse), `loops/goal.ts` (1-line wire),
  `loops/goal-activation.ts` (percent sample + nudge + yield text).
