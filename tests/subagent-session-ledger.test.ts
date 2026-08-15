// pi-goal-list-loop-audit — v0.34.71
// tests/subagent-session-ledger.test.ts
//
// OPEN-ISSUES 1.16 "Subagents lost between restarts": emit a
// subagent_session ledger event on each Agent-tool spawn (session id +
// summary) so parents can recover references after a /reload.
//
// Implementation: pi-subagents broadcasts a cross-extension lifecycle event
// on pi.events ("subagents:started", payload { id, type, description }) when
// an Agent-tool subagent transitions to running — once per spawn, foreground
// AND background. The extension subscribes in activate() and appends
// subagent_session to the ledger, which lives on disk in
// .pi-glla/active.jsonl and survives restarts (unlike the in-process agent
// registry, which dies with a /reload). Tests fire the event via
// MockPi.emitBus().
//
// Contract: spawn path appends subagent_session to the ledger, a
// restart-recovery test asserts the reference survives, suite green + tsc
// clean.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { readState } from "../extensions/goal-loop-core.js";
import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import {
  MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, tick,
  type MockCtx,
} from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}

const pi = new MockPi();
activate(pi.api);
const MAIN_SM = { name: "main-session-manager" };

function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}
async function freshSession(cwd: string, reason: string): Promise<MockCtx> {
  __testOnlyResetOwnerSession();
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason }, ctx);
  return ctx;
}

function readLedger(cwd: string): Array<{ type: string; value?: any }> {
  const raw = fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf-8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function subagentSessions(cwd: string): Array<{ type: string; value?: any }> {
  return readLedger(cwd).filter((l) => l.type === "subagent_session");
}

afterEach(() => {
  __testOnlyResetOwnerSession();
});

/** Active goal + fresh session (autoResume keeps it ACTIVE past the restore gate). */
async function spawnFixture(): Promise<{ cwd: string; ctx: MockCtx }> {
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ policy: "goal", status: "active", objective: "ship the subagent session ledger" }) });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  return { cwd, ctx };
}

// MUST run before any other test binds a ctx: the guard under test is
// "no session has bound a ctx yet → the spawn is dropped". Module state is
// pristine at this point (lastCtx === null, no session_start fired).
test("guard: a spawn observed before any session binds writes nothing", async () => {
  const cwd = tmpCwd();
  pi.emitBus("subagents:started", { id: "sub-orphan", type: "Explore", description: "orphan spawn" });
  await tick();
  // after the session binds, the ledger must not contain the orphan spawn
  const ctx = await freshSession(cwd, "reload");
  await tick();
  const entries = subagentSessions(cwd);
  assert.equal(entries.length, 0, "orphan spawn was not ledgered");
  assert.ok(entries.every((e) => e.value.sessionId !== "sub-orphan"));
  void ctx;
});

test("Agent-tool spawn appends subagent_session (id + summary) to the ledger", async () => {
  const { cwd } = await spawnFixture();
  pi.emitBus("subagents:started", { id: "sub-abc123", type: "Explore", description: "survey auth flow" });
  await tick();
  const entries = subagentSessions(cwd);
  assert.equal(entries.length, 1, "exactly one spawn ledgered");
  assert.equal(entries[0]!.value.sessionId, "sub-abc123", "the subagent session id");
  assert.equal(entries[0]!.value.agentType, "Explore");
  assert.equal(entries[0]!.value.summary, "survey auth flow", "the summary the parent can match on");
  const goal = readState(cwd).goal as { id: string };
  assert.equal(entries[0]!.value.goalId, goal.id, "correlated to the active goal");
  assert.ok(typeof entries[0]!.value.at === "string", "timestamped");
});

test("the reference survives a restart: the ledger entry persists across a /reload", async () => {
  const { cwd } = await spawnFixture();
  pi.emitBus("subagents:started", { id: "sub-persist-1", type: "general-purpose", description: "build the widget" });
  await tick();
  assert.equal(subagentSessions(cwd).length, 1);

  // restart: a fresh session on the same cwd. The in-process agent registry
  // forgets the id on /reload; the disk ledger must not.
  await freshSession(cwd, "reload");
  await tick();
  const after = subagentSessions(cwd);
  assert.equal(after.length, 1, "the reference survives the restart");
  assert.equal(after[0]!.value.sessionId, "sub-persist-1");

  // and the restored session still ledgeres new spawns
  pi.emitBus("subagents:started", { id: "sub-persist-2", type: "Explore", description: "post-restart spawn" });
  await tick();
  const both = subagentSessions(cwd);
  assert.equal(both.length, 2, "post-restart spawns still append");
  assert.equal(both[1]!.value.sessionId, "sub-persist-2");
});

test("every spawn appends — re-observation of an id (resume/re-run) adds fresh evidence", async () => {
  const { cwd } = await spawnFixture();
  pi.emitBus("subagents:started", { id: "sub-run-1", type: "Plan", description: "design the rollout" });
  pi.emitBus("subagents:started", { id: "sub-run-2", type: "Explore", description: "check the suite" });
  pi.emitBus("subagents:started", { id: "sub-run-1", type: "Plan", description: "resumed: design the rollout" });
  await tick();
  const ids = subagentSessions(cwd).map((e) => e.value.sessionId);
  assert.deepEqual(ids, ["sub-run-1", "sub-run-2", "sub-run-1"], "one entry per spawn observation");
});

test("malformed payloads are dropped, not crashy", async () => {
  const { cwd } = await spawnFixture();
  pi.emitBus("subagents:started", { type: "Explore" });        // no id
  pi.emitBus("subagents:started", "not-an-object");            // garbage payload
  pi.emitBus("subagents:started", { id: "", type: "Explore" }); // empty id
  await tick();
  assert.equal(subagentSessions(cwd).length, 0, "nothing ledgered for malformed spawns");
});
