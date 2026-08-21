// pi-goal-list-loop-audit — v0.35.17
// tests/post-accept-hang-retry.test.ts
//
// Field (note.md Next §1, screenshot 20260821_152311): turns dispatched by
// ACCEPTING a Confirm dialog hang with zero provider stream activity often
// enough that users repeatedly return to "action needed - this won't fix
// itself" parked sessions. v0.35.17 amends the zero-stream watchdog: the
// FIRST silence of a streak arms ONE bounded automatic retry; a SECOND
// consecutive silence parks permanently.
//
// Layers under test:
//   1. zombieRetryDecision (pure, goal-loop-backoff.ts) — the one-retry bound:
//      first silence retries, second consecutive silence refuses, and real
//      stream activity between aborts starts a fresh streak.
//   2. Source pins — the scheduler is wired into abortZombieRun with the
//      supervisor-pause gate, the exact pauseReason supersede guard, and the
//      abort-key release that lets the watchdog re-abort a fully-silent retry.
//   3. Behavioral (MockPi harness) — end-to-end: busy+silent turn is aborted
//      and parked once, the delayed timer auto-resumes and re-dispatches
//      exactly one turn; a second consecutive silence refuses the retry.

import { test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  ZOMBIE_RETRY_DELAY_MS,
  zombieRetryDecision,
  type ZombieRetryStreak,
} from "../extensions/goal-loop-backoff.js";
import { __testOnlyResetZombieAutoRetry, __testOnlySetZombieRetryDelay } from "../extensions/loops/goal-activation.js";
import activate, {
  __testOnlyLoadState,
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { __testOnlyResetZombieRunWatchdog, __testOnlyHeartbeatTick, __testOnlySetZombieRunWindows } from "../extensions/goal-heartbeat.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd, tick, type MockCtx } from "./harness/mock-pi.js";

const pi = new MockPi();
activate(pi.api);

// ---------------------------------------------------------------------------
// 1. Pure streak decision
// ---------------------------------------------------------------------------

test("v0.35.17 zombieRetryDecision: the FIRST silence of an episode arms exactly one retry", () => {
  const first = zombieRetryDecision(1000, "goal-1", { key: "", count: 0, lastAbortStreamAt: 0 });
  assert.equal(first.retry, true);
  assert.equal(first.streak.count, 1);

  // A retried turn that actually streams advances the stream clock past the
  // recorded abort point — any LATER independent hang earns its own retry.
  const later = zombieRetryDecision(5000, "goal-1", first.streak);
  assert.equal(later.retry, true, "stream activity between aborts resets the streak");
  assert.equal(later.streak.count, 1);
});

test("v0.35.17 zombieRetryDecision: the SECOND consecutive silence refuses (no storm)", () => {
  const t = 42_000;
  const fresh: ZombieRetryStreak = { key: "", count: 0, lastAbortStreamAt: 0 };
  const first = zombieRetryDecision(t, "goal-1", fresh);
  assert.equal(first.retry, true);
  // Retry hung too: same owner, stream clock never advanced past t.
  const second = zombieRetryDecision(t, "goal-1", first.streak);
  assert.equal(second.retry, false, "a hung retry must not arm another retry");
  assert.equal(second.streak.count, 2);
  const third = zombieRetryDecision(t, "goal-1", second.streak);
  assert.equal(third.retry, false, "the refusal holds for further silences");
});

test("v0.35.17 zombieRetryDecision: a different owner key always gets its own first retry", () => {
  const first = zombieRetryDecision(100, "goal-A", { key: "goal-B", count: 2, lastAbortStreamAt: 100 });
  assert.equal(first.retry, true);
});

test("v0.35.17 production delay default is 90s and stays bounded", () => {
  assert.ok(ZOMBIE_RETRY_DELAY_MS >= 30_000 && ZOMBIE_RETRY_DELAY_MS <= 5 * 60_000);
});

// ---------------------------------------------------------------------------
// 2. Source pins (house pattern for activation-internal wiring)
// ---------------------------------------------------------------------------

const ACTIVATION_SRC = fs.readFileSync(path.resolve("extensions/loops/goal-activation.ts"), "utf-8");

test("v0.35.17 source: the auto-retry is armed inside abortZombieRun behind the streak decision", () => {
  const callIdx = ACTIVATION_SRC.indexOf("scheduleZombieAutoRetry(current, generation, goal?.id, observedStreamAt, silentMinutes)");
  assert.ok(callIdx > 0, "abortZombieRun arms the bounded retry");
  assert.match(
    ACTIVATION_SRC.slice(Math.max(0, callIdx - 400), callIdx),
    /abortError/,
    "the retry is armed only on the successful abort path (after ctx.abort())",
  );
  assert.match(ACTIVATION_SRC, /zombie_auto_retry_scheduled/, "arming is durable in the ledger");
  assert.match(ACTIVATION_SRC, /zombie_auto_retry_refused_streak/, "a refused streak names itself in the ledger");
});

test("v0.35.17 source: the retry timer respects /glla pause and only clears ITS OWN park", () => {
  const timerIdx = ACTIVATION_SRC.indexOf("zombieRetryTimer = scheduleSessionTimeout(");
  const body = ACTIVATION_SRC.slice(timerIdx, timerIdx + 2600);
  assert.match(body, /supervisorPaused\(state\)/, "a frozen supervisor keeps the park standing");
  assert.match(body, /freshCtxForGeneration\(generation\)/, "the timer is generation-fenced");
  assert.match(body, /goal\.pauseReason !== ZOMBIE_PAUSE_REASON/, "a superseded pause is never cleared by the stale timer");
  assert.match(body, /abortedStandDown = false/, "the dispatch stand-down is released before re-dispatching");
  assert.match(body, /scheduleContinuation\(fresh, true\)/, "goal/list items re-dispatch through the durable continuation machinery");
  assert.match(body, /releaseZombieAbortKey\(\)/, "the heartbeat abort latch is released so a fully-silent retry can still be re-aborted");
});

test("v0.35.17 source: the user-facing copy announces the automatic retry when armed", () => {
  assert.match(
    ACTIVATION_SRC,
    /An automatic retry starts in ~90s;/,
    "armed parks say so instead of demanding manual action",
  );
});

// ---------------------------------------------------------------------------
// 3. Behavioral: full hang → abort/park → auto-resume → re-dispatch arc
// ---------------------------------------------------------------------------

function readLedger(cwd: string): Array<{ type: string; value: Record<string, unknown> }> {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8")
    .trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function freshSession(cwd: string): Promise<MockCtx> {
  const ctx = makeMockCtx(cwd);
  await pi.fire("session_start", { reason: "reload" }, ctx);
  return ctx;
}

let currentCtx: MockCtx | null = null;

beforeEach(() => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  __testOnlyResetZombieRunWatchdog();
  __testOnlyResetZombieAutoRetry();
});

afterEach(async () => {
  __testOnlySetZombieRunWindows(null);
  __testOnlySetZombieRetryDelay(null);
  __testOnlyResetZombieRunWatchdog();
  __testOnlyResetZombieAutoRetry();
  if (currentCtx) {
    await pi.fire("session_shutdown", { reason: "quit" }, currentCtx).catch(() => {});
    currentCtx = null;
  }
});

test("v0.35.17 behavioral: a hung post-accept turn aborts, parks, then AUTO-resumes with exactly one re-dispatch", async () => {
  __testOnlySetZombieRunWindows(0, 0);
  __testOnlySetZombieRetryDelay(50);
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ status: "active", objective: "post-accept hang item — done when the bounded auto-retry lands" }),
  });
  const ctx = await freshSession(cwd);
  currentCtx = ctx;
  ctx.isIdle = () => false; // host BUSY, zero stream events — the field signature
  let aborts = 0;
  ctx.abort = () => { aborts++; };

  await pi.runTool("list_add", { items: ["post-accept hang item — done when the bounded auto-retry lands"] }, ctx);
  assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "active");

  (globalThis as any).compactionGraceUntil = 0;
  (globalThis as any).postCompletionSettleUntil = 0;
  __testOnlyHeartbeatTick();

  const parked = readState(cwd).goal as { status?: string; pauseKind?: string; pauseReason?: string } | null;
  assert.equal(aborts, 1, "the confirmed zero-stream turn is aborted once");
  assert.equal(parked?.status, "paused");
  assert.equal(parked?.pauseKind, "error");
  assert.match(parked?.pauseReason ?? "", /zero-stream abort/);
  const ledger = readLedger(cwd);
  assert.equal(ledger.filter((e) => e.type === "zombie_auto_retry_scheduled").length, 1);

  // The waystation: after the shrunk delay the supervisor resumes the goal
  // by itself and re-dispatches EXACTLY one continuation.
  const sendsBeforeAbort = pi.sent.length;
  ctx.isIdle = () => true; // the aborted host settles idle before the timer fires
  await tick(300);

  assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "active", "the automatic retry un-parks the goal");
  assert.equal(readLedger(cwd).filter((e) => e.type === "zombie_auto_retry_dispatched").length, 1);
  assert.equal(pi.sent.length, sendsBeforeAbort + 1, "exactly one fresh dispatch — no storm");
});

