// pi-goal-list-loop-audit — tests/quota-prompter.test.ts
//
// Hourly quota-resume prompter (bug #1.15 / OPEN-ISSUES-2026-08-06):
// on a provider quota wall the goal parks into durable recovery; this file
// pins that a single sendUserMessage is SCHEDULED at the next :00 clock
// minute with the original turn context (detector in goal-loop-core.ts),
// gated on autoResume: true, and that the prompter NEVER self-resumes —
// firing the prompt leaves the parked goal parked.
//
// Co-residency: this file fires agent_end (like the behavioral driver) but
// NEVER session_start. beforeEach resets the module-level terminal/owner
// flags and the prompter state; settings are written to the suite's global
// settings path so autoResume is explicit per test.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isQuotaWallError, nextHourlyPromptMs, readState } from "../extensions/goal-loop-core.js";
import {
  __testOnlyFireQuotaPrompt,
  __testOnlyQuotaPromptState,
  __testOnlyResetOwnerSession,
  __testOnlyResetQuotaPrompt,
  __testOnlyResetStaleFlag,
  __testOnlyResetTerminalFlags,
  __testOnlySetQuotaPromptNow,
  __testOnlyResetStallState,
  __testOnlyLoadState,
} from "../extensions/loops/goal.js";
import activate from "../extensions/loops/goal.js";
import { makeMockCtx, MockPi, seedGoal, seedState, tmpCwd } from "./harness/mock-pi.js";

const MAIN_SM = { name: "main-session-manager" };

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

function ownerCtx(cwd: string) {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}

/** All ledger entries for a cwd, in order. */
function readLedger(cwd: string): Array<{ type: string; value: any; at: string }> {
  return fs
    .readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeSettings(settings: Record<string, unknown>): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(settings));
}

function quotaWallAgentEnd(): Record<string, unknown> {
  return {
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "partial work before the wall" }],
        stopReason: "error",
        errorMessage: "429 rate limit: provider quota exceeded for this hourly window",
      },
    ],
  };
}

beforeEach(() => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnerSession();
  __testOnlyResetStallState();
  __testOnlyResetQuotaPrompt();
  __testOnlySetQuotaPromptNow(Date.UTC(2026, 7, 6, 18, 44, 30)); // 18:44:30Z — next :00 is 19:00:00Z
  writeSettings({ autoResume: true });
});

afterEach(() => {
  __testOnlyResetQuotaPrompt();
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnerSession();
  __testOnlySetQuotaPromptNow(null);
  writeSettings({});
});

// ---- (a) detector in goal-loop-core.ts identifies quota-wall events ----

test("v0.34.58: isQuotaWallError identifies quota-wall events (429 / rate limit / plan quota / billing)", () => {
  assert.equal(isQuotaWallError("429 rate limit: provider quota exceeded"), true);
  assert.equal(isQuotaWallError("Key limit exceeded (total limit): opencode-go free tier"), true);
  assert.equal(isQuotaWallError("plan quota exceeded — upgrade or wait for the reset window"), true);
  assert.equal(isQuotaWallError("insufficient credits: billing required"), true);
  assert.equal(isQuotaWallError("stream ended without finish_reason"), false, "provider stream deaths are not quota walls");
  assert.equal(isQuotaWallError("context window too large — reduce the prompt"), false, "context-token errors are NOT quota walls");
  assert.equal(isQuotaWallError("500 internal server error"), false, "transient 5xx is not a quota wall");
  assert.equal(isQuotaWallError(undefined), false);
});

// ---- next :00 clock minute math ----

test("v0.34.58: nextHourlyPromptMs is the next :00:00.000 strictly after now", () => {
  assert.equal(nextHourlyPromptMs(Date.UTC(2026, 7, 6, 18, 44, 30)), Date.UTC(2026, 7, 6, 19, 0, 0));
  assert.equal(nextHourlyPromptMs(Date.UTC(2026, 7, 6, 18, 59, 59, 999)), Date.UTC(2026, 7, 6, 19, 0, 0));
  assert.equal(nextHourlyPromptMs(Date.UTC(2026, 7, 6, 19, 0, 0, 0)), Date.UTC(2026, 7, 6, 20, 0, 0), "exactly :00 defers to the next hour");
  assert.equal(nextHourlyPromptMs(Date.UTC(2026, 7, 6, 23, 58, 0)), Date.UTC(2026, 7, 7, 0, 0, 0), "rolls over midnight");
});

// ---- (b)+(c) scheduling through the real agent_end → park path ----

