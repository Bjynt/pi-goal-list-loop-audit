# Active goal-card provenance closure — 2026-09-08

## Finding

Screenshot `Screenshot_20260908_143127.png` showed an active goal card with:

```text
● ... · active · total 0s
├─ model: primary opencode-go/muse-spark-1.3-contributor · inherited from session
│  handled turn: opencode-go/muse-spark-1.3-contributor
```

Two display defects combined:

1. `handled turn` repeated the same primary model and added no human-useful
   information.
2. The provenance mapper emitted a continuation connector (`│`) for the last
   row when no recent action, pending task, or queue footer followed. That
   connector visually promised more rows and made the card look truncated.

This was a GLLA-owned renderer defect in `extensions/goal-loop-display.ts`,
not evidence that the model turn was missing or that the turn lifecycle was
stuck.

## Fix — v0.38.28

- Suppress `handled turn` when its case-insensitive model ref equals the
  primary ref. A handled ref that differs during fallback/recovery remains
  visible.
- Track the provenance block's position and rewrite its final connector to
  `└─` when it is the final detail block. A single provenance row now closes
  cleanly too.
- Add regression assertions for a multi-row provenance block, a lone
  provenance row, and duplicate primary/handled refs.

## Validation

- `bun test tests/goal-loop-display.test.ts tests/display.test.ts` — 113 pass,
  0 fail.
- `npx tsc --noEmit` — clean.
- Full `npm run release:check` follows after the v0.38.28 version bump.
