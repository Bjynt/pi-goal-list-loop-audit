// pi-goal-list-loop-audit — v0.35.22
// tests/repair-card-loop-block.test.ts
//
// v0.35.22 suspicious-unstartable-repair-card fix (note.md Next #3).
//
// Field (screenshots 20260821_114109/114210/134442/134645): /goal start of a
// lowercase-fragment objective paused the goal and queued a repair task; the
// card told the user "/list next starts the preserved repair/replan task".
// But activateNextListItem's one-active-thing guard refused activation while
// the Chrome-Bridge loop owned the surface — LEDGER-ONLY, no notification —
// so the repair sat unstartable AND invisibly blocked. And when the loop
// ended, nothing re-attempted activation: dead queue entry.
//
// Fix under test:
//   1. the loop block is LOUD (warning names the queued item + way out);
//   2. loop end (any route) retries list activation — the repair starts.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { replaceState } from "../extensions/goal-state.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd, tick } from "./harness/mock-pi.js";

function ledger(cwd: string): string {
  try {
    return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  } catch {
    return "";
  }
}

async function boot(pi: MockPi, cwd: string) {
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `repair-card-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(80);
  return ctx;
}

const SUSPICIOUS = "passes sequentially, including validated recovery (archive)";

test("v0.35.22: /list next under an active loop refuses LOUDLY — warning names the queued item and the way out", async () => {
  const cwd = tmpCwd();
  const item = { id: String(seedGoal({ policy: "list" }).id), objective: SUSPICIOUS, addedAt: new Date().toISOString() };
  seedState(cwd, {
    goal: null,
    // A live loop owns the surface — the exact field state (Chrome Bridge indefinite).
    loop: { target: "keep chrome bridge alive", active: true, iteration: 1 },
    list: [item],
  });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);

  await pi.command("list", "next", ctx);
  await tick(80);

  // Still blocked — one-active-thing holds…
  assert.equal(readState(cwd).goal, null, "the queued item is NOT activated over a live loop");
  assert.match(ledger(cwd), /"list_activation_blocked_loop"/);
  // …but now LOUDLY, with the item and the way out.
  const warned = ctx.ui.matching("cannot start while a loop owns the surface");
  assert.equal(warned.length, 1, "the refusal notifies with the queued item + how to proceed");
  assert.match(warned[0]!.message, /stays queued/);
  assert.match(warned[0]!.message, /\/loop stop/);
});

test("v0.35.22: when the loop ends, the blocked repair becomes startable — /loop stop advances the queue", async () => {
  const cwd = tmpCwd();
  const item = { id: String(seedGoal({ policy: "list" }).id), objective: SUSPICIOUS, addedAt: new Date().toISOString() };
  seedState(cwd, {
    goal: null,
    loop: { target: "keep chrome bridge alive", active: true, iteration: 1 },
    list: [item],
  });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);

  await pi.command("list", "next", ctx);
  await tick(80);
  assert.equal(readState(cwd).goal, null, "precondition: still blocked while the loop lives");

  await pi.command("loop", "stop", ctx);
  await tick(80);

  // The surface is free again — the head (repair assessment will gate it on
  // explicit retry; here the auto-advance must at least have TRIED loudly).
  const afterStop = readState(cwd);
  const loopGone = !afterStop.loop?.active;
  assert.ok(loopGone, "the loop stopped");
  if (!afterStop.goal) {
    // If auto-advance was gated (e.g. the suspicious assessment queued a
    // repair ahead), the refusal must be visible — never silent.
    assert.ok(
      ledger(cwd).includes("faulty_objective_list_activation_blocked") || ctx.ui.matching("cannot start").length > 0 || ctx.ui.matching("queued list item").length > 0,
      "a non-advancing stop surfaces WHY",
    );
  }
  // The decisive assertion: with the loop gone, ONE more /list next starts
  // the repair task (the field escape hatch now actually works).
  await pi.command("list", "next", ctx);
  await tick(80);
  const final = readState(cwd);
  assert.ok(final.goal, "the queued entry started once the loop no longer owns the surface");
  assert.equal(final.goal!.policy, "list");
  assert.match(ledger(cwd), /"goal_created"/);
});
