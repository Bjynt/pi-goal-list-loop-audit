# Full-project freeze audit — 2026-08-31

## Scope

This review covers GLLA's runtime, detached auditor, mechanical verification
shield, persistence paths, lifecycle timers, tests, documentation, and release
checks. The incident lens was runaway process creation, event-loop blocking,
unbounded ledger work, retry storms, and orphaned child processes.

The review did not modify Pi, the operating system, `pi-subagents`, providers,
or another repository. Findings owned by those systems are recorded below and
remain outside GLLA's implementation boundary.

## Fixed in GLLA

1. The active JSONL ledger was read as one complete string and split into an
   array on every state load. GLLA now scans state records in bounded chunks;
   reverse lookups for the last durable state and bounded audit-log tails scan
   from the file end. The append-only format and recovery rules are unchanged.
   `/glla audits full` retains its deliberate full-history behavior.

2. Mechanical verification commands now run in an owned process group. On
   Linux, GLLA counts that group every 100 ms and terminates the whole tree
   above 256 processes. The detached auditor worker applies the same Linux
   ceiling to its Pi/RPC group. A containment breach is reported as
   infrastructure failure and is not retried into another process storm.

3. The earlier detached mechanical-check teardown fix remains in place:
   process-group termination is asynchronous, descendants and stdio are
   cleaned up, timeouts/output limits do not retry, and goal tools await the
   check result instead of returning while the check is still active.

## External-only incident disposition

The exact recursive `guard-append-only.py` helper observed in the incident is
under `/home/dracon/Dev/dracon-platform/scripts/lib/guard-append-only.py`.
It invokes itself through `python3`, which explains the parent-to-child chain.
GLLA has no reference to that helper and did not edit the external project, as
required by this repository's scope boundary. GLLA now contains recursive
commands when they run through its owned verification or detached-auditor
paths; the canonical helper itself still needs an upstream repair in
`dracon-platform` (replace the self-forwarding call with the real guard
implementation or a non-recursive entry point).

The final read-only process check after verification found no live
`guard-append-only.py` processes and no live GLLA auditor workers.

## Deferred, not silently closed

These remain known architectural follow-ups rather than freeze fixes:

- ledger rotation/retention for indefinite append-only growth;
- transactional archive and queue-sidecar tombstones;
- an OS-level cross-process ownership lock/lease epoch;
- a generic durable wait scheduler;
- a true OS/container sandbox for the intentionally powerful detached auditor;
- replacing remaining SDK/private-shape `any` boundaries and adding more
  multi-process coverage.

They are already tracked in `audit/EXTENSION-AUDIT-2026-08-21.md` and the
follow-up comparison/parked-ideas audits. Rotation in particular should be a
separate migration design, not an opportunistic rewrite during an incident.

## Verification

- `npm run release:check`: **1,763 passed, 1 skipped, 0 failed** across 166
  test files.
- `npm run check` / TypeScript: passed.
- Jiti state-split regression: passed.
- Offline allow-listed auditor-extension check: passed.
- `npm pack --dry-run`: passed; package contents and release contract passed.
- Focused persistence, auditor, process-ceiling, and shield regressions: all
  passed.
- `git diff --check`: passed.

