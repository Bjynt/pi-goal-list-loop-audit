// pi-goal-list-loop-audit — v0.37.2
// Regression for stale queued goal-event continuations that survive
// goal archival via Pi's followUp queue (Pi has no public clear queue API).
// The fix sanitizes at delivery (message_end) and clears timers on archive.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { __testOnlyClassifyStaleContinuation } from "../extensions/loops/goal-activation.js";
import { state, replaceState } from "../extensions/goal-state.js";
import { archivedGoalPath } from "../extensions/goal-loop-core.js";
import { tmpCwd, seedGoal, seedLoop } from "./harness/mock-pi.js";

function resetState(): void {
  replaceState({ goal: null, list: [], loop: null } as any);
}

afterEach(() => {
  resetState();
});

test("helper: goal checkpoint with no active goal is stale", () => {
  resetState();
  const cwd = tmpCwd();
  const content = "[GOAL CHECKPOINT goalId=abc123] hello";
  const reason = __testOnlyClassifyStaleContinuation(content, cwd);
  assert.ok(reason, "stale");
  assert.match(reason!, /no active goal/);
});

test("helper: goal checkpoint with matching active goal is not stale", () => {
  const cwd = tmpCwd();
  const g = seedGoal({ id: "abc123", status: "active" });
  replaceState({ goal: g, list: [], loop: null } as any);
  const content = "[GOAL CHECKPOINT goalId=abc123] work";
  const reason = __testOnlyClassifyStaleContinuation(content, cwd);
  assert.equal(reason, null, "not stale for matching active goal");
});

test("helper: goal checkpoint with mismatched id is stale", () => {
  const cwd = tmpCwd();
  replaceState({ goal: seedGoal({ id: "active-1", status: "active" }), list: [], loop: null } as any);
  const content = "[GOAL CHECKPOINT goalId=other-99] work";
  const reason = __testOnlyClassifyStaleContinuation(content, cwd);
  assert.ok(reason, "stale");
  assert.match(reason!, /mismatch/);
});

test("helper: goal checkpoint with paused goal is stale", () => {
  const cwd = tmpCwd();
  replaceState({ goal: seedGoal({ id: "paused-1", status: "paused" }), list: [], loop: null } as any);
  const content = "[GOAL CHECKPOINT goalId=paused-1] work";
  const reason = __testOnlyClassifyStaleContinuation(content, cwd);
  assert.ok(reason, "stale");
  assert.match(reason!, /not active/);
});

test("helper: goal checkpoint with already archived file is stale even if state still active", () => {
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, ".pi-glla", "archive"), { recursive: true });
  const gid = "archived-1";
  replaceState({ goal: seedGoal({ id: gid, status: "active" }), list: [], loop: null } as any);
  // create archive file
  const p = archivedGoalPath(cwd, gid);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "# archived");
  const content = `[GOAL CHECKPOINT goalId=${gid}] work`;
  const reason = __testOnlyClassifyStaleContinuation(content, cwd);
  assert.ok(reason, "stale");
  assert.match(reason!, /already archived/);
});

test("helper: loop iteration with no active loop is stale", () => {
  resetState();
  const cwd = tmpCwd();
  const content = "[LOOP ITERATION 5] measure";
  const reason = __testOnlyClassifyStaleContinuation(content, cwd);
  assert.ok(reason, "stale");
  assert.match(reason!, /loop not active/);
});

test("helper: loop iteration with active loop is not stale", () => {
  const cwd = tmpCwd();
  replaceState({ goal: null, list: [], loop: seedLoop({ active: true, iteration: 5 }) } as any);
  const content = "[LOOP ITERATION 5] measure";
  const reason = __testOnlyClassifyStaleContinuation(content, cwd);
  assert.equal(reason, null);
});

test("helper: stall warning with no active goal is stale", () => {
  resetState();
  const cwd = tmpCwd();
  const content = "[STALL WARNING escalation=1 goal=abc] you are stuck";
  const reason = __testOnlyClassifyStaleContinuation(content, cwd);
  assert.ok(reason, "stale");
});

test("helper: stall warning with active goal is not stale", () => {
  const cwd = tmpCwd();
  replaceState({ goal: seedGoal({ id: "s1", status: "active" }), list: [], loop: null } as any);
  const content = "[STALL WARNING escalation=1 goal=s1] you are stuck";
  const reason = __testOnlyClassifyStaleContinuation(content, cwd);
  assert.equal(reason, null);
});

test("helper: length continue delivers with live supervision, stale without (audit 2026-09-07)", () => {
  // The old "never stale" pin encoded the bug: a queued length nudge with
  // NO supervision is an unowned turn (queued before archival) and must
  // sanitize like any other marker-less goal-event. A truncated turn
  // implies a live turn, which implies active supervision — so the live
  // case still delivers and no live nudge is dropped.
  const cwd = tmpCwd();
  const content = "Your previous response was cut off at the model's per-response output token limit. Continue EXACTLY where you stopped";
  resetState();
  assert.match(__testOnlyClassifyStaleContinuation(content, cwd)!, /no active supervision/);
  // also with active goal
  replaceState({ goal: seedGoal({ status: "active" }), list: [], loop: null } as any);
  assert.equal(__testOnlyClassifyStaleContinuation(content, cwd), null);
});

test("helper: generic goal-event with no supervision is stale", () => {
  resetState();
  const cwd = tmpCwd();
  const content = "[POST-COMPACTION RESYNC] something";
  const reason = __testOnlyClassifyStaleContinuation(content, cwd);
  assert.ok(reason, "stale");
  assert.match(reason!, /no active supervision/);
});

test("helper: generic goal-event with active goal is not stale", () => {
  const cwd = tmpCwd();
  replaceState({ goal: seedGoal({ status: "active" }), list: [], loop: null } as any);
  const content = "[POST-COMPACTION RESYNC] something";
  const reason = __testOnlyClassifyStaleContinuation(content, cwd);
  assert.equal(reason, null);
});

test("helper: raw continuation source is correctly identified as stale when archived", () => {
  // Reproduces the observed 2026-09-01T18:33:47.410Z payload:
  // "// pi-goal-list-loop-audit — v0.1.0\n// prompts/goal-loop-continuation.md\n[GOAL CHECKPOINT goalId=20260901171431-fkz8a2] ..."
  const cwd = tmpCwd();
  resetState(); // no active goal => simulates post-archival idle
  const raw = `// pi-goal-list-loop-audit — v0.1.0\n// prompts/goal-loop-continuation.md\n[GOAL CHECKPOINT goalId=20260901171431-fkz8a2]\nState: ACTIVE — not yet auditor-approved.`;
  const reason = __testOnlyClassifyStaleContinuation(raw, cwd);
  assert.ok(reason, "raw pasted continuation must be stale when no active goal");
  assert.match(reason!, /no active goal/);
});