test("v0.35.17 behavioral: a SECOND consecutive zero-stream abort refuses the retry and stays parked", async () => {
  __testOnlySetZombieRunWindows(0, 0);
  __testOnlySetZombieRetryDelay(40);
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ status: "active", objective: "double-hang item — done when the second silence parks for good" }),
  });
  const ctx = await freshSession(cwd);
  currentCtx = ctx;
  ctx.isIdle = () => false;
  let aborts = 0;
  ctx.abort = () => { aborts++; };

  await pi.runTool("list_add", { items: ["double-hang item — done when the second silence parks for good"] }, ctx);
  (globalThis as any).compactionGraceUntil = 0;
  (globalThis as any).postCompletionSettleUntil = 0;

  // First silence → abort + scheduled retry.
  __testOnlyHeartbeatTick();
  assert.equal(aborts, 1);
  assert.equal(readLedger(cwd).filter((e) => e.type === "zombie_auto_retry_scheduled").length, 1);

  // The timer fires while the host is STILL busy-silent (retry hangs too):
  // the goal re-activates and one fresh dispatch goes out.
  await tick(200);
  assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "active");
  const sendsAfterFirstRetry = pi.sent.length;

  // Second consecutive silence → abort again, but NO new retry is armed.
  __testOnlyHeartbeatTick();
  assert.equal(aborts, 2, "the hung retry is aborted too");
  assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "paused", "the second silence parks permanently");
  const ledger = readLedger(cwd);
  assert.equal(ledger.filter((e) => e.type === "zombie_auto_retry_scheduled").length, 1, "no second retry is ever scheduled");
  assert.equal(ledger.filter((e) => e.type === "zombie_auto_retry_refused_streak").length, 1);

  await tick(300);
  assert.equal(pi.sent.length, sendsAfterFirstRetry, "the refused park does not self-resume");
  assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "paused");
});

