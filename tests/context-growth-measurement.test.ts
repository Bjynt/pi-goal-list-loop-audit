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
import {
  captureProviderTokenUsage,
  diffContextGrowth,
  measureContextGrowth,
} from "../extensions/context-growth.ts";

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

// A provider-shaped raw usage trace exercises the exact pi-ai fields without
// pretending that the offline fixture contacted a provider. Production
// agent_end samples are captured through the same fields.
function providerMessage(index: number): Record<string, unknown> {
  const input = 8_000 + index * 2_000;
  const output = 100 + index;
  const cacheRead = index * 10;
  const cacheWrite = index % 3;
  return {
    role: "assistant",
    stopReason: "stop",
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
    },
  };
}

function providerMessages(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => providerMessage(index));
}

test("fixture: repeated real continuation payloads grow context linearly and are isolated", () => {
  const payload = continuationPrompt(goalForMeasurement());
  assert.match(payload, /\[GOAL CHECKPOINT goalId=context-growth-measurement\]/);

  const baselineMessages = [
    userMessage("start the long-running task"),
    assistantMessage("I am working on the task."),
  ];
  const one = measureContextGrowth(
    [...baselineMessages, gllaMessage(payload)],
    { providerMessages: providerMessages(1) },
  );
  const twelve = measureContextGrowth(
    [
      ...baselineMessages,
      ...Array.from({ length: 12 }, () => gllaMessage(payload)),
    ],
    { providerMessages: providerMessages(12) },
  );

  assert.equal(payload.length, 21_246);
  assert.equal(new TextEncoder().encode(payload).byteLength, 21_350);
  assert.deepEqual(one, {
    messageCount: 3,
    serializedBytes: 21_911,
    textChars: 21_298,
    estimatedTokens: 5_325,
    gllaMessageCount: 1,
    gllaSerializedBytes: 21_728,
    gllaTextChars: 21_246,
    gllaEstimatedTokens: 5_312,
    uniqueGllaPayloadCount: 1,
    repeatedGllaPayloadCount: 0,
    repeatedGllaSerializedBytes: 0,
    failedErrorOnlyCount: 0,
    unserializableMessageCount: 0,
    provider: {
      sampleCount: 1,
      inputTokens: 8_000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 8_100,
      firstInputTokens: 8_000,
      latestInputTokens: 8_000,
      inputTokenDelta: 0,
      incompleteSampleCount: 0,
    },
  });
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
  assert.deepEqual(twelve, {
    messageCount: 14,
    serializedBytes: 260_919,
    textChars: 255_004,
    estimatedTokens: 63_751,
    gllaMessageCount: 12,
    gllaSerializedBytes: 260_736,
    gllaTextChars: 254_952,
    gllaEstimatedTokens: 63_738,
    uniqueGllaPayloadCount: 1,
    repeatedGllaPayloadCount: 11,
    repeatedGllaSerializedBytes: 239_008,
    failedErrorOnlyCount: 0,
    unserializableMessageCount: 0,
    provider: {
      sampleCount: 12,
      inputTokens: 228_000,
      outputTokens: 1_266,
      cacheReadTokens: 660,
      cacheWriteTokens: 12,
      totalTokens: 229_938,
      firstInputTokens: 8_000,
      latestInputTokens: 30_000,
      inputTokenDelta: 22_000,
      incompleteSampleCount: 0,
    },
  });

  const delta = diffContextGrowth(one, twelve);
  assert.equal(delta.messageCount, 11);
  assert.equal(delta.gllaMessageCount, 11);
  assert.equal(delta.uniqueGllaPayloadCount, 0, "the additional entries are repeats, not new payload shapes");
  assert.equal(delta.repeatedGllaPayloadCount, 11);
  assert.ok(delta.serializedBytes > 150_000, `expected visible cumulative growth: ${delta.serializedBytes}`);
  assert.deepEqual(delta.provider, {
    sampleCount: 11,
    inputTokens: 220_000,
    outputTokens: 1_166,
    cacheReadTokens: 660,
    cacheWriteTokens: 12,
    totalTokens: 221_838,
    firstInputTokens: 8_000,
    latestInputTokens: 30_000,
    inputTokenDelta: 22_000,
    incompleteSampleCount: 0,
  });
});

test("provider capture preserves exact pi-ai usage and rejects partial data", () => {
  assert.deepEqual(captureProviderTokenUsage(providerMessage(3)), {
    inputTokens: 14_000,
    outputTokens: 103,
    cacheReadTokens: 30,
    cacheWriteTokens: 0,
    totalTokens: 14_133,
  });
  assert.equal(captureProviderTokenUsage({ role: "assistant", usage: { input: 14_000 } }), null);
  assert.equal(captureProviderTokenUsage({ role: "assistant", usage: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } }), null);
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
  assert.deepEqual(measured.provider, {
    sampleCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    firstInputTokens: null,
    latestInputTokens: null,
    inputTokenDelta: null,
    incompleteSampleCount: 0,
  });
});
