# Continuation dispatch reliability — 2026-08-19

## Question

Investigate the report that Pi accepted a continuation but never started a
turn, leaving no tool calls, tokens, or visible progress.

## Bounded regression

Command:

```bash
timeout 60 bun test tests/behavioral-orchestrator.test.ts -t "v0.34.88: a transient no-turn-start miss self-heals with exactly ONE verbatim retry"
```

Result:

```text
1 pass
116 filtered out
0 fail
Ran 1 test across 1 file.
```

The regression constructs the accepted-without-`before_agent_start` state with
a bounded 300 ms start-proof window. It verifies that glla:

1. persists the accepted dispatch before sending;
2. distinguishes enqueue acceptance from a real turn-start proof;
3. sends exactly one automatic retry after the first no-start timeout;
4. resends the exact original payload; and
5. settles on the simulated owner start proof without another send.

## Disposition

The symptom is covered by glla's existing bounded watchdog and is not a
missing local retry path. No glla source fix is supported by this regression.
The test reproduces the dispatch state and proves the intended local behavior,
but it does not reproduce the original live Pi host failure itself. If the
live symptom persists after the one retry and the explicit no-start stand-down,
the remaining fault is in Pi's turn-trigger/session lifecycle or its observable
start-event path, not a reason for glla to add blind retries.

Keep the current safeguards: durable dispatch identity, generation/session
fencing, one retry maximum, explicit stand-down, and fresh-session/manual
recovery guidance. A future live reproduction should capture the Pi event
sequence (`continuation_dispatch_accepted`, `before_agent_start`/`turn_start`,
`agent_start`, and session lifecycle events) before any upstream request.
