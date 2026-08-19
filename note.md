# Do

##

we cant resume goal without session restart
/home/dracon/Pictures/Screenshots/Screenshot_20260818_053538.png 

##

we are not inside the main session?? while inside the main session
/home/dracon/Pictures/Screenshots/Screenshot_20260818_054102.png 

##

one thing we can use is very informative formatted summaries when objectives end as i noticed that is one area we lack

## 

we need a better way to handle objectives that are buggy or previous version

##

cont accepted but did nto start turn, but working
/home/dracon/Pictures/Screenshots/Screenshot_20260818_175936.png 

# Later

##

working session wiht sesion lost

/home/dracon/Pictures/Screenshots/Screenshot_20260818_173242.png 
/home/dracon/Pictures/Screenshots/Screenshot_20260818_173824.png 

## 

we want the agent to have long term preference

## idea

option to no audit or audit only on completion or periodically

like we can audit on goal completion or every X tasks, or we can just do it at the end 

# 2026-08-18 audit fixes

- Hardened list queue persistence: queue sidecars now write atomically through the persistence-degradation boundary, clean up temporary files, refuse unsafe symlink replacement, roll back failed batches, and never mutate RAM before disk succeeds.
- Made queue recovery durable: `repairTarget`, `parentId`, `parallelSafe`, and explicit `queueOrder` round-trip through sidecars; recovered items hydrate into `state.list` in stable order; `carryover: clear` removes recoverable sidecars; failed repair metadata writes are surfaced.
- Fixed packaged release drift: public docs/examples are shipped, repository-only links are removed from the packaged index, README reports `v0.35.4`, and schema parity covers runtime goal/audit fields in both directions.
- Fixed parked completion-audit recovery: a healthy same-session heartbeat keeps `paused`/`recovery-pending` work supervised and routes it through the existing bounded one-shot retry without launching a worker directly; cold/manual startup remains explicit-resume safe.
- Fixed inline verification parsing: ordinary prose such as `verify the recovery fix. Done when: ...` no longer gets truncated as if `verify` were a marker. The regression and parser fix landed in `e29d566f`.
- Added or strengthened focused regressions across queue persistence, carryover clearing, recovery hydration/order, schema/release contracts, stale-host recovery, parked completion recovery, and verification parsing.
- Verification is green: `npm test` (1393 passed, 1 skipped), `npm run check`, and `npm run release:check`; package dry-run reports `pi-goal-list-loop-audit@0.35.4`.
- Runtime lesson: source changes require a Pi `/reload` or restart before the live extension sees them; after rebind, `/list resume` is the correct command for this list-scoped goal. Automatic recovery is bounded and never treats a dead host as a reason to launch an unbounded auditor storm.
