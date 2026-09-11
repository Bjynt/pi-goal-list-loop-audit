# Stale-version surfacing — v0.38.44 (2026-09-10)

Field: `Screenshot_20260909_161057` — a live pi-studio session rendered the
pre-0.38.39 summary voice while the repo shipped 0.38.42, with nothing
visible indicating the session ran old GLLA.

## What shipped

- Status line carries the running version on every branch:
  `glla: … · v0.38.44`, plus `· update vX available` when the registry is ahead.
- New `extensions/glla-update-check.ts`: render reads the
  `.pi-glla/update-check.json` sidecar only (never network); a throttled
  24h-TTL fire-and-forget `npm view` refresh rides the 7 command/lifecycle
  contact points inside `replayApprovalSummariesOnContact`; silent on failure.
- Pure `compareVersions`/`updateCheckPath` live in `glla-version.ts` (no
  import cycle); the display module keeps zero runtime imports via a
  precomputed `versionTail` extra resolved in `goal-ui.ts` (running version
  memoized — fixed for the process lifetime).
- `/glla version` appends `Registry latest` + the concrete update path
  (`pi install npm:pi-goal-list-loop-audit@latest` then `/reload`) when the
  sidecar proves staleness; legacy output unchanged with no cache.
- `INSTALL.md` gains an `Updating` section (nudge, command, `/reload`-every-session).

## Verification

- `release:check` gate 2062 pass / 0 fail (`/var/tmp/glla-version-release-check.log`).
- `tsc --noEmit` clean; `tests/glla-update-check.test.ts` (7) +
  `tests/glla-version.test.ts` + status-tail pins in `tests/display.test.ts`.
- Tag/release `v0.38.44`, publish run `34493677566` success, npm `latest` `0.38.44`.

## Deferred

- Narrow-terminal truncation drops the version tail first (correct priority:
  state/actionability outranks version); accepted, documented in code.
