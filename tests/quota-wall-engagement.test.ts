// pi-goal-list-loop-audit — v0.34.57
// tests/quota-wall-engagement.test.ts
//
// Contract item: "quota walls actually engage the recovery machinery —
// the main-model failover/park path is armed and reached in minutes, not
// after 15m of blind re-sends; a surfaced long-lived failure (quota /
// billing / auth) shortens the send-storm escalation window."
//
// Field evidence (2026-08-05): 89+ provider quota/rate-limit signals in the
// live ledger, zero `main_model_*` recovery events. The recovery machinery
// shipped (v0.34.51+) but never engaged because (a) no fallback models were
// configured and (b) pi's internal retry absorbs 429s, so the only glla-side
// signal — the send-rearm storm — waited the generic 15m threshold before
// escalating, and even then only parked/rotated when the goal was active.
//
// This file pins the pure escalation policy:
//
//   - sendStormEscalateMs(): a fresh long-lived-failure (quota/billing/auth)
//     knowledge window shortens storm escalation from 15m to 3m.
//   - isLongLivedFailureKind(): only quota/billing/auth record the signal;
//     transient (5xx/stream/network) failures stay on the fast error ladder.
//   - Source pins: goal.ts records lastLongLivedFailureAt at the classify
//     sites and consults sendStormEscalateMs in the rearm check; the
//     escalation path still funnels into recoverMainModelFromSendStorm.
//
// The failure shape this guards: a quota wall surfacing once, then a send
// wedge — under the old code the wedge re-sent for 15 minutes before the
// recovery envelope engaged ("we just retry a lot and for long").

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const GOAL_SRC = readFileSync(join(here, "..", "extensions", "loops", "goal.ts"), "utf8");
const CONT_SRC = readFileSync(join(here, "..", "extensions", "goal-continuation.ts"), "utf8"); // decomposition step 5 (v0.34.113): send-rearm storm moved
const RECOVERY_SRC = readFileSync(join(here, "..", "extensions", "main-model-recovery.ts"), "utf8");
const RECOVERY_MODULE_SRC = readFileSync(join(here, "..", "extensions", "goal-recovery.ts"), "utf8"); // decomposition step 3 (v0.34.111)

import {
  classifyMainModelFailure,
  isLongLivedFailureKind,
  sendStormEscalateMs,
  SEND_REARM_GENERIC_ESCALATE_MS,
  SEND_REARM_QUOTA_ESCALATE_MS,
  LONG_LIVED_FAILURE_KNOWLEDGE_MS,
} from "../extensions/main-model-recovery.js";

// ---------------------------------------------------------------------------
// Pure escalation policy
// ---------------------------------------------------------------------------

test("v0.34.57: a fresh long-lived failure shortens storm escalation to 3m", () => {
  const now = 2_000_000_000_000;
  assert.equal(sendStormEscalateMs(now - 1_000, now), SEND_REARM_QUOTA_ESCALATE_MS);
  assert.equal(sendStormEscalateMs(now - LONG_LIVED_FAILURE_KNOWLEDGE_MS + 1, now), SEND_REARM_QUOTA_ESCALATE_MS);
  assert.equal(sendStormEscalateMs(now - LONG_LIVED_FAILURE_KNOWLEDGE_MS, now), SEND_REARM_GENERIC_ESCALATE_MS);
  assert.equal(sendStormEscalateMs(now - LONG_LIVED_FAILURE_KNOWLEDGE_MS - 1, now), SEND_REARM_GENERIC_ESCALATE_MS);
});

test("v0.34.57: no knowledge ever falls back to the generic 15m threshold", () => {
  assert.equal(sendStormEscalateMs(0), SEND_REARM_GENERIC_ESCALATE_MS);
  assert.equal(sendStormEscalateMs(-1), SEND_REARM_GENERIC_ESCALATE_MS);
  assert.equal(sendStormEscalateMs(Number.NaN), SEND_REARM_GENERIC_ESCALATE_MS);
  // stale knowledge (hours ago) is no knowledge
  const now = Date.now();
  assert.equal(sendStormEscalateMs(now - 90 * 60_000, now), SEND_REARM_GENERIC_ESCALATE_MS);
});

