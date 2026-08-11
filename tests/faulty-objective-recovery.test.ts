import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  applyObjectiveRepair,
  assessSuspiciousObjective,
  buildRepairTaskObjective,
  deriveObjectiveRepair,
  hasQueuedObjectiveRepair,
} from "../extensions/faulty-objective-recovery.js";
import type { Goal } from "../extensions/goal-loop-core.js";
import activate, { __testOnlyLoadState, __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { guardGoalBeforeContinuation, sendContinuation } from "../extensions/goal-continuation.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd } from "./harness/mock-pi.js";

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "20260810152305-8or7m9",
    objective: "passes sequentially, including validated recovery (archive)",
    status: "active",
    policy: "list",
    autoContinue: true,
    verificationContract: "",
    usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: "2026-08-10T15:23:05.000Z",
    updatedAt: "2026-08-10T15:23:05.000Z",
    ...overrides,
  };
}

test("detects archive-derived and verification-fragment objectives", () => {
  const result = assessSuspiciousObjective("passes sequentially, including validated recovery (archive)");
  assert.equal(result.suspicious, true);
  assert.ok(result.reasons.includes("archive-metadata"));
  assert.ok(result.reasons.includes("verification-fragment"));
});

test("detects reviewer prose, headings, numbered audit text, and dangling fragments", () => {
  for (const text of [
    "The gate and both apply sites exist. Now I need to verify the retry path.",
    "## Required fixes",
    "1. Guard the stored completion audit and stale generation.",
    "Implement the recovery gate or",
  ]) {
    assert.equal(assessSuspiciousObjective(text).suspicious, true, text);
  }
});

test("valid imperative objectives are not flagged", () => {
  assert.equal(assessSuspiciousObjective("Implement the recovery gate").suspicious, false);
  assert.equal(assessSuspiciousObjective("Implement archive").suspicious, false);
  assert.equal(assessSuspiciousObjective("Fix the stale resume path", "run the focused tests").suspicious, false);
});

test("valid imperative objectives may mention auditor and verification machinery", () => {
  const result = assessSuspiciousObjective("Fix the detached completion-auditor recovery path and add focused verification coverage");
  assert.equal(result.suspicious, false);
});

test("normalization is an automatic provenance repair", () => {
  const g = goal({ objective: "Implement the repair gate (archive)" });
  const assessment = assessSuspiciousObjective(g.objective, g.verificationContract);
  const proposal = deriveObjectiveRepair(g, assessment);
  assert.ok(proposal);
  assert.equal(proposal?.objective, "Implement the repair gate");
  const record = applyObjectiveRepair(g, proposal!, "2026-08-10T15:24:00.000Z");
  assert.equal(g.objective, "Implement the repair gate");
  assert.equal(g.revision, 1);
  assert.equal(record.action, "auto-applied");
  assert.equal(record.reason, "removed explicit archive decoration without inventing intent");
  assert.equal(record.revisionBefore, 0);
  assert.equal(record.revisionAfter, 1);
  assert.equal(g.objectiveRepairHistory?.length, 1);
});

test("durable original provenance wins over reviewer prose and supplies the saved contract", () => {
  const g = goal({
    objective: "The gate and both apply sites exist. Now I need to verify the retry path.",
    verificationContract: "",
    objectiveProvenance: {
      originalObjective: "Implement archive",
      originalContract: "Done when: the recovery test passes",
      userSeeds: ["Implement archive\nDone when: the recovery test passes"],
    },
    pendingCompletion: {
      at: "2026-08-10T15:24:00.000Z",
      verificationSummary: "Ran 1228 tests, zero failures",
    },
  });
  const proposal = deriveObjectiveRepair(g, assessSuspiciousObjective(g.objective));
  assert.equal(proposal?.source, "original-record");
  assert.equal(proposal?.objective, "Implement archive");
  assert.equal(proposal?.verificationContract, "Done when: the recovery test passes");
  assert.match(proposal?.evidence ?? "", /original record/);
  assert.match(proposal?.evidence ?? "", /pending verification summary/);
});

test("unverified completion prose is never promoted", () => {
  const g = goal({
    objective: "The gate and both apply sites exist. Now I need to verify the retry path.",
    completionSummary: "Implement an invented replacement from the last chat",
  });
  assert.equal(deriveObjectiveRepair(g, assessSuspiciousObjective(g.objective)), null);
});

test("audit history contributes only an actionable required-fix line", () => {
  const g = goal({
    objective: "## Required fixes",
    auditHistory: [{
      at: "2026-08-10T15:24:00.000Z",
      approved: false,
      disapproved: true,
      impossible: false,
      model: "test-auditor",
      report: "## Required fixes\n- Implement the missing guard\n\n<disapproved/>",
    }],
  });
  const proposal = deriveObjectiveRepair(g, assessSuspiciousObjective(g.objective));
  assert.equal(proposal?.source, "auditHistory");
  assert.equal(proposal?.objective, "Implement the missing guard");
});

test("all direct continuation and stored-audit paths retain the final gate", () => {
  const continuation = fs.readFileSync(path.join(process.cwd(), "extensions", "goal-continuation.ts"), "utf8");
  const auditorHooks = fs.readFileSync(path.join(process.cwd(), "extensions", "loops", "goal-auditor-hooks.ts"), "utf8");
  assert.match(continuation, /sendStallEscalation[\s\S]{0,500}guardGoalBeforeContinuation/);
  assert.match(continuation, /sendLengthContinue[\s\S]{0,500}guardGoalBeforeContinuation/);
  assert.match(continuation, /retryContinuationDispatch[\s\S]{0,500}guardGoalBeforeContinuation/);
  assert.match(auditorHooks, /stored-completion-audit/);
});

