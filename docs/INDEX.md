# docs/ — index

Ordered by reading path, not alphabetically.

## Active focus (recent work, durable artifacts)

- `../audit/INDEX.md` — top-level entry for the audit trail; the
  "Active focus (2026-08-17 → 2026-08-19)" section lists the seven
  follow-up categories from the most recent full audit plus the
  v0.35.x release trail.
- `../audit/COMPLETION-SUMMARY-POLICY-2026-08-19.md` — six-label recap
  contract (Outcome / Changed / Evidence / Tests / Unresolved / Next)
  that `complete_goal` now recommends.
- `../audit/LONG-TERM-PREFERENCES-POLICY-2026-08-19.md` — typed-boundary
  policy for cross-session memory: conversation / completion / auditor /
  Explore transcripts are NOT auto-promoted to preferences.
- `../audit/AUDIT-POLICY-CONTROLS-2026-08-19.md` — four-mode postaudit
  cadence contract (`none` / `completion-only` / `every-n-tasks` /
  `periodic`).
- `../audit/GLLA-MENU-PRESENTATION-2026-08-19.md` — `/glla` menu noise
  review and the Status / About tab proposal.

## Entry points
- `../README.md` — what the plugin is, install, quickstart
- `../INSTALL.md` — manual install / symlink setup
- `../CHANGELOG.md` — user-facing changelog; current package version is
  at the top of the file (use `/glla version` to compare with the
  registry).

## Architecture
- `DESIGN.md` — plugin design (types, state, extension lifecycle)
- `GLLA-POSITIONING-AND-DECOMPOSITION-2026-08-08.md` — ecosystem
  positioning, competitor review, and the goal.ts decomposition plan
  (the current strategic doc — read this before touching
  `extensions/loops/goal.ts`)
- `VISION-ASSIST.md` — vision-assist plugin notes
- `RELEASING.md` — how to publish to npm

## Supporting material
- `../prompts/` — goal/loop drafting prompt templates
- `../schemas/` — goal state JSON schema
- `../examples/` — example objective files
- `../CHANGELOG.md` — user-facing changelog (unreleased at top)

## Repository-only material
The audit history and competitor research live in `audit/` and `.research/`
for contributors, but are intentionally not included in the npm tarball.

## Research material
`.research/` — competitor plugin sources pulled from npm tarballs for study
(gitignored, local only). Re-pull with `cd .research && npm pack <pkg> &&
tar xzf <tgz>`; see the positioning doc's appendix for the package list.
