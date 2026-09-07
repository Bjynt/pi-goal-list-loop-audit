// pi-goal-list-loop-audit — v0.38.x
// tests/audit-tasks.test.ts
//
// Behavioral coverage for the /glla "Audit Tasks" setting: when ON, a
// detached per-task audit fires on every complete_task call (in addition
// to the goal-level audit on complete_goal). Goal stays active; the task
// is the audit scope.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  __testOnlySetTaskAuditRunner,
} from "../extensions/loops/goal-tools.js";
import { loadSettings, globalSettingsPath } from "../extensions/goal-settings.js";
import { MockPi, makeMockCtx, tmpCwd, tick, seedState, seedGoal } from "./harness/mock-pi.js";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";

const GLOBAL_FILE = globalSettingsPath();
const ORIGINAL_GLOBAL = fs.existsSync(GLOBAL_FILE) ? fs.readFileSync(GLOBAL_FILE, "utf-8") : null;

function setGlobalSettings(value: Record<string, unknown>): void {
  fs.writeFileSync(GLOBAL_FILE, JSON.stringify(value));
}
function readLedger(cwd: string): Array<{ type: string; value: Record<string, unknown> }> {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8")
    .trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l));
}

const MAIN_SM = { name: "main-session-manager-audit-tasks" };
const pi = new MockPi();
activate(pi.api);

afterEach(() => {
  __testOnlySetTaskAuditRunner(undefined);
  if (ORIGINAL_GLOBAL === null) {
    try { fs.unlinkSync(GLOBAL_FILE); } catch { /* ignore */ }
  } else {
    fs.writeFileSync(GLOBAL_FILE, ORIGINAL_GLOBAL);
  }
});

test("auditTasks default is off (the setting exists and defaults to false)", () => {
  setGlobalSettings({ aggressiveMode: false });
  const settings = loadSettings(GLOBAL_FILE);
  assert.equal(settings.auditTasks, false, "default is off");
});

test("auditTasks on fires task_audit_started + task_audit_verdict ledger events on complete_task", async () => {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  setGlobalSettings({ auditTasks: true, aggressiveMode: false });

  // Seed an active goal with a taskList so complete_task can find the task.
  const goal = seedGoal({
    id: "20260904000000-audt01",
    objective: "audit-tasks test goal — done when the per-task audit fires",
    taskList: { tasks: [{ id: "t1", title: "first task", status: "pending" }] },
  });
  seedState(cwd, { goal });
  const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(100);

  let runnerCalled = false;
  let passedArgs: { completionSummary: string; verificationSummary: string } | undefined;
  __testOnlySetTaskAuditRunner(async (args) => {
    runnerCalled = true;
    passedArgs = { completionSummary: args.completionSummary ?? "", verificationSummary: args.verificationSummary ?? "" };
    return {
      approved: true,
      model: "test/mock-model",
      output: "task looks good",
      durationMs: 1,
    } as never;
  });

  const res = await pi.runTool("complete_task", { id: "t1" }, ctx);
  assert.match(res.content[0]!.text, /Task t1 marked complete/);

  // Wait for the fire-and-forget audit to complete.
  await tick(500);

  const ledger = readLedger(cwd);
  const started = ledger.filter((e) => e.type === "task_audit_started");
  const verdicts = ledger.filter((e) => e.type === "task_audit_verdict");
  assert.equal(started.length, 1, "task_audit_started ledger event fired");
  assert.equal(started[0]!.value.taskId, "t1");
  assert.equal(started[0]!.value.goalId, "20260904000000-audt01");
  assert.equal(verdicts.length, 1, "task_audit_verdict ledger event fired");
  assert.equal(verdicts[0]!.value.approved, true);
  assert.equal(verdicts[0]!.value.taskId, "t1");
  assert.equal(runnerCalled, true, "the injected runner was called");
  assert.match(passedArgs!.completionSummary, /first task/);
  assert.match(passedArgs!.verificationSummary, /Task t1/);
});

test("auditTasks off does not fire a per-task audit (the default)", async () => {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  setGlobalSettings({ auditTasks: false, aggressiveMode: false });

  const goal = seedGoal({
    id: "20260904000001-audt02",
    objective: "audit-tasks off test — done when no per-task audit fires",
    taskList: { tasks: [{ id: "t1", title: "first task", status: "pending" }] },
  });
  seedState(cwd, { goal });
  const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(100);

  let runnerCalled = false;
  __testOnlySetTaskAuditRunner(async () => {
    runnerCalled = true;
    return { approved: true, model: "x", output: "", durationMs: 0 } as never;
  });

  await pi.runTool("complete_task", { id: "t1" }, ctx);
  await tick(300);

  const ledger = readLedger(cwd);
  const started = ledger.filter((e) => e.type === "task_audit_started");
  assert.equal(started.length, 0, "no per-task audit when auditTasks is off");
  assert.equal(runnerCalled, false, "the runner was not called");
});
