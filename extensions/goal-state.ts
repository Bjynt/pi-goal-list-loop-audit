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
 * whole object must go through replaceState(). */
export let state: State = { goal: null };

/** Replace the whole state object (the 18 wholesale `state = ...` sites in
 * goal.ts). A function — not a bare exported `let` + reassignment — because
 * ES module imports are read-only bindings. */
export function replaceState(next: State): void {
  state = next;
}

/** Persistence core: append the durable "state" ledger line (active.jsonl).
 * JSON omits undefined, while readState intentionally merges state
 * snapshots; explicit nulls for the optional top-level recovery slot
 * prevent resurrecting an older quota wall after a successful retry.
 *
 * v0.34.57: lastModelRef is carried on the state line so a fresh process
 * can restore it (readState) and the turn-boundary check can catch a
 * changed default model across sessions (bug #1.14).
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
  });
}
