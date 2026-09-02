// v0.38.5 (delta-only): steady-state sends marker-only, deltas send full.
import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  buildMarkerContent,
  continuationPrompt,
  needsFullContinuation,
  sendContinuation,
  setLastContinuationSentAtRef,
} from "../extensions/goal-continuation.js";
import type { Goal } from "../extensions/goal-loop-core.js";
import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedState, tick, tmpCwd } from "./harness/mock-pi.js";

function cleanGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "20260903000000-delta01",
    objective: "Implement delta-only continuation",
    verificationContract: "Done when marker-only steady-state ships",
    status: "active",
    policy: "goal",
    autoContinue: true,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    taskList: { tasks: [{ id: "t1", title: "Do the thing", status: "pending" }] },
    auditHistory: [],
    ...overrides,
  } as Goal;
}

async function boot(pi: MockPi, cwd: string): Promise<ReturnType<typeof makeMockCtx>> {
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `delta-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(80);
  return ctx;
}

test("marker is tiny and carries the dispatch marker", () => {
  const m = buildMarkerContent("20260903000000-delta01");
  assert.equal(m, "[GOAL CHECKPOINT goalId=20260903000000-delta01]");
  assert.ok(m.length < 100, `marker must stay tiny, got ${m.length}`);
});

test("clean goal needs no full — repair/recovery/audit/designer do", () => {
  assert.equal(needsFullContinuation(cleanGoal()), false);
  assert.equal(needsFullContinuation(cleanGoal({ repairTarget: { id: "x", objective: "orig", reasons: ["r"], source: "test" } as any })), true);
  assert.equal(needsFullContinuation(cleanGoal({ autoResumedAt: "2026-09-03T00:00:00.000Z" })), true);
  assert.equal(needsFullContinuation(cleanGoal({ pendingTasks: ["fix this"] })), true);
  assert.equal(
    needsFullContinuation(cleanGoal({ auditHistory: [{ at: "2026-09-03T00:00:00.000Z", approved: false, report: "bad" } as any] })),
    true,
  );
  assert.equal(
    needsFullContinuation(
      cleanGoal({
        revision: 2,
        auditHistory: [{ at: "2026-09-03T00:00:00.000Z", approved: true, revision: 1 } as any],
      }),
    ),
    true,
    "stale approval mismatch forces full",
  );
  assert.equal(needsFullContinuation(cleanGoal({ agentRole: "designer" as any })), true);
  const full = continuationPrompt(cleanGoal());
  assert.ok(full.length > 15000, `full prompt must stay material, got ${full.length}`);
});

test("steady-state send is marker-only; dirty sends full", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: cleanGoal(), list: [] });
  const pi = new MockPi();
  activate(pi.api);
  await boot(pi, cwd);
  const live = readState(cwd).goal;
  assert.ok(live, "goal seeded");
  pi.sent.length = 0;
  // Force steady-state (not first-send) so the assertion is order-independent.
  setLastContinuationSentAtRef(Date.now());
  await sendContinuation(live!.id);
  await tick(40);
  assert.ok(pi.sent.length >= 1, "steady-state send lands");
  const markerSend = pi.sent[pi.sent.length - 1]?.message.content ?? "";
  assert.equal(markerSend, buildMarkerContent(live!.id));
  // Dirty (auditor report) sends full.
  pi.sent.length = 0;
  const dirty = {
    ...live!,
    auditHistory: [{ at: "2026-09-03T00:00:00.000Z", approved: false, report: "needs work" } as any],
  };
  seedState(cwd, { goal: dirty as Goal, list: [] });
  await sendContinuation(live!.id);
  await tick(40);
  const fullSend = pi.sent[pi.sent.length - 1]?.message.content ?? "";
  assert.ok(fullSend.length > 15000, `dirty send must be full, got ${fullSend.length}`);
});
