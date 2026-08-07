// pi-goal-list-loop-audit — v0.34.75
// tests/host-session-lost.test.ts
//
// "Host session lost" (note.md recurring, 13 screenshots 08-05→08-07): pi
// invalidated the session's extension handle and the goal-loop went terminal
// with "pi invalidated this session's extension handle without delivering a
// replacement session". The ledger timeline (audit/HOST-SESSION-LOST-
// 2026-08-07.md) shows ~45 host-wide invalidate bursts over 3 days, each
// aligning with session_shutdown/session_rebound cycles, and single-project
// invalidates with NO shutdown record (the silent deaths).
//
// v0.34.57 wrote `session_handle_invalidated` with a hardcoded
// `reason: "unknown"` — useless for separating "the session cycle ended
// normally" from "the host truly lost the session". v0.34.75 classifies the
// reason AT EMISSION from what the loop already knows:
//   - session_shutdown — clearSessionOwnedTimers ran (a lifecycle shutdown
//     preceded the invalidation — the tail of a proper quit/reload/resume);
//   - provider_disconnect — the main model was in provider-failure recovery;
//   - silent_handle_death — neither: pi invalidated the handle WITHOUT a
//     shutdown record and without delivering a replacement — the real
//     "host session lost" class.

import { test, afterEach, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { classifySessionHandleInvalidation } from "../extensions/loops/goal.js";
import activate, {
  __testOnlyHeartbeatTick,
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlyResetTerminalFlags,
  __testOnlySetSessionReplacementUntil,
} from "../extensions/loops/goal.js";
import { MockPi, invalidateHostSession, makeMockCtx, tmpCwd, seedState, seedGoal, tick, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true } : {}));
}

const pi = new MockPi();
activate(pi.api);

function readLedger(cwd: string): Array<{ type: string; value: any }> {
  const raw = fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf-8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function invalidations(cwd: string): Array<{ type: string; value: any }> {
  return readLedger(cwd).filter((e) => e.type === "session_handle_invalidated");
}

beforeEach(() => {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
});
afterEach(() => __testOnlyResetOwnerSession());

// ── (a) the reason classifier (pure) ───────────────────────────────────

test("classifySessionHandleInvalidation: each mechanism maps to its reason", () => {
  assert.equal(classifySessionHandleInvalidation({ sessionHandoffPending: true }), "session_shutdown");
  assert.equal(classifySessionHandleInvalidation({ mainModelRecoveryActive: true }), "provider_disconnect");
  // a recorded shutdown wins even when provider recovery is also active
  assert.equal(classifySessionHandleInvalidation({ sessionHandoffPending: true, mainModelRecoveryActive: true }), "session_shutdown");
  // neither → the real loss class
  assert.equal(classifySessionHandleInvalidation({}), "silent_handle_death");
  assert.equal(classifySessionHandleInvalidation({ sessionHandoffPending: false, mainModelRecoveryActive: false }), "silent_handle_death");
});

// ── (b) behavioral — the silent death (the screenshot case) ─────────────

test("host loss without any lifecycle shutdown classifies silent_handle_death", async () => {
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ policy: "goal", status: "active", objective: "repro host session lost" }) });
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  // pi invalidates the handle with NO session_end, NO replacement session.
  invalidateHostSession(pi, ctx);
  __testOnlyHeartbeatTick();
  try {
    const evs = invalidations(cwd);
    assert.equal(evs.length, 1, "one session_handle_invalidated");
    assert.equal(evs[0]!.value.reason, "silent_handle_death", "no shutdown record → the true loss class");
    assert.equal(evs[0]!.value.where, "heartbeat probe");
    assert.equal(evs[0]!.value.kind, "goal");
  } finally {
    pi.sendMessageError = null;
    pi.sessionNameError = null;
  }
});

// ── (c) behavioral — a proper lifecycle shutdown precedes the death ─────

test("a lifecycle shutdown suppresses the terminal entirely — no loss event", async () => {
  // The discriminator: after a proper session_shutdown the loop has no
  // lastCtx (clearSessionOwnedTimers nulls it) and expects the announced
  // replacement — it does NOT declare a loss. The next session_start
  // consumes the handoff debt. The silent-death event is reserved for the
  // no-shutdown case (the real "host session lost").
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ policy: "goal", status: "active", objective: "repro host session lost" }) });
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  __testOnlySetSessionReplacementUntil(0); // grace expired — even so, no terminal
  invalidateHostSession(pi, ctx);
  __testOnlyHeartbeatTick();
  try {
    const evs = invalidations(cwd);
    assert.equal(evs.length, 0, "a recorded shutdown is NOT a host loss — no terminal event");
    const shutdowns = readLedger(cwd).filter((e) => e.type === "session_shutdown");
    assert.equal(shutdowns.length, 1, "the shutdown was recorded");
    assert.equal(shutdowns[0]!.value.reason, "quit");
  } finally {
    pi.sendMessageError = null;
    pi.sessionNameError = null;
    __testOnlySetSessionReplacementUntil(null);
  }
});

// ── (d) source pins — the emission classifies; no hardcoded unknown ────

test("source pin: the emission classifies the reason instead of hardcoding unknown", () => {
  const src = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  assert.match(src, /reason: classifySessionHandleInvalidation\(\{/);
  assert.match(src, /sessionHandoffPending,/);
  assert.match(src, /mainModelRecoveryActive: mainModelRecoveryActive\(\),/);
  assert.doesNotMatch(src, /"session_handle_invalidated", \{\s*where,\s*kind: isLoopActive\(\) \? "loop" : "goal",\s*reason: "unknown"/s, "the hardcoded unknown must be gone");
});

test("source pin: the classifier and its enum are exported", () => {
  const src = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  assert.match(src, /export function classifySessionHandleInvalidation\(/);
  assert.match(src, /"session_shutdown" \| "provider_disconnect" \| "silent_handle_death"/);
});
