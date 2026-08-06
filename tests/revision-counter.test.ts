// pi-goal-list-loop-audit — v0.34.59
// tests/revision-counter.test.ts
//
// v0.34.59: focus token / revision counter on every goal mutation. The
// persist path bumps goal.revision; reads validate (goalId, revision)
// and refuse to apply when stale. The detached auditor captures a
// (goalId, revision) token at dispatch and echoes it back in result.json;
// the parent re-validates before applying the verdict. A mismatched
// token refuses the verdict rather than silently overwriting a goal
// that moved on during the audit.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  bumpGoalRevision,
  captureGoalRevision,
  isGoalRevisionCurrent,
  type Goal,
  type GoalRevisionToken,
} from "../extensions/goal-loop-core.ts";

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "20260806074836-test01",
    objective: "test goal",
    status: "active",
    policy: "goal",
    autoContinue: false,
    usage: { tokensUsed: 0, tokensLimit: 200_000 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("bumpGoalRevision increments revision by exactly 1", () => {
  const g = makeGoal({ revision: 0 });
  const bumped = bumpGoalRevision(g);
  assert.equal(bumped.revision, 1, "first bump yields revision 1");
  // Original object is unchanged (immutable update).
  assert.equal(g.revision, 0, "bump does not mutate the input");

  const bumped2 = bumpGoalRevision(bumped);
  assert.equal(bumped2.revision, 2, "second bump yields revision 2");
});

test("bumpGoalRevision treats undefined revision as 0", () => {
  // Pre-revision (v0.34.58 and earlier) goals have no revision field;
  // bumping must produce revision=1, not NaN or NaN-ish.
  const g = makeGoal();
  assert.equal(g.revision, undefined, "preconditions: no revision yet");
  const bumped = bumpGoalRevision(g);
  assert.equal(bumped.revision, 1, "first bump on a legacy goal yields 1");
});

test("captureGoalRevision returns null for null goal", () => {
  assert.equal(captureGoalRevision(null), null, "null goal → null token");
  assert.equal(captureGoalRevision(undefined), null, "undefined goal → null token");
});

test("captureGoalRevision tokens match by value, not identity", () => {
  const g = makeGoal({ revision: 7 });
  const t1 = captureGoalRevision(g);
  const t2 = captureGoalRevision(g);
  assert.deepEqual(t1, t2, "two captures of the same goal token-equal");
  assert.equal(t1?.goalId, g.id);
  assert.equal(t1?.revision, 7);
});

test("isGoalRevisionCurrent: matches when revision is unchanged", () => {
  const g = makeGoal({ revision: 5 });
  const token = captureGoalRevision(g);
  assert.equal(isGoalRevisionCurrent(token, g), true);
});

test("isGoalRevisionCurrent: refuses when revision bumped", () => {
  const g = makeGoal({ revision: 5 });
  const token = captureGoalRevision(g);
  const bumped = bumpGoalRevision(bumped_helper(g));
  assert.equal(isGoalRevisionCurrent(token, bumped), false, "bumped revision → not current");
});

test("isGoalRevisionCurrent: refuses when goal replaced", () => {
  const g = makeGoal({ revision: 5 });
  const token = captureGoalRevision(g);
  const replaced = makeGoal({ revision: 5, id: "20260806074836-test02" });
  assert.equal(isGoalRevisionCurrent(token, replaced), false, "different goalId → not current");
});

test("isGoalRevisionCurrent: refuses when current goal is null", () => {
  const g = makeGoal({ revision: 5 });
  const token = captureGoalRevision(g);
  assert.equal(isGoalRevisionCurrent(token, null), false, "current null → not current");
  assert.equal(isGoalRevisionCurrent(token, undefined), false, "current undefined → not current");
});

test("isGoalRevisionCurrent: null token passes through (legacy compat)", () => {
  // v0.34.59: pre-revision goals (no captured token) pass through the
  // unchanged. The legacy auditor must not break because of a missing
  // token.
  const g = makeGoal({ revision: 5 });
  assert.equal(isGoalRevisionCurrent(null, g), true, "null token → always current");
});

function bumped_helper(g: Goal): Goal {
  return bumpGoalRevision(g);
}

test("end-to-end: capture → mutate → refuse", () => {
  // The most important behavioral test: simulates the real race the
  // feature exists for. A worker captures a token at dispatch time;
  // meanwhile the orchestrator (or another writer) mutates the goal
  // (revision bumps); the worker returns a verdict; the validator must
  // refuse to apply.
  const originalGoal = makeGoal({ revision: 0 });
  const capturedToken = captureGoalRevision(originalGoal);
  assert.ok(capturedToken, "captured at dispatch");

  // Simulate a concurrent mutate bumping the revision.
  const afterMutate = bumpGoalRevision(originalGoal);
  // Then ANOTHER mutate.
  const afterMoreMutates = bumpGoalRevision(afterMutate);

  // The worker's verdict should be refused.
  assert.equal(isGoalRevisionCurrent(capturedToken, afterMutate), false, "first mutation refused");
  assert.equal(isGoalRevisionCurrent(capturedToken, afterMoreMutates), false, "later mutation refused");

  // Sanity: the worker's state read right after dispatch (before any
  // mutation) is still current.
  assert.equal(isGoalRevisionCurrent(capturedToken, originalGoal), true, "un-mutated goal still current");
});

test("GoalRevisionToken shape carries only goalId+revision", () => {
  // Shape discipline: the token must NOT carry data the worker can use
  // to overstate authority (no revision history, no extra fields). If
  // the shape expands accidentally, the equality check at validation
  // time could match spurious states.
  const token: GoalRevisionToken = captureGoalRevision(makeGoal({ revision: 3 }))!;
  assert.deepEqual(Object.keys(token).sort(), ["goalId", "revision"], "token has exactly {goalId, revision}");
});
