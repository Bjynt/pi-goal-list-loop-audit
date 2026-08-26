/**
 * Tests for the v0.37.0 commissar termination paths in
 * extensions/goal-commissar-hooks.ts: the new-session preference
 * (attemptFreshSessionRecovery first, abort as honest fallback), the
 * durable marker, the pending flag consumed by the aborted handler, and
 * loop-mode termination.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  terminateMainRunForDereliction,
  terminateLoopForDereliction,
  commissarNewSessionPending,
  clearCommissarNewSessionPending,
} from "../extensions/goal-commissar-hooks.ts";
import { state } from "../extensions/goal-state.ts";
import type { Goal } from "../extensions/goal-loop-core.ts";

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "commissar-term-"));
}

function seedActiveGoal(cwd: string): Goal {
  const goal: Goal = {
    id: "term-test-goal",
    objective: "termination test objective",
    status: "active",
    policy: "goal",
    autoContinue: true,
    usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  const line = JSON.stringify({
    type: "state",
    value: { goal, list: [], loop: null, mainModelRecovery: null },
    at: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), line + "\n");
  // Point the module singleton at the seeded workspace.
  (state as { goal: Goal | null }).goal = goal;
  return goal;
}

function seedActiveLoop(target = "loop target"): void {
  state.loop = {
    target,
    iteration: 3,
    maxIterations: 50,
    plateauWindow: 5,
    stallCount: 0,
    bestValue: null,
    lastValue: null,
    active: true,
    history: [],
    startedAt: new Date().toISOString(),
  } as NonNullable<typeof state.loop>;
}

function makeCtx(cwd: string, opts: { newSession?: boolean } = {}) {
  let aborted = 0;
  let newSessions = 0;
  const notifications: string[] = [];
  const ctx = {
    cwd,
    ui: { notify: (msg: string) => notifications.push(msg) },
    abort: () => {
      aborted++;
    },
    ...(opts.newSession ? { newSession: () => { newSessions++; } } : {}),
  } as unknown as Parameters<typeof terminateMainRunForDereliction>[0] & {
    _aborted: () => number;
    _newSessions: () => number;
    _notifications: string[];
  };
  (ctx as Record<string, unknown>)._aborted = () => aborted;
  (ctx as Record<string, unknown>)._newSessions = () => newSessions;
  (ctx as Record<string, unknown>)._notifications = notifications;
  return ctx;
}

/** The hooks call the orchestrator's updateGoal through the runtime-global
 * bridge — stand in a stub that applies the patch to the live goal. */
function installUpdateGoalBridge(): void {
  (globalThis as Record<string, unknown>).updateGoal = (
    patch: Partial<Goal>,
  ) => {
    if (state.goal) Object.assign(state.goal, patch);
  };
  // Loop termination persists via the same runtime-global bridge.
  (globalThis as Record<string, unknown>).persistState = () => {};
}

test("terminateMainRunForDereliction prefers a NEW main session over aborting", () => {
  installUpdateGoalBridge();
  clearCommissarNewSessionPending();
  const cwd = tmpCwd();
  const goal = seedActiveGoal(cwd);
  const ctx = makeCtx(cwd, { newSession: true });

  terminateMainRunForDereliction(ctx, goal, "sustained dereliction");

  assert.equal((ctx as unknown as { _newSessions: () => number })._newSessions(), 1, "new session forced");
  assert.equal((ctx as unknown as { _aborted: () => number })._aborted(), 0, "no same-session abort on the new-session path");
  assert.equal(commissarNewSessionPending(), true, "flag tells the aborted handler the successor owns resumption");
  assert.equal(state.goal?.commissarRestart?.reason, "sustained dereliction", "durable marker set");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.ok(ledger.includes('"commissar_terminate"'), "termination ledgered");
  assert.ok(ledger.includes('"fresh_session_recovery_triggered"'), "session swap ledgered");
});

test("without a newSession capability it falls back to abort and disarms the flag", () => {
  installUpdateGoalBridge();
  clearCommissarNewSessionPending();
  const cwd = tmpCwd();
  const goal = seedActiveGoal(cwd);
  const ctx = makeCtx(cwd);

  terminateMainRunForDereliction(ctx, goal, "dereliction without capability");

  assert.equal((ctx as unknown as { _aborted: () => number })._aborted(), 1, "legacy abort fallback");
  assert.equal(commissarNewSessionPending(), false, "flag disarmed so the aborted handler restarts in-session");
});

test("refuses to abort without the durable marker bridge (loud degrade)", () => {
  delete (globalThis as Record<string, unknown>).updateGoal;
  const cwd = tmpCwd();
  const goal = seedActiveGoal(cwd);
  const ctx = makeCtx(cwd, { newSession: true });

  terminateMainRunForDereliction(ctx, goal, "no bridge");

  assert.equal((ctx as unknown as { _newSessions: () => number })._newSessions(), 0, "no swap without the marker");
  assert.equal((ctx as unknown as { _aborted: () => number })._aborted(), 0, "never abort unmarked — it would read as user Esc");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.ok(ledger.includes('"commissar_terminate_refused"'), "the refusal is loud in the ledger");
});

test("terminateLoopForDereliction marks the loop and prefers the new session", () => {
  installUpdateGoalBridge();
  clearCommissarNewSessionPending();
  const cwd = tmpCwd();
  seedActiveGoal(cwd);
  seedActiveLoop();
  const before = state.loop!;
  const ctx = makeCtx(cwd, { newSession: true });

  terminateLoopForDereliction(ctx, "fabricated measure output");

  assert.equal((ctx as unknown as { _newSessions: () => number })._newSessions(), 1, "new session forced for loops too");
  assert.notEqual(state.loop, before, "the loop object was replaced, not mutated in place");
  assert.equal(state.loop?.commissarRestart?.reason, "fabricated measure output", "durable loop marker set");
  assert.equal(state.loop!.active, true, "the loop stays active — this is a replacement, not a stop");
});
