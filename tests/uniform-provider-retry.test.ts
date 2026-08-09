// pi-goal-list-loop-audit — v0.34.51
// tests/uniform-provider-retry.test.ts
//
// Pins the "dumb retry" policy: error text is NOT trusted to pick a retry
// policy. Every main-model provider failure (quota, billing, auth, transient,
// unknown) rides ONE uniform bounded durable envelope; classification only
// labels the display and keeps the positive-evidence no-retry classes
// (context-length/aborted, auditor watchdog timeouts). The auditor durable
// plan catches ANY non-timeout infrastructure error with neutral wording.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { mainModelFailureDelayMs, classifyMainModelFailure } from "../extensions/main-model-recovery.js";

const SRC = fs.readFileSync("extensions/loops/goal-runtime.ts", "utf-8");
const RECOVERY = fs.readFileSync("extensions/main-model-recovery.ts", "utf-8");
const DISPLAY = fs.readFileSync("extensions/goal-loop-display.ts", "utf-8");
const README = fs.readFileSync("README.md", "utf-8");

test("v0.34.51: the cadence is kind-independent (unit proof)", () => {
  const at = (kind: string) => classifyMainModelFailure(kind);
  // v0.34.63: the uniform cadence is hour-aligned — next :00 of the local
  // clock hour (quota windows reset on the hour); the attempt number and
  // failure class no longer shape the delay at all.
  const nowMs = Date.parse("2026-08-07T01:18:01.930Z");
  const next = new Date(nowMs);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  const first = Math.max(1_000, next.getTime() - nowMs);
  assert.equal(mainModelFailureDelayMs(at("429 usage limit"), 1, 15, nowMs), first);
  assert.equal(mainModelFailureDelayMs(at("Token Plan rate limit reached (2062)"), 1, 15, nowMs), first);
  assert.equal(mainModelFailureDelayMs(at("insufficient credits — buy credits"), 1, 15, nowMs), first);
  assert.equal(mainModelFailureDelayMs(at("401 invalid API key"), 1, 15, nowMs), first);
  assert.equal(mainModelFailureDelayMs(at("503 temporarily unavailable"), 1, 15, nowMs), first);
  assert.equal(mainModelFailureDelayMs(at("weird provider prose, no hint"), 1, 15, nowMs), first);
  // The upstream hint still outranks (factual provider fact):
  assert.equal(mainModelFailureDelayMs(at("429 rate limit; retry in 4 hours"), 1, 15, nowMs), 4 * 60 * 60_000);
});

test("v0.34.51: main-model recovery has no kind-gated cadence left", () => {
  assert.ok(!RECOVERY.includes('failure.kind === "quota" && failure.quotaSignal === "plan-quota"'), "plan-quota 1h special case gone");
  assert.ok(!RECOVERY.includes("cadenceBase"), "kind-picked base gone");
  assert.match(RECOVERY, /one uniform envelope for EVERY provider failure/);
});

test("v0.34.51: the billing manual-hold is gone — billing retries like everything else", () => {
  assert.ok(!SRC.includes("pauseMainModelForManualAction"), "billing manual-hold function gone");
  assert.ok(!SRC.includes("main_model_billing_hold"), "billing-hold ledger event gone");
  assert.ok(!SRC.includes('failure.kind === "billing"'), "no billing special case in goal.ts");
  assert.ok(!SRC.includes("blind retries are stopped"), "manual-stop wording gone");
});

test("v0.34.51: quota-only parking gates are widened to every non-transient failure", () => {
  assert.ok(!SRC.includes('lastMainModelFailure?.kind === "quota"'), "loop-brake quota-only gate gone");
  assert.match(SRC, /sr === "error" && lastMainModelFailure && lastMainModelFailure\.kind !== "non-recoverable"/);
  assert.ok(!SRC.includes('(failure.kind === "quota" && state.goal?.status === "active")'), "send-storm quota-only gate gone");
  // Everything parks into the durable envelope except transient
  // (5xx/timeout/network — positive evidence of a short-lived hiccup keeps
  // the fast ladder). Nothing STOPS on classification anymore.
  assert.match(SRC, /\(state\.goal\?\.status === "active" && failure\.kind !== "transient"\) \|\| backupRefs\.length > 0/);
  // v0.34.58: even the upstream-hint budget gate is gone — an over-budget
  // provider reset hint falls back to the bounded cadence instead of parking
  // the goal for a manual resume. The kind-independent 24h horizon hold is
  // the only remaining stop for automatic probes.
  assert.ok(!SRC.includes("mainModelHintExceedsProbeBudget"), "quota-only upstream-hint parking gate gone");
  assert.ok(!SRC.includes("provider supplied a reset beyond"), "over-budget hint hold reason gone");
  assert.ok(!SRC.includes('failure.kind === "quota"'), "no kind==='quota' check left in goal.ts");
});

test("v0.34.51: the auditor durable plan catches ANY non-timeout infra error with neutral wording", () => {
  assert.ok(!SRC.includes("isQuotaError"), "no quota classification gate left in goal.ts");
  assert.match(SRC, /v0\.34\.51: ANY infrastructure failure enters the durable bounded retry/);
  assert.match(SRC, /auditor retry: \$\{result\.error\}/);
  assert.match(SRC, /auditor retry: retry in \$\{plan\.retryAfterSec\}s \(stored-claim retry\)/);
  assert.match(SRC, /auditor_retry_capped/);
  assert.ok(!SRC.includes("quota_retry_capped"), "old quota-only ledger event gone");
  assert.ok(!SRC.includes("Auditor still quota-limited"), "old quota-only notify gone");
  assert.ok(!SRC.includes("Quota auto-retry in"), "old quota-only action wording gone");
  // The 3-strike stop and its vocabulary are gone:
  assert.ok(!SRC.includes("reachedInfraCap"), "3-strike cap gone");
  assert.ok(!SRC.includes("audit_infra_waiting\", { goalId, attemptId: claim.attemptId, error: result.error.slice(0, 240), infraStreak }"), "3-strike ledger payload gone");
  assert.ok(!SRC.includes("The auditor has failed ${infraStreak} times in a row"), "3-strike verdict wording gone");
  // Watchdog timeouts keep their loud branch (a hanging command will hang again):
  assert.match(SRC, /isAuditorTimeoutError\(result\.error\)\) \{\n    \/\/ Watchdog timeouts stay ahead/);
  assert.match(SRC, /completion audit timed out — \$\{result\.error\}/);
});

test("v0.34.51 + v0.34.64: the badge says resuming…, never 'retrying now' (a wait is not a retry)", () => {
  assert.ok(!DISPLAY.includes('"retrying now"'), "old lie gone from the display");
  // v0.34.64: the wait badge lives in the sidebar wait/blocked branch with
  // the uniform auto-retry wording; the paused card uses `next probe in`.
  assert.match(DISPLAY, /rms <= 0 \? " · resuming…" : ` · auto-retry in \$\{fmtElapsed\(rms\)\}`/);
  assert.match(DISPLAY, /retryMs <= 0 \? "now" : `next probe in \$\{fmtElapsed\(retryMs\)\}`/);
});

test("v0.34.51: README no longer claims quota walls get no retries", () => {
  assert.ok(!README.includes("do **not** get more blind request retries"), "old no-retry claim gone");
  assert.ok(!README.includes("Credit/billing exhaustion gets a manual-action hold"), "old billing-hold claim gone");
  assert.match(README, /Error text is \*\*not trusted\*\* to pick a retry policy/);
  assert.match(README, /durable recovery envelope `15m → 30m → 1h → 2h → 4h → 5h`/);
});
