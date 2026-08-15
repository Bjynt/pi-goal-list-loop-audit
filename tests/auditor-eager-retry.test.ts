// pi-goal-list-loop-audit — v0.34.141
// tests/auditor-eager-retry.test.ts
//
// The auditor does not probe or check quota state. It retries infrastructure
// failures uniformly: one eager 5s retry, then probes just after each local
// hour starts so a possible reset at 15:00/16:00 is picked up quickly.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { auditorQuotaRetryPlan, runDetachedCompletionWithFallback } from "../extensions/loops/goal.js";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const SRC = readGoalRuntimeSource();

/** Minimal claim the plan reads: quotaAttempts / quotaFirstAt / quotaAutoRetryUntil. */
function claim(over: Partial<Record<string, unknown>> = {}): any {
  return {
    phase: "auditing" as const,
    claim: "done",
    goalId: "g-1",
    attemptId: "a-1",
    ...over,
  };
}

function quota(retryAfterSec: number, fromUpstream: boolean, signal?: "rate-limit" | "plan-quota" | "billing"): any {
  return { raw: "", retryAfterSec, fromUpstream, signal };
}

test("eager: first attempt is 5s for every provider failure family", () => {
  for (const failure of [
    quota(0, false),
    quota(0, false, "rate-limit"),
    quota(0, false, "plan-quota"),
    quota(0, false, "billing"),
  ]) {
    const plan = auditorQuotaRetryPlan(claim(), failure, 60);
    assert.equal(plan.attempt, 1);
    assert.equal(plan.retryAfterSec, 5, "the first probe is eager regardless of provider wording");
    assert.equal(plan.automatic, true);
  }
});

test("hourly: later attempts align just after the next local hour", () => {
  const plan = auditorQuotaRetryPlan(
    claim({ quotaAttempts: 1, quotaFirstAt: new Date().toISOString() }),
    quota(0, false, "plan-quota"),
    60,
  );
  assert.equal(plan.attempt, 2);
  assert.ok(plan.retryAfterSec >= 60, `hourly probe must floor at 60s, got ${plan.retryAfterSec}`);
  assert.ok(plan.retryAfterSec <= 60 * 60, `hourly probe must be within one hour, got ${plan.retryAfterSec}`);
  assert.equal(plan.requestedSec, plan.retryAfterSec);
});

test("hourly: rate-limit, billing, and transient-shaped failures share the same later schedule", () => {
  const attempts = [
    quota(0, false),
    quota(0, false, "rate-limit"),
    quota(0, false, "plan-quota"),
    quota(0, false, "billing"),
  ].map((failure) => auditorQuotaRetryPlan(
    claim({ quotaAttempts: 1, quotaFirstAt: new Date().toISOString() }),
    failure,
    1,
  ));
  assert.deepEqual(attempts.map((plan) => plan.retryAfterSec), [
    attempts[0]!.retryAfterSec,
    attempts[0]!.retryAfterSec,
    attempts[0]!.retryAfterSec,
    attempts[0]!.retryAfterSec,
  ]);
});

test("eager: an upstream Retry-After hint does not suppress the uniform retry", () => {
  const first = auditorQuotaRetryPlan(claim(), quota(3600, true, "rate-limit"), 60);
  assert.equal(first.attempt, 1);
  assert.equal(first.retryAfterSec, 5, "the scheduler retries instead of waiting on a quota hint");

  const later = auditorQuotaRetryPlan(
    claim({ quotaAttempts: 1, quotaFirstAt: first.firstAt, quotaAutoRetryUntil: first.autoRetryUntil }),
    quota(7200, true, "billing"),
    60,
  );
  assert.equal(later.requestedSec, later.retryAfterSec, "the later retry stays hour-aligned");
  assert.ok(later.retryAfterSec <= 60 * 60);
});

test("eager: detached auditor retries an account-shaped failure once before durable parking", async () => {
  const waits: number[] = [];
  let calls = 0;
  const outcome = await runDetachedCompletionWithFallback(
    [{ model: "provider/model", via: "test" }],
    async () => {
      calls++;
      return { approved: false, disapproved: false, output: "", model: "provider/model", error: "Token Plan limit reached" };
    },
    { sleep: async (ms) => { waits.push(ms); }, shouldRetry: () => true },
  );
  assert.equal(outcome.retriedOnce, true);
  assert.equal(calls, 2, "account-shaped text does not suppress the eager retry");
  assert.deepEqual(waits, [5000], "the first retry uses the uniform eager delay");
});

test("eager: attempts remain bounded by the existing durable safety window", () => {
  const horizon = new Date(Date.now() + 2 * 60_000).toISOString();
  const plan = auditorQuotaRetryPlan(claim({ quotaAttempts: 4, quotaFirstAt: new Date().toISOString(), quotaAutoRetryUntil: horizon }), quota(0, false), 60);
  assert.equal(plan.attempt, 5);
  assert.ok(plan.retryAfterSec >= 1);
});

test("source pins: uniform eager retry and hourly probe wording are present at both dispatch sites", () => {
  assert.match(SRC, /const EAGER_AUDITOR_RETRY_SEC = 5;/);
  assert.match(SRC, /attempt === 1\s*\?\s*EAGER_AUDITOR_RETRY_SEC/);
  assert.match(SRC, /nextHourlyProbeMs\(now\)/);
  assert.match(SRC, /fmtRetryDelay\(plan\.retryAfterSec\)/);
  assert.match(SRC, /fmtRetryDelay\(quota\.retryAfterSec\)/);
  assert.match(SRC, /uniform retry schedule/);
  assert.doesNotMatch(SRC, /quota\.signal === "rate-limit"/);
  assert.doesNotMatch(SRC, /quotaRetryDelaySeconds\(attempt, baseMinutes\)/);
});
