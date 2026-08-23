// pi-goal-list-loop-audit — v0.35.28
// tests/wait-overdue-backstop.test.ts
//
// GitHub issue #16: a goal sat paused with {pauseKind:"wait", autoContinue:
// true, pauseResumeAt: <30 minutes stale>} while the agent narrated "the
// system should have auto-resumed by now". Investigation (Explore map of
// every wait-pause site) found the root cause class:
//   - agent-authored waits (pause_goal kind="wait") armed NO timer at all,
//     while their own copy promised automatic continuation;
//   - error-brake cooldown waits were not re-armed on session_start;
//   - every scheduled resume died with the session that created it;
//   - NO code path compared Date.now() against pauseResumeAt outside
//     display rendering.
// The fix is a heartbeat due-wait backstop: every tick, a lapsed wait gets
// its route re-fired (main-model prefix → provider probe; everything else →
// clear park + one fresh continuation), gated by supervisorPaused() so the
// manual /glla pause and the v0.35.23 load hold still freeze it. Resumed
// goals carry an autoResumed stamp whose recovery notice tells the agent it
// was ITSELF that was recovered.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { __testOnlyHeartbeatTick, __testOnlyHeartbeatTickRaw, __testOnlyResetZombieRunWatchdog, __testOnlyResetOverdueWaitBackstop } from "../extensions/goal-heartbeat.js";
import { readState } from "../extensions/goal-loop-core.js";
import { mainModelRecoveryActive } from "../extensions/goal-recovery.js";
import { replaceState } from "../extensions/goal-state.js";
import { continuationPrompt } from "../extensions/goal-continuation.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, tick, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager-wait-backstop" };

function ctxFor(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}

async function boot(cwd: string): Promise<MockCtx> {
  const ctx = ctxFor(cwd);
  await pi.fire("session_start", { reason: "reload" }, ctx);
  return ctx;
}

function readLedger(cwd: string): Array<{ type: string; value: Record<string, unknown> }> {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8")
    .trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; value: Record<string, unknown> });
}

function overdueWaitGoal(reason: string): Record<string, unknown> {
  return seedGoal({
    objective: "wait-overdue item — done when the lapsed wait actually resumes",
    status: "paused",
    autoContinue: true,
    pauseKind: "wait",
    // 30 minutes past due — the issue's exact shape.
    pauseResumeAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    pauseReason: reason,
    pauseSuggestedAction: "The system should auto-resume.",
  });
}

const GLOBAL_BACKUP = GLOBAL_SETTINGS_PATH + ".wait-backstop-backup";
try { fs.copyFileSync(GLOBAL_SETTINGS_PATH, GLOBAL_BACKUP); } catch { /* absent */ }
afterEach(() => {
  try { fs.copyFileSync(GLOBAL_BACKUP, GLOBAL_SETTINGS_PATH); } catch { fs.rmSync(GLOBAL_SETTINGS_PATH, { force: true }); }
  fs.rmSync(GLOBAL_BACKUP, { force: true });
});

