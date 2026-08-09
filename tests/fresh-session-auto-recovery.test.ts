// pi-goal-list-loop-audit — v0.34.117
// tests/fresh-session-auto-recovery.test.ts
//
// Pins the v0.34.117 contract: when pi's compact subsystem throws the
// stale signature, the cached ctx is dead — only /new clears it (pi
// error: "For newSession, fork, and switchSession, move post-replacement
// work into withSession and use the ctx passed to withSession. For
// reload, do not use the old ctx after await ctx.reload()").
// The user observed this exact wedge (Screenshot_20260809_095353 — only
// /new cleared the locked ctx). This contract pins the helper that
// automates /new so a future regression either fails or removes the
// recovery on purpose.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

const GOAL_RECOVERY_SRC = fs.readFileSync("extensions/goal-recovery.ts", "utf-8");
const GOAL_CONTINUATION_SRC = fs.readFileSync("extensions/goal-continuation.ts", "utf-8");
const GOAL_LOOP_SRC = fs.readFileSync("extensions/goal-loop.ts", "utf-8");

test("attemptFreshSessionRecovery: helper is exported from goal-recovery.ts and reads extensionApi from the recovery factory flags", () => {
  assert.match(GOAL_RECOVERY_SRC, /export function attemptFreshSessionRecovery\(ctx: ExtensionContext, where: string\): boolean/);
  assert.match(GOAL_RECOVERY_SRC, /flags\.extensionApi/, "reads the extension api through the createGoalRecovery factory flags (one-way, not a direct import from goal.ts)");
  assert.match(GOAL_RECOVERY_SRC, /api\.newSession\(\)/, "calls the newSession entrypoint on the extension api (programmatic equivalent of /new)");
  assert.match(GOAL_RECOVERY_SRC, /fresh_session_recovery_triggered/, "ledger event when the recovery fires so future regressions are observable");
  assert.match(GOAL_RECOVERY_SRC, /fresh_session_recovery_skipped/, "ledger event when the entrypoint is missing so the manual /new path is observable");
});

test("attemptFreshSessionRecovery: returns false when the newSession entrypoint is missing (so the legacy terminal park runs)", () => {
  assert.match(GOAL_RECOVERY_SRC, /typeof api\.newSession !== "function"/);
  assert.match(GOAL_RECOVERY_SRC, /return false;/);
});

test("every stale-ctx send site routes through attemptFreshSessionRecovery before falling back to goStaleTerminal", () => {
  // Five sites observed in the codebase; each must try auto-recovery first.
  const sites = [
    { where: "retryContinuationDispatch", in: GOAL_CONTINUATION_SRC },
    { where: "sendContinuation", in: GOAL_CONTINUATION_SRC },
    { where: "sendStallEscalation", in: GOAL_CONTINUATION_SRC },
    { where: "sendLengthContinue", in: GOAL_CONTINUATION_SRC },
    { where: "sendLoopTurn", in: GOAL_LOOP_SRC },
  ];
  for (const { where, in: src } of sites) {
    assert.match(
      src,
      new RegExp(`if \\(!attemptFreshSessionRecovery\\(ctx, "${where}"\\)\\) goStaleTerminal\\(ctx, "${where}"\\);`),
      `${where} must try auto-recovery before the terminal park`,
    );
  }
});

test("attemptFreshSessionRecovery: notify surfaces the no-/new-needed message", () => {
  assert.match(GOAL_RECOVERY_SRC, /auto-recovering with a fresh session \(no \/new needed\)/);
});