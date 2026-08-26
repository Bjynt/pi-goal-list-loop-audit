// pi-goal-list-loop-audit — v0.35.54
// tests/metric-never-moved-resumable.test.ts
//
// Collect-pass HIGH finding (2026-08-23): the v0.35.31 "metric never moved"
// stop reason (extensions/goal-loop-forever.ts) promises "/loop resume
// retries or /loop stop" in its own message, but the RESUMABLE_STOP
// predicate in /loop resume (extensions/goal-loop.ts) never matched that
// prefix — the promised command answered "No held loop to resume", and with
// propose_loop_refine gated on an ACTIVE loop, the only recovery was
// /loop stop + a fresh start discarding iteration history. Same class as
// the v0.35.25 issue-#14 zombie prefix bug (fixed there for zero-stream,
// missed for this brand-new prefix).
//
// Pins: a loop parked by "metric never moved —" RESUMES via /loop resume
// with iteration/best/history preserved and counters re-armed; a genuinely
// bounded stop ("max iterations reached") stays non-resumable.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedLoop, seedState, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const pi = new MockPi();
activate(pi.api);

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}

const NEVER_MOVED_REASON = 'metric never moved — 10 measurements without one improvement against the initial reading (best: 74, dir max). Check measureCmd/direction; /loop resume retries or /loop stop.';

function parkedNeverMovedLoop() {
  return seedLoop({
    measureCmd: "echo 74",
    direction: "max",
    active: false,
    stopReason: NEVER_MOVED_REASON,
    iteration: 10,
    bestValue: 74,
    lastValue: 74,
    stallCount: 0,
    consecutiveErrors: 3,
    consecutiveStuck: 2,
    lastStuckReason: "degenerate run",
    history: Array.from({ length: 10 }, (_, i) => ({ iteration: i + 1, value: 74, improved: false, at: new Date().toISOString() })),
  });
}

afterEach(() => {
  setGlobalAutoResume(false);
  __testOnlyResetOwnerSession();
});

async function freshCtx(cwd: string): Promise<MockCtx> {
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `nmr-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(60);
  return ctx;
}

test("behavioral: a loop parked by 'metric never moved' resumes via /loop resume — history kept, counters re-armed", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: null, list: [], loop: parkedNeverMovedLoop() });
  setGlobalAutoResume(false); // the restore gate must NOT auto-resume; this is about the explicit command
  const ctx = await freshCtx(cwd);
  const before = readState(cwd).loop;
  assert.equal(before?.active, false);
  await pi.command("loop", "resume", ctx);
  await tick(80);
  const after = readState(cwd).loop;
  assert.equal(after?.active, true, "the promised /loop resume actually resumes");
  assert.equal(after?.stopReason, undefined, "the held reason clears");
  assert.equal(after?.iteration, 10, "iteration preserved across resume");
  assert.equal(after?.bestValue, 74, "best preserved across resume");
  assert.equal(after?.history.length, 10, "history preserved — no forced fresh start");
  assert.equal(after?.consecutiveErrors ?? 0, 0, "error streak re-armed");
  assert.equal(after?.consecutiveStuck ?? 0, 0, "stuck streak re-armed");
  assert.equal(after?.stallCount, 0, "stall window re-armed");
});

test("v0.35.x: time and token bound stops resume as fresh windows without discarding history", async () => {
  const timeCwd = tmpCwd();
  const oldStartedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  seedState(timeCwd, {
    goal: null,
    list: [],
    loop: seedLoop({
      measureCmd: "echo 74",
      direction: "max",
      active: false,
      stopReason: "time bound reached (1h); best: 74",
      timeLimitHours: 1,
      startedAt: oldStartedAt,
      iteration: 4,
      bestValue: 74,
      history: [{ iteration: 4, value: 74, improved: false, at: oldStartedAt }],
    }),
  });
  const timeCtx = await freshCtx(timeCwd);
  const timeBefore = readState(timeCwd).loop!;
  await pi.command("loop", "resume", timeCtx);
  await tick(80);
  const timeAfter = readState(timeCwd).loop!;
  assert.equal(timeAfter.active, true);
  assert.equal(timeAfter.iteration, timeBefore.iteration);
  assert.equal(timeAfter.history.length, timeBefore.history.length);
  assert.ok(Date.parse(timeAfter.startedAt) > Date.parse(timeBefore.startedAt), "time resume starts a fresh window");

  const tokenCwd = tmpCwd();
  seedState(tokenCwd, {
    goal: null,
    list: [],
    loop: seedLoop({
      measureCmd: "echo 74",
      direction: "max",
      active: false,
      stopReason: "token budget exhausted (100 >= 100); best: 74",
      tokenBudget: 100,
      tokensUsed: 100,
      iteration: 5,
      bestValue: 74,
      history: [{ iteration: 5, value: 74, improved: false, at: new Date().toISOString() }],
    }),
  });
  const tokenCtx = await freshCtx(tokenCwd);
  const tokenBefore = readState(tokenCwd).loop!;
  await pi.command("loop", "resume", tokenCtx);
  await tick(80);
  const tokenAfter = readState(tokenCwd).loop!;
  assert.equal(tokenAfter.active, true);
  assert.equal(tokenAfter.iteration, tokenBefore.iteration);
  assert.equal(tokenAfter.history.length, tokenBefore.history.length);
  assert.equal(tokenAfter.tokensUsed, 0, "token resume starts a fresh budget");
  assert.ok(fs.readFileSync(path.join(tokenCwd, ".pi-glla", "active.jsonl"), "utf8").includes('"loop_bound_window_reset"'));
});

test("v0.35.x: metricless cadence delays automatic re-wakes but explicit start is urgent", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: null, list: [], loop: null });
  const ctx = await freshCtx(cwd);
  pi.sent.length = 0;
  await pi.command("loop", 'start "mature the spec" cadence=0.25', ctx);
  await tick(80);
  assert.ok(pi.sent.length >= 1, "explicit loop start wakes immediately");
  await pi.fire("agent_end", {
    messages: [{ role: "assistant", content: [{ type: "text", text: "recorded one real spec improvement" }], stopReason: "end_turn" }],
  }, ctx);
  const afterTurn = pi.sent.length;
  await tick(80);
  assert.equal(pi.sent.length, afterTurn, "automatic wake waits for the cadence");
  await tick(230);
  assert.ok(pi.sent.length > afterTurn, "automatic wake lands after the cadence");
  assert.ok(readState(cwd).loop?.lastIterationCompletedAt, "successful iteration arms the cadence timestamp");
  await pi.command("loop", "stop", ctx);
});

test("negative pin: a bounded stop ('max iterations reached') is still not resumable", async () => {
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: null,
    list: [],
    loop: seedLoop({
      measureCmd: "echo 74",
      direction: "max",
      active: false,
      stopReason: "max iterations reached (50); best: 74",
      iteration: 50,
      bestValue: 74,
    }),
  });
  const ctx = await freshCtx(cwd);
  await pi.command("loop", "resume", ctx);
  await tick(60);
  const after = readState(cwd).loop;
  assert.equal(after?.active, false, "bounds are bounds — no resume");
  assert.match(after?.stopReason ?? "", /^max iterations reached/);
});
