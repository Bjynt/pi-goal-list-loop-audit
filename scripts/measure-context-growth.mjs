#!/usr/bin/env bun
// Deterministic context-growth probe for the # Now context-bloat item.
// Run with: bun scripts/measure-context-growth.mjs
//
// The payload is produced by the real continuationPrompt() helper. The probe
// does not send a provider request or mutate a session; it measures the
// effective-history cost of retaining repeated goal-event messages.

import { continuationPrompt } from "../extensions/goal-continuation.ts";
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
const baselineMessages = [
  { role: "user", content: [{ type: "text", text: "start the long-running task" }] },
  { role: "assistant", content: [{ type: "text", text: "I am working on the task." }], stopReason: "stop" },
];
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
  const measurement = measureContextGrowth(messages);
  return {
    continuations,
    measurement,
    deltaFromBaseline: diffContextGrowth(baseline, measurement),
  };
});

console.log(JSON.stringify({
  fixture: "real continuationPrompt repeated as goal-event history",
  payloadChars: payload.length,
  payloadBytes: new TextEncoder().encode(payload).byteLength,
  rows,
}, null, 2));
