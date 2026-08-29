#!/usr/bin/env bun
// Deterministic context-growth probe for the # Now context-bloat item.
// Run with: bun scripts/measure-context-growth.mjs
//
// The payload is produced by the real continuationPrompt() helper. The probe
// does not send a provider request or mutate a session; it measures the
// effective-history cost of retaining repeated goal-event messages.

import { continuationPrompt } from "../extensions/goal-continuation.ts";
import { buildAuthoritativeContextCheckpoint, projectBoundedGllaContext } from "../extensions/context-checkpoint.ts";
import { diffContextGrowth, measureContextGrowth } from "../extensions/context-growth.ts";

const goal = {
  id: "context-growth-measurement",
  objective: "Measure the context cost of repeated GLLA continuation payloads.",
  verificationContract: "Done when the measurement is reproducible and the repeated payload cost is explicit.",
  status: "active",
  policy: "goal",
  startedAt: "2026-08-29T00:00:00.000Z",
  auditHistory: [],
  taskList: { tasks: [] },
};

const payload = continuationPrompt(goal);
const checkpoint = buildAuthoritativeContextCheckpoint({
  goal,
  sessionGeneration: 1,
  ownerSessionId: "offline-measurement-owner",
});
const baselineMessages = [
  { role: "user", content: [{ type: "text", text: "start the long-running task" }] },
  { role: "assistant", content: [{ type: "text", text: "I am working on the task." }], stopReason: "stop" },
];
function providerMessage(index) {
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

function providerMessages(count) {
  return Array.from({ length: count }, (_, index) => providerMessage(index));
}

const baseline = measureContextGrowth(baselineMessages);
const rows = [0, 1, 5, 12, 25].map((continuations) => {
  const messages = [
    ...baselineMessages,
    ...Array.from({ length: continuations }, () => ({
      role: "user",
      customType: "goal-event",
      content: payload,
      display: false,
    })),
  ];
  const measurement = measureContextGrowth(messages, {
    // This deterministic raw pi-ai Usage-shaped trace verifies the exact
    // provider-token capture path. A live agent_end supplies real values to
    // the same fields; this offline probe never claims to contact a provider.
    providerMessages: providerMessages(continuations),
  });
  const projection = projectBoundedGllaContext(messages, checkpoint);
  const boundedMeasurement = measureContextGrowth(projection.messages, {
    providerMessages: providerMessages(continuations),
  });
  return {
    continuations,
    measurement,
    deltaFromBaseline: diffContextGrowth(baseline, measurement),
    boundedProjection: {
      removedPayloads: projection.removedPayloads,
      retainedPayloads: projection.retainedPayloads,
      insertedCheckpoint: projection.insertedCheckpoint,
      checkpointChars: projection.checkpointChars,
      measurement: boundedMeasurement,
      deltaFromBaseline: diffContextGrowth(baseline, boundedMeasurement),
    },
  };
});

console.log(JSON.stringify({
  fixture: "real continuationPrompt repeated as goal-event history",
  payloadChars: payload.length,
  payloadBytes: new TextEncoder().encode(payload).byteLength,
  providerCapture: "deterministic pi-ai AssistantMessage.usage-shaped fixture; production agent_end captures exact provider values",
  rows,
}, null, 2));
