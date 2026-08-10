import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  applyObjectiveRepair,
  assessSuspiciousObjective,
  buildRepairTaskObjective,
  deriveObjectiveRepair,
  hasQueuedObjectiveRepair,
} from "../extensions/faulty-objective-recovery.js";
import type { Goal } from "../extensions/goal-loop-core.js";

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

test("valid imperative objectives are not flagged", () => {
  assert.equal(assessSuspiciousObjective("Implement the recovery gate").suspicious, false);
  assert.equal(assessSuspiciousObjective("Fix the stale resume path", "run the focused tests").suspicious, false);
});

test("normalization is an automatic provenance repair", () => {
  const g = goal({ objective: "Implement the repair gate (archive)" });
  const assessment = assessSuspiciousObjective(g.objective, g.verificationContract);
  const proposal = deriveObjectiveRepair(g, assessment);
  assert.ok(proposal);
  assert.equal(proposal?.objective, "passes sequentially, including validated recovery");
  const record = applyObjectiveRepair(g, proposal!, "2026-08-10T15:24:00.000Z");
  assert.equal(g.objective, "passes sequentially, including validated recovery");
  assert.equal(g.revision, 1);
  assert.equal(record.action, "auto-applied");
  assert.equal(g.objectiveRepairHistory?.length, 1);
});

test("durable pending task is preferred when the objective cannot be normalized", () => {
  const g = goal({ objective: "verification contract", pendingTasks: ["Implement the paused recovery gate"] });
  const proposal = deriveObjectiveRepair(g, assessSuspiciousObjective(g.objective));
  assert.equal(proposal?.source, "pendingTasks");
  assert.equal(proposal?.objective, "Implement the paused recovery gate");
});

test("irrecoverable suspicious objectives produce a queued repair task", () => {
  const g = goal({ objective: "verification contract" });
  const assessment = assessSuspiciousObjective(g.objective);
  assert.equal(deriveObjectiveRepair(g, assessment), null);
  assert.match(buildRepairTaskObjective(g, assessment), /^Repair suspicious objective:/);
  assert.equal(hasQueuedObjectiveRepair(g), false);
});
