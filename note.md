# Prio

## 0.37.3 — issue #40 loop stall — IN PROGRESS (fix landed locally, awaiting release)

https://github.com/DraconDev/pi-goal-list-loop-audit/issues/40 — /loop stalls every iteration: pi >=0.84 emits no before_agent_start for followUp continuations (0/10 acknowledged). Fix: dispatchStartAcknowledged now accepts agent_start/turn_start fallback (owner/gen/foreign still fenced) + GLLA_CONTINUATION_RETRY_BACKOFF_MS env.

https://github.com/DraconDev/pi-goal-list-loop-audit/issues

# Now

## we need to keep checking instead of waiting for tasks that take a while

so we might guess x task 10 minutes but mgiht takes only 10 seconds, but would we pick up work after 10 seconds? — policy: event-driven + 250ms→15s adaptive fallback already in ContinuousSupervisor; loop stall fix restores the primary signal so fallback is not the only path.

## we need ot cut down on questions mid execution ideally none jsut finish the objetive unless critical 

we can compensave by asking more questions up front — policy: LONG_RUNNING_JUDGMENT_POLICY + ACTIVE_EXECUTION_QUESTION_GUIDANCE; drafting is the sole interview boundary, active execution is autonomous defaults.

# Next



# Next


# Later

## Review NVIDIA AVO

Assess whether the related PRs are complete and relevant after the higher-
priority GLLA work:

https://github.com/DraconDev/pi-goal-list-loop-audit/pulls

Assess whether the related PRs are complete and relevant after the higher-
priority GLLA work:

https://github.com/DraconDev/pi-goal-list-loop-audit/pulls
