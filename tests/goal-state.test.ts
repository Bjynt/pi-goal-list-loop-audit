// pi-goal-list-loop-audit — v0.34.109
// tests/goal-state.test.ts
//
// Pins the decomposition step-1 invariant (docs/GLLA-POSITIONING-AND-
// DECOMPOSITION-2026-08-08.md, invariant #2): the mutable `state` singleton
// is owned by exactly ONE module — extensions/goal-state.ts. goal.ts reads
// the imported binding but must replace the whole object through
// replaceState() — no second `state =` declaration may reappear in goal.ts
// (a second source of truth is the exact failure the doc forbids).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const GOAL_SRC = readGoalRuntimeSource();
const CMDS_SRC = fs.readFileSync("extensions/goal-commands.ts", "utf-8");
const STATE_SRC = fs.readFileSync("extensions/goal-state.ts", "utf-8");

test("goal-state.ts owns the state singleton (single source of truth)", () => {
  // The singleton is declared exactly once, in goal-state.ts.
  assert.match(STATE_SRC, /export const state: State = \{ goal: null \};/);
  assert.ok(!GOAL_SRC.includes("let state: State"), "goal.ts must not declare a second state singleton");
  // goal.ts imports the binding from goal-state.js.
  assert.match(GOAL_SRC, /import \{ state, replaceState, persistStateLine \} from "\.\.\/goal-state\.js";/);
});

test("wholesale state replacement goes through replaceState() only", () => {
  // No `state =` reassignment may survive in goal.ts — the import binding is
  // read-only by ESM semantics anyway; a stray reassignment would be a tsc
  // error. Property mutations (state.goal = ...) are fine and expected.
  const reassigns = GOAL_SRC.split("\n")
    .map((line, i) => ({ line, i: i + 1 }))
    .filter(({ line }) => /^\s*state = /.test(line));
  assert.deepEqual(reassigns.map((r) => r.i), [], `stray state = reassignments: ${JSON.stringify(reassigns.map((r) => r.line.trim().slice(0, 80)))}`);
  // And the primitive exists for the sites that DID move.
  assert.match(STATE_SRC, /export function replaceState\(next: State\): void \{/);
  // v0.34.122: in-place mutation — the exported binding must NEVER be
  // reassigned (jiti's captured-value export binding froze importers on the
  // original object; see the incident comment in goal-state.ts).
  assert.match(STATE_SRC, /export const state: State = \{ goal: null \};/);
  assert.match(STATE_SRC, /Object\.assign\(mutable, next\);/);
  assert.ok(!STATE_SRC.includes("state = next;"), "replaceState must not reassign the exported binding");
});

test("the persistence core lives in goal-state.ts (persistStateLine)", () => {
  assert.match(STATE_SRC, /export function persistStateLine\(cwd: string, s: State\): boolean \{/);
  // The ledger "state" line write moved out of goal.ts.
  assert.ok(!GOAL_SRC.includes('appendLedger(ctx.cwd, "state", { goal: state.goal'), "goal.ts no longer writes the state ledger line inline");
  // goal.ts's persistState wraps the core with the UI side effects.
  assert.match(GOAL_SRC, /persistStateLine\(ctx\.cwd, state\);/);
  assert.match(GOAL_SRC, /notifyPersistenceState\(ctx\);/);
  assert.match(GOAL_SRC, /refreshUI\(ctx, true\);/);
});

test("replaceState is used at the moved wholesale sites", () => {
  // v0.34.109 converted the 18 wholesale `state = ...` sites; spot-check the
  // semantically critical ones (goal swap, archive, list ops) all route
  // through the primitive.
  for (const needle of [
    "writeGoalStateTransaction(ctx.cwd, { ...state, goal: nextGoal })",
    "replaceState({ ...state, goal: nextGoal });",
    "replaceState(readState(cwd));",
    "replaceState({ ...state, lastCompactionAt });",
  ]) {
    assert.ok(GOAL_SRC.includes(needle), `expected in goal.ts: ${needle}`);
  }
  // Decomposition step 2: the list-clear and wipe sites moved to
  // goal-commands.ts — the primitive requirement travels with them.
  // v0.35.30: the wipe site also clears lastOutcome (clean slate means
  // the terminal-outcome retention line goes too).
  for (const needle of ["replaceState({ ...state, list: [] });", "replaceState({ ...state, goal: null, lastOutcome: undefined });"]) {
    assert.ok(CMDS_SRC.includes(needle), `expected in goal-commands.ts: ${needle}`);
  }
});
