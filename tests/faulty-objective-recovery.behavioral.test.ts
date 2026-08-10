import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import activate, { __testOnlyResetOwnerSession, sendContinuation } from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd } from "./harness/mock-pi.js";

function ledger(cwd: string): string {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
}

function suspiciousGoal(status: "active" | "paused" = "active", policy: "goal" | "list" = "goal"): Record<string, unknown> {
  return seedGoal({
    status,
    policy,
    objective: "passes sequentially, including validated recovery, no-proof manual hold, and duplicate/stale-attempt protections.",
    verificationContract: "",
  });
}

async function boot(pi: MockPi, cwd: string): Promise<ReturnType<typeof makeMockCtx>> {
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `faulty-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(80);
  return ctx;
}

test("session_start auto-resume blocks a suspicious active objective and queues repair", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: suspiciousGoal("active"), list: [] });
  const pi = new MockPi();
  activate(pi.api);
  await boot(pi, cwd);
  const state = readState(cwd);
  assert.equal(state.goal?.status, "paused");
  assert.ok(state.list?.some((item) => item.objective.startsWith("Repair suspicious objective:")));
  assert.match(ledger(cwd), /"faulty_objective_repair_queued"/);
  assert.doesNotMatch(ledger(cwd), /"goal_continuation_sent"/);
});

test("manual resume blocks a suspicious paused objective before dispatch", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: suspiciousGoal("paused"), list: [] });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  await pi.command("goal", "resume", ctx);
  await tick(80);
  assert.equal(readState(cwd).goal?.status, "paused");
  assert.match(ledger(cwd), /"faulty_objective_repair_queued"/);
  assert.doesNotMatch(ledger(cwd), /"goal_continuation_sent"/);
});

test("list activation blocks a suspicious queued objective", async () => {
  const cwd = tmpCwd();
  const queued = { ...seedGoal({ policy: "list" }), objective: "passes sequentially, including validated recovery (archive)", status: undefined };
  const item = { id: queued.id, objective: queued.objective, addedAt: new Date().toISOString() };
  seedState(cwd, { goal: null, list: [item] });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  await pi.command("list", "next", ctx);
  await tick(80);
  const state = readState(cwd);
  assert.equal(state.goal?.status, "paused");
  assert.ok(state.list?.some((entry) => entry.objective.startsWith("Repair suspicious objective:")));
  assert.match(ledger(cwd), /"faulty_objective_repair_queued"/);
});

test("direct continuation dispatch rechecks the suspicious objective", async () => {
  const cwd = tmpCwd();
  const g = suspiciousGoal("active");
  seedState(cwd, { goal: g, list: [] });
  const pi = new MockPi();
  activate(pi.api);
  await boot(pi, cwd);
  await sendContinuation(g.id);
  await tick(80);
  assert.doesNotMatch(ledger(cwd), /"goal_continuation_sent"/);
  assert.equal(readState(cwd).goal?.status, "paused");
});