test("v0.34.58: a quota-wall agent_end parks the goal and schedules exactly one sendUserMessage at the next :00 with the original turn context", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() });
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  await pi.fire("agent_end", quotaWallAgentEnd(), ownerCtx(cwd));

  // The goal parked into durable recovery (this is the recovery's own pause).
  const parked = readState(cwd);
  assert.equal(parked.goal?.status, "paused");
  assert.ok(parked.mainModelRecovery, "quota wall parks the goal into main-model recovery");

  // Exactly ONE prompt scheduled at the next :00 — nothing sent yet.
  const sched = __testOnlyQuotaPromptState();
  assert.equal(sched.scheduledFireAt, nextHourlyPromptMs(Date.UTC(2026, 7, 6, 18, 44, 30)), "fires at the next :00, not now");
  assert.ok(sched.context, "the original turn context is captured");
  const context = sched.context;
  assert.ok(context.includes("seeded test objective"));
  assert.ok(context.includes("429 rate limit"), "the quota failure detail is captured");
  assert.equal(pi.userMessages.length, 0, "no premature message — only scheduled");
  const ledger = readLedger(cwd);
  assert.equal(ledger.filter((l) => l.type === "quota_prompt_scheduled").length, 1);
  assert.equal(ledger.filter((l) => l.type === "quota_prompt_sent").length, 0);

  // Fire at :00 → exactly ONE sendUserMessage with the original turn context.
  __testOnlyFireQuotaPrompt();
  assert.equal(pi.userMessages.length, 1);
  const [msg] = pi.userMessages;
  assert.ok(msg);
  assert.ok(msg.message.includes("seeded test objective"), "message carries the original turn context");
  assert.ok(msg.message.includes("/goal resume"), "message tells the user how to resume");
  assert.equal(readState(cwd).goal?.status, "paused", "no self-resume — the parked goal stays parked after the prompt");
  assert.equal(__testOnlyQuotaPromptState().scheduledFireAt, null, "the schedule is consumed by the single fire");
  assert.equal(readLedger(cwd).filter((l) => l.type === "quota_prompt_sent").length, 1);
});

test("v0.34.58: repeated quota-wall events while one prompt is pending still schedule exactly one", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() });
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  await pi.fire("agent_end", quotaWallAgentEnd(), ownerCtx(cwd));
  await pi.fire("agent_end", quotaWallAgentEnd(), ownerCtx(cwd)); // recovery already active — must not double-schedule

  assert.equal(__testOnlyQuotaPromptState().scheduledFireAt, nextHourlyPromptMs(Date.UTC(2026, 7, 6, 18, 44, 30)));
  __testOnlyFireQuotaPrompt();
  assert.equal(pi.userMessages.length, 1, "exactly one sendUserMessage, never two");
  assert.equal(readLedger(cwd).filter((l) => l.type === "quota_prompt_scheduled").length, 1);
  assert.equal(readLedger(cwd).filter((l) => l.type === "quota_prompt_sent").length, 1);
});

test("v0.34.58: gated on autoResume: true — with autoResume false the quota wall schedules nothing", async () => {
  writeSettings({ autoResume: false });
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() });
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  await pi.fire("agent_end", quotaWallAgentEnd(), ownerCtx(cwd));

  // The recovery park still happens (recovery is not the prompter)…
  assert.ok(readState(cwd).mainModelRecovery);
  // …but the prompter is gated off entirely.
  assert.equal(__testOnlyQuotaPromptState().scheduledFireAt, null);
  assert.equal(__testOnlyQuotaPromptState().context, null);
  __testOnlyFireQuotaPrompt();
  assert.equal(pi.userMessages.length, 0, "no prompt with autoResume off");
  assert.equal(readLedger(cwd).filter((l) => l.type === "quota_prompt_scheduled").length, 0);
  assert.equal(readLedger(cwd).filter((l) => l.type === "quota_prompt_sent").length, 0);
});

test("v0.34.58: if recovery succeeds before :00 the pending prompt is cancelled — no late message", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() });
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  await pi.fire("agent_end", quotaWallAgentEnd(), ownerCtx(cwd));
  assert.ok(__testOnlyQuotaPromptState().scheduledFireAt, "prompt scheduled while walled");

  // The recovery probe succeeds before the hour turns (a normal agent_end
  // clears the recovery envelope).
  await pi.fire(
    "agent_end",
    { messages: [{ role: "assistant", content: [{ type: "text", text: "back up" }], stopReason: "end_turn" }] },
    ownerCtx(cwd),
  );
  assert.equal(readState(cwd).mainModelRecovery, undefined, "recovery cleared on success");

  __testOnlyFireQuotaPrompt();
  assert.equal(pi.userMessages.length, 0, "no prompt fires after the wall already lifted");
  assert.equal(readLedger(cwd).filter((l) => l.type === "quota_prompt_sent").length, 0);
});

// ---- (d) v0.34.90: never spam — once per parked episode, durable across sessions ----