test("v0.34.57: only quota/billing/auth record the long-lived signal", () => {
  assert.ok(isLongLivedFailureKind("quota"));
  assert.ok(isLongLivedFailureKind("billing"));
  assert.ok(isLongLivedFailureKind("auth"));
  assert.equal(isLongLivedFailureKind("transient"), false);
  assert.equal(isLongLivedFailureKind("unknown"), false);
  assert.equal(isLongLivedFailureKind("non-recoverable"), false);
});

test("v0.34.57: real quota texts classify as long-lived; stream drops do not", () => {
  // The rig's actual surfaced walls (2026-08-05): ChatGPT usage limit and the
  // MiniMax/OpenCode "Token Plan usage limit" family.
  const chatGpt = classifyMainModelFailure("You have hit your ChatGPT usage limit (plus plan). Try again in ~6037 min.");
  assert.equal(chatGpt.kind, "quota");
  assert.ok(isLongLivedFailureKind(chatGpt.kind));
  const planWall = classifyMainModelFailure("429 Token Plan usage limit reached. Upgrade or switch billing.");
  assert.equal(planWall.kind, "quota");
  assert.ok(isLongLivedFailureKind(planWall.kind));
  // Stream/transport failures are transient-shaped: the fast ladder owns them.
  const stream = classifyMainModelFailure("Stream ended without finish_reason");
  assert.notEqual(stream.kind, "quota");
  assert.equal(isLongLivedFailureKind(stream.kind), false);
  const ws = classifyMainModelFailure("WebSocket error");
  assert.equal(isLongLivedFailureKind(ws.kind), false);
});

// ---------------------------------------------------------------------------
// Orchestrator wiring (source pins)
// ---------------------------------------------------------------------------

test("v0.34.57: goal.ts records the long-lived timestamp at the classify site", () => {
  const agentEndSection = GOAL_SRC.slice(GOAL_SRC.indexOf("const failure = classifyMainModelFailure(rawError);"));
  assert.ok(
    agentEndSection.includes("if (isLongLivedFailureKind(failure.kind)) lastLongLivedFailureAt = Date.now();"),
    "the agent-end handler must record the knowledge window when the surfaced failure is long-lived",
  );
  const stormSection = RECOVERY_MODULE_SRC.slice(RECOVERY_MODULE_SRC.indexOf("async function recoverMainModelFromSendStorm")); // decomposition step 3 (v0.34.111)
  assert.ok(
    stormSection.includes("lastLongLivedFailureAt = Date.now();"),
    "the send-storm recovery classifies a quota-shaped wedge and records it",
  );
});

test("v0.34.57: the rearm escalation consults the dynamic threshold", () => {
  assert.ok(
    CONT_SRC.includes("elapsed >= sendStormEscalateMs(flags.lastLongLivedFailureAt)"),
    "the send-rearm storm check must use the knowledge-aware threshold, not the flat 15m constant (decomposition step 5: moved + flags re-spelling)",
  );
  assert.ok(
    CONT_SRC.includes("const mins = Math.round(sendStormEscalateMs(flags.lastLongLivedFailureAt) / 60000)"),
    "the escalation ledger/notification must report the actual threshold used",
  );
});

test("v0.34.57: escalation still funnels into the recovery envelope", () => {
  const escalateSection = CONT_SRC.slice(CONT_SRC.indexOf("function escalateSendRearmStorm")); // decomposition step 5
  assert.ok(escalateSection.includes("recoverMainModelFromSendStorm(ctx, kind)"));
  assert.ok(
    escalateSection.includes('appendLedger(ctx.cwd, "send_rearm_escalated"'),
    "the escalation stays a ledger-visible fact",
  );
});

test("v0.34.57: the recovery envelope is importable and complete (failover + park)", () => {
  assert.ok(RECOVERY_SRC.includes("export function sendStormEscalateMs"));
  assert.ok(RECOVERY_SRC.includes("export function isLongLivedFailureKind"));
  assert.ok(RECOVERY_SRC.includes("SEND_REARM_QUOTA_ESCALATE_MS = 3 * 60_000"));
  assert.ok(RECOVERY_SRC.includes("SEND_REARM_GENERIC_ESCALATE_MS = 15 * 60_000"));
  // The envelope itself: a candidate rotation + a bounded retry cadence that
  // honors upstream Retry-After hints.
  assert.ok(RECOVERY_SRC.includes("export function nextUntriedModelRef"));
  assert.ok(RECOVERY_SRC.includes("export function mainModelFailureDelayMs"));
});
