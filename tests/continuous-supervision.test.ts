import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { activeSupervisionPlanes, ContinuousSupervisor, SUPERVISION_MAX_POLL_MS, SUPERVISION_MIN_POLL_MS } from "../extensions/continuous-supervision.js";
import { buildLoopCompletionSummary, isTerminalLoopStopReason } from "../extensions/completion-summary.js";
import type { State } from "../extensions/goal-loop-core.js";

const empty = (): State => ({ goal: null, list: [] });

function goal(policy: "goal" | "list", status: "active" | "auditing" | "aborted" = "active"): any {
  return {
    id: "20260828000000-supervision",
    objective: "long-running work",
    status,
    policy,
    autoContinue: true,
    usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

test("v0.36.0: activeSupervisionPlanes covers every GLLA work plane without inventing activity", () => {
  assert.deepEqual(activeSupervisionPlanes({ ...empty(), goal: goal("goal") }), ["goal"]);
  assert.deepEqual(activeSupervisionPlanes({ ...empty(), goal: goal("list"), list: [{ id: "q", objective: "queued" }] as any }), ["list", "queue"]);
  assert.deepEqual(activeSupervisionPlanes({ ...empty(), goal: goal("list", "auditing"), list: [{ id: "q", objective: "queued" }] as any, loop: { active: true } as any, mainModelRecovery: { primary: "p", attempted: [], attempts: 0, reason: "retry", kind: "loop" } as any }, 2), ["list", "auditor", "loop", "queue", "provider-recovery", "subagent"]);
  assert.deepEqual(activeSupervisionPlanes({ ...empty(), goal: goal("goal", "aborted"), list: [] }), []);
});

test("v0.36.0: fallback polling adapts from 250ms to the 15s safety cadence", () => {
  const supervisor = new ContinuousSupervisor();
  supervisor.observeState({ ...empty(), goal: goal("goal") });
  assert.deepEqual(
    [supervisor.nextPollMs(true), supervisor.nextPollMs(true), supervisor.nextPollMs(true), supervisor.nextPollMs(true)],
    [SUPERVISION_MIN_POLL_MS, 500, 1000, 2000],
  );
  for (let i = 0; i < 8; i++) supervisor.nextPollMs(true);
  assert.equal(supervisor.nextPollMs(true), SUPERVISION_MAX_POLL_MS);
  assert.equal(supervisor.nextPollMs(false), SUPERVISION_MAX_POLL_MS);
});

test("v0.36.0: a real event resets fallback backoff instead of waiting for the old slot", () => {
  const supervisor = new ContinuousSupervisor();
  supervisor.observeState({ ...empty(), goal: goal("goal") });
  assert.equal(supervisor.nextPollMs(true), SUPERVISION_MIN_POLL_MS);
  assert.equal(supervisor.nextPollMs(true), 500);
  supervisor.signal({ plane: "goal", kind: "progress", source: "agent_end" });
  assert.equal(supervisor.nextPollMs(true), SUPERVISION_MIN_POLL_MS);
  const snapshot = supervisor.snapshot();
  assert.equal(snapshot.lastSignals.goal?.source, "agent_end");
});

test("v0.36.0: loop terminal outcomes receive a durable user-facing recap", () => {
  assert.equal(isTerminalLoopStopReason("plateau — no improvement"), true);
  assert.equal(isTerminalLoopStopReason("held: restored in a fresh session"), false);
  assert.equal(isTerminalLoopStopReason("main model recovery — retrying"), false);
  const summary = buildLoopCompletionSummary({ target: "polish the metric", stopReason: "plateau — no improvement", iteration: 4, bestValue: 2, historyLength: 4 });
  for (const label of ["Outcome:", "Changed:", "Evidence:", "Tests:", "Unresolved:", "Next:"]) assert.match(summary, new RegExp(`^${label}`, "m"));
  assert.match(summary, /best=2/);
});

test("v0.36.0: production heartbeat is event-first with adaptive timeout fallback", () => {
  const heartbeat = fs.readFileSync(path.resolve("extensions/goal-heartbeat.ts"), "utf8");
  const activation = fs.readFileSync(path.resolve("extensions/loops/goal-activation.ts"), "utf8");
  const orchestrator = fs.readFileSync(path.resolve("extensions/loops/goal-orchestrator.ts"), "utf8");
  assert.match(heartbeat, /ContinuousSupervisor/);
  assert.match(heartbeat, /setTimeout\(/);
  assert.doesNotMatch(heartbeat, /setInterval\(heartbeatTick/);
  assert.match(heartbeat, /signalSupervisionEvent/);
  assert.match(activation, /source: "agent_end"/);
  assert.match(activation, /source: "subagents:completed"/);
  assert.match(orchestrator, /isTerminalLoopStopReason\(loop\.stopReason\)/);
  assert.match(orchestrator, /completionSummary: buildLoopCompletionSummary\(/);
});
