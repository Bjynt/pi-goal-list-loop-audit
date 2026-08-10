# Root cause: jiti `export let state` binding split froze persistence and broke activation

**Incident**: 2026-08-09/10. `/list audit` (and any enqueue) wrote `.queue.json`
sidecars and logged `list_queue_disk_first` / `list_imported`, but the
persisted `state` ledger line never gained the item and **no goal ever
activated**. Two live workspaces were affected (`dracon-platform` root,
`dracon-platform/web`); the web ledger showed a frozen state line repeated
verbatim across many minutes and events.

**Fixed**: `9159622f` (+ daemon-pushed auto-commits), v0.34.122.
Regression test: `tests/repro-jiti-state-split.test.mjs` (run with
`npm run test:jiti` — node, not bun).

## Mechanism

pi's extension loader (`@earendil-works/pi-coding-agent` → jiti 2.7.0,
`createJiti(import.meta.url, { moduleCache: false })`) compiles TypeScript
modules to CJS. For `export let state`, the compile emits a
**captured-value** export binding: the module-internal variable is
reassignable, but importers of the `state` binding keep the value they got
at import time (the ORIGINAL object), not a live binding to the variable.

The extension honored "replace the whole object through replaceState()":

```ts
export let state: State = { goal: null };
export function replaceState(next: State): void { state = next; }
```

Under jiti, after `replaceState(next)`:

- the module-local variable holds `next` → `state.goal`/`state.list` reads
  inside goal-state.ts look correct;
- every importer (`goal-commands.ts`, `goal-orchestrator.ts`, …) still sees
  the ORIGINAL `{goal:null}` object → `persistStateLine(ctx.cwd, state)`
  serialized the frozen first-read state.

So the ledger line always read `goal=null listlen=0` regardless of what
the enqueue/activation did — the exact observed signature, plus a stale
`activateNextListItem` that read an empty queue and silently returned.

bun (the 1209-test harness) and node-native ESM keep live bindings, so the
split was invisible to the suite. Only the real loader (jiti) exhibits it —
any bun-based test cannot catch this class of bug.

## Proof

- `/tmp/jiti-repro.mjs` (node + jiti 2.7.0, mock harness also through jiti,
  exact live event sequence `session_start(startup)` →
  `session_shutdown(resume)` → `session_start(resume)` → `/list audit`):
  pre-fix output `state goal=null listlen=0` + no goal md; post-fix
  `state ... listlen=1`, `goal_created`, goal md written.
- Instrumented run showed `[GS-replaceState] in=1` (module-local updated)
  alongside `[GS-persist] s.list=0 s===moduleState=false` (imported binding
  still the original object) — the divergence, in one graph, one eval.
- `tests/repro-jiti-state-split.test.mjs` fails on pre-fix code
  (verified against a reverted copy via `GLLA_EXT_PATH`), passes on HEAD.

## Fix

`extensions/goal-state.ts`:

```ts
export const state: State = { goal: null };   // const — never reassigned

export function replaceState(next: State): void {
  const mutable = state as unknown as Record<string, unknown>;
  for (const key of Object.keys(mutable)) delete mutable[key];
  Object.assign(mutable, next);
}
```

In-place mutation keeps the exported object identity stable, so every
imported binding is current under ANY loader by construction. The shape
always mirrors what the caller passed (delete-then-assign). All 37
replaceState call sites pass a full `State` (they spread the current
state), so key coverage is unchanged. `export let` is now forbidden
repo-wide (only goal-state.ts had one; guard test pins `const` +
`Object.assign`).

## Operational notes

- Queued items were always safe on disk (`goals/*.queue.json` sidecars) —
  the failure was purely the in-memory→disk persistence binding, not the
  enqueue logic. After restarting pi with HEAD (≥ v0.34.122), the disk
  restore path picks the queue back up.
- The web workspace additionally had a stale active goal (`w8oyym`) with an
  archive fence — restart with the fix fences/archives it and activates the
  head of the 13-item queue.
- Do not run the jiti regression test under bun (`bun test` globs it but it
  passes either way there — it only catches the bug under node, which is
  where the real loader lives). `npm run test:jiti` / `test:all` include it.
