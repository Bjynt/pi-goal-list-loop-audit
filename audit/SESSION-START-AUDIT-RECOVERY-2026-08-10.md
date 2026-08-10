# Session-start recovery for parked detached audits — 2026-08-10

## Status

Implemented in the unreleased follow-up after v0.34.121. This is a plugin-side
recovery improvement; it does not create or replace a Pi host session.

## Finding

When a host/session boundary interrupted a detached completion audit, glla
already preserved the completion claim and changed it to
`phase: "recovery-pending"`. A valid successor session could rebind the main
plane, but the parked claim still required `/goal resume`. That was the
remaining manual-recovery step in the stale-session failure family.

## Lifecycle decision

`session_start` is the recovery trigger because it is the host-owned boundary
after Pi has created or rebound a session. `agent_settled` is not a safe
replacement: it only reports that an agent run settled and does not fire when
the turn never starts. `session_shutdown` remains persistence/cancellation
only.

On `session_start`, glla now applies the existing recovery policy to both:

- an interrupted `status: "auditing"` claim, which is first released to
  `recovery-pending`; and
- a claim already persisted as `status: "paused"` with
  `pendingCompletion.phase: "recovery-pending"`.

Exactly one fresh detached attempt is dispatched when either a matching
session handoff/rebind proves a real successor or the user has enabled global
Auto-resume. An ordinary cold/manual startup remains paused and still gives
`/goal resume` guidance. The auditor verdict, revision, archive, and list
cascade gates are unchanged.

## Safety boundaries

- No event handler calls `newSession()`: pi exposes replacement methods on
  command contexts/`AgentSessionRuntime`, not the public event
  `ExtensionContext`; glla cannot manufacture a command context.
- No stale `pi.sendMessage`, `sendUserMessage`, or transcript turn is used to
  trigger recovery.
- Old worker callbacks remain generation/attempt fenced and cannot apply a
  verdict to the replacement claim.
- A mere tool call from a file-backed successor is not a recovery trigger; the
  lifecycle proof is still required.
- If Pi never creates a fresh session, this change cannot repair the host; the
  truthful `/new`/restart guidance remains necessary.
- Literal hourly Pi process/session replacement remains out of scope.

## Evidence

The behavioral suite covers validated handoff recovery, explicit Auto-resume
recovery, cold-start/manual holding, and successor/no-blind-resend behavior:

```text
bun test tests/behavioral-orchestrator.test.ts
88 pass / 0 fail
```

The source contract remains TypeScript-clean:

```text
npx tsc --noEmit
TypeScript: No errors found
```

Pi documentation sources consulted: `docs/extensions.md` (session events,
command contexts, replacement lifecycle footguns and message APIs) and
`docs/sdk.md` (`AgentSessionRuntime` replacement APIs). Pi core/host changes
would be required for a plugin to manufacture a missing replacement session.
