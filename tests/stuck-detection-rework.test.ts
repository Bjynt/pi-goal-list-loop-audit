// pi-goal-list-loop-audit — v0.25.1
// tests/stuck-detection-rework.test.ts
//
// Stuck-detection rework contract items 1-6: the multi-signal
// "progress signals" gate. The loop is stuck ONLY when file writes, git
// commits, spec_item_progress events, AND a PAIRED forward transition are
// all zero — and the legacy detector also fires.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  detectLoopStuck,
  forwardTransitionMarker,
  forwardTransitionPaired,
  isActuallyStuck,
  textFingerprint,
  type LoopStuckInput,
  type ToolResultPrint,
} from "../extensions/goal-loop-repetition.ts";

function stableCheckResults(): ToolResultPrint[] {
  const h = textFingerprint("9 warnings, 0 errors");
  return [
    { tool: "bash", hash: h, isError: false },
    { tool: "bash", hash: h, isError: false },
    { tool: "bash", hash: h, isError: false },
  ];
}

function baseInput(over: Partial<LoopStuckInput> = {}): LoopStuckInput {
  return {
    assistantText: "Verification is stable at 9 warnings. Next step (iter-222, implement branch): wire the branch gate.",
    recentPrints: ["aaa", "bbb", "ccc"],
    recentToolResults: stableCheckResults(),
    toollessStreak: 0,
    ...over,
  };
}

// ---- item 1: exports exist and are pure ----

test("item 1: isActuallyStuck and forwardTransitionMarker are exported functions", () => {
  assert.equal(typeof isActuallyStuck, "function");
  assert.equal(typeof forwardTransitionMarker, "function");
});

// ---- item 5: the marker word list ----

test("item 5: forwardTransitionMarker matches the conservative word list", () => {
  assert.equal(forwardTransitionMarker("Next step (iter-222, implement branch)"), true);
  assert.equal(forwardTransitionMarker("Next phantom: §9 audio ducking"), true);
  assert.equal(forwardTransitionMarker("moving on to the audio system"), true);
  assert.equal(forwardTransitionMarker("Now implement the retry path"), true);
  assert.equal(forwardTransitionMarker("Next: wire the branch gate"), true);
  assert.equal(forwardTransitionMarker("the check output is stable"), false);
  assert.equal(forwardTransitionMarker(""), false);
});

// ---- item 5: pairing rule ----

test("item 5: an UNPAIRED forward marker is NOT a progress signal", () => {
  assert.equal(forwardTransitionPaired(baseInput({ fileWriteCount: 0, gitCommitCount: 0 })), false);
  assert.equal(forwardTransitionPaired(baseInput({ fileWriteCount: 1 })), true);
  assert.equal(forwardTransitionPaired(baseInput({ gitCommitCount: 2 })), true);
  // No marker at all → not paired regardless of writes.
  assert.equal(
    forwardTransitionPaired(baseInput({ assistantText: "stable output", fileWriteCount: 1 })),
    false,
  );
});

// ---- the gate itself ----

test("items 3/5: file writes exempt the iteration even with stable tool results", () => {
  assert.equal(isActuallyStuck(baseInput({ fileWriteCount: 1 })), undefined);
});

test("item 4: git commits exempt the iteration", () => {
  assert.equal(isActuallyStuck(baseInput({ gitCommitCount: 1 })), undefined);
});

test("item 6: spec_item_progress events exempt the iteration", () => {
  assert.equal(isActuallyStuck(baseInput({ specItemProgressCount: 1 })), undefined);
});

test("narrate-but-don't-ship: unpaired marker + stable results IS still stuck", () => {
  const verdict = isActuallyStuck(baseInput({ fileWriteCount: 0, gitCommitCount: 0 }));
  assert.match(verdict ?? "", /same bash result 3× in a row/);
});

test("item 8: toolsamerepeat=0 disables the legacy same-result check entirely", () => {
  // With the legacy check off and all progress signals zero, an otherwise
  // clean iteration is NOT stuck.
  assert.equal(
    isActuallyStuck(baseInput({ assistantText: "steady progress, no markers", fileWriteCount: 0 }), 0),
    undefined,
  );
  // ...and detectLoopStuck honors the override directly:
  assert.equal(detectLoopStuck(baseInput(), 0), undefined);
  assert.match(detectLoopStuck(baseInput()) ?? "", /same bash result/);
});

test("backward compat: detectLoopStuck unchanged for legacy callers", () => {
  assert.match(detectLoopStuck(baseInput({ assistantText: "no markers here" })) ?? "", /same bash result 3×/);
});
