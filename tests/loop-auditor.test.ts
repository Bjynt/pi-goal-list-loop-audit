import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  applyLoopAuditVerdict,
  shouldTriggerLoopAudit,
  LOOP_AUDIT_STOP_STREAK,
} from "../extensions/loops/loop-auditor.ts";
import { buildLoopAuditorPrompt } from "../extensions/goal-loop-auditor.ts";
import { normalizeLoadedSettings, MAX_AUDIT_LOOP_INTERVAL } from "../extensions/goal-settings.ts";
import type { LoopState } from "../extensions/goal-loop-forever.ts";
import type { GoalAuditorResult } from "../extensions/goal-loop-auditor-process.ts";

function testLoop(): LoopState {
  return {
    target: "Improve benchmark score",
    measureCmd: "bun bench | tail -1",
    direction: "max",
    iteration: 4,
    maxIterations: 50,
    plateauWindow: 5,
    stallCount: 0,
    bestValue: 102,
    lastValue: 102,
    active: true,
    history: [
      { iteration: 3, value: 101, improved: true, at: "2026-01-01T00:03:00.000Z" },
      { iteration: 4, value: 102, improved: true, at: "2026-01-01T00:04:00.000Z" },
    ],
    startedAt: "2026-01-01T00:00:00.000Z",
  };
}

function verdict(over: Partial<GoalAuditorResult> = {}): GoalAuditorResult {
  return { approved: false, disapproved: false, output: "", model: "test/model", ...over };
}

// =================================================================
// shouldTriggerLoopAudit — pure predicate
// =================================================================

test("loop audit trigger: off settings never fire", () => {
  assert.equal(shouldTriggerLoopAudit(5, 0, false), false);
  assert.equal(shouldTriggerLoopAudit(5, undefined, false), false);
  assert.equal(shouldTriggerLoopAudit(5, -3, false), false);
});

test("loop audit trigger: fires on multiples of N, not between them", () => {
  assert.equal(shouldTriggerLoopAudit(0, 5, false), false, "zero completed iterations never fires");
  assert.equal(shouldTriggerLoopAudit(1, 5, false), false);
  assert.equal(shouldTriggerLoopAudit(4, 5, false), false);
  assert.equal(shouldTriggerLoopAudit(5, 5, false), true);
  assert.equal(shouldTriggerLoopAudit(6, 5, false), false);
  assert.equal(shouldTriggerLoopAudit(10, 5, false), true);
});

test("loop audit trigger: an in-flight audit suppresses the next slot", () => {
  assert.equal(shouldTriggerLoopAudit(5, 5, true), false);
});

// =================================================================
// applyLoopAuditVerdict — pure verdict application
// =================================================================

test("loop audit verdict: approval resets the streak and clears a stale note", () => {
  const loop = testLoop();
  loop.consecutiveLoopAuditDisapprovals = 1;
  loop.loopAuditNote = "old fixes";
  const outcome = applyLoopAuditVerdict(loop, verdict({ approved: true, output: "<approved/>" }), "");
  assert.equal(outcome, "approved");
  assert.equal(loop.consecutiveLoopAuditDisapprovals, 0);
  assert.equal(loop.loopAuditNote, undefined);
  assert.equal(loop.loopAuditStopRequested, undefined);
});

test("loop audit verdict: first disapproval steers (corrective note), does not stop", () => {
  const loop = testLoop();
  const report = "body\n\n## Required fixes\n- fix the real gap\n- verify with the bench";
  const outcome = applyLoopAuditVerdict(loop, verdict({ disapproved: true, output: report }), report);
  assert.equal(outcome, "disapproved-corrective");
  assert.equal(loop.consecutiveLoopAuditDisapprovals, 1);
  assert.equal(loop.loopAuditNote, report);
  assert.equal(loop.loopAuditStopRequested, undefined);
});

test("loop audit verdict: second consecutive disapproval requests the stop", () => {
  const loop = testLoop();
  loop.consecutiveLoopAuditDisapprovals = 1;
  const outcome = applyLoopAuditVerdict(loop, verdict({ disapproved: true, output: "x" }), "x");
  assert.equal(outcome, "disapproved-stop");
  assert.equal(loop.consecutiveLoopAuditDisapprovals, LOOP_AUDIT_STOP_STREAK);
  assert.equal(loop.loopAuditStopRequested, true);
  assert.match(loop.loopAuditStopReason ?? "", /2 consecutive disapprovals/);
  assert.equal(loop.loopAuditNote, undefined);
});

