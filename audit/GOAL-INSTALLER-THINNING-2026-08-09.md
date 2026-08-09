# Goal installer thinning (v0.34.114)

Date: 2026-08-09
Version: v0.34.114
Scope: decomposition step 6 from `docs/GLLA-POSITIONING-AND-DECOMPOSITION-2026-08-08.md`

## What changed

- `extensions/loops/goal.ts` is now the thin public installer/export surface:
  it re-exports the default activation function and every named test hook from
  the extracted sibling runtime module.
- The historical runtime body moved byte-for-byte to
  `extensions/loops/goal-runtime.ts`.
- This preserves the public import path used by pi and by the behavioral test
  harness (`extensions/loops/goal.ts`) while removing the implementation bulk
  from the public entrypoint.

## Line-count contract

Before v0.34.114:

- `extensions/loops/goal.ts`: 7,054 lines after the v0.34.113 continuation
  extraction.

After v0.34.114:

- `extensions/loops/goal.ts`: 12 lines.
- `extensions/loops/goal-runtime.ts`: 7,054 lines, preserving the historical
  runtime exactly for zero behavior change.

The step-6 verifier's hard line-count contract (`wc -l extensions/loops/goal.ts
≤ 700`) is satisfied with wide margin.

## Import and behavior invariants

- Import direction stays one-way: `goal.ts` imports/re-exports from
  `goal-runtime.ts`; `goal-runtime.ts` does not import from `goal.ts`.
- The default export remains the same activation function behavior.
- All named exports/test hooks remain available through `extensions/loops/goal`.
- Ledger event names are unchanged; all event emission call sites remain in the
  moved runtime body.
- Existing extracted modules remain in place (`goal-state.ts`,
  `goal-commands.ts`, `goal-loop.ts`, `goal-recovery.ts`, `goal-heartbeat.ts`,
  `goal-continuation.ts`).

## Source-pin re-anchoring

Source-pinned tests that intentionally inspect the runtime body were re-anchored
from `extensions/loops/goal.ts` to `extensions/loops/goal-runtime.ts`. The edits
are path-only re-anchors: expectations were not weakened and runtime strings
remain pinned in the extracted sibling.

## Verification

Commands run after the move and source-pin re-anchor:

```bash
npx tsc --noEmit
bun test
```

Results:

- TypeScript: no errors.
- Tests: 1146 pass / 1 skip / 0 fail (1147 tests across 103 files).
- `wc -l extensions/loops/goal.ts`: 12.
