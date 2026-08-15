// pi-goal-list-loop-audit — v0.34.62
// tests/stale-self-heal.test.ts
//
// The "long-session park" bug (hegemon 2026-08-06, screenshot
// 20260807_014658): in a long-running session, ONE heartbeat probe failure
// latched extensionApiStale and parked the goal plane ("this session is
// handing off to a fresh pi context — /list will be handled after
// session_start") while the SAME pi process kept serving commands. pi never
// replaced the session (no session_shutdown, no session_start — compaction
// emits only session_compact), so the only recovery was a restart.
//
// Fix shape:
//   1. HEARTBEAT_STALE_DEBOUNCE: the heartbeat requires N consecutive probe
//      failures before declaring the stale terminal — a transient probe
//      failure must not park a live session.
//   2. selfHealStaleSameSession: when a user command arrives from the SAME
//      sessionManager after the park (and the rebind grace expired) and the
//      handle now probes healthy, the latch was wrong — un-park, reclaim the
//      plane, and resume the interrupted goal per the autoResume gate.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, seedLoop, staleError, tick, type MockCtx } from "./harness/mock-pi.js";
import { readState } from "../extensions/goal-loop-core.js";
import activate, {
  __testOnlyResetStaleFlag,
  __testOnlyResetTerminalFlags,
  __testOnlyResetOwnerSession,
} from "../extensions/loops/goal.js";
import {
  __testOnlyHeartbeatTickRaw,
  __testOnlySetHeartbeatStaleDebounce,
} from "../extensions/goal-heartbeat.js";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const SRC = readGoalRuntimeSource();
const HB = fs.readFileSync("extensions/goal-heartbeat.ts", "utf-8"); // decomposition step 4 (v0.34.112)

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager" };
const OTHER_SM = { name: "other-session-manager" };

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}

function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}

async function freshSession(cwd: string, reason: string): Promise<MockCtx> {
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason }, ctx);
  return ctx;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function ledger(cwd: string): string {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
}

/** Park the session via the DEBOUNCED production path (N raw ticks). */
function parkViaHeartbeat(cwd: string, ctx: MockCtx): void {
  pi.sessionNameError = staleError();
  for (let i = 0; i < 3; i++) __testOnlyHeartbeatTickRaw();
  pi.sessionNameError = null;
  assert.match(ledger(cwd), /extension_api_stale/, "debounce expiry must park");
}

afterEach(() => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnerSession();
  __testOnlySetHeartbeatStaleDebounce(null);
  pi.sessionNameError = null;
  pi.sendMessageError = null;
  pi.sent.length = 0;
  setGlobalAutoResume(false);
});

// ---------------------------------------------------------------- source

test("v0.34.62 — debounce + self-heal wiring (source guards)", () => {
  assert.match(HB, /const HEARTBEAT_STALE_DEBOUNCE = 3;/);
  assert.match(SRC, /function probeExtensionApiStaleRaw\(\): boolean/);
  assert.match(HB, /flags\.heartbeatStaleStreak\+\+/);
  assert.match(HB, /if \(flags\.heartbeatStaleStreak < heartbeatStaleDebounce\) return;/);
  assert.match(SRC, /function selfHealStaleSameSession\(ctx: ExtensionContext\): boolean/);
  // self-heal runs BEFORE the stale gates inside rememberCtx, and before
  // successor absorption (they are mutually exclusive: heal = same session,
  // absorb = different session).
  const rememberIdx = SRC.indexOf("function rememberCtx(ctx: ExtensionContext): void {");
  const rememberBlock = SRC.slice(rememberIdx, SRC.indexOf("function isForeignCtx", rememberIdx));
  const healIdx = rememberBlock.indexOf("selfHealStaleSameSession(ctx)");
  const absorbIdx = rememberBlock.indexOf('tryAbsorbHostSuccessor(ctx, "rememberCtx")');
  assert.ok(healIdx > 0 && absorbIdx > healIdx, "self-heal runs before successor absorption in rememberCtx");
  // same-session only, never while a zombie owns the plane, never inside the
  // rebind window, and only when the fresh probe passes.
  assert.match(SRC, /if \(zombieStoodDown\) return false;/);
  assert.match(SRC, /ctx\.sessionManager !== recordedOwner\) return false;/);
  assert.match(SRC, /Date\.now\(\) < sessionReplacementUntil\) return false;/);
  assert.match(SRC, /if \(!extensionApi \|\| probeExtensionApiStaleRaw\(\)\) return false;/);
  assert.match(SRC, /"stale_self_healed"/);
});

// ----------------------------------------------------------- behavioral

test("v0.34.62 — ONE heartbeat probe failure must NOT park a live session", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlySetHeartbeatStaleDebounce(3);
  try {
    const cwd = tmpCwd();
    const ctx = await freshSession(cwd, "startup");
    await pi.command("goal", "heal target — done when pinned", ctx);
    await tick();
    assert.equal(pi.sent.length, 1, "goal dispatched a continuation");

    // The probe fails ONCE (transient — pi mid-settle), then recovers.
    pi.sessionNameError = staleError();
    __testOnlyHeartbeatTickRaw();
    pi.sessionNameError = null;

    const l = ledger(cwd);
    assert.doesNotMatch(l, /extension_api_stale/, "a single probe failure must not latch");
    assert.equal(readState(cwd).goal?.interruptedAt, undefined, "goal must not be interrupted");

    // The session stays fully live afterwards.
    await pi.command("goal", "status", ctx);
    assert.doesNotMatch(ledger(cwd), /extension_api_stale/);
    await pi.command("goal", "pause", ctx);
  } finally {
    __testOnlySetHeartbeatStaleDebounce(null);
  }
});

