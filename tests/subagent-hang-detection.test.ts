// pi-goal-list-loop-audit — v0.34.85
// tests/subagent-hang-detection.test.ts
//
// note.md Screenshots 161019/161032: subagents frozen at 10697s (3h) with
// zero stream activity — repeated "BUSY with zero stream activity" warnings
// at 22/31/41 min. The auditor's detached worker has a heartbeat-without-
// progress watchdog (auditor-process.ts, 10m); subagent sessions have none.
// v0.34.85 extends the no-progress watchdog to subagent sessions with a
// SHORTER default (5m vs the auditor's 10m): a subagent whose pi-subagents
// record is still "running" but shows no NEW progress (tool uses or output
// tokens) for 5m is surfaced (ui.notify + notifyExternal) and ledgered
// `subagent_hang_detected` so the main session can decide to abort.
//
// Progress evidence joins the record via the cross-package registry
// Symbol.for("pi-subagents:manager") → getRecord(id) (live toolUses /
// lifetimeUsage.output / status); compacted/steered events refresh the
// streak as secondary evidence; completed/failed end the watch.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import activate, {
  classifyHungSubagents,
  __testOnlyResetOwnerSession,
  __testOnlySubagentHangProbes,
  __testOnlyClearSubagentHangProbes,
} from "../extensions/loops/goal.js";
import {
  MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, tick,
  type MockCtx,
} from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true } : {}));
}
function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: { name: "main-session-manager" } });
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
function ledgerHangs(cwd: string): Array<{ type: string; value?: any }> {
  return readLedger(cwd).filter((l) => l.type === "subagent_hang_detected");
}
/** Active goal + fresh session (autoResume keeps it ACTIVE past the restore gate). */
async function spawnFixture(): Promise<{ cwd: string; ctx: MockCtx }> {
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ policy: "goal", status: "active", objective: "watch a subagent" }) });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  return { cwd, ctx };
}

const pi = new MockPi();
activate(pi.api);

/** A fake running subagent record, mirroring pi-subagents' AgentRecord poll shape. */
function runningRecord(overrides: { toolUses?: number; output?: number; status?: string } = {}): any {
  return { toolUses: 0, lifetimeUsage: { output: 0 }, status: "running", ...overrides };
}
const MANAGER_KEY = Symbol.for("pi-subagents:manager");
function installManager(getRecord: (id: string) => any | undefined): void {
  (globalThis as any)[MANAGER_KEY] = { getRecord };
}
function uninstallManager(): void {
  delete (globalThis as any)[MANAGER_KEY];
}

afterEach(() => {
  __testOnlyResetOwnerSession();
  __testOnlyClearSubagentHangProbes();
  uninstallManager();
});

// ---------------------------------------------------------------- pure unit

test("classify: a running subagent with no new progress for 5m is hung", () => {
  const probes = [
    { recordId: "r1", lastProgressAt: Date.now() - 5 * 60_000 - 1, lastToolUses: 1, lastOutputTokens: 10 },
  ];
  const hung = classifyHungSubagents(probes, () => runningRecord({ toolUses: 1, output: 10 }));
  assert.equal(hung.length, 1, "the wedged subagent is flagged");
  assert.equal(hung[0]!.recordId, "r1");
  assert.ok(hung[0]!.silentMs >= 5 * 60_000);
});

test("classify: sub-5m silence is not hung (5m floor, shorter than the auditor's 10m)", () => {
  const probes = [
    { recordId: "r1", lastProgressAt: Date.now() - 4 * 60_000, lastToolUses: 1, lastOutputTokens: 10 },
  ];
  const hung = classifyHungSubagents(probes, () => runningRecord({ toolUses: 1, output: 10 }));
  assert.equal(hung.length, 0, "4m of silence is inside the 5m window");
});

test("classify: a NEW tool use refreshes the streak (working, not wedged)", () => {
  const probes = [
    { recordId: "r1", lastProgressAt: Date.now() - 30 * 60_000, lastToolUses: 1, lastOutputTokens: 10 },
  ];
  const hung = classifyHungSubagents(probes, () => runningRecord({ toolUses: 2, output: 10 }));
  assert.equal(hung.length, 0, "a tool use is progress — no hang");
  assert.equal(probes[0]!.lastToolUses, 2, "the counters advanced");
  assert.ok(probes[0]!.lastProgressAt > Date.now() - 60_000, "the streak reset to now");
});

test("classify: NEW output tokens refresh the streak (long think, still alive)", () => {
  const probes = [
    { recordId: "r1", lastProgressAt: Date.now() - 20 * 60_000, lastToolUses: 5, lastOutputTokens: 100 },
  ];
  const hung = classifyHungSubagents(probes, () => runningRecord({ toolUses: 5, output: 400 }));
  assert.equal(hung.length, 0, "output tokens are progress — no hang");
  assert.equal(probes[0]!.lastOutputTokens, 400);
});

test("classify: ended / non-running records are not hung (watch stops)", () => {
  const ended = [{ recordId: "r1", lastProgressAt: Date.now() - 60 * 60_000, lastToolUses: 1, lastOutputTokens: 1, endedAt: Date.now() }];
  assert.equal(classifyHungSubagents(ended, () => runningRecord()).length, 0, "ended probe is skipped");
  const completed = [{ recordId: "r2", lastProgressAt: Date.now() - 60 * 60_000, lastToolUses: 1, lastOutputTokens: 1 }];
  assert.equal(classifyHungSubagents(completed, () => runningRecord({ status: "completed" })).length, 0, "completed record is skipped");
  const gone = [{ recordId: "r3", lastProgressAt: Date.now() - 60 * 60_000, lastToolUses: 1, lastOutputTokens: 1 }];
  assert.equal(classifyHungSubagents(gone, () => undefined).length, 0, "vanished record is skipped (no false positive)");
});

