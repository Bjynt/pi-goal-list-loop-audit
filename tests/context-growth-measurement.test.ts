// pi-goal-list-loop-audit — context-growth measurement fixture
//
// This is intentionally a measurement test, not a context-reduction test.
// It uses the exact continuationPrompt() payload that sendContinuation sends
// as a goal-event, repeats it as a synthetic long-running history, and reports
// the marginal/repeated bytes separately from ordinary messages. The next
// list item owns the bounded checkpoint implementation.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { continuationPrompt } from "../extensions/goal-continuation.ts";
import { diffContextGrowth, measureContextGrowth } from "../extensions/context-growth.ts";

function goalForMeasurement(): any {
  return {
    id: "context-growth-measurement",
    objective: "Measure the context cost of repeated GLLA continuation payloads.",
    verificationContract: "Done when the measurement is reproducible and the repeated payload cost is explicit.",
    status: "active",
    policy: "goal",
    startedAt: "2026-08-29T00:00:00.000Z",
    auditHistory: [],
    taskList: { tasks: [] },
  };
}

function userMessage(text: string): Record<string, unknown> {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMessage(text: string): Record<string, unknown> {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}

function gllaMessage(content: string): Record<string, unknown> {
  return { role: "user", customType: "goal-event", content, display: false };
}

test("fixture: repeated real continuation payloads grow context linearly and are isolated", () => {
  const payload = continuationPrompt(goalForMeasurement());
  assert.match(payload, /\[GOAL CHECKPOINT goalId=context-growth-measurement\]/);

  const baselineMessages = [
    userMessage("start the long-running task"),
    assistantMessage("I am working on the task."),
  ];
  const one = measureContextGrowth([...baselineMessages, gllaMessage(payload)]);
  const twelve = measureContextGrowth([
    ...baselineMessages,
    ...Array.from({ length: 12 }, () => gllaMessage(payload)),
  ]);

  assert.equal(one.messageCount, 3);
  assert.equal(one.gllaMessageCount, 1);
  assert.equal(one.uniqueGllaPayloadCount, 1);
  assert.equal(one.repeatedGllaPayloadCount, 0);
  assert.ok(one.gllaSerializedBytes > 15_000, `expected the real continuation payload to be material: ${one.gllaSerializedBytes}`);

  assert.equal(twelve.messageCount, 14);
  assert.equal(twelve.gllaMessageCount, 12);
  assert.equal(twelve.uniqueGllaPayloadCount, 1);
  assert.equal(twelve.repeatedGllaPayloadCount, 11);
  assert.ok(twelve.gllaTextChars >= one.gllaTextChars * 12, "each continuation remains in the effective context");
  assert.ok(twelve.repeatedGllaSerializedBytes >= one.gllaSerializedBytes * 10, "repeated GLLA bytes dominate the marginal growth");
  assert.equal(twelve.failedErrorOnlyCount, 0);

  const delta = diffContextGrowth(one, twelve);
  assert.equal(delta.messageCount, 11);
  assert.equal(delta.gllaMessageCount, 11);
  assert.equal(delta.uniqueGllaPayloadCount, 0, "the additional entries are repeats, not new payload shapes");
  assert.equal(delta.repeatedGllaPayloadCount, 11);
  assert.ok(delta.serializedBytes > 150_000, `expected visible cumulative growth: ${delta.serializedBytes}`);
});

test("measurement: failed turns and ordinary conversation remain separate from GLLA payload bytes", () => {
  const payload = continuationPrompt(goalForMeasurement());
  const measured = measureContextGrowth([
    userMessage("keep the real conversation"),
    { role: "assistant", content: [], stopReason: "error", errorMessage: "503" },
    gllaMessage(payload),
  ]);

  assert.equal(measured.messageCount, 3);
  assert.equal(measured.gllaMessageCount, 1);
  assert.equal(measured.failedErrorOnlyCount, 1);
  assert.ok(measured.serializedBytes > measured.gllaSerializedBytes);
  assert.ok(measured.textChars > measured.gllaTextChars);
  assert.equal(measured.unserializableMessageCount, 0);
});
