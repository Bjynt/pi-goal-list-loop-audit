# docs/ — index

Ordered by reading path, not alphabetically.

## Entry points
- `../README.md` — what the plugin is, install, quickstart
- `../INSTALL.md` — manual install / symlink setup

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
