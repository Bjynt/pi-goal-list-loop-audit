// pi-goal-list-loop-audit — v0.34.116
// tests/context-overflow-recovery.test.ts
//
// Pins the v0.34.116 contract:
//   - classifyMainModelFailure(error, { isContextOverflow: true }) returns
//     kind: "context-overflow" for length/context-window strings, instead of
//     the legacy "non-recoverable". Without the override the classifier
//     stays non-recoverable (a length cap mid-stream MUST NOT silently
//     rotate to a backup on its own — the prompt is the problem).
//   - recoverFromContextOverflow is exported from goal-recovery.ts and
//     routes through the same sessionModelSelector as tryMainModelFallback
//     (chain + forbidden + resolver + ledger).
//   - observeCompactFailure appends a "compact_failure_observed" ledger
//     entry and emits a one-liner UI notify (so the user sees the signal
//     even when the recovery rollover is silent).
//   - The agent_end context-starved branch detects "compaction already
//     happened within COMPACTION_GRACE_MS" and calls
//     recoverFromContextOverflow so the user gets an automated fallback
//     instead of seeing "Context overflow recovery FAILED after one
//     compact-and-retry attempt" with no recourse (the
//     Screenshot_20260808_192604 hegemion case).
//
// Source pins only — no runtime. The selector and the recovery path are
// covered by tests/model-selector.test.ts and tests/main-model-recovery.test.ts.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const RECOVERY = fs.readFileSync("extensions/goal-recovery.ts", "utf-8");
const MAIN = fs.readFileSync("extensions/main-model-recovery.ts", "utf-8");
const SRC = readGoalRuntimeSource();

test("v0.34.116: classifyMainModelFailure accepts an isContextOverflow override", () => {
  assert.match(MAIN, /export function classifyMainModelFailure\(error: string \| undefined, opts\?: \{ isContextOverflow\?: boolean \}\): MainModelFailure \{/);
});

test("v0.34.116: context-overflow override routes to a context-overflow kind, not non-recoverable", () => {
  // The legacy non-recoverable path stays the default — the override is
  // the explicit signal that the model is too small (not the prompt too
  // big for any model).
  const block = MAIN.slice(MAIN.indexOf("export function classifyMainModelFailure"), MAIN.indexOf("export function isContextOverflowError"));
  assert.match(block, /return opts\?\.isContextOverflow\s+\?\s*\{\s*kind:\s*"context-overflow"/);
  assert.match(block, /:\s*\{\s*kind:\s*"non-recoverable",\s*raw\s*\};/);
});

test("v0.34.116: helper isContextOverflowError covers the same surface as the legacy non-recoverable regex", () => {
  assert.match(MAIN, /export function isContextOverflowError\(error: string \| undefined\): boolean \{/);
  // Match the actual regex literal in the source file (it contains a literal
  // character class `[ -]?` which is awkward to encode in a test regex, so
  // confirm the markers around it instead).
  assert.match(MAIN, /\.test\(text\);/);
  const helperIdx = MAIN.indexOf("export function isContextOverflowError");
  const helperBody = MAIN.slice(helperIdx, MAIN.indexOf("/** v0.34.57", helperIdx));
  assert.match(helperBody, /context\|output/);
  assert.match(helperBody, /prompt too large\|context window/);
});

test("v0.34.116: recoverFromContextOverflow is exported and routes through tryMainModelFallback", () => {
  assert.match(RECOVERY, /export async function recoverFromContextOverflow\(ctx: ExtensionContext, error: string \| undefined\): Promise<boolean> \{/);
  assert.match(RECOVERY, /const failure = classifyMainModelFailure\(error, \{ isContextOverflow: true \}\);/);
  assert.match(RECOVERY, /observeCompactFailure\(ctx, error\);/);
  assert.match(RECOVERY, /return tryMainModelFallback\(ctx, failure\);/);
});

test("v0.34.116: observeCompactFailure is the one-liner surface (notify + ledger)", () => {
  assert.match(RECOVERY, /export function observeCompactFailure\(ctx: ExtensionContext, error: string \| undefined\): boolean \{/);
  assert.match(RECOVERY, /appendLedger\(ctx\.cwd, "compact_failure_observed", \{ at: nowIso\(\), error: text\.slice\(0, 240\) \}\);/);
  assert.match(RECOVERY, /ctx\.ui\.notify\("glla: session_compact did not release the overflow — walking the fallback chain to a larger-context model\.", "warning"\);/);
});

test("v0.34.116: tryMainModelFallback opens context-overflow (it is the only rotation kind beyond provider failures)", () => {
  // non-recoverable stays the gate; context-overflow is the new pass-through.
  const block = RECOVERY.slice(RECOVERY.indexOf("export async function tryMainModelFallback"), RECOVERY.indexOf("export async function tryMainModelFallback") + 1200);
  assert.match(block, /if \(flags\.mainModelSwitchInFlight\) return false;/);
  assert.match(block, /if \(failure\.kind === "non-recoverable"\)/);
  assert.doesNotMatch(block, /if \(flags\.mainModelSwitchInFlight \|\| failure\.kind === "non-recoverable"\)/);
});

test("v0.34.116: agent_end context-starved branch detects recent compaction and walks the chain", () => {
  // The chokepoint is the `if (contextStarvedLength)` block in extensions/loops/goal-activation.ts.
  const block = SRC.slice(SRC.indexOf("if (contextStarvedLength) {"), SRC.indexOf("if (contextStarvedLength) {") + 2400);
  assert.match(block, /const sinceLastCompactMs = state\.lastCompactionAt \? Date\.now\(\) - state\.lastCompactionAt : Number\.POSITIVE_INFINITY;/);
  assert.match(block, /if \(sinceLastCompactMs < COMPACTION_GRACE_MS && mainModelFallbackRefs\(ctx\)\.length > 0\)/);
  assert.match(block, /const switched = await recoverFromContextOverflow\(ctx, overflowMessage\);/);
  assert.match(block, /if \(switched\) \{/);
});
