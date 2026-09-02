// v0.38.5 (delta-only): steady-state sends marker-only, deltas send full.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import {
  buildContinuationContent,
  buildMarkerContent,
  continuationPrompt,
  needsFullContinuation,
} from "../extensions/goal-continuation.js";
import type { Goal } from "../extensions/goal-loop-core.js";

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

test("builder: steady-state marker, resync+marker, dirty full", () => {
  const goal = cleanGoal();
  const steady = buildContinuationContent(goal, { firstSend: false });
  assert.equal(steady.kind, "marker");
  assert.equal(steady.content, buildMarkerContent(goal.id));

  const first = buildContinuationContent(goal, { firstSend: true });
  assert.equal(first.kind, "full");
  assert.ok(first.content.length > 15000, `first send must teach discipline once, got ${first.content.length}`);

  const resyncBlock = "[POST-COMPACTION RESYNC] trust disk\n\n";
  const resyncOnly = buildContinuationContent(goal, { resync: resyncBlock, firstSend: false });
  assert.equal(resyncOnly.kind, "resync");
  assert.equal(resyncOnly.content, resyncBlock + buildMarkerContent(goal.id));
  assert.ok(resyncOnly.content.includes(goal.id), "resync+marker keeps the dispatch marker for start-proof");
  assert.ok(resyncOnly.content.length < 1000, `resync must stay tiny, got ${resyncOnly.content.length}`);

  const dirty = cleanGoal({ auditHistory: [{ at: "2026-09-03T00:00:00.000Z", approved: false, report: "needs work" } as any] });
  const dirtySend = buildContinuationContent(dirty, { firstSend: false });
  assert.equal(dirtySend.kind, "full");
  assert.ok(dirtySend.content.length > 15000);
});

test("sendContinuation wires the delta-only branch with kind ledger", () => {
  const src = fs.readFileSync(new URL("../extensions/goal-continuation.ts", import.meta.url), "utf-8");
  const send = src.slice(src.indexOf("export function sendContinuation"));
  assert.match(send, /buildContinuationContent/, "send path uses the pure builder");
  assert.match(send, /kind, payloadChars/, "ledger distinguishes marker vs full");
});
