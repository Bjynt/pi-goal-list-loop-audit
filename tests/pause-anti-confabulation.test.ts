// pi-goal-list-loop-audit — v0.38.15 (pause anti-confabulation)
//
// Field incident (new-tab 2026-09-04, Screenshot_20260904_142010): after 5
// compactions in a 2.5-day session, the model paused with "this session has
// no complete_goal tool" — while the transcript and ledger held ZERO tool
// errors and complete_goal had worked earlier in the same session (plus a
// second unverified claim that the reviewer runner was broken, minutes
// after the reviewer wrote its report). The tool path provably worked: the
// pause_goal call itself dispatched through the same registration batch.
//
// Guard: a pause whose blocker names a missing GLLA tool is refused with a
// correction (call it now) unless the reason quotes pi's own
// `Tool X not found` error — genuine-outage evidence the pause accepts.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import activate, { __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, seedState, seedGoal, tick, tmpCwd, readState, type MockCtx } from "./harness/mock-pi.js";
import {
  claimedMissingGllaTool,
  PI_TOOL_NOT_FOUND_QUOTE,
  ledgerEvent,
} from "../extensions/goal-loop-core.js";
import { __testOnlyResetOwnerSession } from "../extensions/loops/goal-session.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

const pi = new MockPi();
activate(pi.api);
const MAIN_SM = { name: "pause-guard-main-sm" };

function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}
async function freshSession(cwd: string, reason: string): Promise<MockCtx> {
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason }, ctx);
  return ctx;
}

afterEach(() => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  pi.execHandler = null;
});

test("claimed-missing matches absence language only", () => {
  assert.equal(claimedMissingGllaTool("this session has no complete_goal tool to close the goal"), "complete_goal");
  assert.equal(claimedMissingGllaTool("complete_goal is missing from my tools"), "complete_goal");
  assert.equal(claimedMissingGllaTool("Tool pause_goal not found when I tried"), "pause_goal");
  assert.equal(claimedMissingGllaTool("list_add no longer available, cannot queue"), "list_add");
  assert.equal(claimedMissingGllaTool("the complete_goal summary was thorough"), null, "ordinary mentions never match");
  assert.equal(claimedMissingGllaTool("call complete_goal now with the recap"), null, "instructions never match");
  assert.equal(claimedMissingGllaTool("complete_goal returned an error, retrying"), null, "errors without absence language never match");
  assert.equal(claimedMissingGllaTool(""), null);
  assert.ok(PI_TOOL_NOT_FOUND_QUOTE.test("Tool complete_goal not found"), "pi's outage wording is recognized");
  assert.ok(!PI_TOOL_NOT_FOUND_QUOTE.test("no complete_goal tool here"), "confabulation carries no pi error");
});

test("pause claiming a missing tool is refused with a correction, goal stays active", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ objective: "guard probe objective — done when pinned" }) });
  const ctx = await freshSession(cwd, "startup");
  await tick();
  const result = await pi.runTool("pause_goal", {
    reason: "work is done but this session has no complete_goal tool to close the active goal",
    kind: "blocked",
  }, ctx);
  assert.match(result.content[0]!.text, /Not paused/, "the pause is refused, not recorded");
  assert.match(result.content[0]!.text, /`complete_goal` is registered in this session/, "the correction names the tool");
  assert.match(result.content[0]!.text, /quoting that exact error/, "the escape hatch is offered");
  assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "active", "the goal never paused");
  assert.ok(ledgerEvent(cwd, "pause_refused_tool_present"), "the refusal is ledgered");
});

test("pause quoting pi's own not-found error is accepted as a genuine outage", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ objective: "outage probe objective — done when pinned" }) });
  const ctx = await freshSession(cwd, "startup");
  await tick();
  const result = await pi.runTool("pause_goal", {
    reason: "tried to close out but pi answered Tool complete_goal not found twice; no complete_goal tool in this session",
    kind: "blocked",
  }, ctx);
  assert.match(result.content[0]!.text, /Goal paused/, "genuine-outage evidence pauses normally");
  assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "paused");
});

test("ordinary pauses are untouched by the guard", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ objective: "ordinary probe objective — done when pinned" }) });
  const ctx = await freshSession(cwd, "startup");
  await tick();
  const result = await pi.runTool("pause_goal", { reason: "waiting on user answer about scope", kind: "blocked" }, ctx);
  assert.match(result.content[0]!.text, /Goal paused/);
  assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "paused");
});
