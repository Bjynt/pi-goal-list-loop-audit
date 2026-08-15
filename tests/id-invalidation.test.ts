// pi-goal-list-loop-audit — v0.34.73
// tests/id-invalidation.test.ts
//
// OPEN-ISSUES 1.12 (Screenshot_20260805_121634): "a goal/list id was
// invalidated mid-flow (likely by a session-handoff or a forced rewrite).
// Need the goal id and the surrounding active.jsonl events to diagnose.
// Fix path: once a repro is captured, add an id_invalidation ledger event
// with the old/new id pair and a reason field."
//
// The screenshot shows the goStaleTerminal warning: "pi invalidated this
// session's extension handle without delivering a replacement session."
// The invalidated identity is the SESSION id (ctx.sessionManager
// getSessionId). The owner sidecar (.pi-glla/session-owner.json) records
// the previous owner's session id; a fresh session_start carrying a
// DIFFERENT id is the forced rewrite/handoff — v0.34.73 ledgeres
// `id_invalidation { oldId, newId, reason, goalId?, at }`.
//
// Repro from real history (ai-auto-writer/.pi-glla/active.jsonl): 10
// extension_api_stale events 2026-07-27..08-05 (the last at 2026-08-05T17:41
// — the screenshot's day), each followed by a user action (quit/resume/new)
// NOT a delivered replacement — but the OLD session id was never recorded,
// so past pairs are unrecoverable. v0.34.73 closes the gap.
//
// Contract: id_invalidation event exists and is tested, repro attempt
// documented in an audit doc, suite green + tsc clean.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { classifyIdInvalidationReason } from "../extensions/loops/goal.js";
import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, tick, type MockCtx } from "./harness/mock-pi.js";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}

const pi = new MockPi();
activate(pi.api);
const MAIN_SM = { name: "main-session-manager" };

function ownerCtx(cwd: string, sessionId = "unknown-session"): MockCtx {
  return makeMockCtx(cwd, {
    sessionManager: { name: "main-session-manager", getSessionId: () => sessionId },
  });
}
async function freshSession(cwd: string, reason: string, sessionId = "unknown-session"): Promise<MockCtx> {
  __testOnlyResetOwnerSession();
  const ctx = ownerCtx(cwd, sessionId);
  await pi.fire("session_start", { reason }, ctx);
  return ctx;
}

