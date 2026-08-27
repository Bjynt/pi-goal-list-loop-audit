# Now

The status-surface redesign is complete and recorded under `# Done`. The
current eight-report GLLA reconciliation is recorded in
`audit/GITHUB-MAINTAINER-INVENTORY-2026-08-25.md`: external reports received
boundary evidence and were closed as not planned, while the public no-stream
containment shipped in v0.35.71.

# Next

No follow-up from this reconciliation is active. GLLA continues to own only
its lifecycle, durable state, public recovery boundaries, and evidence
surfaces; Pi, the OS, providers, and other plugins remain outside its fix
boundary.

# Later

## we always want a useful summarywhen objective completes

## README/Pi Store thumbnail

After the status-surface work, upload a thumbnail for the README opening and Pi
Store listing. Keep this separate from runtime UI and release behavior.

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

antigravity doesnt wait it just keep checking if done maybe we shoulddo the same cause it leads to lno guess and faster work

## Fewer mid-execution questions

Questions are useful for real decisions, but interrupting a list/goal/loop for
routine implementation choices is costly. Save non-blocking questions for the
end, ask only when the choice changes the result, and gather more constraints
in the initial draft.

