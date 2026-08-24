/**
 * Tests for extensions/goal-stagnation.ts (v0.37.0) — the AVO-inspired goal
 * stagnation supervisor: progress-lineage vectors, exhaustion/cycling
 * detectors, bounded supervisor directives. Pure functions, imported from
 * the real module (never a copy — v0.23.7).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STAGNATION,
  emptyStagnation,
  vectorHasProgress,
  recordTurnObservation,
  supervisorDirectiveBlock,
  type GoalStagnation,
  type ProgressVector,
} from "../extensions/goal-stagnation.ts";

let clock = 0;
const at = (): string => new Date(2026, 7, 24, 12, 0, 0, clock++).toISOString();

function vec(partial: Partial<ProgressVector> = {}): ProgressVector {
  return {
    at: at(),
    toolCalls: 3,
    fileWrites: 0,
    bashCalls: 0,
    gitCommits: 0,
    taskCompletions: 0,
    ...partial,
  };
}

/** Genuinely DIFFERENT reply bodies — near-identical ones would (correctly)
 * trip the cycling detector before exhaustion can accumulate. */
const DISTINCT_TEXTS = [
  "I am investigating the failing scheduler path by reading the lock ordering sources and comparing them against the upstream patch series.",
  "The documentation build regressed because the generated API tables reference a module that was renamed last week; regenerating now.",
  "Benchmark numbers look noisy: rerunning the suite with more warm-up iterations and pinning CPU frequency before drawing conclusions.",
  "Reviewing git history shows the flaky test was added without a retry guard; adding an explicit poll deadline instead of a bare sleep.",
  "Profiling points at the serializer allocating per element; switching the hot loop to a reusable buffer should cut the garbage pressure.",
  "The config loader silently swallows malformed YAML entries; making the parser fail loudly and fixing the two affected fixtures.",
];
const BUSY_TEXT = DISTINCT_TEXTS[0]!;
const OTHER_TEXT = DISTINCT_TEXTS[1]!;
/** Near-identical phrasings for cycling-detector tests — only a few words
 * change, so word-trigram Jaccard stays ≥ the 0.8 threshold. */
const CYCLE_A =
  "I am investigating the failing kernel module by reading the scheduler sources and comparing the lock ordering against the upstream patch series before instrumenting anything else today.";
const CYCLE_B =
  "I am investigating the failing kernel module by reading the scheduler sources and comparing the lock ordering against the upstream patch series before instrumenting anything else tomorrow.";

// ---- primitives ----

test("vectorHasProgress counts commits, task completions, and writes — not bare activity", () => {
  assert.equal(vectorHasProgress(vec({ gitCommits: 1 })), true);
  assert.equal(vectorHasProgress(vec({ taskCompletions: 2 })), true);
  assert.equal(vectorHasProgress(vec({ fileWrites: 1 })), true);
  assert.equal(vectorHasProgress(vec({ toolCalls: 9, bashCalls: 4 })), false);
});

test("recordTurnObservation is pure: input state is not mutated", () => {
  const prev = emptyStagnation();
  const { next } = recordTurnObservation(prev, { vector: vec() });
  assert.notEqual(next, prev);
  assert.equal(prev.window.length, 0);
  assert.equal(prev.exhaustedStreak, 0);
  assert.equal(next.window.length, 1);
});

test("emptyStagnation returns clean state", () => {
  const st = emptyStagnation();
  assert.deepEqual(st.window, []);
  assert.deepEqual(st.recentTexts, []);
  assert.equal(st.exhaustedStreak, 0);
  assert.equal(st.directive, undefined);
});

// ---- exhaustion ----

test("active turns without progress grow the streak but do not fire early", () => {
  let st: GoalStagnation = emptyStagnation();
  for (let i = 0; i < STAGNATION.exhaustionAfter - 1; i++) {
    const r = recordTurnObservation(st, { vector: vec(), assistantText: DISTINCT_TEXTS[i % DISTINCT_TEXTS.length] });
    st = r.next;
    assert.equal(r.fired, undefined, `no directive on streak ${st.exhaustedStreak}`);
  }
  assert.equal(st.exhaustedStreak, STAGNATION.exhaustionAfter - 1);
});

test("exhaustion fires after exhaustionAfter consecutive active no-progress turns", () => {
  let st: GoalStagnation = emptyStagnation();
  for (let i = 0; i < STAGNATION.exhaustionAfter; i++) {
    const r = recordTurnObservation(st, { vector: vec(), assistantText: DISTINCT_TEXTS[i % DISTINCT_TEXTS.length] });
    st = r.next;
    if (i === STAGNATION.exhaustionAfter - 1) {
      assert.ok(r.fired, "directive fired at threshold");
      assert.equal(r.fired!.kind, "exhaustion");
      assert.match(r.fired!.reason, /consecutive active turns/);
    }
  }
  assert.equal(st.directive?.kind, "exhaustion");
});

test("idle turns (no tools, no substantial text) do not feed the exhaustion streak", () => {
  const idle = vec({ toolCalls: 0 });
  let st: GoalStagnation = recordTurnObservation(emptyStagnation(), { vector: idle, assistantText: "ok" }).next;
  assert.equal(st.exhaustedStreak, 0);
  st = recordTurnObservation(st, { vector: idle, assistantText: "still just narrating progress" }).next;
  assert.equal(st.exhaustedStreak, 0);
  // But a substantial text-only turn IS activity.
  st = recordTurnObservation(st, { vector: vec({ toolCalls: 0 }), assistantText: BUSY_TEXT }).next;
  assert.equal(st.exhaustedStreak, 1);
});