test("durable pending task is preferred when the objective cannot be normalized", () => {
  const g = goal({ objective: "verification contract", pendingTasks: ["Implement the paused recovery gate"] });
  const proposal = deriveObjectiveRepair(g, assessSuspiciousObjective(g.objective));
  assert.equal(proposal?.source, "pendingTasks");
  assert.equal(proposal?.objective, "Implement the paused recovery gate");
});

test("irrecoverable suspicious objectives produce a non-suspicious queued repair task", () => {
  const g = goal({ objective: "verification contract" });
  const assessment = assessSuspiciousObjective(g.objective);
  assert.equal(deriveObjectiveRepair(g, assessment), null);
  const repair = buildRepairTaskObjective(g, assessment);
  assert.equal(assessSuspiciousObjective(repair).suspicious, false);
  assert.match(repair, /^Repair the blocked list item from saved intent$/);
  assert.equal(hasQueuedObjectiveRepair(g), false);
});

function ledger(cwd: string): string {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
}

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH;
function setGlobalAutoResume(enabled: boolean): void {
  if (GLOBAL_SETTINGS_PATH) fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(enabled ? { autoResume: true } : {}));
}
afterEach(() => setGlobalAutoResume(false));

function suspiciousGoal(status: "active" | "paused" | "auditing" | "aborted" = "active", policy: "goal" | "list" = "goal"): Record<string, unknown> {
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
  setGlobalAutoResume(true);
  seedState(cwd, { goal: suspiciousGoal("active"), list: [] });
  const pi = new MockPi();
  activate(pi.api);
  await boot(pi, cwd);
  const state = readState(cwd);
  assert.equal(state.goal?.status, "paused");
  assert.equal(state.list?.[0]?.objective, "Repair the blocked goal from saved intent");
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

test("list activation blocks a suspicious queued objective and leaves its repair task actionable", async () => {
  const cwd = tmpCwd();
  const queued = seedGoal({ policy: "list" });
  const item = {
    id: String(queued.id),
    objective: "passes sequentially, including validated recovery (archive)",
    addedAt: new Date().toISOString(),
  };
  seedState(cwd, { goal: null, list: [item] });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  await pi.command("list", "next", ctx);
  await tick(80);
  const state = readState(cwd);
  assert.equal(state.goal, null);
  assert.equal(state.list?.[0]?.objective, "Repair the blocked list item from saved intent");
  assert.equal(state.list?.[1]?.objective, item.objective);
  assert.match(ledger(cwd), /"faulty_objective_list_activation_blocked"/);
  await pi.command("list", "next", ctx);
  await tick(80);
  const repaired = readState(cwd);
  assert.equal(repaired.goal?.objective, "Repair the blocked list item from saved intent");
  assert.match(ledger(cwd), /"goal_continuation_sent"/);
});

test("provenance-backed repair auto-applies before dispatch", async () => {
  const cwd = tmpCwd();
  setGlobalAutoResume(true);
  const g = suspiciousGoal("active");
  g.objective = "Implement the recovery gate (archive)";
  seedState(cwd, { goal: g, list: [] });
  const pi = new MockPi();
  activate(pi.api);
  await boot(pi, cwd);
  const state = readState(cwd);
  assert.equal(state.goal?.objective, "Implement the recovery gate");
  assert.equal(state.goal?.revision, 1);
  assert.match(ledger(cwd), /"faulty_objective_auto_repaired"/);
  assert.match(ledger(cwd), /"goal_continuation_sent"/);
});

test("direct continuation dispatch rechecks the suspicious objective", async () => {
  const cwd = tmpCwd();
  const g = suspiciousGoal("active");
  seedState(cwd, { goal: g, list: [] });
  const pi = new MockPi();
  activate(pi.api);
  await boot(pi, cwd);
  await sendContinuation(String(g.id));
  await tick(80);
  assert.doesNotMatch(ledger(cwd), /"goal_continuation_sent"/);
  assert.equal(readState(cwd).goal?.status, "paused");
});

test("a canceled goal and stale continuation attempt are hard fences", async () => {
  const cwd = tmpCwd();
  const g = suspiciousGoal("aborted");
  seedState(cwd, { goal: g, list: [] });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  assert.equal(guardGoalBeforeContinuation(ctx as any, "canceled-test", String(g.id)), false);
  await sendContinuation(`${g.id}-stale`);
  await tick(40);
  assert.doesNotMatch(ledger(cwd), /"goal_continuation_sent"/);
  assert.match(ledger(cwd), /"faulty_objective_terminal_fence"|"faulty_objective_stale_attempt_fence"/);
});

test("an archived goal id is a hard fence against stale resurrection", async () => {
  const cwd = tmpCwd();
  setGlobalAutoResume(true);
  const g = suspiciousGoal("active");
  fs.mkdirSync(path.join(cwd, ".pi-glla", "archive"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "archive", `${g.id}.md`), "# Goal\\n\\n**Status**: aborted\\n");
  seedState(cwd, { goal: g, list: [] });
  const pi = new MockPi();
  activate(pi.api);
  await boot(pi, cwd);
  assert.equal(readState(cwd).goal, null);
  assert.match(ledger(cwd), /"faulty_objective_archive_fence"/);
  assert.doesNotMatch(ledger(cwd), /"goal_continuation_sent"/);
});

test("an active goal with an interrupted terminal stopReason is not dispatched", () => {
  const cwd = tmpCwd();
  const g = seedGoal({ status: "active", stopReason: "already_shipped:v0.34.74" });
  seedState(cwd, { goal: g, list: [] });
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd);
  assert.equal(guardGoalBeforeContinuation(ctx as any, "interrupted-terminal-test", String(g.id)), false);
  assert.match(ledger(cwd), /"faulty_objective_terminal_fence"/);
});