// ------------------------------------------------------------- integration

test("hang detection surfaces ui.notify + ledger `subagent_hang_detected` via the heartbeat scan", async () => {
  const { cwd, ctx } = await spawnFixture();
  installManager(() => runningRecord({ toolUses: 0, output: 0 })); // frozen record
  pi.emitBus("subagents:started", { id: "sub-wedged-1", type: "Explore", description: "survey auth flow" });
  await tick();
  assert.equal(__testOnlySubagentHangProbes().length, 1, "spawn seeded the probe");

  // Backdate the probe so the 5m streak is already elapsed.
  const probe = __testOnlySubagentHangProbes()[0]!;
  probe.lastProgressAt = Date.now() - 6 * 60_000;

  await pi.fire("heartbeat_tick", {}, ctx);
  await tick();

  const hangs = ledgerHangs(cwd);
  assert.equal(hangs.length, 1, "exactly one hang ledgered");
  assert.equal(hangs[0]!.value.recordId, "sub-wedged-1");
  assert.equal(hangs[0]!.value.agentType, "Explore");
  assert.equal(hangs[0]!.value.summary, "survey auth flow");
  assert.ok(hangs[0]!.value.silentMs >= 5 * 60_000);
  const warned = ctx.ui.notifies.filter((n) => n.message.includes("no progress"));
  assert.equal(warned.length, 1, "the user was warned");
  assert.ok(warned[0]!.message.includes("Explore"), "the warning names the subagent");
});

test("hang warning is throttled — one alert per 5m streak window, not per tick", async () => {
  const { cwd, ctx } = await spawnFixture();
  installManager(() => runningRecord({ toolUses: 0, output: 0 }));
  pi.emitBus("subagents:started", { id: "sub-throttle-1", type: "general-purpose", description: "build the widget" });
  await tick();
  const probe = __testOnlySubagentHangProbes()[0]!;
  probe.lastProgressAt = Date.now() - 6 * 60_000;

  await pi.fire("heartbeat_tick", {}, ctx);
  await tick();
  await pi.fire("heartbeat_tick", {}, ctx); // second tick within the throttle window
  await tick();

  assert.equal(ledgerHangs(cwd).length, 1, "the second tick does not re-alert inside the throttle");
});

test("completed/failed events end the watch — no hang alert after completion", async () => {
  const { cwd, ctx } = await spawnFixture();
  installManager(() => runningRecord({ toolUses: 0, output: 0 }));
  pi.emitBus("subagents:started", { id: "sub-done-1", type: "Plan", description: "design the rollout" });
  await tick();
  pi.emitBus("subagents:completed", { id: "sub-done-1", type: "Plan", description: "design the rollout", status: "completed" });
  await tick();
  const probe = __testOnlySubagentHangProbes()[0]!;
  assert.ok(probe.endedAt !== undefined, "the watch ended on completion");
  probe.lastProgressAt = Date.now() - 6 * 60_000;

  await pi.fire("heartbeat_tick", {}, ctx);
  await tick();
  assert.equal(ledgerHangs(cwd).length, 0, "no hang alert for a completed subagent");
});

test("compacted/steered events refresh the streak (secondary progress evidence)", async () => {
  const { cwd, ctx } = await spawnFixture();
  installManager(() => runningRecord({ toolUses: 0, output: 0 }));
  pi.emitBus("subagents:started", { id: "sub-alive-1", type: "Explore", description: "long research pass" });
  await tick();
  const probe = __testOnlySubagentHangProbes()[0]!;
  probe.lastProgressAt = Date.now() - 6 * 60_000;
  pi.emitBus("subagents:compacted", { id: "sub-alive-1", reason: "context full" });
  await tick();

  await pi.fire("heartbeat_tick", {}, ctx);
  await tick();
  assert.equal(ledgerHangs(cwd).length, 0, "a compaction is fresh evidence — no hang");
  assert.ok(probe.lastProgressAt > Date.now() - 60_000, "the streak reset on the compacted event");
});

test("malformed hang inputs are dropped, not crashy", async () => {
  const { cwd } = await spawnFixture();
  installManager(() => runningRecord());
  pi.emitBus("subagents:started", { type: "Explore" });         // no id
  pi.emitBus("subagents:compacted", "not-an-object");           // garbage payload
  pi.emitBus("subagents:steered", { message: "no id" });        // no id
  pi.emitBus("subagents:completed", { id: 42 });                // non-string id
  pi.emitBus("subagents:failed", { id: "" });                   // empty id
  await tick();
  assert.equal(__testOnlySubagentHangProbes().length, 0, "nothing registered for malformed events");
  void cwd;
});

test("source pins: constants, watchdog wiring, and ledger key", () => {
  const src = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  assert.match(src, /const SUBAGENT_HANG_NO_PROGRESS_MS = 5 \* 60_000;/);
  assert.match(src, /Symbol\.for\("pi-subagents:manager"\)/);
  assert.match(src, /subagent_hang_detected/);
  assert.match(src, /subagents:compacted/);
  assert.match(src, /subagents:steered/);
  assert.match(src, /subagents:completed/);
  assert.match(src, /subagents:failed/);
  assert.match(src, /upsertSubagentHangProbe\(sessionId/);
});
