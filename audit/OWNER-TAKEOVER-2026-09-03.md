# State-root owner takeover — v0.38.11 (2026-09-03)

Field incident, same day: two live `pi` hosts shared one folder
(vidpro-extension) — a 12.5h session suspended in the background plus a
56-minute duplicate that claimed `owner.json` at 19:48. The denied session
could only show a dead-end warning; resolution was `kill` in a terminal.

## What shipped

- **`/glla owner`** — read-only inspection, deliberately ungated (a denied
  session is exactly the one that needs it): holder pid + comm, claimed
  time, idle since heartbeat, holder session id, and a verdict line
  (you / unclaimed / released / dead / recycled / live-foreign + resolve).
- **`/glla takeover`** — consented steal with verification:
  - dead / released / missing / self records: reclaim via the existing
    `claimProcessOwner`, no process touched, `owner_takeover` ledgered;
  - **recycled pid**: the current occupant started after the claim, so it
    cannot be the claimant — unlink without signaling (never SIGTERM an
    unrelated process that inherited the number);
  - **live foreign owner**: needs-confirm first (nothing sent, nothing
    claimed); after `ctx.ui.confirm`, refuse positively-identified non-pi
    processes, SIGTERM, poll up to 5s for exit, claim only after verified
    death. A survivor is NEVER claimed — two live writers is worse than
    read-only. Every path ledgered (`owner_takeover` /
    `owner_takeover_refused` with reason).
- **Owner heartbeat**: the owner's claim `at` refreshes throttled (60s) on
  `agent_end`, so `/glla owner` idle is real signal — a session suspended
  since morning reads idle-hours; an active one reads idle-seconds.
  `writeOwnerFile` already no-ops for foreign owners, so the hook is safe
  from any session.
- Both read-only warnings now point at `/glla owner` + `/glla takeover`.

## Safety design (the part that matters)

- Errors bias toward live-foreign (ask the user), never toward recycled:
  the recycled verdict needs the occupant younger than the claim by
  `RECYCLED_MARGIN_MS` (60s) so wall-clock vs boot-clock skew can never
  manufacture a two-writer split.
- Unknown platform (no /proc): start time unknowable → never recycled;
  unknown cmdline → `looksLikePi` false → live path needs confirm, and a
  positively non-pi comm hard-refuses. The user confirm is the final
  authority; the guards are the backstop.
- Headless (no confirm UI): takeover of a live owner aborts; quiet paths
  still work. `stateRootPending` refuses takeover outright.

## Verification

- `tests/state-root-owner.test.ts` (17 tests): classify matrix incl.
  margin + unknown-start abstention, cmdline/comm guards, dead/self/none
  reclaim with zero signals, needs-confirm gate, real-SIGTERM end-to-end
  against a pi-shaped child (exit verified, claimed after), SIGTERM-ignorer
  refusal with no claim, recycled unlink with the occupant provably alive,
  heartbeat throttle + foreign-root protection, both command flows,
  warning-text pins.
- Full suite green (`release:check`), `tsc` clean.
