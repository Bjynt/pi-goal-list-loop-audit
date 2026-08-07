// pi-goal-list-loop-audit — v0.2.0
// tests/auditor-eager-retry.test.ts
//
// v0.34.79 (note.md 112555): "auditor likely stuck — we are not retrying the
// auditor as eagerly as the main thread". The main thread's runWithInfraRetry
// retries an infra failure once after 5s; the auditor's durable plan parked
// the goal for the base window (default 60m) before the FIRST probe. Now the
// first no-hint attempt is eager (5s), then the exponential minute-scale
// cadence takes over; provider Retry-After hints still win.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { auditorQuotaRetryPlan } from "../extensions/loops/goal.js";

const SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");

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

function quota(retryAfterSec: number, fromUpstream: boolean): any {
  return { raw: "", retryAfterSec, fromUpstream };
}

test("eager: first no-hint attempt retries in 5s (mirrors runWithInfraRetry's 5s backoff)", () => {
  const plan = auditorQuotaRetryPlan(claim(), quota(0, false), 60);
  assert.equal(plan.attempt, 1);
  assert.equal(plan.retryAfterSec, 5, "the first probe is seconds-scale, not the 60m base");
  assert.equal(plan.automatic, true);
});

test("eager: later no-hint attempts keep the exponential minute-scale cadence", () => {
  const p2 = auditorQuotaRetryPlan(claim({ quotaAttempts: 1, quotaFirstAt: new Date().toISOString() }), quota(0, false), 60);
  assert.equal(p2.attempt, 2);
  assert.equal(p2.retryAfterSec, 60 * 60, "attempt 2 = 60m base");
  const p3 = auditorQuotaRetryPlan(claim({ quotaAttempts: 2, quotaFirstAt: new Date().toISOString() }), quota(0, false), 60);
  assert.equal(p3.attempt, 3);
  assert.equal(p3.retryAfterSec, 120 * 60, "attempt 3 = 2h");
});

test("eager: an upstream Retry-After hint still wins over the eager default", () => {
  const plan = auditorQuotaRetryPlan(claim(), quota(3600, true), 60);
  assert.equal(plan.attempt, 1);
  assert.equal(plan.retryAfterSec, 3600, "the provider's own hint outranks the eager 5s");
  assert.equal(plan.requestedSec, 3600);
});

test("eager: attempts are bounded by the automatic horizon (capped after 5)", () => {
  const horizon = new Date(Date.now() + 2 * 60_000).toISOString();
  const plan = auditorQuotaRetryPlan(claim({ quotaAttempts: 4, quotaFirstAt: new Date().toISOString(), quotaAutoRetryUntil: horizon }), quota(0, false), 60);
  assert.equal(plan.attempt, 5);
  assert.ok(plan.retryAfterSec >= 1);
});

test("eager: the first eager attempt counts toward the attempt streak (no infinite loop)", () => {
  // After the eager probe fails, attempt 2 is the 60m base — a stuck
  // provider does not get hammered every 5s.
  const p1 = auditorQuotaRetryPlan(claim(), quota(0, false), 60);
  const p2 = auditorQuotaRetryPlan(claim({ quotaAttempts: p1.attempt, quotaFirstAt: p1.firstAt, quotaAutoRetryUntil: p1.autoRetryUntil }), quota(0, false), 60);
  assert.equal(p2.attempt, 2);
  assert.equal(p2.retryAfterSec, 60 * 60);
});

test("source pins: eager constant + seconds-aware wording at both dispatch sites", () => {
  assert.match(SRC, /const EAGER_AUDITOR_RETRY_SEC = 5;/);
  assert.match(SRC, /attempt === 1\s*\?\s*EAGER_AUDITOR_RETRY_SEC/);
  assert.match(SRC, /fmtRetryDelay\(plan\.retryAfterSec\)/);
  assert.match(SRC, /fmtRetryDelay\(quota\.retryAfterSec\)/);
  // the eager branch is documented as the main-thread mirror
  assert.match(SRC, /mirroring runWithInfraRetry/);
});
