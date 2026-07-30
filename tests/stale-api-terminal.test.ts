// pi-goal-list-loop-audit — v0.26.7
// tests/stale-api-terminal.test.ts
//
// pi 0.82.x invalidates the extension runtime on session replacement
// (ctx.newSession/fork/switchSession/reload; the compaction path reaches
// the same teardownCurrent → dispose → invalidate in pi's
// agent-session-runtime.js). Once stale, EVERY sendMessage throws
// forever in-process (`staleMessage ??=` — never cleared). Field-observed
// in hegemon 2026-07-26: goal_continuation_send_failed at EVERY
// compaction (10:10, 19:28, 19:30) with pi's exact stale error; a goal
// the user created never auto-started (continuation send threw); the
// heartbeat retried into a void. Retrying a dead handle is the hegemon
// failure shape — the fix detects the stale signature and goes
// terminally loud on FIRST detection (v0.28.1: goals STAY ACTIVE with an
// interrupt marker so the next fresh session auto-resumes; loops stop).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { isStaleApiError } from "../extensions/goal-loop-core.ts";

const SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");

const PI_STALE_MSG = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";

test("isStaleApiError matches pi's exact stale signature, rejects everything else", () => {
  assert.equal(isStaleApiError(new Error(PI_STALE_MSG)), true);
  assert.equal(isStaleApiError(new Error("stale after session replacement or reload. …")), true);
  assert.equal(isStaleApiError(new Error("quota exceeded")), false);
  assert.equal(isStaleApiError(new Error("network timeout")), false);
  assert.equal(isStaleApiError("stale after session replacement"), false, "non-Error");
  assert.equal(isStaleApiError(null), false);
  assert.equal(isStaleApiError(undefined), false);
});

test("both autonomous send paths detect staleness and go terminal", () => {
  const cont = SRC.indexOf('if (isStaleApiError(err)) goStaleTerminal(ctx, "sendContinuation");');
  const loop = SRC.indexOf('if (isStaleApiError(err)) goStaleTerminal(ctx, "sendLoopTurn");');
  assert.ok(cont > 0, "sendContinuation detects");
  assert.ok(loop > 0, "sendLoopTurn detects");
});

test("terminal path: ledger event, single-fire, goal ACTIVE+marker / loop stop with restart guidance", () => {
  assert.match(SRC, /let extensionApiStale = false;/);
  assert.match(SRC, /if \(extensionApiStale\) return; \/\/ already terminal/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "extension_api_stale", \{ where, kind:/);
  // v0.28.1 (S1/S2): the stale goal branch keeps status ACTIVE and sets the
  // interrupt marker — pausing here stranded goals (restore only
  // auto-resumes active goals).
  assert.match(SRC, /updateGoal\(\{ interruptedAt: nowIso\(\), interruptedReason: `extension api stale \(\$\{where\}\)` \}, ctx\)/);
  assert.ok(!SRC.includes('pauseReason: "extension api stale (pi session replacement)"'), "old pause shape gone");
  assert.match(SRC, /Restart pi \(or reload extensions\) — the goal\/loop holds on the fresh session: \/glla resume continues it \(autoresume=on resumes for you\)\./);
  // guidance names the pi-side cause:
  assert.match(SRC, /session replacement — compaction triggers it in pi 0\.82\.x/);
});

test("v0.29.11 — heartbeat PROBES staleness before burning stall refires", () => {
  // Field (polis stall 3/5, endless-td stall 1/5, 2026-07-30): the
  // heartbeat refired into a session-replaced handle until a send happened
  // to throw. Now the first tick after replacement goes terminal at once.
  assert.match(SRC, /if \(probeExtensionApiStale\(\)\) \{ goStaleTerminal\(ctx, "heartbeat probe"\); return; \}/);
});

test("v0.29.11 — stale/stall-stopped loops HOLD on next load (resume, not restart-from-scratch)", () => {
  // "loops need /loop start" discarded iteration/best/history; the loop
  // now holds on restore and /loop resume continues from the saved state.
  assert.match(SRC, /stopReason\?\.startsWith\("extension api stale"\) \|\| state\.loop\.stopReason\?\.startsWith\("stalled:"\)/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "loop_held_for_resume"/);
  assert.match(SRC, /Restart pi, then \/loop resume \(the loop holds on restore\)\./);
  assert.ok(!SRC.includes("loops need /loop start"), "stale guidance no longer discards loop state");
  assert.ok(!SRC.includes("then /loop start again"), "stall escalation no longer discards loop state");
});

test("send paths short-circuit once stale (no retry-into-the-void)", () => {
  assert.match(SRC, /if \(!extensionApi \|\| extensionApiStale\) return;/, "sendContinuation guard");
  assert.match(SRC, /if \(!extensionApi \|\| extensionApiStale\) return null;/, "sendLoopTurn guard");
});

test("a fresh factory run clears the stale flag (extension reload recovery)", () => {
  assert.match(SRC, /export default function \(pi: ExtensionAPI\): void \{\n  extensionApi = pi;\n  extensionApiStale = false;/);
});