test("any committed progress resets the streak and clears a pending directive", () => {
  let st = emptyStagnation();
  for (let i = 0; i < STAGNATION.exhaustionAfter; i++) {
    st = recordTurnObservation(st, { vector: vec(), assistantText: DISTINCT_TEXTS[i % DISTINCT_TEXTS.length] }).next;
  }
  assert.ok(st.directive);
  st = recordTurnObservation(st, { vector: vec({ gitCommits: 1 }), assistantText: OTHER_TEXT }).next;
  assert.equal(st.exhaustedStreak, 0);
  assert.equal(st.directive, undefined);
});

// ---- cycling ----

test("cycling fires after cyclingAfter consecutive near-duplicate replies even WITH writes", () => {
  let st: GoalStagnation = emptyStagnation();
  // Alternate two near-identical phrasings — pairwise-similar series.
  const cycle = [CYCLE_A, CYCLE_B];
  for (let i = 0; i < STAGNATION.cyclingAfter; i++) {
    const r = recordTurnObservation(st, { vector: vec({ fileWrites: 2 }), assistantText: cycle[i % 2] });
    st = r.next;
    if (i >= STAGNATION.cyclingAfter - 1) {
      assert.ok(r.fired, "cycling fired despite file writes");
      assert.equal(r.fired!.kind, "cycling");
    }
  }
});

test("dissimilar replies do not trigger cycling", () => {
  let st: GoalStagnation = emptyStagnation();
  st = recordTurnObservation(st, { vector: vec(), assistantText: BUSY_TEXT }).next;
  st = recordTurnObservation(st, { vector: vec(), assistantText: OTHER_TEXT }).next;
  const r = recordTurnObservation(st, { vector: vec(), assistantText: BUSY_TEXT });
  assert.equal(r.fired, undefined);
});

test("short replies never count toward cycling", () => {
  let st: GoalStagnation = emptyStagnation();
  for (let i = 0; i < STAGNATION.cyclingAfter + 1; i++) {
    // Idle turn: short repeated acks must not fire ANY detector.
    const r = recordTurnObservation(st, { vector: vec({ toolCalls: 0 }), assistantText: "ok done" });
    st = r.next;
    assert.equal(r.fired, undefined);
  }
});

// ---- bounded nagging ----

test("a carried directive stands down after maxConsecutiveInjections stalled turns", () => {
  let st = emptyStagnation();
  for (let i = 0; i < STAGNATION.exhaustionAfter; i++) {
    st = recordTurnObservation(st, { vector: vec(), assistantText: DISTINCT_TEXTS[i % DISTINCT_TEXTS.length] }).next;
  }
  assert.ok(st.directive, "fired");
  assert.equal(st.directive!.injections, 0);

  for (let i = 0; i < STAGNATION.maxConsecutiveInjections; i++) {
    st = recordTurnObservation(st, {
      vector: vec(),
      assistantText: DISTINCT_TEXTS[(STAGNATION.exhaustionAfter + i) % DISTINCT_TEXTS.length],
    }).next;
    assert.ok(st.directive, `still injected after ${i + 1} further stalled turns`);
  }
  st = recordTurnObservation(st, { vector: vec(), assistantText: OTHER_TEXT }).next;
  assert.equal(st.directive, undefined, "supervisor stood down past the cap");
});

test("window respects the rolling caps", () => {
  let st: GoalStagnation = emptyStagnation();
  for (let i = 0; i < STAGNATION.windowCap + 5; i++) {
    st = recordTurnObservation(st, { vector: vec(), assistantText: `${OTHER_TEXT} unique ${i}` }).next;
  }
  assert.equal(st.window.length, STAGNATION.windowCap);
  assert.equal(st.recentTexts.length, STAGNATION.textCap);
});

// ---- directive rendering ----

test("supervisorDirectiveBlock renders non-prescriptive framing per kind", () => {
  const ex = supervisorDirectiveBlock({
    kind: "exhaustion",
    reason: "4 consecutive active turns with no committed progress",
    at: at(),
    injections: 0,
  });
  assert.match(ex, /^## SUPERVISOR DIRECTIVE — STAGNATION REVIEW/);
  assert.match(ex, /EXHAUSTION/);
  assert.match(ex, /not an instruction to make one specific change/);

  const cy = supervisorDirectiveBlock({
    kind: "cycling",
    reason: "3 consecutive near-duplicate replies",
    at: at(),
    injections: 0,
  });
  assert.match(cy, /CYCLING/);
  assert.match(cy, /not an instruction to make one specific change/);
});

// ---- wiring integration (source-pinned, per repo convention —
// continuationPrompt needs the full runtime globals to execute) ----

import * as fs from "node:fs";
import * as nodePath from "node:path";

const readSrc = (...p: string[]): string => fs.readFileSync(nodePath.resolve(...p), "utf-8");

test("continuationPrompt injects the pending supervisor directive conditionally", () => {
  const src = readSrc("extensions", "goal-continuation.ts");
  assert.match(src, /supervisorDirectiveBlock/);
  assert.match(src, /goal\.status === "active" && goal\.stagnation\?\.directive/);
});

test("agent_end folds turns into the lineage with error/abort exemption", () => {
  const src = readSrc("extensions", "loops", "goal-activation.ts");
  // The hook exists and sits next to the goal gates (after the length path
  // and nudge accounting — ordering pinned by tests/length-continue.test.ts).
  assert.match(src, /noteGoalStagnationTurn\(ctx, \{ assistantText: text \}\)/);
  // Provider-error and abort turns never count: the model never got a say.
  assert.match(src, /stopReason !== "error" && stopReason !== "aborted"/);
  // Best-effort: telemetry must never break the loop.
  assert.match(src, /catch \{\n[\s\S]{0,120}?never breaks the loop/);
});