function readLedger(cwd: string): Array<{ type: string; value: any }> {
  const raw = fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf-8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function invalidations(cwd: string): Array<{ type: string; value: any }> {
  return readLedger(cwd).filter((e) => e.type === "id_invalidation");
}
function writeOwnerSidecar(cwd: string, rec: Record<string, unknown>): void {
  fs.mkdirSync(`${cwd}/.pi-glla`, { recursive: true });
  fs.writeFileSync(`${cwd}/.pi-glla/session-owner.json`, JSON.stringify(rec));
}

afterEach(() => __testOnlyResetOwnerSession());

// ── (a) the reason classifier (pure) ───────────────────────────────────

test("classifyIdInvalidationReason: each mechanism maps to its reason", () => {
  assert.equal(classifyIdInvalidationReason({ staleTerminal: true }), "stale_terminal");
  assert.equal(classifyIdInvalidationReason({ zombieStoodDown: true }), "zombie_stood_down");
  assert.equal(classifyIdInvalidationReason({ rebindWithoutShutdown: true }), "rebind_without_shutdown");
  assert.equal(classifyIdInvalidationReason({ hadShutdown: true }), "session_shutdown");
  // hadShutdown wins over a foreign pid
  assert.equal(classifyIdInvalidationReason({ hadShutdown: true, previousPid: 999999 }), "session_shutdown");
  // no shutdown record + a foreign pid = the crash/kill case (forced rewrite)
  assert.equal(classifyIdInvalidationReason({ previousPid: 999999 }), "forced_rewrite");
  // same-process, no flags, no shutdown → generic handoff
  assert.equal(classifyIdInvalidationReason({ previousPid: process.pid }), "session_handoff");
  assert.equal(classifyIdInvalidationReason({}), "session_handoff");
});

// ── (b) the forced-rewrite repro (crash/kill — the screenshot case) ────

test("forced rewrite: a fresh session with a different sidecar id ledgeres id_invalidation", async () => {
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  const goal = seedGoal({ policy: "goal", status: "active", objective: "repro the invalidated id" });
  seedState(cwd, { goal });
  // A previous process died WITHOUT a shutdown record: the sidecar holds its
  // pid + session id, no shutdownReason.
  writeOwnerSidecar(cwd, { pid: 999999, at: new Date().toISOString(), generation: 7, ownerSessionId: "old-session-id" });
  const ctx = await freshSession(cwd, "startup", "new-session-id");
  await tick();
  const evs = invalidations(cwd);
  assert.equal(evs.length, 1, "one id_invalidation");
  assert.deepEqual(
    { oldId: evs[0]!.value.oldId, newId: evs[0]!.value.newId, reason: evs[0]!.value.reason, goalId: evs[0]!.value.goalId },
    { oldId: "old-session-id", newId: "new-session-id", reason: "forced_rewrite", goalId: goal.id },
  );
  assert.equal(typeof evs[0]!.value.at, "string", "timestamp present");
  assert.equal(evs[0]!.value.shutdownReason, undefined, "no shutdown record in the crash case");
  void ctx;
});

// ── (c) clean shutdown → session_shutdown with the raw reason ──────────

test("clean shutdown: the sidecar shutdownReason flows into the event", async () => {
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ policy: "goal", status: "active", objective: "repro" }) });
  writeOwnerSidecar(cwd, { pid: 999999, at: new Date().toISOString(), generation: 7, ownerSessionId: "old-session-id", shutdownReason: "quit", shutdownAt: new Date().toISOString() });
  const ctx = await freshSession(cwd, "startup", "new-session-id");
  await tick();
  const evs = invalidations(cwd);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.value.reason, "session_shutdown");
  assert.equal(evs[0]!.value.shutdownReason, "quit");
  assert.equal(evs[0]!.value.oldId, "old-session-id");
  assert.equal(evs[0]!.value.newId, "new-session-id");
  void ctx;
});

// ── (d) no invalidation when the id did NOT change (plain /reload) ─────

test("same id (plain reload): no id_invalidation", async () => {
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ policy: "goal", status: "active", objective: "repro" }) });
  writeOwnerSidecar(cwd, { pid: process.pid, at: new Date().toISOString(), generation: 7, ownerSessionId: "same-session-id" });
  const ctx = await freshSession(cwd, "startup", "same-session-id");
  await tick();
  assert.equal(invalidations(cwd).length, 0, "the id did not change — nothing invalidated");
  void ctx;
});

// ── (e) first boot: no previous owner → no id_invalidation ─────────────

test("first boot (no sidecar): no id_invalidation", async () => {
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ policy: "goal", status: "active", objective: "repro" }) });
  const ctx = await freshSession(cwd, "startup", "new-session-id");
  await tick();
  assert.equal(invalidations(cwd).length, 0, "nothing was invalidated before the first owner");
  void ctx;
});

// ── (f) the successor-absorption hook exists (source pin) ──────────────

test("successor absorption also emits id_invalidation (source-level pin)", () => {
  const src = readGoalRuntimeSource();
  assert.match(src, /emitIdInvalidation\(ctx, absorbedOldId, sessionIdOf\(ctx\.sessionManager\), "successor_absorption"\)/);
  assert.match(src, /sessionIdOf\(ownerSession \?\? deadOwnerSession\)/, "the old id comes from the recorded owner");
  assert.match(src, /function emitIdInvalidation\(/, "the emitter exists");
  assert.match(src, /"id_invalidation"/, "the ledger type is written");
});

// ── (g) unknown session ids are never recorded (fail closed) ───────────

test("unknown-session ids are not emitted (the mock default has no getSessionId)", async () => {
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ policy: "goal", status: "active", objective: "repro" }) });
  writeOwnerSidecar(cwd, { pid: 999999, at: new Date().toISOString(), generation: 7, ownerSessionId: "old-session-id" });
  // ctx WITHOUT getSessionId → sessionManagerId returns "unknown-session"
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  assert.equal(invalidations(cwd).length, 0, "unknown-session is not a real id — fail closed");
});
