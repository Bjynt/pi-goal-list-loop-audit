# Audit pass 2026-09-07 → v0.38.24 (goal `20260907131550-12ddoy`)

One project audit pass over display, lifecycle, and settings (fan-out
`e3d8278f`, three parallel read-only scouts, ~35-tool budget each).
44 candidate findings deduped against `.pi-glla/audit-loop/findings.md`;
11 display findings fixed under Tasks 1–4 (head owns liveness, `[WORKING]`
static badge, `active {age}` / `quiet {age}` labels, exceptions-only
`quiet` default, HUNG-never-silent flag unification), 6 lifecycle HIGH
under Tasks 5–6 (send-side `abortedStandDown` guards, zombie retry routes
on the abort-closure owner, cycle-reset consumes budget + honors the 24h
horizon), 8 lifecycle MED/LOW under Task 7, 5 settings MED under Task 8,
13 settings LOW under Task 9. Zero open findings remain (217 checked).

## Display decisions (user-grilled 2026-09-07)

- **Head owns liveness**: head keeps the lifesign (`stream {age}` readout +
  breathing glyph); status line drops the `LIVE` capsule and tails.
- **Exceptions only**: `quiet` (new default) renders troubled rows + the
  count line; healthy fan-out lives on the native fleet panel. The richness
  setting remains for opt-in `rich`.

## Lifecycle fixes worth knowing

- `sendContinuation` / `sendStallEscalation` / `sendLengthContinue` refuse
  on `flags.abortedStandDown`; terminal-notice refusal is scoped to the
  abort latch only so transcript closure still wins on stoodDown/pending.
- Zombie retry routes on the abort-closure `goalId`, never the live
  `state.goal` (a goal started during the 90s delay no longer strands the
  loop's retry).
- Ownership writes are compare-and-swap: a stale refresh never clobbers a
  live foreign claim (dead records still refresh — the heartbeat reclaims
  over dead holders through the same path).
- Fallback `agent_start` / `turn_start` acks refuse when a genuine user
  message landed after the dispatch was sent (stale ack, not proof).
- Length-continue lost its stale-classifier exemption: marker-less length
  text with live supervision still delivers; only the no-supervision stale
  case is now sanitized.
- Successor absorb and same-session self-heal share
  `clearDeadGenerationDispatch`: the orphaned pending that blocked the
  rebind tail's fresh schedule behind a truthful-sounding "re-armed"
  notify is cleared with a ledger.

## Settings fixes worth knowing

- `stallShortWords: 0` (= off, as the editor promises) survives
  normalization; the consumer already honored it (`wordCount < 0`).
- Auditor thinking has the drafter's inherit/clear parity: a
  `session — inherit` ladder row clears the override, and picking a
  non-reasoning model clears a stale override instead of immortalizing it.
- Bare `/glla fallbacks` is a read-only display again on stale handles;
  only `clear/off/unset/none` mutates (arg-aware gate).
- Typing the displayed `auto` in the notify editor round-trips to unset
  instead of persisting a shell command literally named `auto`.
- Comment/doc drift from the v0.38.23 redesign swept (richness/quiet copy
  at every surface, reviewer write→migrate lifecycle, DESIGN one-line row
  example, SETTINGS wedge vs aggressive default).

## Ship notes (v0.38.24 release)

- `publish` runs only on GitHub Release publication, not tag push — the
  v0.38.23 tag was pushed without a Release, which is why npm sat at
  0.38.22. (v0.38.23's code ships inside v0.38.24; no separate .23
  release — the tag remains for the record.)
- Publish was further blocked by the concurrency race: one `npm-publish`
  group serialized the ~10 min quality gate with publish, and GitHub
  cancels all but the newest queued run per group — with the daemon
  pushing ~every minute, every release run died superseded before firing.
  Real fix (commit `eae0550`, GLLA-owned workflow): quality churns in
  `glla-quality`, publish owns `npm-publish`. The re-fired release went
  pending → success with no supersede; `npm view` confirms `0.38.24`.

## Evidence

- `.pi-glla/audit-loop/findings.md`: 0 unchecked, 217 checked.
- Gate: `release:check` **1979 pass, 2 skip, 0 fail**; `tsc --noEmit` clean.
- Behavioral pins: `stall-handling` (fallback-ack source, zombie routing,
  cycle-reset budget/horizon), `last-wins` (CAS re-read, force recheck),
  `glla-stale-context` (bare fallbacks allowed / clear refused),
  `settings-editors` (notify auto round-trip), `model-picker` (auditor
  inherit/clear), `settings-menu-complete` (0 = off survives, quiet copy).
