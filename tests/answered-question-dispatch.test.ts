import { test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  resetContinuationDispatchState,
  scheduleContinuation,
} from "../extensions/goal-continuation.js";
import {
  __testOnlyResetZombieAutoRetry,
  __testOnlySetZombieRetryDelay,
  __testOnlySetZombieRetryMaxAttempts,
} from "../extensions/loops/goal-activation.js";
import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlySetLastRealActivityAt,
} from "../extensions/loops/goal.js";
import { __testOnlyResetZombieRunWatchdog } from "../extensions/goal-heartbeat.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, tmpCwd, tick, type MockCtx } from "./harness/mock-pi.js";
import { DEFAULT_ZOMBIE_RETRY_MAX_ATTEMPTS } from "../extensions/goal-loop-backoff.js";

// v0.38.19 track 2 (neonbreak dispatch stall, auditor-required): after the
// user answers ask_user_question, the answer lands but pi goes phantom-busy
// — busy, nothing pending, zero stream — and the old wait-for-idle send
// gate deferred the owed continuation forever (field: 35 re-arms, zero
// sends, 45m to the zombie abort). A busy session with nothing pending and
// no real stream for busySilentSendMs is wedged, not working: the marker is
// sent into pi's followUp queue instead of rearming into the void.

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager" };
const SIX_MINUTES = 6 * 60_000;

function readLedger(cwd: string): Array<{ type: string; value: Record<string, unknown> }> {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8")
    .trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function freshSession(cwd: string): Promise<MockCtx> {
  const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
  await pi.fire("session_start", { reason: "reload" }, ctx);
  return ctx;
}

let currentCtx: MockCtx | null = null;

beforeEach(() => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  __testOnlyResetZombieRunWatchdog();
  __testOnlyResetZombieAutoRetry();
  __testOnlySetZombieRetryMaxAttempts(DEFAULT_ZOMBIE_RETRY_MAX_ATTEMPTS);
  __testOnlySetLastRealActivityAt(0);
  resetContinuationDispatchState(tmpCwd());
});

afterEach(async () => {
  __testOnlySetZombieRetryDelay(null);
  __testOnlySetZombieRetryMaxAttempts(null);
  __testOnlyResetZombieRunWatchdog();
  __testOnlyResetZombieAutoRetry();
  __testOnlySetLastRealActivityAt(0);
  if (currentCtx) {
    resetContinuationDispatchState(currentCtx.cwd);
    await pi.fire("session_shutdown", { reason: "quit" }, currentCtx).catch(() => {});
    currentCtx = null;
  }
});

test("v0.38.19 answered ask_user_question dispatches a continuation turn from a phantom-busy session", async () => {
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  currentCtx = ctx;
  await pi.runTool("list_add", { items: ["answer-me item — done when the post-answer dispatch lands"] }, ctx);
  assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "active");

  // The agent asks; the user answers; the tool result lands. Then pi goes
  // phantom-busy: claims busy, holds nothing pending, streams nothing.
  await pi.fire("tool_call", { name: "ask_user_question", args: { questions: ["Proceed?"] } }, ctx);
  await pi.fire("tool_result", { name: "ask_user_question", answers: ["yes, proceed"] }, ctx);
  ctx.isIdle = () => false;
  (ctx as { hasPendingMessages?: () => boolean }).hasPendingMessages = () => false;
  // Six silent minutes pass with no turn and no stream (the field shape).
  __testOnlySetLastRealActivityAt(Date.now() - SIX_MINUTES);

  // Work is owed after the answer; the supervisor schedules the send.
  const sendsBefore = pi.sent.length;
  scheduleContinuation(ctx as never, true);
  await tick(500);

  assert.equal(pi.sent.length, sendsBefore + 1, "the owed continuation is dispatched, not rearmed forever");
  const sentText = JSON.stringify(pi.sent[pi.sent.length - 1]);
  assert.match(sentText, /GOAL CHECKPOINT goalId=/);
  const ledger = readLedger(cwd);
  assert.equal(ledger.filter((e) => e.type === "goal_continuation_send_busy_bypass").length, 1);
  const sent = ledger.filter((e) => e.type === "goal_continuation_sent");
  assert.equal(sent.length, 1);
  assert.equal((sent[0]!.value as { busyBypass?: boolean }).busyBypass, true);
});

test("v0.38.19 fresh stream keeps the wait path: no bypass into live thinking", async () => {
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  currentCtx = ctx;
  await pi.runTool("list_add", { items: ["thinking item — done when the wait path holds"] }, ctx);

  await pi.fire("tool_call", { name: "ask_user_question", args: { questions: ["Proceed?"] } }, ctx);
  await pi.fire("tool_result", { name: "ask_user_question", answers: ["yes"] }, ctx);
  ctx.isIdle = () => false;
  (ctx as { hasPendingMessages?: () => boolean }).hasPendingMessages = () => false;
  // Stream just flowed (the answer landing counts) — the turn may be
  // thinking. The old wait path must hold: rearm, never send.
  __testOnlySetLastRealActivityAt(Date.now());

  const sendsBefore = pi.sent.length;
  scheduleContinuation(ctx as never, true);
  await tick(500);

  assert.equal(pi.sent.length, sendsBefore, "no marker is fired into a live session");
  const ledger = readLedger(cwd);
  assert.equal(ledger.filter((e) => e.type === "goal_continuation_send_busy_bypass").length, 0);
  assert.ok(ledger.some((e) => e.type === "send_rearm_start"), "the send stays owed via rearm");
});

test("v0.38.19 a loaded followUp queue keeps the wait path even when silent", async () => {
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  currentCtx = ctx;
  await pi.runTool("list_add", { items: ["queued item — done when the loaded queue holds"] }, ctx);

  await pi.fire("tool_call", { name: "ask_user_question", args: { questions: ["Proceed?"] } }, ctx);
  ctx.isIdle = () => false;
  // pi already holds queued followUps that should drain on their own.
  (ctx as { hasPendingMessages?: () => boolean }).hasPendingMessages = () => true;
  __testOnlySetLastRealActivityAt(Date.now() - SIX_MINUTES);

  const sendsBefore = pi.sent.length;
  scheduleContinuation(ctx as never, true);
  await tick(500);

  assert.equal(pi.sent.length, sendsBefore, "no stacked send onto a loaded queue");
  assert.equal(readLedger(cwd).filter((e) => e.type === "goal_continuation_send_busy_bypass").length, 0);
});
