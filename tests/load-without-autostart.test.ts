// pi-goal-list-loop-audit — v0.35.23
// tests/load-without-autostart.test.ts
//
// note.md Next #2: loading a session with persisted goal/list/loop state
// must RESTORE and DISPLAY everything truthfully but hold ALL automatic
// dispatch until the user decides (/goal resume, /list resume, /list next,
// /loop resume|start) — with explicit `autoResume: true` in global settings
// restoring today's load-time automation.
//
// Root cause this pins: resolveEffectiveAggressiveSettings coerced unset
// autoResume→true (aggressiveMode defaults on), so stock installs auto-
// resumed on every load despite the documented v0.28.21 tri-state whose
// undefined default is HOLD. The fix reads the RAW setting for load consent
// and engages a dedicated load hold (loadHoldAt) through the same freeze
// gates as /glla pause.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { seedGoal, seedLoop, seedState, tmpCwd, tick, MockPi, makeMockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

function ledger(cwd: string): Array<{ type: string; value?: Record<string, unknown> }> {
  try {
    return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function coldBoot(pi: MockPi, cwd: string) {
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `no-autostart-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  await tick(120);
  return ctx;
}

function seedPendingState(cwd: string): void {
  seedState(cwd, {
    goal: seedGoal({ policy: "goal", status: "active", objective: "persisted active goal — done when pinned" }),
    loop: seedLoop({ active: true, target: "persisted metric loop" }),
    list: [{ id: "waiting-1", objective: "waiting queued item", addedAt: new Date().toISOString() }],
  });
}

test("v0.35.23: a DEFAULT cold load restores + displays pending state but sends NOTHING and arms NO automation", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({})); // stock install: no autoResume anywhere
  const cwd = tmpCwd();
  seedPendingState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await coldBoot(pi, cwd);

  // ZERO sends on the restored-but-held load.
  assert.equal(pi.sent.length, 0, "no agent sends fire from a held session_start");
  assert.equal(pi.userMessages.length, 0, "no user-message injections fire either");

  // State is restored TRUTHFULLY — visible, intact, but held.
  const after = readState(cwd);
  assert.equal(after.loop?.active, false, "the persisted loop is HELD, not running");
  assert.match(String(after.loop?.stopReason), /HELD_ON_RESTORE|held/);
  assert.equal(after.goal?.status, "paused", "the persisted goal is held for explicit resume");
  assert.equal(after.list?.length, 1, "the waiting queue stays fully visible");

  // The load hold is engaged durably through the supervisor-freeze gate.
  assert.equal(typeof after.loadHoldAt, "number", "loadHoldAt marks the engaged hold");
  assert.ok(ledger(cwd).some((e) => e.type === "load_hold_engaged"));

  // And it STAYS inert: more event-loop turns arm no late timers/sends.
  await tick(200);
  await tick(200);
  assert.equal(pi.sent.length, 0, "no continuation timer fires after the hold");
});

test("v0.35.23: explicit autoResume:true restores load-time automation (opt-in = today's behavior)", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true }));
  const cwd = tmpCwd();
  seedPendingState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await coldBoot(pi, cwd);

  const after = readState(cwd);
  assert.equal(after.loadHoldAt, undefined, "no load hold when the user opted in");
  assert.equal(after.goal?.status, "active", "the goal resumes under explicit consent");
  assert.equal(after.loop?.active, true, "the loop resumes under explicit consent");
  await tick(150);
  assert.ok(pi.sent.length >= 1 || pi.userMessages.length >= 1, "automation actually dispatches after an opted-in load");
});

test("v0.35.23: /goal resume releases the load hold and re-arms automation", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({}));
  const cwd = tmpCwd();
  seedPendingState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await coldBoot(pi, cwd);
  assert.equal(typeof readState(cwd).loadHoldAt, "number", "precondition: held");

  await pi.command("goal", "resume", ctx);
  await tick(150);

  const after = readState(cwd);
  assert.equal(after.loadHoldAt, undefined, "the hold is released by the explicit resume");
  assert.equal(after.goal?.status, "active", "the goal goes active");
  assert.ok(ledger(cwd).some((e) => e.type === "load_hold_released" && e.value?.via === "goal-resume"));
  await tick(150);
  assert.ok(pi.sent.length >= 1 || pi.userMessages.length >= 1, "a continuation actually fires after the release");
});

test("v0.35.23: /list next also releases the hold and starts the queued head", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({}));
  const cwd = tmpCwd();
  // No goal: only the queue waits — the exact "decide what runs next" shape.
  seedState(cwd, {
    list: [{ id: "head-1", objective: "queued head — done when pinned", addedAt: new Date().toISOString() }],
  });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await coldBoot(pi, cwd);
  assert.equal(typeof readState(cwd).loadHoldAt, "number", "precondition: held with a waiting queue");
  assert.equal(pi.sent.length, 0);

  await pi.command("list", "next", ctx);
  await tick(150);

  const after = readState(cwd);
  assert.equal(after.loadHoldAt, undefined, "an explicit activation releases the hold");
  assert.ok(after.goal, "the queued head started");
  assert.equal(after.goal?.policy, "list");
  assert.ok(ledger(cwd).some((e) => e.type === "load_hold_released"));
  assert.match(JSON.stringify(ledger(cwd)), /goal_created/);
});
