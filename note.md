# Now

## Better status visuals, not just better but arguably broken

The status/widget surfaces deserve a visual pass: decide what a user needs to
see for active work, queues, auditor state, stalls, recovery, and optional
subagents without turning the TUI into a wall of text. The existing
`/glla agents` panel tracks workers, but most sessions have few; each visible
worker should still make its purpose and current activity understandable.

Evidence:
- /home/dracon/Pictures/Screenshots/Screenshot_20260822_132806.png
- /home/dracon/Pictures/Screenshots/Screenshot_20260822_200250.png
- /home/dracon/Pictures/Screenshots/Screenshot_20260825_223048.png

> Most of the time we dont have that many subagents showing what they are and what they do would be useful
/home/dracon/Pictures/Screenshots/Screenshot_20260825_225550.png

> After better visuals we also plan on uploading a thumnail for the start of the readme that is also the thumbnail on the pi store

# Next

## Maintainer issue and PR review

The live inventory is recorded in
`audit/GITHUB-MAINTAINER-INVENTORY-2026-08-25.md`. Four plugin-owned issues
(#23, #30, #32, #34), the related launcher PR #24, and two blocked feature PRs
(#22, #36) need explicit follow-up decisions; upstream/out-of-scope requests
remain catalogued without local action.

## Compaction fallback for long goals

Sometimes a large goal gets stuck because the current model cannot compact its
context. Evaluate a dedicated compact/recovery fallback model path, including
whether a free model is acceptable, without treating this as a price hack.

## Optional subagent provider boundary

`@tintinweb/pi-subagents` is an optional runtime companion: GLLA's core runs
inline without it, while the full development suite uses it for integration
coverage. Before relying on the optional path more heavily, add a genuine
no-provider smoke check and decide whether `defaultAgentDir()` should honor
custom `PI_CODING_AGENT_DIR` instead of assuming `~/.pi/agent`. Keep this
runtime boundary separate from README wording tests.

# Later

## `/glla bug` capture flow

Consider a `/glla bug` command that records observed failure context and useful
logs, while keeping the capture artifact separate from durable goal state.

## audit other goal plugins

# Idea

## We are bad at guesing how long tasks take can we record the time it took once then guess basd on that

the problem is that lately we were defaulting to some safe long waits but that is pretty bad velocity
so i think we need a better solution
we should investigate how oters do it like antigravity most of all is quite snappy but codex kind of too
/home/dracon/Pictures/Screenshots/Screenshot_20260826_000412.png

## Audit command naming

`/list audit`, `/goal audit`, and `/loop audit` may need clearer distinctions
from `/list start`, `/goal start`, and `/loop start`. Avoid launching a broad
audit immediately when the user has not specified what they mean.

one problem is htat hte audit often goes outside the folder so i launch audit on a page
then next i see everything is getting audited

## Fewer mid-execution questions

Questions are useful for real decisions, but interrupting a list/goal/loop for
routine implementation choices is costly. Save non-blocking questions for the
end, ask only when the choice changes the result, and gather more constraints
in the initial draft.

# Done

## Documentation and test-boundary cleanup

README and INSTALL now describe current first-use behavior without pinning a
literal release version or recommending the advisor extension. README prose and
positioning assertions were removed from runtime tests; only stable package and
critical behavior checks remain. The subagent recommendation is conditional on
parallelism being worthwhile.