test("v0.35.17 behavioral: /glla pause freezes the automatic retry — the park stands until resume", async () => {
  __testOnlySetZombieRunWindows(0, 0);
  __testOnlySetZombieRetryDelay(40);
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ status: "active", objective: "paused-supervisor item — done when pause keeps the park" }),
  });
  const ctx = await freshSession(cwd);
  currentCtx = ctx;
  ctx.isIdle = () => false;
  let aborts = 0;
  ctx.abort = () => { aborts++; };

  await pi.runTool("list_add", { items: ["paused-supervisor item — done when pause keeps the park"] }, ctx);
  // Freeze the supervisor BEFORE the watchdog fires.
  await pi.command("glla", "pause", ctx);
  assert.equal((readState(cwd).goal as { supervisorPausedAt?: number } & Record<string, unknown> | null)?.supervisorPausedAt !== undefined, true);

  (globalThis as any).compactionGraceUntil = 0;
  (globalThis as any).postCompletionSettleUntil = 0;
  __testOnlyHeartbeatTick();
  assert.equal(aborts, 1, "an in-flight zero-stream abort still lands (it stops token bleed)");
  // The scheduler itself runs inside abortZombieRun — the PAUSE gate lives in
  // the timer body, so the ledger records the schedule but the frozen timer
  // must refuse to fire it.
  const sendsBefore = pi.sent.length;
  ctx.isIdle = () => true;
  await tick(300);
  assert.equal(
    (readState(cwd).goal as { status?: string } | null)?.status,
    "paused",
    "the frozen supervisor leaves the park standing",
  );
  assert.equal(pi.sent.length, sendsBefore, "no automatic dispatch under /glla pause");
});