test("v0.35.28 #16: a wait 30min past its pauseResumeAt is resumed by the heartbeat backstop", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  __testOnlyResetOverdueWaitBackstop();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true }));
  const cwd = tmpCwd();
  seedState(cwd, { goal: overdueWaitGoal("waiting for the upstream Nvidia provider to recover") });
  pi.sent.length = 0;
  const ctx = await boot(cwd);
  try {
    assert.equal((readState(cwd).goal as { status?: string }).status, "paused", "boot alone does not resume it");
    assert.equal(pi.sent.length, 0);

    __testOnlyHeartbeatTick();
    await tick();

    const goal = readState(cwd).goal as { status?: string; pauseKind?: string; autoResumedAt?: string; autoResumedEvent?: string };
    assert.equal(goal.status, "active", "the lapsed wait actually resumes");
    assert.equal(goal.pauseKind, undefined);

    const events = readLedger(cwd).filter((e) => e.type === "wait_pause_overdue_resume");
    assert.equal(events.length, 1, "exactly one backstop fire, ledgered");
    assert.equal(events[0]!.value.route, "continuation");

    assert.ok(pi.sent.length >= 1, "one fresh continuation dispatch follows");
    const sent = String((pi.sent[pi.sent.length - 1]!.message as { content?: unknown }).content ?? "");
    assert.ok(sent.includes("YOU WERE RECOVERED"), "the agent is told it was itself that was recovered");
    assert.ok(sent.includes("no external recovery signal to wait for"), "the waiting-for-recovery confusion is named");

    // v0.35.37: the notice fires EXACTLY ONCE — the accepted dispatch marks
    // it delivered (ledger + stamp cleared), so a goal that keeps running
    // for days stops getting the stale directive injected on every turn.
    const delivered = readLedger(cwd).filter((e) => e.type === "recovery_notice_delivered");
    assert.equal(delivered.length, 1, "the delivery is ledgered once");
    assert.equal(goal.autoResumedAt, undefined, "the stamp clears once the notice has been dispatched");
    assert.equal(goal.autoResumedEvent, undefined);
    assert.doesNotMatch(
      continuationPrompt(readState(cwd).goal as Parameters<typeof continuationPrompt>[0]),
      /YOU WERE RECOVERED/,
      "subsequent continuations no longer inject the stale recovery directive",
    );

    await pi.command("goal", "cancel", ctx);
  } finally {
    __testOnlyResetOverdueWaitBackstop();
    __testOnlyResetZombieRunWatchdog();
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("v0.35.28 #16: not-yet-due and already-fired waits do not double-dispatch", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  __testOnlyResetOverdueWaitBackstop();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true }));
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({
      objective: "future wait — must stay parked until its time",
      status: "paused",
      pauseKind: "wait",
      pauseResumeAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      pauseReason: "rate limit window",
    }),
  });
  pi.sent.length = 0;
  const ctx = await boot(cwd);
  try {
    __testOnlyHeartbeatTick();
    await tick();
    assert.equal((readState(cwd).goal as { status?: string }).status, "paused", "a future wait stays parked");
    assert.equal(pi.sent.filter(Boolean).length, 0, "no dispatch for a non-overdue wait");
    assert.equal(readLedger(cwd).filter((e) => e.type === "wait_pause_overdue_resume").length, 0);
  } finally {
    __testOnlyResetOverdueWaitBackstop();
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("v0.35.28 #16: under the load hold (stock consent-less boot) an overdue wait stays frozen", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  __testOnlyResetOverdueWaitBackstop();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({}));
  const cwd = tmpCwd();
  seedState(cwd, { goal: overdueWaitGoal("waiting for the upstream provider") });
  pi.sent.length = 0;
  const ctx = await boot(cwd);
  try {
    assert.ok(typeof readState(cwd).loadHoldAt === "number", "cold boot without consent engages the hold");
    __testOnlyHeartbeatTick();
    await tick(50);
    __testOnlyHeartbeatTick();
    await tick(50);
    assert.equal((readState(cwd).goal as { status?: string }).status, "paused", "hold freezes the overdue wait");
    assert.equal(readLedger(cwd).filter((e) => e.type === "wait_pause_overdue_resume").length, 0);

  } finally {
    __testOnlyResetOverdueWaitBackstop();
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("v0.35.28 #16: manual /goal resume clears the recovery stamp (user-driven, no notice needed)", async () => {
  const cwd = tmpCwd();
  const ctx = ctxFor(cwd);
  seedState(cwd, {
    goal: seedGoal({
      objective: "stamp clearing check",
      status: "active",
      autoResumedAt: new Date().toISOString(),
      autoResumedEvent: "old event",
    }),
  });
  await pi.command("goal", "resume", ctx);
  const goal = readState(cwd).goal as { autoResumedAt?: string };
  assert.equal(goal.autoResumedAt, undefined, "manual resume clears the auto-resume stamp");
});

test("v0.35.28 #16: the pause_goal wait copy is now backed by machinery (source pin)", () => {
  const toolsSrc = fs.readFileSync("extensions/loops/goal-tools.ts", "utf8");
  assert.match(toolsSrc, /heartbeat backstop/, "the long-wait copy names the mechanism that honors it");
});

test("v0.35.28 #16: once consent exists on reload, the overdue wait resumes through the backstop", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  __testOnlyResetOverdueWaitBackstop();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({}));
  const cwd = tmpCwd();
  seedState(cwd, { goal: overdueWaitGoal("waiting for the upstream provider") });
  pi.sent.length = 0;
  let ctx = await boot(cwd);
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);

  // The user opts into auto-resume (Auto-resume=on) and pi reloads.
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true }));
  ctx = await boot(cwd);
  try {
    assert.equal(typeof readState(cwd).loadHoldAt, "undefined" as unknown as typeof undefined, "consenting boot does not engage the hold");
    __testOnlyHeartbeatTick();
    await tick();
    const goal = readState(cwd).goal as { status?: string };
    assert.equal(goal.status, "active", "the backstop resumes the lapsed wait under consent");
    assert.ok(readLedger(cwd).some((e) => e.type === "wait_pause_overdue_resume"));
  } finally {
    __testOnlyResetOverdueWaitBackstop();
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

// v0.35.48 (audit finding): overdueWaitBackstop mutates DURABLE state
// (parked → active, pauseResumeAt cleared) — it must only fire when the
// dispatch surface can carry the resume. Mid-handoff or stale-latched
// windows stay parked; an active main-model recovery only releases
// recovery-routed waits (the probe route), never unrelated agent-authored
// waits that would dispatch into the same broken model.
test("v0.35.48: the backstop stays parked during a session handoff window", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  __testOnlyResetOverdueWaitBackstop();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true }));
  const cwd = tmpCwd();
  const ctx = await boot(cwd);
  seedState(cwd, { goal: overdueWaitGoal("waiting for the upstream provider to recover") });
  try {
    // A real session_shutdown latches sessionHandoffPending (the handoff
    // window) WITHOUT rebinding a new session.
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
    __testOnlyHeartbeatTickRaw();
    await tick();

    const goal = readState(cwd).goal as { status?: string };
    assert.equal(goal.status, "paused", "mid-handoff: the overdue wait STAYS parked — no active-with-no-dispatch state");
    assert.equal(readLedger(cwd).filter((e) => e.type === "wait_pause_overdue_resume").length, 0, "no backstop fire is ledgered");
  } finally {
    __testOnlyResetOverdueWaitBackstop();
    __testOnlyResetZombieRunWatchdog();
  }
});