test("loop audit verdict: impossible target requests the stop with the reason", () => {
  const loop = testLoop();
  const outcome = applyLoopAuditVerdict(loop, verdict({ impossible: true, impossibleReason: "benchmark was deleted", output: "<impossible>benchmark was deleted</impossible>" }));
  assert.equal(outcome, "impossible");
  assert.equal(loop.loopAuditStopRequested, true);
  assert.match(loop.loopAuditStopReason ?? "", /can never be satisfied/);
  assert.match(loop.loopAuditStopReason ?? "", /benchmark was deleted/);
});

test("loop audit verdict: infra failure is NOT evidence — streak untouched", () => {
  const loop = testLoop();
  loop.consecutiveLoopAuditDisapprovals = 1;
  const outcome = applyLoopAuditVerdict(loop, verdict({ error: "auditor stalled", infrastructureClass: "timeout" }));
  assert.equal(outcome, "infra");
  assert.equal(loop.consecutiveLoopAuditDisapprovals, 1, "streak must survive an infra failure");
  assert.equal(loop.loopAuditStopRequested, undefined);
  assert.equal(loop.loopAuditNote, undefined);
});

test("loop audit verdict: disapproval without a report still steers with a fallback note", () => {
  const loop = testLoop();
  const outcome = applyLoopAuditVerdict(loop, verdict({ disapproved: true, output: "" }));
  assert.equal(outcome, "disapproved-corrective");
  assert.ok((loop.loopAuditNote ?? "").length > 0);
});

// =================================================================
// buildLoopAuditorPrompt
// =================================================================

test("loop auditor prompt carries the loop facts and the verdict contract", () => {
  const p = buildLoopAuditorPrompt({
    target: "Improve benchmark score",
    measureCmd: "bun bench | tail -1",
    direction: "max",
    iteration: 10,
    maxIterations: 50,
    bestValue: 102,
    lastValue: 100,
    history: [
      { iteration: 9, value: 101 },
      { iteration: 10, value: 100 },
    ],
  });
  assert.match(p, /independent progress auditor/);
  assert.match(p, /Target: Improve benchmark score/);
  assert.match(p, /measure: bun bench \| tail -1 \(higher is better\)/);
  assert.match(p, /Iteration: 10 of 50/);
  assert.match(p, /Best value: 102 · Last value: 100/);
  assert.match(p, /- iter 9: 101/);
  assert.match(p, /- iter 10: 100/);
  assert.match(p, /<approved\/>/);
  assert.match(p, /<disapproved\/>/);
  assert.match(p, /<impossible>one-line reason<\/impossible>/);
  assert.match(p, /## Required fixes/);
  assert.match(p, /Metric movement alone is NOT proof/);
});

test("loop auditor prompt: metricless mode + escaping + prior-disapproval block", () => {
  const evil = 'Improve <script>alert("x")</script> & friends';
  const p = buildLoopAuditorPrompt({
    target: evil,
    iteration: 3,
    maxIterations: 0,
    bestValue: null,
    lastValue: null,
    history: [{ iteration: 3, value: null }],
    specExcerpt: "spec body",
    headRef: "abc1234",
    branch: "pi-glla-loop/x",
    priorDisapproval: "- close finding #7",
    consecutiveDisapprovals: 1,
  });
  assert.match(p, /metricless spec loop/);
  assert.doesNotMatch(p, /<script>/);
  assert.match(p, /&lt;script&gt;/);
  assert.match(p, /Spec excerpt/);
  assert.match(p, /commit abc1234/);
  assert.match(p, /branch pi-glla-loop\/x/);
  assert.match(p, /PREVIOUS AUDIT OF THIS RUN WAS DISAPPROVED \(1 consecutive so far\)/);
  assert.match(p, /- close finding #7/);
  assert.match(p, /- iter 3: \(no number\)/);
});

// =================================================================
// settings — auditLoop normalization
// =================================================================

test("auditLoop setting: junk normalizes to off (0)", () => {
  assert.equal(normalizeLoadedSettings({ auditLoop: "5" as any }).auditLoop, 0);
  assert.equal(normalizeLoadedSettings({ auditLoop: 2.5 }).auditLoop, 0);
  assert.equal(normalizeLoadedSettings({ auditLoop: -1 }).auditLoop, 0);
  assert.equal(normalizeLoadedSettings({ auditLoop: MAX_AUDIT_LOOP_INTERVAL + 1 }).auditLoop, 0);
  assert.equal(normalizeLoadedSettings({}).auditLoop, 0);
});

test("auditLoop setting: valid values are preserved at the bounds", () => {
  assert.equal(normalizeLoadedSettings({ auditLoop: 1 }).auditLoop, 1);
  assert.equal(normalizeLoadedSettings({ auditLoop: MAX_AUDIT_LOOP_INTERVAL }).auditLoop, MAX_AUDIT_LOOP_INTERVAL);
  assert.equal(normalizeLoadedSettings({ auditLoop: 0 }).auditLoop, 0);
});
