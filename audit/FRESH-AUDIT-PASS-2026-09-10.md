# Fresh audit pass — 2026-09-10 (v0.38.44 → v0.38.45)

Goal `20260910204321-suiaxh`: ONE full-project audit pass. Three parallel
scout surveys (lifecycle/recovery/session, display/auditor/commands,
tests/docs/packaging), tight briefs, named dirs under cwd, ~30-40 budget.
All three reports collected; every finding below was re-verified against
the tree by the orchestrator before recording — six scout claims were
disposed as unproven/by-design (rationale at the bottom). 16 FIX recorded
in `.pi-glla/audit-loop/findings.md`, all fixed on `main`, one DECIDE
raised to the owner.

## Fixed (all on main, gate 2077+0 at ship — see release log)

- HIGH — `refreshUpdateCheck` spawn had no `error` listener
  (`extensions/glla-update-check.ts:64`): a missing/broken npm emits async
  `error`, which the outer try/catch cannot catch → unhandled crash on any
  command contact while the cache is stale. Now subscribes (fail-silent),
  `unref`s, ignores stderr/stdin, and caches only `isVersionLike` tokens.
  Pinned: error-swallow, garbage-stdout, future-cache-skip.
- HIGH — `formatGllaVersion` printed "up to date" for `version: "unknown"`
  (`extensions/glla-version.ts:84`): NaN→0 compare. Now makes no staleness
  claim without a running version, and both surfaces share the strict
  reader. Pinned.
- HIGH — `withoutStaleNext` ate the recorded-facts fallback Next
  (`extensions/completion-summary.ts:217`): `/review/i` matched
  "Next: review the durable record at …". Exempted via
  `RECORDED_FACTS_NEXT_PATTERN`; self-referential Nexts still drop. Pinned.
- MEDIUM — future-dated cache → per-contact spawn storm: refresh now uses
  the raw read for its TTL skip (`now - future < TTL` ⇒ skip). Pinned.
- MEDIUM — unvalidated npm token cached: `isVersionLike` gate in the close
  handler. Pinned.
- MEDIUM — `formatGllaVersion` hand-rolled parse diverged from the render
  read: canonical `readUpdateCheckRaw`/`readUpdateCheck` moved into
  `glla-version.ts` (cycle-free: `update-check` imports, not vice versa).
- MEDIUM — approval goalId dedup blocked post-delivery re-renders
  (`extensions/approval-render-store.ts:93`): refined to content-equality —
  exact duplicates still dedup (repeated settlements never double-notify,
  old `terminal-summary-delivery` contract preserved), new verdict lines
  queue fresh. The first cut broke that old test; the content rule
  satisfies both contracts. Pinned both ways.
- MEDIUM — `updateCheckPath` hardcoded `cwd/.pi-glla`: now
  `resolveGllaStateDir`-rooted (identical in cwd mode). Pinned default.
- LOW — dead `readUpdateCheck` import in `goal-commands.ts` removed.
- LOW — `auditorVerdictTally` `void now`: `now` now suppresses future
  `lastAt` (was "0s ago" via clamp). Pinned.
- LOW — `chatSafeDetailValue` nested husks: bounded fixpoint loop. Pinned.
- LOW — `clipSummaryValue` UTF-16 split: code-point ops throughout
  (including the boundary scan and last-space search). Pinned.
- LOW — label segmentation: shared `labelPositions` (last-occurrence) for
  both `compactCompletionSummary` and `completionSummaryLines`. Pinned.
- LOW — `recoveryResume` disjunct: no producer exists, but the restore
  gate also feeds `via:`/auto-resume off it and a foreign/older producer
  must still consent — documented as a reserved hook, semantics untouched.
- LOW — `compareVersions` prerelease equality: strictly numeric segments.
  Pinned.
- LOW — version-tail pins: paused-branch coverage added.
- DECIDE (open) — idle sessions show no running version (`withVersion`
  only attaches when a goal/list segment exists). Options before the owner.

## Disposed after verification (not recorded as findings)

1. `stripApprovalModel` case-sensitivity — inputs lowercased by
   construction (`chatSafeDetailValue(...).toLowerCase()`); anchored regex
   cannot misfire. No behavior; no change.
2. `foldCounts` vs lone `approvalBullet` duplicate — no caller renders both
   for one verdict; `terminalHumanBrief` picks one branch. Unproven.
3. `dispatchAccepted` true-on-replaced-slot — the send already happened, so
   the sent-ledger/streak writes are true regardless. Unproven bad outcome.
4. "Refresh rides the replay gate / read-only contacts spawn" — designed
   gate (no-live-work ⇒ no refresh need), TTL-throttled, fail-silent.
5. Ancient-cache no-age — conservative-true transient until the throttled
   refresh lands; no fabrication. By design.
6. `checkedAt: 0` fabrication + `runningGllaVersion` memo staleness +
   narrow-terminal tail truncation — internal latent / prod-correct
   (single long-lived process) / explicitly decided in the v0.38.44
   evidence. No change.

## Verification

- `npx tsc --noEmit` clean.
- Full `npm run release:check` (TMPDIR=/var/tmp): gate 2073/2 → after the
  dedup refinement re-run at ship; both prior failures addressed (old
  contract restored by the content rule; the `behavioral-orchestrator`
  timing case passes solo 131/131 and single-filter).
- Release `v0.38.45` tagged + GitHub release + npm publish (see CHANGELOG).
