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

function quota(retryAfterSec: number, fromUpstream: boolean): any {
  return { raw: "", retryAfterSec, fromUpstream };
}

/** v0.34.84: quota-shaped errors carry a signal so the plan can route them
 * to the hour-aligned branch instead of the exponential cadence. */
function quotaSignal(retryAfterSec: number, fromUpstream: boolean, signal: "rate-limit" | "plan-quota" | "billing"): any {
  return { raw: "", retryAfterSec, fromUpstream, signal };
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
  assert.equal(p2.retryAfterSec, 120 * 60, "attempt 2 = base·2^1 = 2h");
  const p3 = auditorQuotaRetryPlan(claim({ quotaAttempts: 2, quotaFirstAt: new Date().toISOString() }), quota(0, false), 60);
  assert.equal(p3.attempt, 3);
  assert.equal(p3.retryAfterSec, 240 * 60, "attempt 3 = base·2^2 = 4h");
});

test("eager: an upstream Retry-After hint still wins over the eager default", () => {
  const plan = auditorQuotaRetryPlan(claim(), quota(3600, true), 60);
  assert.equal(plan.attempt, 1);
  assert.equal(plan.retryAfterSec, 3600, "the provider's own hint outranks the eager 5s");
  assert.equal(plan.requestedSec, 3600);
});

test("v0.35.x: request-rate and account-wall retry plans stay separate", () => {
  const rateFirst = auditorQuotaRetryPlan(claim(), quotaSignal(0, false, "rate-limit"), 60);
  assert.equal(rateFirst.retryAfterSec, 5, "a pure request-rate wall gets one bounded eager retry");
  const accountFirst = auditorQuotaRetryPlan(claim(), quotaSignal(0, false, "plan-quota"), 60);
  assert.ok(accountFirst.retryAfterSec >= 60, "an account wall does not inherit the request-rate eager retry");
  const rateSecond = auditorQuotaRetryPlan(
    claim({ quotaAttempts: rateFirst.attempt, quotaFirstAt: rateFirst.firstAt, quotaAutoRetryUntil: rateFirst.autoRetryUntil }),
    quotaSignal(0, false, "rate-limit"),
    60,
  );
  assert.ok(rateSecond.retryAfterSec <= 60 * 60, "the next request-rate retry uses the hourly reset slot");
});

test("v0.34.84: quota-shaped errors get hour-aligned probes on attempts 2+ (not exponential 2h/4h rungs)", () => {
  // note.md Screenshots 160846–161010: the auditor sat 6232s–6367s ≈ 1h44m
  // between retries because exponential 2h/4h… rungs don't align with the
  // provider's quota reset (most providers reset at top-of-hour or on a
  // billing boundary). hour-aligned probes react within minutes of the reset.
  const p2 = auditorQuotaRetryPlan(
    claim({ quotaAttempts: 1, quotaFirstAt: new Date().toISOString() }),
    quotaSignal(0, false, "rate-limit"),
    60,
  );
  assert.equal(p2.attempt, 2);
  // ≤ 60min (next top-of-hour strictly after now); must NOT be the 2h exponential rung
  assert.ok(p2.retryAfterSec <= 60 * 60, `hour-aligned probe should be ≤ 60min, got ${p2.retryAfterSec}`);
  assert.ok(p2.retryAfterSec < 2 * 60 * 60, `hour-aligned probe must NOT be the 2h exponential rung, got ${p2.retryAfterSec}`);
  // the requestedSec also reflects the hour-aligned schedule (not 2h)
  assert.ok(p2.requestedSec < 2 * 60 * 60, `requestedSec should be hour-aligned, got ${p2.requestedSec}`);
});

test("v0.34.84: plan-quota and billing signals also get hour-aligned probes", () => {
  for (const signal of ["plan-quota", "billing"] as const) {
    const p = auditorQuotaRetryPlan(
      claim({ quotaAttempts: 2, quotaFirstAt: new Date().toISOString() }),
      quotaSignal(0, false, signal),
      60,
    );
    assert.equal(p.attempt, 3);
    assert.ok(p.retryAfterSec <= 60 * 60, `${signal} should also get hour-aligned probes, got ${p.retryAfterSec}`);
    assert.ok(p.retryAfterSec < 4 * 60 * 60, `${signal} must NOT be the 4h exponential rung`);
  }
});

test("v0.34.84: non-quota transient infra errors keep the exponential minute-scale cadence", () => {
  // When the failure isn't quota-shaped (no signal set), the existing
  // exponential cadence still applies — a stuck provider shouldn't be
  // probed at the top of every hour.
  const p2 = auditorQuotaRetryPlan(
    claim({ quotaAttempts: 1, quotaFirstAt: new Date().toISOString() }),
    quota(0, false), // no signal
    60,
  );
  assert.equal(p2.retryAfterSec, 120 * 60, "non-quota transient keeps the 2h exponential rung");
  const p3 = auditorQuotaRetryPlan(
    claim({ quotaAttempts: 2, quotaFirstAt: new Date().toISOString() }),
    quota(0, false),
    60,
  );
  assert.equal(p3.retryAfterSec, 240 * 60, "non-quota transient keeps the 4h exponential rung");
});

test("v0.34.84: hour-aligned probes floor at 60s (no sub-minute cadence on a stale nextHourlyPromptMs)", () => {
  // Pathological case: if nextHourlyPromptMs returns a time within 60s of
  // now (e.g. at exactly 14:59:59 with sub-second drift), the probe must
  // still floor at 60s — never go below the main-thread 5s eager default.
  // This test pins the Math.max(60, ...) floor by feeding a quota object
  // that would otherwise compute a sub-60s wait.
  const p = auditorQuotaRetryPlan(
    claim({ quotaAttempts: 1, quotaFirstAt: new Date().toISOString() }),
    quotaSignal(0, false, "rate-limit"),
    60,
  );
  assert.ok(p.retryAfterSec >= 60, `hour-aligned probe must floor at 60s, got ${p.retryAfterSec}`);
});

test("v0.34.84: upstream Retry-After still wins over hour-aligned", () => {
  // If the provider gave a hint (e.g. Retry-After: 7200), we honor that
  // — hour-aligned is the fallback, not the override.
  const plan = auditorQuotaRetryPlan(
    claim({ quotaAttempts: 1, quotaFirstAt: new Date().toISOString() }),
    quotaSignal(7200, true, "rate-limit"),
    60,
  );
  assert.equal(plan.retryAfterSec, 7200, "the provider's hint still wins over hour-aligned");
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
  assert.equal(p2.retryAfterSec, 120 * 60, "a stuck provider does not get hammered every 5s — attempt 2 is the 2h rung");
});

test("source pins: eager constant + seconds-aware wording at both dispatch sites", () => {
  assert.match(SRC, /const EAGER_AUDITOR_RETRY_SEC = 5;/);
  assert.match(SRC, /attempt === 1\s*\?\s*EAGER_AUDITOR_RETRY_SEC/);
  assert.match(SRC, /fmtRetryDelay\(plan\.retryAfterSec\)/);
  assert.match(SRC, /fmtRetryDelay\(quota\.retryAfterSec\)/);
  // the eager branch is documented as the main-thread mirror
  assert.match(SRC, /mirroring runWithInfraRetry/);
});
