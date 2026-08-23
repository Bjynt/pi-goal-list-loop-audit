/**
 * pi-goal-list-loop-audit — v0.34.109
 * extensions/goal-state.ts
 *
 * SINGLE OWNER of the mutable `state` singleton (invariant #2 of
 * docs/GLLA-POSITIONING-AND-DECOMPOSITION-2026-08-08.md: "Single mutable
 * state object stays owned by one module — module boundaries must not
 * create a second source of truth").
 *
 * Extracted from extensions/loops/goal.ts (step 1 of the decomposition
 * sequencing). goal.ts reads properties of the imported `state` binding
 * freely, but wholesale replacements go through replaceState() so the
 * object identity stays in this module. The ledger "state" line write
 * (the persistence core) lives here as persistStateLine(); goal.ts wraps
 * it with the UI side effects (notifyPersistenceState / refreshUI).
 *
 * Module-level MUTABLE FLAGS (invariant #3) do NOT move here — they stay
 * in the module that owns them (goal.ts) until their owning cluster is
 * extracted in a later step. This file has no flags of its own.
 */

import { appendLedger, type State } from "./goal-loop-core.js";

/** The single mutable state object. goal.ts reads `state.goal` etc. through
 * this imported binding (property reads/mutations are fine); replacing the
 * whole object must go through replaceState().
 *
 * v0.34.122 (INCIDENT 2026-08-09/10): `state` is a `const`, NOT a `let` —
 * replaceState() mutates it IN PLACE. Root cause of the live enqueue-
 * no-activation bug: pi's extension loader (jiti 2.7.0, moduleCache:false)
 * compiles `export let state` with a captured-value export binding, so
 * after `state = next` every importer of the `state` binding kept the
 * ORIGINAL object (e.g. `{goal:null, list:[]}`), while the module-local
 * variable held the new object. persistStateLine serialized the stale
 * object → the ledger froze on the first-read state → /list audit queued
 * sidecars + events but the persisted state never showed the item and no
 * goal ever activated. bun (harness) and node keep live bindings, so the
 * 1209-test suite could not catch it. Mutating the shared object in place
 * keeps every imported binding current under ANY loader. */
export const state: State = { goal: null };

/** Replace the whole state object (the 18 wholesale `state = ...` sites in
 * goal.ts). A function — not a bare exported `let` + reassignment — because
 * ES module imports are read-only bindings. In-place mutation: the shape
 * always mirrors what the caller passes (delete existing keys, then assign),
 * and object identity stays stable for every import site. */
export function replaceState(next: State): void {
  const mutable = state as unknown as Record<string, unknown>;
  for (const key of Object.keys(mutable)) delete mutable[key];
  Object.assign(mutable, next);
}

/** Persistence core: append the durable "state" ledger line (active.jsonl).
 * JSON omits undefined, while readState intentionally merges state
 * snapshots; explicit nulls for the optional top-level recovery slot
 * prevent resurrecting an older recovery episode after a successful retry.
 *
 * v0.34.57: lastModelRef is carried on the state line so a fresh process
 * can restore it (readState) and the turn-boundary check can catch a
 * changed default model across sessions (bug #1.14).
 *
 * v0.35.15: lastCompactionAt and supervisorPausedAt join the line.
 * lastCompactionAt was ADDED to State in v0.34.97 with a comment claiming
 * it persisted, but this writer never serialized it — the ⏳ compacting…
 * chip silently lost its reload survival (latent bug found while wiring
 * supervisorPausedAt through the same path). Both are plain epoch fields:
 * omitting them here means they can NEVER reach readState, no matter what
 * the callers put into replaceState.
 *
 * The UI side of a persist (notifyPersistenceState / refreshUI) is goal.ts's
 * wrapper — this is the disk write, not the HUD. */
export function persistStateLine(cwd: string, s: State): void {
  appendLedger(cwd, "state", {
    goal: s.goal,
    list: s.list ?? [],
    loop: s.loop ?? null,
    mainModelRecovery: s.mainModelRecovery ?? null,
    lastModelRef: s.lastModelRef,
    ...(typeof s.lastCompactionAt === "number" ? { lastCompactionAt: s.lastCompactionAt } : { lastCompactionAt: null }),
    ...(typeof s.supervisorPausedAt === "number" ? { supervisorPausedAt: s.supervisorPausedAt } : { supervisorPausedAt: null }),
    ...(typeof s.loadHoldAt === "number" ? { loadHoldAt: s.loadHoldAt } : { loadHoldAt: null }),
    // v0.35.34 (audit finding 2026-08-23): v0.35.30 claimed a DURABLE
    // last-outcome record but this writer never serialized it — the field
    // died with the process and any restart blanked the widget retention
    // line within its 24h window (the exact failure v0.35.30 fixed). Same
    // latent class as the lastCompactionAt trap documented above.
    // ALWAYS serialized (null when absent): readState spreads successive
    // state events, so an omitted key would resurrect the previous value
    // and /glla wipe could never clear the record from disk.
    ...(s.lastOutcome ? { lastOutcome: s.lastOutcome } : { lastOutcome: null }),
  });
}
