// pi-goal-list-loop-audit — v0.27.2
// tests/length-continue.test.ts
//
// Folded-in auto-continue for output-token truncation (standalone
// pi-length-continue deprecated). Tracker state machine + goal.ts wiring:
// the agent_end length path runs BEFORE all turn bookkeeping (a truncated
// turn is not a completed turn, not a stall, no loop measure on half a
// response) and works with no goal active.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import {
  LENGTH_CONTINUE_MAX,
  LENGTH_CONTINUE_TEXT,
  isContextStarvedLengthStop,
  makeLengthContinueTracker,
} from "../extensions/length-continue.ts";

test("tracker: fires up to MAX consecutive, gives up once, resets on a normal turn", () => {
  const t = makeLengthContinueTracker();
  assert.deepEqual(t.tick(true), { fire: true, giveUpNow: false, consecutive: 1 });
  assert.deepEqual(t.tick(true), { fire: true, giveUpNow: false, consecutive: 2 });
  assert.deepEqual(t.tick(true), { fire: true, giveUpNow: false, consecutive: 3 });
  // cap exceeded: no fire, give-up exactly once
  assert.deepEqual(t.tick(true), { fire: false, giveUpNow: true, consecutive: 4 });
  assert.deepEqual(t.tick(true), { fire: false, giveUpNow: false, consecutive: 5 });
  // normal turn resets the streak AND the give-up latch
  assert.deepEqual(t.tick(false), { fire: false, giveUpNow: false, consecutive: 0 });
  assert.deepEqual(t.tick(true), { fire: true, giveUpNow: false, consecutive: 1 });
});

test("continue text carries the root-cause mitigation (split large writes)", () => {
  assert.equal(LENGTH_CONTINUE_MAX, 3);
  assert.match(LENGTH_CONTINUE_TEXT, /EXACTLY where you stopped/i);
  assert.match(LENGTH_CONTINUE_TEXT, /split large file writes/i);
});

test("v0.34.19: tiny-output length at a nearly full context is context starvation, not a real output cap", () => {
  const message = { stopReason: "length", usage: { output: 1 } };
  assert.equal(isContextStarvedLengthStop(message, { tokens: 198_116, contextWindow: 200_000, percent: 99.058 }), true);
  assert.equal(isContextStarvedLengthStop(message, { tokens: 198_116, contextWindow: 200_000, percent: null }), true, "derives percent from tokens/contextWindow");
  assert.equal(isContextStarvedLengthStop(message, { tokens: 180_000, contextWindow: 200_000, percent: 90 }), true, "90% threshold is inclusive");
  assert.equal(isContextStarvedLengthStop(message, { tokens: 179_999, contextWindow: 200_000, percent: 89.9995 }), false);
  assert.equal(isContextStarvedLengthStop({ stopReason: "length", usage: { output: 4_096 } }, { percent: 99.1 }), false, "a large output means the model really hit its response cap");
  assert.equal(isContextStarvedLengthStop({ stopReason: "length" }, { percent: 99.1 }), false, "missing output usage fails open to legacy length-continue");
  assert.equal(isContextStarvedLengthStop({ stopReason: "stop", usage: { output: 1 } }, { percent: 99.1 }), false);
});

const SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");

test("agent_end: length path runs BEFORE nudge accounting, telemetry, and goal gating", () => {
  // Window sized generously: the contract is ORDER (length path first), not
  // distance — prior 5000-char window broke when P1/P3 (0.28.4) added ~1100
  // chars between the length path and the goal gate.
  const handler = SRC.slice(SRC.indexOf('pi.on("agent_end"'), SRC.indexOf('pi.on("agent_end"') + 12000);
  const lengthIdx = handler.indexOf('tickLengthContinue(lastA?.stopReason === "length" && !contextStarvedLength)');
  assert.ok(lengthIdx > 0, "length tick present");
  assert.ok(handler.indexOf("isContextStarvedLengthStop(rawLastA, contextUsage)") < lengthIdx, "context-starvation classification runs before the tracker");
  assert.ok(handler.indexOf('length_continue_deferred_context_full') > lengthIdx, "context-starvation ledger is emitted by the defer path");
  // before the no-tool nudge accounting (stall brake) …
  assert.ok(lengthIdx < handler.indexOf("accountTurnForNudges"), "before nudge accounting");
  // … before per-goal telemetry …
  assert.ok(lengthIdx < handler.indexOf("state.goal.telemetry"), "before telemetry");
  // … and before the "no goal → return" gate (works in plain sessions)
  assert.ok(lengthIdx < handler.indexOf('if (!state.goal) return;'), "before goal gating");
  // truncated turns return early — no continuation scheduling on half a response
  const early = handler.slice(lengthIdx, lengthIdx + 2200);
  assert.match(early, /if \(lastA\?\.stopReason === "length"\) \{\s*\n\s*if \(lc\.fire && !ctx\.hasPendingMessages\(\)\) sendLengthContinue\(ctx, lc\.consecutive\);\s*\n\s*return;\s*\n\s*\}/);
});

test("sendLengthContinue: stale-api terminal guard + ledger + factory reset", () => {
  assert.match(SRC, /function sendLengthContinue\(ctx: ExtensionContext, consecutive: number\)/);
  assert.match(SRC, /if \(sessionHandoffPending \|\| initialSessionLoadPending \|\| !extensionApi \|\| extensionApiStale\) return;/, "lifecycle handoff, blank-start barrier, and stale-runtime guards short-circuit the send");
  assert.match(SRC, /try \{\s*\n\s*extensionApi\.sendMessage\(\{\s*\n\s*customType: GOAL_EVENT_ENTRY,\s*\n\s*content: LENGTH_CONTINUE_TEXT/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "length_continue_sent", \{ consecutive \}\)/);
  assert.match(SRC, /if \(isStaleApiError\(err\)\) goStaleTerminal\(ctx, "sendLengthContinue"\);/);
  assert.match(SRC, /resetLengthContinue\(\); \/\/ v0\.27\.2/);
  // give-up is surfaced once via notify + external push
  assert.match(SRC, /lc\.giveUpNow/);
});
