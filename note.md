# Now

## Visual auditor follow-up — native vision first, external tools optional

For visual objectives, use the native image capability of the current main/auditor model first; do not assume MMX or any other external CLI is installed. The vision guidance/router now defaults to the current model, uses MMX only when availability is explicitly confirmed, and fails closed when neither native vision nor a confirmed external provider exists. Fresh evidence is still mandatory. The durable/defer goal has a production-path integration test and a fresh production-widget projection; the remaining gap is obtaining an authentic live Pi TUI capture rather than a local projection.

# Next

- Decide whether `pi-subagents` needs true runtime fallback; if so, design bounded retry/respawn and auth-gate coverage rather than treating startup selection as failover.
- Reproduce or explicitly disposition the remaining unrelated full-suite failures without weakening the durable/order evidence.
- Obtain a genuine live Pi TUI capture if the environment permits; otherwise keep the projection-vs-TUI distinction explicit.
- Keep visual-audit evidence honest when the current model lacks native image input: use only a confirmed external provider or state that visual evidence is unavailable.

## we are still not doing perfect summaries at the end of objectives

lets look into how others do it plugins and codex/claude/agy

## when we are making up the objective during goal start or audit for example show that we are instead of jsut looking laggy and frrozen

# Later

## check out out other harnesses and goal extensions 
nottably pi goal x, deepseek harness, codex, cladue, antirgravity, grok harness

## nvidia AVO careful consideration 

we have prs too it too but apparently incomplete
https://github.com/DraconDev/pi-goal-list-loop-audit/pulls

# Idea