test("v0.34.90: the hourly repeat is dead — after the one prompt is sent, auto-recovery flapping schedules NOTHING (field 2026-08-07: four identical quota-wall messages)", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() });
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  await pi.fire("agent_end", quotaWallAgentEnd(), ownerCtx(cwd));
  assert.ok(__testOnlyQuotaPromptState().scheduledFireAt, "prompt scheduled while walled");

  // :00 → the ONE prompt fires and marks the goal durably.
  __testOnlyFireQuotaPrompt();
  assert.equal(pi.userMessages.length, 1, "exactly one prompt");
  assert.ok(readState(cwd).goal?.quotaPromptedAt, "the goal carries the durable once-per-episode marker");

  // Auto-recovery flap: a probe SUCCEEDS (recovery cleared, goal active —
  // but the marker stays: no user action), then the next turn hits the wall
  // again and re-parks fresh. The prompter must stay silent.
  await pi.fire(
    "agent_end",
    { messages: [{ role: "assistant", content: [{ type: "text", text: "back up" }], stopReason: "end_turn" }] },
    ownerCtx(cwd),
  );
  assert.equal(readState(cwd).mainModelRecovery, undefined, "recovery cleared on success");
  assert.equal(readState(cwd).goal?.status, "active", "the recovery pause auto-resumes");
  assert.ok(readState(cwd).goal?.quotaPromptedAt, "auto-recovery success does NOT clear the marker");
  await pi.fire("agent_end", quotaWallAgentEnd(), ownerCtx(cwd));

  assert.equal(__testOnlyQuotaPromptState().scheduledFireAt, null, "no re-schedule while the marker stands");
  __testOnlyFireQuotaPrompt();
  assert.equal(pi.userMessages.length, 1, "still exactly one message — the wall stayed silent for hours");
  assert.equal(readLedger(cwd).filter((l) => l.type === "quota_prompt_scheduled").length, 1);
  assert.equal(readLedger(cwd).filter((l) => l.type === "quota_prompt_sent").length, 1);
});

test("v0.34.90: a peer session's pending schedule for the same :00 suppresses a second schedule (ledger scan)", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() });
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  await pi.fire("agent_end", quotaWallAgentEnd(), ownerCtx(cwd));
  assert.ok(__testOnlyQuotaPromptState().scheduledFireAt, "session A holds the :00 slot");

  // Session B (field 09:19/09:20/09:25/09:35 bunching): fresh module state,
  // same disk state. Recovery success clears the envelope, then B's own wall
  // hit parks fresh — but the ledger scan sees A's pending schedule for the
  // SAME fireAt and stands down.
  __testOnlyResetQuotaPrompt();
  await pi.fire(
    "agent_end",
    { messages: [{ role: "assistant", content: [{ type: "text", text: "back up" }], stopReason: "end_turn" }] },
    ownerCtx(cwd),
  );
  await pi.fire("agent_end", quotaWallAgentEnd(), ownerCtx(cwd));
  assert.equal(__testOnlyQuotaPromptState().scheduledFireAt, null, "peer slot held — B schedules nothing");
  __testOnlyFireQuotaPrompt();
  assert.equal(pi.userMessages.length, 0, "no message from B");
  const ledger = readLedger(cwd);
  assert.equal(ledger.filter((l) => l.type === "quota_prompt_scheduled").length, 1, "one schedule on disk, not two");
  const sched = ledger.find((l) => l.type === "quota_prompt_scheduled");
  assert.ok(sched?.value?.goalId, "the schedule carries the goal id for cross-session dedupe");
});

test("v0.34.90: a USER resume re-arms the allowance — a wall after resume schedules exactly one fresh prompt", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() });
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  const ctx = ownerCtx(cwd);
  await pi.fire("agent_end", quotaWallAgentEnd(), ctx);
  __testOnlyFireQuotaPrompt();
  assert.equal(pi.userMessages.length, 1);
  assert.ok(readState(cwd).goal?.quotaPromptedAt);

  // Auto-recovery lifts, the wall returns (still silent — flap protection),
  // and THEN the user explicitly resumes the parked goal.
  await pi.fire(
    "agent_end",
    { messages: [{ role: "assistant", content: [{ type: "text", text: "back up" }], stopReason: "end_turn" }] },
    ctx,
  );
  await pi.fire("agent_end", quotaWallAgentEnd(), ctx);
  assert.equal(__testOnlyQuotaPromptState().scheduledFireAt, null, "still silent through the flap");
  await pi.command("goal", "resume", ctx);
  assert.equal(readState(cwd).goal?.quotaPromptedAt, undefined, "user resume clears the marker");
  // Let the resume probe land successfully, then hours later the wall
  // returns — a genuinely new parked episode with a new :00 slot.
  await pi.fire(
    "agent_end",
    { messages: [{ role: "assistant", content: [{ type: "text", text: "back up" }], stopReason: "end_turn" }] },
    ctx,
  );
  __testOnlySetQuotaPromptNow(Date.UTC(2026, 7, 6, 21, 44, 30));
  await pi.fire("agent_end", quotaWallAgentEnd(), ctx);
  assert.ok(__testOnlyQuotaPromptState().scheduledFireAt, "re-armed — schedules the fresh episode's prompt");
  __testOnlyFireQuotaPrompt();
  assert.equal(pi.userMessages.length, 2, "one prompt per user-resumed episode, never more");
  assert.equal(readLedger(cwd).filter((l) => l.type === "quota_prompt_sent").length, 2);
});
