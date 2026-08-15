// pi-goal-list-loop-audit — generic provider recovery regression coverage.
//
// The filename is retained for continuity with the older audit record. The
// contract is now deliberately reason-agnostic: provider wording must not
// shorten, suppress, or otherwise steer recovery.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  classifyMainModelFailure,
  isMainModelFallbackFailure,
  mainModelFailureDelayMs,
  sendStormEscalateMs,
  SEND_REARM_GENERIC_ESCALATE_MS,
} from "../extensions/main-model-recovery.js";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const here = dirname(fileURLToPath(import.meta.url));
const GOAL_SRC = readGoalRuntimeSource();
const CONT_SRC = readFileSync(join(here, "..", "extensions", "goal-continuation.ts"), "utf8");
const RECOVERY_SRC = readFileSync(join(here, "..", "extensions", "main-model-recovery.ts"), "utf8");
const RECOVERY_MODULE_SRC = readFileSync(join(here, "..", "extensions", "goal-recovery.ts"), "utf8");

test("send-storm escalation has one generic threshold", () => {
  assert.equal(sendStormEscalateMs(), SEND_REARM_GENERIC_ESCALATE_MS);
  assert.equal(sendStormEscalateMs(), 15 * 60_000);
});

test("quota-shaped provider text is opaque and still recoverable", () => {
  for (const raw of [
    "429 Too Many Requests",
    "Token Plan usage limit reached",
    "insufficient credits — buy credits",
    "503 temporarily unavailable",
  ]) {
    const failure = classifyMainModelFailure(raw);
    assert.equal(failure.quotaSignal, undefined, raw);
    assert.equal(isMainModelFallbackFailure(failure), true, raw);
    assert.equal(mainModelFailureDelayMs(failure, 1), 5_000, raw);
  }
});

test("source contains no reason-specific send-storm policy", () => {
  assert.ok(RECOVERY_SRC.includes("export function sendStormEscalateMs"));
  assert.ok(RECOVERY_SRC.includes("SEND_REARM_GENERIC_ESCALATE_MS = 15 * 60_000"));
  assert.doesNotMatch(RECOVERY_SRC, /SEND_REARM_QUOTA_ESCALATE_MS|isLongLivedFailureKind|lastLongLivedFailureAt/);
  assert.doesNotMatch(GOAL_SRC, /allowRateLimit|mainModelFallbackOnRateLimit|lastLongLivedFailureAt/);
  assert.doesNotMatch(RECOVERY_MODULE_SRC, /failure\.kind === "(?:quota|billing|rate-limit)"/);
});

test("send-rearm escalation still funnels into the generic recovery envelope", () => {
  const escalateSection = CONT_SRC.slice(CONT_SRC.indexOf("function escalateSendRearmStorm"));
  assert.ok(escalateSection.includes("recoverMainModelFromSendStorm(ctx, kind)"));
  assert.ok(escalateSection.includes('appendLedger(ctx.cwd, "send_rearm_escalated"'));
});