test("v0.35.48: an agent-authored wait stays parked while main-model recovery is active", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  __testOnlyResetOverdueWaitBackstop();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true }));
  const cwd = tmpCwd();
  seedState(cwd, { goal: overdueWaitGoal("waiting for the quota window to reset") });
  pi.sent.length = 0;
  const ctx = await boot(cwd);
  // Set the recovery park AFTER boot — session_start settles its own state.
  replaceState({ ...readState(cwd), mainModelRecovery: { attempt: 1, retryAt: Date.now() + 5 * 60_000 } } as never);
  try {
    assert.equal(mainModelRecoveryActive(), true, "precondition: recovery park is live");
    __testOnlyHeartbeatTick();
    await tick();

    const goal = readState(cwd).goal as { status?: string };
    assert.equal(goal.status, "paused", "recovery-active: an unrelated wait STAYS parked instead of dispatching into the broken model");
    assert.equal(readLedger(cwd).filter((e) => e.type === "wait_pause_overdue_resume").length, 0, "no backstop fire is ledgered");
    assert.equal(pi.sent.length, 0, "nothing was dispatched");
  } finally {
    replaceState({ ...(readState(cwd)), mainModelRecovery: null } as never);
    __testOnlyResetOverdueWaitBackstop();
    __testOnlyResetZombieRunWatchdog();
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});
