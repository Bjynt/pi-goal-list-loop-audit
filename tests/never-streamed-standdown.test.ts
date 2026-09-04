import { test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  DEFAULT_ZOMBIE_RETRY_MAX_ATTEMPTS,
  zombieRetryDecision,
} from "../extensions/goal-loop-backoff.js";
import {
  accountSendRearm,
  setContinuationRearmStreak,
  setContinuationRearmSince,
  __testOnlySetObservedTurnStartAt,
  resetContinuationDispatchState,
} from "../extensions/goal-continuation.js";
import {
  __testOnlyResetZombieAutoRetry,
  __testOnlySetZombieRetryDelay,
  __testOnlySetZombieRetryMaxAttempts,
} from "../extensions/loops/goal-activation.js";
import activate, {
  __testOnlyLoadState,
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { __testOnlyResetZombieRunWatchdog, __testOnlyHeartbeatTick, __testOnlySetZombieRunWindows } from "../extensions/goal-heartbeat.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, tmpCwd, tick, type MockCtx } from "./harness/mock-pi.js";

// v0.38.18 track 2 (neonbreak never-streamed hot loop): a turn that starts
// and never streams must not burn hot abort→retry cycles (field: 3 aborts in
// 5m on the same frozen clock, a full 23k payload each). The first abort
// parks durably for an explicit resume, and the rearm milestone tells the
// truth about an open-but-silent turn instead of claiming "no turn started".

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager" };

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
  __testOnlySetObservedTurnStartAt(0);
  setContinuationRearmStreak(0);
  setContinuationRearmSince(0);
});

afterEach(async () => {
  __testOnlySetZombieRunWindows(null);
  __testOnlySetZombieRetryDelay(null);
  __testOnlySetZombieRetryMaxAttempts(null);
  __testOnlyResetZombieRunWatchdog();
  __testOnlyResetZombieAutoRetry();
  __testOnlySetObservedTurnStartAt(0);
  if (currentCtx) {
    resetContinuationDispatchState(currentCtx.cwd);
    await pi.fire("session_shutdown", { reason: "quit" }, currentCtx).catch(() => {});
    currentCtx = null;
  }
});

test("v0.38.18 zombieRetryDecision: a turn that never streamed refuses at once", () => {
  const prev = { key: "goal-1", count: 0, lastAbortStreamAt: 0 };
  // Stream clock never advanced past the turn-start marker: park, no retry.
  const refused = zombieRetryDecision(1000, "goal-1", prev, 3, 1000);
  assert.equal(refused.retry, false);
  assert.equal(refused.neverStreamed, true);
  // Any stream after the begin-marker is an ordinary wedge: budget applies.
  const wedged = zombieRetryDecision(1001, "goal-1", prev, 3, 1000);
  assert.equal(wedged.retry, true);
  assert.equal(wedged.neverStreamed, undefined);
  // Unknown begin-marker (extension loaded mid-turn): legacy behavior.
  const unknown = zombieRetryDecision(1000, "goal-1", prev, 3, 0);
  assert.equal(unknown.retry, true);
});

test("v0.38.18 rearm milestone: an open-but-silent turn is named, not denied", () => {
  const cwd = tmpCwd();
  const ctx = makeMockCtx(cwd);
  // Storm in progress for 11 minutes with 35 re-arms (the field shape).
  setContinuationRearmStreak(35);
  setContinuationRearmSince(Date.now() - 11 * 60_000);
  // A turn began 6 minutes ago and never picked up the dispatch.
  __testOnlySetObservedTurnStartAt(Date.now() - 6 * 60_000);
  accountSendRearm(ctx as never, "continuation");
  const ui = ctx.ui as { notifies: Array<{ message: string }> };
  assert.equal(ui.notifies.length, 1);
  assert.match(ui.notifies[0]!.message, /a turn started 6m ago but no continuation was accepted since/);
  assert.match(ui.notifies[0]!.message, /35 re-arms/);
  assert.doesNotMatch(ui.notifies[0]!.message, /no turn started/);
});

test("v0.38.18 rearm milestone: with no open turn the legacy wording stays", () => {
  const cwd = tmpCwd();
  const ctx = makeMockCtx(cwd);
  setContinuationRearmStreak(35);
  setContinuationRearmSince(Date.now() - 11 * 60_000);
  __testOnlySetObservedTurnStartAt(0);
  accountSendRearm(ctx as never, "continuation");
  const ui = ctx.ui as { notifies: Array<{ message: string }> };
  assert.equal(ui.notifies.length, 1);
  assert.match(ui.notifies[0]!.message, /no turn started/);
});

test("v0.38.18 behavioral: a never-streamed turn aborts once and stays parked", async () => {
  __testOnlySetZombieRunWindows(0, 0);
  __testOnlySetZombieRetryDelay(50);
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  currentCtx = ctx;
  ctx.isIdle = () => false; // host BUSY, zero stream events — the field signature
  let aborts = 0;
  ctx.abort = () => { aborts++; };

  await pi.runTool("list_add", { items: ["never-streamed item — done when the park holds without a hot retry"] }, ctx);
  assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "active");

  // The turn really begins (begin-marker observed through the real handler)
  // and nothing streams after it.
  await pi.fire("turn_start", {}, ctx);
  (globalThis as any).compactionGraceUntil = 0;
  (globalThis as any).postCompletionSettleUntil = 0;
  __testOnlyHeartbeatTick();

  assert.equal(aborts, 1, "the never-streamed turn is aborted once");
  const parked = readState(cwd).goal as { status?: string; pauseReason?: string; pauseSuggestedAction?: string } | null;
  assert.equal(parked?.status, "paused");
  assert.match(parked?.pauseSuggestedAction ?? "", /never produced stream activity/);
  const ledger = readLedger(cwd);
  assert.equal(ledger.filter((e) => e.type === "zombie_auto_retry_refused_never_streamed").length, 1);
  assert.equal(ledger.filter((e) => e.type === "zombie_auto_retry_scheduled").length, 0);

  // No hot retry: the park holds without self-resume.
  const sendsAfterAbort = pi.sent.length;
  ctx.isIdle = () => true;
  await tick(300);
  assert.equal(pi.sent.length, sendsAfterAbort, "no automatic retry replays the silence");
  assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "paused");
  const ui = ctx.ui as { notifies: Array<{ message: string }> };
  assert.ok(ui.notifies.some((n) => /never produced stream activity, so no automatic retry was scheduled/.test(n.message)));
});
