// pi-goal-list-loop-audit — v0.25.0
// tests/quota-retry.test.ts
//
// Eager-continuation contract item 12 (Section C): quota-aware retry.
// Tests 1-2 cover parseQuotaError exactly as the contract specifies.
// Tests 3-4 as drafted asserted orchestrator branch behavior (goal status
// after a 429 audit) which lives inline in complete_goal — not reachable
// without a pi harness. The deterministic core is tested instead: the
// schedule/fire/cancel mechanics and the error-pattern recognition the
// branch keys on. The branch itself is pinned by source-text assertions
// in tests/eager-continuation-core.test.ts.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  capQuotaRetrySeconds,
  isBillingError,
  isQuotaError,
  parseQuotaError,
  quotaRetryDelaySeconds,
  scheduleQuotaRetry,
  cancelQuotaRetry,
  isQuotaRetryPending,
} from "../extensions/quota-retry.ts";

const fakeCtx = { ui: { notify: () => {} } } as any;

test("parseQuotaError: 429 with Retry-After: 5 → retryAfterSec 5 (item 12 test 1)", () => {
  const q = parseQuotaError("Error: 429 Too Many Requests\nRetry-After: 5");
  assert.equal(q.retryAfterSec, 5);
  assert.equal(q.fromUpstream, true);
});

test("parseQuotaError: 429 without hint → default 3600 (item 12 test 2)", () => {
  const q = parseQuotaError("Error: 429 quota exceeded");
  assert.equal(q.retryAfterSec, 3600);
  assert.equal(q.fromUpstream, false);
});

test("parseQuotaError: prose hints (retry in 2m / retry after 30 seconds)", () => {
  assert.equal(parseQuotaError("temporarily rate-limited upstream, retry in 2m").retryAfterSec, 120);
  assert.equal(parseQuotaError("retry after 30 seconds").retryAfterSec, 30);
  assert.equal(parseQuotaError("Retry in 1h please").retryAfterSec, 3600);
  assert.equal(parseQuotaError("plan limit; retry in 1 week").retryAfterSec, 7 * 24 * 3600);
});

test("quota classification stays conservative around ambiguous provider errors", () => {
  assert.equal(isQuotaError("503 temporarily unavailable"), false);
  assert.equal(isQuotaError("403 forbidden"), false);
  assert.equal(isQuotaError("429 Too Many Requests"), true);
  assert.equal(isBillingError("insufficient credits"), true);
  assert.equal(isBillingError("429 Too Many Requests"), false);
});

test("parseQuotaError: JSON reset fields and HTTP-date reset are understood", () => {
  const now = Date.parse("2026-08-03T00:00:00Z");
  const json = parseQuotaError('{"error":{"reset_at":"2026-08-03T02:00:00Z"}}', 3600, now);
  assert.equal(json.retryAfterSec, 2 * 3600);
  assert.equal(json.resetAt, "2026-08-03T02:00:00.000Z");
  const http = parseQuotaError("429\nRetry-After: Mon, 03 Aug 2026 02:00:00 GMT", 3600, now);
  assert.equal(http.retryAfterSec, 2 * 3600);
  assert.equal(http.fromUpstream, true);
});

test("quota retry cadence caps at five hours instead of retrying for a week", () => {
  assert.equal(quotaRetryDelaySeconds(1, 60), 60 * 60);
  assert.equal(quotaRetryDelaySeconds(2, 60), 2 * 60 * 60);
  assert.equal(quotaRetryDelaySeconds(3, 60), 4 * 60 * 60);
  assert.equal(quotaRetryDelaySeconds(4, 60), 5 * 60 * 60);
  assert.equal(capQuotaRetrySeconds(7 * 24 * 3600), 5 * 60 * 60);
});

test("isQuotaError: wild-caught shapes", () => {
  assert.equal(isQuotaError('403: {"message":"Key limit exceeded (total limit)"}'), true);
  assert.equal(isQuotaError("429 Too Many Requests"), true);
  assert.equal(isQuotaError("temporarily rate-limited upstream"), true);
  assert.equal(isQuotaError("insufficient credits"), true);
  assert.equal(isQuotaError("model not found"), false);
  assert.equal(isQuotaError(undefined), false);
});

test("scheduleQuotaRetry: fires the callback after the window (item 12 test 3 core)", async () => {
  let fired = 0;
  scheduleQuotaRetry(fakeCtx, 1, "429 test", () => { fired++; });
  assert.equal(isQuotaRetryPending(), true);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(fired, 1);
  assert.equal(isQuotaRetryPending(), false);
});

test("cancelQuotaRetry: a pending retry does not fire (item 12 test 4 core)", async () => {
  let fired = 0;
  scheduleQuotaRetry(fakeCtx, 1, "429 test", () => { fired++; });
  cancelQuotaRetry();
  assert.equal(isQuotaRetryPending(), false);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(fired, 0);
});
