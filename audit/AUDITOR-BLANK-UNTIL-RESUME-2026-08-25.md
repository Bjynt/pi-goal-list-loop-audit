# Auditor context held until resume — 2026-08-25

## Verdict

**Shipped in v0.35.63.** A cold session restore keeps the durable unfinished
goal/list objective and status visible, but suppresses only newly projected
previous-auditor feedback until a continuation consent path is admitted.

The existing Pi transcript is historical and is not edited. The gate prevents
GLLA from adding a fresh continuation prompt or stale auditor report to model
context before the user (or an explicitly enabled auto-resume policy) elects
to continue.

## Contract

- Cold restore with auto-resume off:
  - reloads the objective/list/queue state;
  - paints the objective and the held/resume status in the UI;
  - sends no continuation or user-message injection;
  - omits `LATEST AUDITOR` report text from new continuation context and the
    durable required-fixes feedback projection.
- `/goal resume`, `/list resume`, `/list next`, `/glla resume`, an admitted
  `/loop resume`, validated lifecycle continuity, and global `autoResume: true`
  release the surface gate only on consent paths that can continue work.
- A rejected or held scheduler attempt does not release the gate.
- Durable `auditHistory`, objective markdown, queue sidecars, and the prior
  transcript remain unchanged.

## Implementation

- `extensions/loops/goal-auditor-surface.ts` owns the dependency-free,
  process-local surface gate.
- `extensions/loops/goal-activation.ts` suppresses the surface at the cold
  load barrier and releases it only for admitted continuation consent.
- `extensions/goal-continuation.ts` gates the latest report in continuation
  and post-compaction context.
- `extensions/goal-loop-display.ts` gates only stale auditor feedback; the
  objective/status card remains visible.
- Explicit goal/list/glla/loop continuation commands release the gate after
  passing their existing foreign/stale guards. In particular, `/goal resume`
  now probes active-idle and paused paths before releasing; a stale paused
  resume still persists the existing `active + interrupted` recovery marker,
  but cannot expose the old auditor context.

This is intentionally separate from the state-root work derived from PR #21:
state persistence and auditor-context consent are related lifecycle concerns,
but independent user-facing behaviors.

## Verification

- `tests/auditor-blank-until-resume.test.ts`: **4 pass / 0 fail**, including
  rejected stale `/goal resume` admission.
- `tests/stale-interrupt-resume.test.ts` and
  `tests/load-without-autostart.test.ts`: passed in the focused regression
  run; existing stale-resume persistence behavior remains covered.
- `npx tsc --noEmit`: **passed** (`/tmp/tsc-auditor-blank-repair.log`).
- Fresh repaired `npm run release:check`
  (`/tmp/rc-auditor-blank-repair.log`): **1583 pass / 0 fail / 2 skipped**,
  1585 tests across 146 files in 258.01s; Jiti smoke passed and
  `npm pack --dry-run` produced `pi-goal-list-loop-audit-0.35.63.tgz`.

## Post-audit repair

The first completion claim was correctly disapproved because `/goal resume`
released the surface before its stale/foreign admission guard. The fix moved
`releaseAuditorSurface()` after the admitted branches, added an entry probe for
active-idle resumes, and added the behavioral stale-resume regression above.
A rejected stale resume now leaves the gate suppressed, sends no continuation,
and preserves the durable stale-session recovery marker. The fresh repaired
release gate above supersedes the earlier pre-repair evidence.
