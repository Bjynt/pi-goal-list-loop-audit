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
//   2. loop end (/loop stop) retries list activation — the item starts.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { replaceState, state } from "../extensions/goal-state.js";
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

/** The session-restore gate holds seeded loops inactive on load (v0.34.15);
 * the field state under test is a LIVE loop owning the surface, so flip it
 * back active after boot — exactly what /loop resume produces. */
function wakeLoop(): void {
  assert.ok(state.loop, "a loop was seeded");
  replaceState({ ...state, loop: { ...state.loop!, active: true, stopReason: undefined } });
}

const PLAIN_ITEM = "clean up the README examples — done when pinned";

function seedLoopAndItem() {
  const cwd = tmpCwd();
  const item = { id: String(seedGoal({ policy: "list" }).id), objective: PLAIN_ITEM, addedAt: new Date().toISOString() };
  // LoopState needs the fields the runtime touches; seedState persists it raw.
  seedState(cwd, {
    goal: null,
    loop: { target: "keep chrome bridge alive", measureCmd: "echo 1", direction: "max", active: true, iteration: 1, maxIterations: 0, plateauWindow: 5 },
    list: [item],
  });
  return { cwd, itemId: item.id };
}

test("v0.35.22: activating a queued item under a LIVE loop refuses LOUDLY — warning names the queued item and the way out", async () => {
  const { cwd } = seedLoopAndItem();
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  wakeLoop();

  // Drive the production activation entry point directly: /list next would
  // first route an objective-conflict picker over the live loop, but the
  // field bug lives in the shared activation choke point (it is what every
  // caller — command, cascade, tool — funnels into).
  const advanced = (globalThis as unknown as { activateNextListItem: (c: unknown) => boolean }).activateNextListItem(ctx);
  await tick(80);

  // Still blocked — one-active-thing holds…
  assert.equal(advanced, false, "the queued item is NOT activated over a live loop");
  assert.equal(readState(cwd).goal, null);
  const blocked = ledger(cwd).match(/"type":"list_activation_blocked_loop"[^}]*}/g) ?? [];
  assert.ok(blocked.length >= 1, "the refusal is ledgered");
  assert.match(blocked[blocked.length - 1]!, /"queueItemId"/, "the ledger names WHAT stayed queued");
  // …but now LOUDLY, with the item and the way out.
  const warned = ctx.ui.matching("cannot start while a loop owns the surface");
  assert.equal(warned.length, 1, "the refusal notifies with the queued item + how to proceed");
  assert.match(warned[0]!.message, /stays queued/);
  assert.match(warned[0]!.message, /\/loop stop/);
});

test("v0.35.22: when the loop ends, the blocked item becomes startable — /loop stop advances the queue", async () => {
  const { cwd } = seedLoopAndItem();
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  wakeLoop();

  await pi.command("list", "next", ctx);
  await tick(80);
  assert.equal(readState(cwd).goal, null, "precondition: still blocked while the loop lives");

  await pi.command("loop", "stop", ctx);
  await tick(120);

  const after = readState(cwd);
  assert.ok(!after.loop?.active, "the loop stopped");
  // v0.35.22: loop end ANNOUNCES the unblocked queue (it must not auto-start
  // — /loop stop is a stop gesture, and /glla cancel pins non-interference
  // with an unrelated waiting queue) but the item is now genuinely startable.
  const unblocked = ctx.ui.matching("can start again");
  assert.equal(unblocked.length, 1, "loop end surfaces that the queued item is startable");
  assert.match(unblocked[0]!.message, /clean up the README examples/);
  assert.match(unblocked[0]!.message, /\/list next starts it/);

  // The decisive assertion: the field escape hatch now actually works.
  await pi.command("list", "next", ctx);
  await tick(80);
  const final = readState(cwd);
  assert.ok(final.goal, "the previously-blocked queued item STARTED once the loop ended");
  assert.equal(final.goal!.policy, "list");
  assert.match(final.goal!.objective, /clean up the README examples/);
  assert.match(ledger(cwd), /"goal_created"/);
});