test("v0.34.62 — debounced park, then a same-session command self-heals (autoResume resumes the goal)", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  setGlobalAutoResume(true);
  __testOnlySetHeartbeatStaleDebounce(3);
  try {
    const cwd = tmpCwd();
    const ctx = await freshSession(cwd, "startup");
    await pi.command("goal", "heal target — done when pinned", ctx);
    await tick();
    assert.equal(pi.sent.length, 1, "goal dispatched");

    parkViaHeartbeat(cwd, ctx);
    const parked = readState(cwd).goal as { status: string; interruptedAt?: string };
    assert.equal(parked.status, "active", "the park leaves the goal recoverable");
    assert.ok(parked.interruptedAt, "the interrupt marker is durable");

    // The user returns and types a command; the handle is healthy again.
    pi.sent.length = 0;
    await pi.command("goal", "status", ctx);
    const l = ledger(cwd);
    assert.match(l, /stale_self_healed/, "the same-session command self-heals");
    const healed = readState(cwd).goal as { interruptedAt?: string };
    assert.equal(healed.interruptedAt, undefined, "the interrupt marker is cleared on heal");
    // The post-heal continuation re-dispatches (the old dispatch ledger entry
    // from the initial start must not satisfy this wait — pi.sent is the proof).
    await waitUntil(() => pi.sent.length > 0);
    assert.ok(pi.sent.length > 0, "the goal resumes dispatching after the heal");
    assert.doesNotMatch(ledger(cwd), /list_mutation_refused_stale/, "commands flow again");
    await pi.command("goal", "pause", ctx);
  } finally {
    __testOnlySetHeartbeatStaleDebounce(null);
  }
});

test("v0.34.62 — a genuinely dead handle stays parked (no heal)", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlySetHeartbeatStaleDebounce(3);
  try {
    const cwd = tmpCwd();
    const ctx = await freshSession(cwd, "startup");
    await pi.command("goal", "heal target — done when pinned", ctx);
    await tick();

    // Park AND keep the probe failing — the handle never recovers.
    pi.sessionNameError = staleError();
    for (let i = 0; i < 3; i++) __testOnlyHeartbeatTickRaw();
    await pi.command("goal", "status", ctx);
    const l = ledger(cwd);
    assert.doesNotMatch(l, /stale_self_healed/, "a dead handle must not heal");
    assert.match(l, /extension_api_stale/, "the honest park stays");
    assert.ok((readState(cwd).goal as { interruptedAt?: string }).interruptedAt, "goal stays interrupted");
    pi.sessionNameError = null;
  } finally {
    __testOnlySetHeartbeatStaleDebounce(null);
  }
});

test("v0.34.62 — a DIFFERENT session's command is not self-healed (successor absorption owns that path)", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlySetHeartbeatStaleDebounce(3);
  try {
    const cwd = tmpCwd();
    const ctx = await freshSession(cwd, "startup");
    await pi.command("goal", "heal target — done when pinned", ctx);
    await tick();

    parkViaHeartbeat(cwd, ctx);
    // In-memory (non-file-backed) successor: absorption must refuse, heal must not fire.
    const foreign = makeMockCtx(cwd, { sessionManager: OTHER_SM });
    await pi.command("goal", "status", foreign);
    assert.doesNotMatch(ledger(cwd), /stale_self_healed/, "a foreign ctx must never heal the plane");
    assert.match(ledger(cwd), /extension_api_stale/, "the park stays for the owner's session");
  } finally {
    __testOnlySetHeartbeatStaleDebounce(null);
  }
});

test("v0.34.62 — the rebind window (session_shutdown) still refuses a same-session heal", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  try {
    const cwd = tmpCwd();
    const ctx = await freshSession(cwd, "startup");
    // A shutdown announces a replacement: the handoff window is open for
    // SESSION_REBIND_GRACE_MS. A same-session command inside the window with
    // a HEALTHY handle must NOT heal — a successor session_start is expected.
    await pi.fire("session_shutdown", { reason: "reload" }, ctx);
    assert.match(ledger(cwd), /session_shutdown/);
    await pi.command("goal", "status", ctx);
    const l = ledger(cwd);
    assert.doesNotMatch(l, /stale_self_healed/, "no heal inside the rebind window");
    // With a HEALTHY handle the entry probe lets the command through (the
    // handoff warning is for the genuinely-stale probe); the plane stays
    // parked for the expected successor session_start.
    assert.match(l, /session_shutdown/, "the shutdown handoff is still recorded");
  } finally {
    // no debounce override needed — the window guard is time-based
  }
});

test("v0.34.62 — a stale-stopped loop stays held after a heal (user resumes explicitly)", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlySetHeartbeatStaleDebounce(3);
  try {
    const cwd = tmpCwd();
    seedState(cwd, {
      goal: seedGoal({ status: "active", interruptedAt: new Date().toISOString(), interruptedReason: "extension api stale (heartbeat probe)" }),
      loop: seedLoop({ active: false, stopReason: "extension api stale: pi invalidated this session's extension handle" }),
    });
    const ctx = await freshSession(cwd, "startup");
    // Park the plane again (no active goal dispatch; the park stamps the goal).
    parkViaHeartbeat(cwd, ctx);
    await pi.command("goal", "status", ctx);
    assert.match(ledger(cwd), /stale_self_healed/, "the heal happens");
    const loop = readState(cwd).loop as { active: boolean; stopReason?: string };
    assert.equal(loop.active, false, "the loop is not auto-resumed");
    assert.match(loop.stopReason ?? "", /held/, "the loop keeps its held state (restore gate normalized the stop reason)");
  } finally {
    __testOnlySetHeartbeatStaleDebounce(null);
  }
});
