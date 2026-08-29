import { test } from "node:test";
import * as assert from "node:assert/strict";

import type { Goal } from "../extensions/goal-loop-core.ts";
import {
  AUTHORITATIVE_CHECKPOINT_CUSTOM_TYPE,
  MAX_AUTHORITATIVE_CHECKPOINT_CHARS,
  buildAuthoritativeContextCheckpoint,
  projectBoundedGllaContext,
} from "../extensions/context-checkpoint.ts";

function goalFixture(): Goal {
  return {
    id: "goal-checkpoint-test",
    objective: "Preserve the authoritative objective while bounding repeated continuation context.",
    verificationContract: "Done when checkpoint projection is bounded, retains the current payload, and records audit/fence state.",
    status: "active",
    policy: "goal",
    autoContinue: true,
    revision: 7,
    taskList: {
      version: 1,
      tasks: [
        { id: "1", title: "Measure growth", status: "complete" },
        { id: "2", title: "Implement checkpoint", status: "in_progress" },
      ],
    },
    auditHistory: [{
      at: "2026-08-29T10:00:00.000Z",
      approved: false,
      disapproved: true,
      model: "fixture-auditor",
      revision: 7,
      report: "## Required fixes\nKeep the objective and verification contract visible after compaction.",
      regressionShieldPassed: true,
    }],
    pendingTasks: ["Add lifecycle regression coverage"],
    pendingCompletion: {
      at: "2026-08-29T10:01:00.000Z",
      phase: "recovery-pending",
      attemptId: "attempt-7",
      recoveryReason: "auditor transport failed",
      auditorFailureClass: "transport",
      auditorFailureCount: 1,
    },
    usage: { tokensUsed: 10, tokensLimit: 1000 },
    createdAt: "2026-08-29T09:00:00.000Z",
    updatedAt: "2026-08-29T10:01:00.000Z",
  };
}

function gllaPayload(index: number): Record<string, unknown> {
  return {
    role: "user",
    customType: "goal-event",
    content: `continuation-${index}`,
    display: false,
  };
}

test("authoritative checkpoint carries state, audit evidence, and lifecycle fences", () => {
  const checkpoint = buildAuthoritativeContextCheckpoint({
    goal: goalFixture(),
    sessionGeneration: 12,
    ownerSessionId: "session-owner-12",
  });

  assert.ok(checkpoint.length <= MAX_AUTHORITATIVE_CHECKPOINT_CHARS);
  assert.match(checkpoint, /goalId=goal-checkpoint-test/);
  assert.match(checkpoint, /Objective: Preserve the authoritative objective/);
  assert.match(checkpoint, /Verification contract: Done when checkpoint projection/);
  assert.match(checkpoint, /revision=7/);
  assert.match(checkpoint, /sessionGeneration=12/);
  assert.match(checkpoint, /ownerSession=session-owner-12/);
  assert.match(checkpoint, /label=disapproved/);
  assert.match(checkpoint, /Required fixes/);
  assert.match(checkpoint, /recovery-pending/);
  assert.match(checkpoint, /Implement checkpoint/);
  assert.match(checkpoint, /Add lifecycle regression coverage/);
});

test("projection removes old goal events, inserts one checkpoint, and keeps newest payload", () => {
  const original = [
    { role: "user", content: "ordinary user context" },
    { role: "assistant", content: "ordinary assistant context" },
    ...Array.from({ length: 25 }, (_, index) => gllaPayload(index)),
    { role: "toolResult", content: "tool result" },
  ];
  const checkpoint = buildAuthoritativeContextCheckpoint({
    goal: goalFixture(),
    sessionGeneration: 12,
    ownerSessionId: "session-owner-12",
  });
  const projected = projectBoundedGllaContext(original, checkpoint);

  assert.equal(projected.originalPayloads, 25);
  assert.equal(projected.removedPayloads, 24);
  assert.equal(projected.retainedPayloads, 1);
  assert.equal(projected.insertedCheckpoint, true);
  assert.equal(projected.messages.length, 5);
  assert.deepEqual(projected.messages[0], original[0]);
  assert.deepEqual(projected.messages[1], original[1]);
  assert.equal((projected.messages[2] as { customType?: unknown }).customType, AUTHORITATIVE_CHECKPOINT_CUSTOM_TYPE);
  assert.equal((projected.messages[3] as { content?: unknown }).content, "continuation-24");
  assert.deepEqual(projected.messages[projected.messages.length - 1], original[original.length - 1]);
  assert.equal(original.length, 28, "projection must not mutate the source transcript list");
});

test("one goal event is a no-op and does not inject a checkpoint", () => {
  const messages = [{ role: "user", customType: "goal-event", content: "current", display: false }];
  const result = projectBoundedGllaContext(messages, "checkpoint");

  assert.equal(result.messages, messages);
  assert.equal(result.removedPayloads, 0);
  assert.equal(result.insertedCheckpoint, false);
  assert.equal(result.retainedPayloads, 1);
});

test("zero-retention mode resynchronizes from the checkpoint without retaining payloads", () => {
  const messages = [gllaPayload(1), gllaPayload(2)];
  const result = projectBoundedGllaContext(messages, "authoritative", { maxRetainedPayloads: 0 });

  assert.equal(result.removedPayloads, 2);
  assert.equal(result.retainedPayloads, 0);
  assert.equal(result.messages.length, 1);
  assert.equal((result.messages[0] as { customType?: unknown }).customType, AUTHORITATIVE_CHECKPOINT_CUSTOM_TYPE);
  assert.equal((result.messages[0] as { content?: unknown }).content, "authoritative");
});
