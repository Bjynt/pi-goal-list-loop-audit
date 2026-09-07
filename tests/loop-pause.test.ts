// pi-goal-list-loop-audit — v0.38.23
// tests/loop-pause.test.ts
//
// /loop pause is a soft-hold parallel to /goal pause and /glla pause: the
// loop stops firing iterations but stays in a held, resumable state. NO
// finishLoopGit, NO hard-stop ledger. /loop resume picks it up via the
// RESUMABLE_STOP predicate.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { readGoalRuntimeSource } from "./harness/goal-source.js";

const goalSrc = readGoalRuntimeSource();
const loopSrc = fs.readFileSync(path.resolve("extensions", "goal-loop.ts"), "utf-8"); // decomposition step 2

test("v0.38.23: /loop pause is routed in cmdLoop and clears the tick", () => {
  assert.match(loopSrc, /if \(sub === "pause"\) \{/);
  // The pause handler must clear the timer + tool activity, set active=false,
  // and write the held stopReason. It must NOT call finishLoopGit (soft-hold).
  // Slice only the pause block (up to the next /loop subcommand) so the
  // /loop finish block (which legitimately calls finishLoopGit) doesn't
  // contaminate the assertion.
  const pauseStart = loopSrc.indexOf('if (sub === "pause")');
  const finishStart = loopSrc.indexOf('if (sub === "finish")', pauseStart);
  const pauseBlock = loopSrc.slice(pauseStart, finishStart);
  assert.match(pauseBlock, /clearLoopTimer\(\)/, "pause clears the tick timer");
  assert.match(pauseBlock, /active: false, stopReason: "paused by user \(\/loop pause\)"/, "pause writes the held stopReason");
  assert.doesNotMatch(pauseBlock, /finishLoopGit/, "pause skips finishLoopGit (soft-hold, not hard stop)");
  assert.match(pauseBlock, /loop_paused/, "pause ledgered as loop_paused");
});

test("v0.38.23: /loop pause is registered in the help completions", () => {
  assert.match(goalSrc, /\["pause", "hold the active loop/);
});

test("v0.38.23: RESUMABLE_STOP matches the pause stopReason so /loop resume picks it up", () => {
  // The predicate must include the new prefix; /loop resume reads it to
  // decide whether the held loop is user-resumable.
  assert.match(
    loopSrc,
    /!!r\?\.startsWith\("paused by user \(\/loop pause\)"\)/,
    "RESUMABLE_STOP recognizes the pause stopReason",
  );
});
