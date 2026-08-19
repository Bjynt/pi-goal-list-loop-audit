# Pi host-session replacement request — 2026-08-15

## Status

The plugin-side investigation and coordination artifact are complete. No
upstream issue or pull request was opened from this checkout; that requires an
explicit operator decision. Until Pi exposes an event-safe replacement API,
glla retains the truthful `/new` guidance and durable parked state.

## Evidence from the installed Pi SDK

The repository currently type-checks against
`@earendil-works/pi-coding-agent` `0.84.2`.

`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
defines `ExtensionContext` with a read-only `sessionManager`, model registry,
send/compaction/liveness operations, and no session-creation or session-switch
method. `ExtensionCommandContext` adds `newSession()`, `fork()`,
`switchSession()`, and `reload()`. Those methods are explicitly documented as
safe for user-invoked command handlers and are not present on event contexts.

That boundary explains the incident class recorded in
[HOST-SESSION-LOST-2026-08-10.md](HOST-SESSION-LOST-2026-08-10.md): glla can
persist the objective, fence stale callbacks, classify a dead handle, and
rebind when Pi delivers a successor `session_start`; it cannot manufacture the
successor from the stale event context.

## Requested host capability

Pi should expose one host-owned, event-safe session replacement operation. The
exact name is a Pi design choice; the contract matters more than the spelling.
An illustrative shape is:

```ts
interface HostSessionReplacementOptions {
  reason: "stale-extension" | "continuation-not-started" | "operator-request";
  parentSession?: string;
  withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}

interface ExtensionContext {
  replaceSession(options?: HostSessionReplacementOptions): Promise<{
    cancelled: boolean;
    sessionId?: string;
  }>;
}
```

The host implementation should own the lifecycle boundary and guarantee:

- the old context is invalidated before replacement work can reuse it;
- the replacement gets a fresh command-capable context through an awaitable
  callback, just like the existing command-side `withSession` callbacks;
- the replacement is generation- and session-identity fenced, so delayed work
  from the old session cannot rebind the loop or send a duplicate;
- cancellation and user shutdown are explicit outcomes, not inferred from a
  missing event;
- a repeated request with the same operation token is idempotent; and
- the host emits the normal shutdown/start/rebind lifecycle events so plugins
  do not need a private dispatch path.

## Acceptance tests for the host

Pi-side coverage should include:

1. An event handler calls replacement after a stale-handle or no-turn-start
   proof and receives a fresh context in `withSession`.
2. A replacement cannot produce two live owners when the original request is
   retried.
3. A user cancellation leaves the original durable transcript and returns
   `{ cancelled: true }`.
4. A late callback from the old generation cannot send, switch models, or
   claim ownership in the successor.
5. The operation works from TUI/RPC modes and remains unavailable to arbitrary
   untrusted prompt text.

## Plugin boundary until then

glla will continue to:

- persist dispatch, goal, queue, and audit state before attempting recovery;
- stop blind sends after the bounded no-turn-start proof window;
- tell the user whether the failure is “turn start not observed” or “host
  session lost”;
- consume a valid fresh lifecycle event when Pi supplies one; and
- recommend `/new` only when the cached event context is genuinely stale and
  no replacement boundary has arrived.

It must not cast an event `ExtensionContext` to
`ExtensionCommandContext`, call private Pi internals, or pretend a new session
was created after a failed send.

## Verification

The local type evidence was re-read on 2026-08-15. Existing lifecycle tests
cover stale classification, bounded start proof, durable parking, and fresh
session rebind. The remaining missing acceptance tests are host tests and
belong upstream once the API exists.

## Fresh boundary assessment — 2026-08-19

The installed Pi package is still `0.84.2`. A fresh read of
`dist/core/extensions/types.d.ts` confirms that `ExtensionContext` exposes a
read-only `sessionManager`, while `newSession()`, `switchSession()`,
`fork()`, and `withSession()` remain restricted to `ExtensionCommandContext`.
The documented lifecycle still emits `session_shutdown` followed by
`session_start` for user-controlled session replacement. No event-safe
`replaceSession()` capability exists.

This confirms that glla's current plugin-side approach is the correct safe
containment strategy, not a mistaken attempt to own the host lifecycle: it
persists and parks work, fences stale generations, absorbs only a validated
file-backed host successor, self-heals only after a healthy same-session
probe, and never casts an event context or injects private `/new` actions.
It is not a complete automatic replacement solution. The remaining fix belongs
upstream in Pi: either guarantee lifecycle events for every real host-session
replacement or expose an idempotent, cancellation-aware, host-owned
replacement API returning a fresh command-capable context.

**Concrete next action:** open an upstream Pi issue/request with this document
and the five acceptance tests above when the operator authorizes that external
action. Until then, keep this item classified as an upstream/API boundary,
retain the current fallback, and do not make a local unsafe replacement hack.
