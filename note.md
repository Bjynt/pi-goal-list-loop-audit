# Now

## Investigate and fix long-running subagent stalls

The watchdog currently detects and warns about a child that stops producing
progress, but it does not take a bounded recovery action. The field behavior
is especially bad when an Explore/general-purpose child remains visibly
running for 70–120 minutes while the main session only repeats a warning.
Preserve legitimate telemetry and healthy long reasoning; act only after a
second, longer no-progress threshold and leave an honest resume/cancel path.

Evidence:
- /home/dracon/Pictures/Screenshots/Screenshot_20260824_091051.png
- /home/dracon/Pictures/Screenshots/Screenshot_20260824_124530.png
- /home/dracon/Pictures/Screenshots/Screenshot_20260825_141357.png

## Why this is first

This is the only item with fresh evidence of an active, unbounded failure
mode. The current code has a 5-minute tracked-record warning and a 20-minute
event-only warning, but `subagent_hang_detected` is notification-only.

# Next

## Replan/repair UX audit

Recheck the repair-card path from the saved-intent screenshot and make sure a
malformed list item cannot keep re-firing forever, the original target remains
recoverable, and `/list next`/`/list resume` are always the truthful actions.

Evidence:
- /home/dracon/Pictures/Screenshots/Screenshot_20260823_181617.png

## PR #21 — review only, no wholesale merge

https://github.com/DraconDev/pi-goal-list-loop-audit/pulls/21

The state-root portion has already been ported and hardened on `main`; the
blank-until-resume auditor-surface work was developed separately and is now
hardened on `main`. Do not merge or close this PR without explicit
confirmation. Revisit only to extract any still-unported, independently
useful change.

## Command semantics and question timing

Review `/list audit` versus `/list start`, `/goal start`, and free-form
objectives so audit intent is explicit. Keep mid-execution questions for real
trade-offs; prefer more drafting up front and infer quality-preserving
implementation details from the objective.

# Next 2

## Compaction fallback for long goals

Sometimes a large goal gets stuck because the current model cannot compact its
context. Evaluate a dedicated compact/recovery fallback model path, including
whether a free model is acceptable, without treating this as a price hack.

## Replan-required visibility

Keep the replan state obvious and actionable when a saved objective cannot be
completed as written. This is related to the repair-card item above, but stays
as a user-facing follow-up if the first investigation finds the persistence
path sound.

# Later

## Better status visuals

The status/widget surfaces deserve a visual pass: decide what a user needs to
see for active work, queues, auditor state, stalls, and recovery without
turning the TUI into a wall of text.

Evidence:
- /home/dracon/Pictures/Screenshots/Screenshot_20260822_132806.png
- /home/dracon/Pictures/Screenshots/Screenshot_20260822_200250.png

## Documentation refresh

Update the README and docs for new visitors after the current behavior settles;
start with the installation and first-use path rather than an exhaustive
changelog narrative.

## `/list add` accidental command

I rarely use `/list add` and sometimes type it instead of an audit. Revisit
command wording/completion only after `/list audit` semantics are settled.

## `/glla bug` capture flow

Consider a `/glla bug` command that records observed failure context and useful
logs, while keeping the capture artifact separate from durable goal state.

# Idea

## Audit command naming

`/list audit`, `/goal audit`, and `/loop audit` may need clearer distinctions
from `/list start`, `/goal start`, and `/loop start`. Avoid launching a broad
audit immediately when the user has not specified what they mean.

## Fewer mid-execution questions

Questions are useful for real decisions, but interrupting a list/goal/loop for
routine implementation choices is costly. Save non-blocking questions for the
end, ask only when the choice changes the result, and gather more constraints
in the initial draft.

# Superseded / resolved

- **Objective cannot complete / subagent called `complete_goal`:** the child
  session now fails closed at the host boundary; only MAIN may mutate goal,
  loop, or list state. Fixed and covered by the v0.35.62 host-boundary work.
- **List vanished after reload / `/list resume` had nothing visible:** queue
  hydration and queue-only visibility were repaired and released in v0.35.61.
- **Agent completed a goal in the middle of a list:** child ownership and exit
  handling were hardened in v0.35.62; retain the screenshot only as historical
  evidence unless a fresh reproduction appears.
- **Auditor selector parity:** auditor model selection now uses the model picker
  and chooses thinking immediately with the selected model; parity tests cover
  persistence and forbidden-model filtering. The standalone thinking row is a
  convenience path, not the primary selection flow.
