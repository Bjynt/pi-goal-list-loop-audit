// pi-goal-list-loop-audit — v0.3.0
// tests/loop-forever.test.ts
//
// Unit tests for loop 3 core: metric parsing, improvement comparison,
// plateau/termination logic, and /loop start arg parsing.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyMeasurement,
  applyMetriclessTick,
  applyRefinement,
  isImprovement,
  loopBranchName,
  parseLoopStartArgs,
  parseMetric,
  resolveSpecFile,
  resolveSpecFiles,
  respecTarget,
  auditMeasureCmd,
  auditTarget,
  countOpenAuditFindings,
  topOpenAuditFinding,
  AUDIT_FINDINGS_REL,
  HELD_ON_RESTORE,
  isLifecycleHeldLoopReason,
  type LoopState,
} from "../extensions/goal-loop-forever.ts";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

function freshLoop(overrides: Partial<LoopState> = {}): LoopState {
  return {
    target: "reduce failures",
    measureCmd: "grep -c FAIL report.txt",
    direction: "min",
    iteration: 0,
    maxIterations: 10,
    plateauWindow: 3,
    stallCount: 0,
    bestValue: null,
    lastValue: null,
    active: true,
    history: [],
    startedAt: "2026-07-20T00:00:00Z",
    ...overrides,
  };
}

test("isLifecycleHeldLoopReason separates recoverable lifecycle holds from deliberate/safety stops", () => {
  assert.equal(isLifecycleHeldLoopReason(HELD_ON_RESTORE), true);
  assert.equal(isLifecycleHeldLoopReason("extension api stale: host replacement"), true);
  assert.equal(isLifecycleHeldLoopReason("stalled: continuation refires landed no turn — the session is not continuing"), true);
  assert.equal(isLifecycleHeldLoopReason("stalled: continuation start acknowledgement timed out (dispatch-1) — /loop resume to retry explicitly"), true);
  assert.equal(isLifecycleHeldLoopReason("stalled: 3 consecutive unproductive turns (no tools, short or repetitive)"), false);
  assert.equal(isLifecycleHeldLoopReason("send-retry storm: no turn"), true);
  assert.equal(isLifecycleHeldLoopReason("stopped by user (/loop stop)"), false);
  assert.equal(isLifecycleHeldLoopReason("stopped by user — 3 consecutive aborts"), false);
  assert.equal(isLifecycleHeldLoopReason("provider errors — quota"), false);
  assert.equal(isLifecycleHeldLoopReason("plateau — no improvement"), false);
  assert.equal(isLifecycleHeldLoopReason("stuck — repeated output"), false);
});

// ---- parseMetric ----

test("parseMetric: plain integer", () => {
  assert.equal(parseMetric("42"), 42);
});

test("parseMetric: number inside text", () => {
  assert.equal(parseMetric("score: 3.75 points"), 3.75);
});

test("parseMetric: negative + scientific", () => {
  assert.equal(parseMetric("-12"), -12);
  assert.equal(parseMetric("1.5e3"), 1500);
});

test("parseMetric: no number → null (broken measure is a stall, not a crash)", () => {
  assert.equal(parseMetric("no output"), null);
  assert.equal(parseMetric(""), null);
});

test("parseMetric: takes the FIRST number", () => {
  assert.equal(parseMetric("7 passed, 2 failed"), 7);
});

// ---- isImprovement ----

test("isImprovement: first value is always baseline", () => {
  assert.equal(isImprovement("min", 100, null), true);
  assert.equal(isImprovement("max", 100, null), true);
});

test("isImprovement: min direction", () => {
  assert.equal(isImprovement("min", 5, 10), true);
  assert.equal(isImprovement("min", 10, 10), false);
  assert.equal(isImprovement("min", 15, 10), false);
});

test("isImprovement: max direction", () => {
  assert.equal(isImprovement("max", 15, 10), true);
  assert.equal(isImprovement("max", 10, 10), false);
  assert.equal(isImprovement("max", 5, 10), false);
});

// ---- applyMeasurement ----

test("v0.29.10 — applyMeasurement: null best (deferred audit baseline) seeds on first real measurement", () => {
  // The audit loop's pre-discovery baseline is degenerate (0 open findings
  // just means findings.md doesn't exist yet). With best pinned at 0 no
  // iteration could ever improve — junk-runner/hegemon 2026-07-30 stalled
  // on real progress and the prompt cried REGRESSED. deferBaseline leaves
  // bestValue null; the first REAL measurement becomes the baseline.
  const loop = freshLoop({ bestValue: null, lastValue: null, kind: "audit" });
  let out = applyMeasurement(loop, 23, "t1"); // discovery iteration
  assert.equal(out.kind, "continue");
  if (out.kind === "continue") assert.equal(out.improved, true); // null best = baseline, always "improved"
  assert.equal(loop.bestValue, 23);
  assert.equal(loop.stallCount, 0); // discovery is NOT a stall
  out = applyMeasurement(loop, 20, "t2"); // fixing iteration — real improvement
  if (out.kind === "continue") assert.equal(out.improved, true);
  assert.equal(loop.bestValue, 20);
  out = applyMeasurement(loop, 20, "t3"); // flat — now an honest stall
  if (out.kind === "continue") assert.equal(out.improved, false);
  assert.equal(loop.stallCount, 1);
  out = applyMeasurement(loop, 0, "t4"); // well dry — 0 IS an improvement once best is real
  if (out.kind === "continue") assert.equal(out.improved, true);
  assert.equal(loop.bestValue, 0);
});

test("v0.29.10 — audit loop source pins: deferred baseline, true-regression note, live-loop reseed migration", () => {
  const src = readFileSync(new URL("../extensions/goal-loop.ts", import.meta.url), "utf-8");
  const goalSrc = readGoalRuntimeSource();
  // The /loop audit route defers the baseline and tags the loop kind.
  assert.ok(src.includes("deferBaseline: true,"), "audit route defers the baseline");
  assert.ok(src.includes('kind: "audit",'), "audit route tags the loop kind");
  // startLoopFromConfig honours the flag (no baseline measure, null best).
  assert.ok(src.includes("metricless || cfg.deferBaseline ? null : await runMeasure"), "deferred baseline skips the start measure");
  assert.ok(src.includes("bestValue: cfg.deferBaseline ? null : baseline,"), "deferred baseline seeds null best");
  assert.ok(src.includes("deferred — the first real measurement seeds it"), "banner names the deferred baseline");
  // The regression note fires only on a TRUE regression (last two
  // measurements moved the wrong way) — never on a mere stall.
  assert.ok(src.includes("trueRegression"), "true-regression detection present");
  assert.ok(!src.includes("regressedLast"), "old any-stall-is-regression trigger gone");
  assert.ok(
    src.includes("The closed-findings count went DOWN last iteration — a checked finding was reopened or findings.md was rewritten (both forbidden)"),
    "audit loops get audit-flavoured regression wording (v0.29.14: closed-count/max semantics)",
  );
  // v0.29.14: live loops on the open-count/min metric migrate to
  // closed-count/max on session load (supersedes the baseline-0 reseed).
  assert.ok(goalSrc.includes("audit_loop_metric_migrated"), "migration ledgers the metric flip");
  assert.ok(goalSrc.includes('from: "open-count/min", to: "closed-count/max"'), "migration names both metrics");
  assert.ok(!goalSrc.includes("audit_loop_baseline_reseeded"), "v0.29.10 reseed superseded");
});


test("applyMeasurement: improvement resets stall, records best", () => {
  const loop = freshLoop();
  let out = applyMeasurement(loop, 10, "t1");
  assert.equal(out.kind, "continue");
  assert.equal(loop.bestValue, 10);
  out = applyMeasurement(loop, 7, "t2");
  assert.equal(out.kind, "continue");
  assert.equal(loop.bestValue, 7);
  assert.equal(loop.stallCount, 0);
  assert.equal(loop.iteration, 2);
});

test("applyMeasurement: non-improvement increments stall", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 1 });
  const out = applyMeasurement(loop, 8, "t1");
  assert.equal(out.kind, "continue");
  assert.equal(loop.bestValue, 5); // best unchanged
  assert.equal(loop.stallCount, 1);
});

test("applyMeasurement: broken measure (null) is NOT a stall — tracked separately (E5)", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 1 });
  const out = applyMeasurement(loop, null, "t1");
  assert.equal(out.kind, "continue");
  assert.equal(loop.stallCount, 0, "a null says nothing about improvement — plateau stays reserved for real numbers");
  assert.equal(loop.consecutiveNullMeasures, 1);
  assert.equal(loop.lastValue, null);
});

test("applyMeasurement: a numeric value resets the null streak (E5)", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 1, consecutiveNullMeasures: 2 });
  applyMeasurement(loop, 3, "t1"); // improves (min direction)
  assert.equal(loop.consecutiveNullMeasures, 0);
});

test("applyMeasurement: plateauWindow consecutive nulls stop with 'measure command broken', NOT plateau (E5)", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 1, plateauWindow: 3 });
  applyMeasurement(loop, null, "t1");
  applyMeasurement(loop, null, "t2");
  const out = applyMeasurement(loop, null, "t3");
  assert.equal(out.kind, "stop");
  assert.equal(loop.active, false);
  assert.match(loop.stopReason!, /measure command broken/);
  assert.match(loop.stopReason!, /3 consecutive iterations printed no number/);
  assert.doesNotMatch(loop.stopReason!, /plateau/);
});

test("applyMeasurement: an interleaved null does not move the real stall count (E5)", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 1, stallCount: 1, plateauWindow: 3 });
  applyMeasurement(loop, null, "t1"); // null — stall stays 1
  assert.equal(loop.stallCount, 1);
  applyMeasurement(loop, 9, "t2"); // real non-improvement — stall 2
  assert.equal(loop.stallCount, 2);
  const out = applyMeasurement(loop, 8, "t3"); // real non-improvement — stall 3 → plateau
  assert.equal(out.kind, "stop");
  assert.match(loop.stopReason!, /plateau/);
});

test("applyMeasurement: plateau stops the loop", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 3, stallCount: 2, plateauWindow: 3 });
  const out = applyMeasurement(loop, 9, "t1");
  assert.equal(out.kind, "stop");
  assert.equal(loop.active, false);
  assert.match(loop.stopReason!, /plateau/);
});

// v0.35.31 (field: doomtap 2026-08-22, Screenshot_20260822_094423): a
// min-direction loop whose metric reads 0 before work exists (open findings
// at survey start) locked best at 0; the productive readings that followed
// (12 → 7 findings being worked down) all scored "flat" and burned five
// plateau slots → false stop while iterations were visibly fixing work.
test("v0.35.31 — a never-moved zero baseline does not false-plateau a working min loop", () => {
  const loop = freshLoop({ bestValue: 0, iteration: 0, stallCount: 0, plateauWindow: 5 });
  for (const [i, v] of [0, 0, 0, 12, 7, 7].entries()) {
    const out = applyMeasurement(loop, v, `t${i + 1}`);
    assert.equal(out.kind, "continue", `iteration ${i + 1} must not stop — baseline still forming`);
  }
  assert.equal(loop.stallCount, 0, "no honest plateau is possible while the metric never moved");
});

test("v0.35.31 — the never-moved grace is bounded by a loud distinct stop", () => {
  const loop = freshLoop({ bestValue: 0, iteration: 0, stallCount: 0, plateauWindow: 3 });
  let out: ReturnType<typeof applyMeasurement> = { kind: "continue", improved: false, value: 0 };
  for (let i = 0; i < 6 && out.kind === "continue"; i++) out = applyMeasurement(loop, 0, `t${i}`);
  assert.equal(out.kind, "stop");
  assert.match(out.reason, /metric never moved/);
  assert.doesNotMatch(out.reason, /plateau —/, "the old misleading reason is gone for this class");
});

test("v0.35.31 — a resumed run whose best differs from its first reading still plateaus honestly", () => {
  // History restarted but bestValue was carried from real prior movement:
  // flat readings count again (regression protection preserved).
  const loop = freshLoop({ bestValue: 5, iteration: 0, stallCount: 2, plateauWindow: 3 });
  const out = applyMeasurement(loop, 9, "t1"); // 9 > best 5 under min → flat, counts
  assert.equal(out.kind, "stop");
  assert.match(out.reason, /plateau/);
});

test("applyMeasurement: max iterations stops the loop", () => {
  const loop = freshLoop({ iteration: 9, maxIterations: 10, bestValue: 3, stallCount: 0 });
  const out = applyMeasurement(loop, 2, "t1"); // improving, but cap hit
  assert.equal(out.kind, "stop");
  assert.match(loop.stopReason!, /max iterations/);
});

test("applyMeasurement: plateau wins over cap when both hit", () => {
  const loop = freshLoop({ iteration: 9, maxIterations: 10, stallCount: 4, plateauWindow: 5, bestValue: 1 });
  const out = applyMeasurement(loop, 5, "t1");
  assert.equal(out.kind, "stop");
  assert.match(loop.stopReason!, /plateau/);
});

test("applyMeasurement: history is capped at 200", () => {
  const loop = freshLoop({ history: new Array(200).fill({ iteration: 0, value: 1, improved: true, at: "x" }) });
  applyMeasurement(loop, 1, "t1");
  assert.equal(loop.history.length, 200);
});

// ---- parseLoopStartArgs ----

test("parseLoopStartArgs: full form", () => {
  const cfg = parseLoopStartArgs('"reduce TODOs" measure="grep -c TODO src.txt" direction=min window=3 max=20');
  assert.equal(cfg.target, "reduce TODOs");
  assert.equal(cfg.measureCmd, "grep -c TODO src.txt");
  assert.equal(cfg.direction, "min");
  assert.equal(cfg.plateauWindow, 3);
  assert.equal(cfg.maxIterations, 20);
});

test("parseLoopStartArgs: defaults for window and max", () => {
  const cfg = parseLoopStartArgs('grow coverage measure="cat cov.txt" direction=max');
  assert.equal(cfg.plateauWindow, 5);
  assert.equal(cfg.maxIterations, 50);
});

test("parseLoopStartArgs: unquoted target works", () => {
  const cfg = parseLoopStartArgs('reduce the number in num.txt measure="cat num.txt" direction=min');
  assert.equal(cfg.target, "reduce the number in num.txt");
});

test("parseLoopStartArgs: bare start (no measure=) is the infinite metricless form (v0.23.6)", () => {
  const cfg = parseLoopStartArgs('"keep polishing the UI"');
  assert.equal(cfg.target, "keep polishing the UI");
  assert.equal(cfg.measureCmd, "");
  assert.equal(cfg.direction, undefined);
  assert.equal(cfg.maxIterations, 0); // unbounded — ends at time=/tokens= or /loop stop
});

test("parseLoopStartArgs: direction= without a measure throws", () => {
  assert.throws(() => parseLoopStartArgs('"x" direction=min'), /meaningless without a metric/);
});

test("parseLoopStartArgs: missing direction throws", () => {
  assert.throws(() => parseLoopStartArgs('target measure="cat x"'), /direction/);
});

test("parseLoopStartArgs: missing target throws", () => {
  assert.throws(() => parseLoopStartArgs('measure="cat x" direction=min'), /target/);
});

test("parseLoopStartArgs: measure with pipes/quotes survives", () => {
  const cfg = parseLoopStartArgs('t measure="grep -c x f.txt | head -1" direction=max');
  assert.equal(cfg.measureCmd, "grep -c x f.txt | head -1");
});

test("parseLoopStartArgs: branch flag off by default", () => {
  const cfg = parseLoopStartArgs('t measure="cat x" direction=min');
  assert.equal(cfg.branch, false);
});

test("parseLoopStartArgs: branch=1 / branch=true enable branch mode", () => {
  assert.equal(parseLoopStartArgs('t measure="cat x" direction=min branch=1').branch, true);
  assert.equal(parseLoopStartArgs('t measure="cat x" direction=min branch=true').branch, true);
  assert.equal(parseLoopStartArgs('t measure="cat x" direction=min branch=0').branch, false);
});

test("applyMeasurement: time bound stops when elapsed hours exceeded", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 1, timeLimitHours: 2, startedAt: "2026-07-21T00:00:00.000Z" });
  const out = applyMeasurement(loop, 4, "2026-07-21T03:00:00.000Z"); // 3h elapsed > 2h bound
  assert.equal(out.kind, "stop");
  assert.match(loop.stopReason!, /time bound reached \(2h\)/);
  assert.equal(loop.active, false);
});

test("applyMeasurement: time bound does not stop before the limit", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 1, timeLimitHours: 2, startedAt: "2026-07-21T00:00:00.000Z" });
  const out = applyMeasurement(loop, 4, "2026-07-21T01:00:00.000Z");
  assert.equal(out.kind, "continue");
});

test("applyMeasurement: token budget stops when exhausted", () => {
  const loop = freshLoop({ bestValue: 5, iteration: 1, tokenBudget: 1000, tokensUsed: 1200 });
  const out = applyMeasurement(loop, 4, "2026-07-21T00:00:00.000Z");
  assert.equal(out.kind, "stop");
  assert.match(loop.stopReason!, /token budget exhausted/);
});

test("applyMeasurement: no bound = process never 'completes' (v0.15.0)", () => {
  // Even a perfect metric value does not stop the loop — there is no done=.
  const loop = freshLoop({ direction: "min", bestValue: 5, iteration: 1 });
  const out = applyMeasurement(loop, 0, "2026-07-21T00:00:00.000Z");
  assert.equal(out.kind, "continue");
  assert.equal(loop.active, true);
});

test("parseLoopStartArgs: done= throws a teaching error (v0.15.0)", () => {
  assert.throws(
    () => parseLoopStartArgs('t measure="cat x" direction=min done=0'),
    /done= was removed.*GOAL/i,
  );
});

test("parseLoopStartArgs: time= and tokens= parse as arbitrary bounds", () => {
  const cfg = parseLoopStartArgs('t measure="cat x" direction=min time=2.5 tokens=500000');
  assert.equal(cfg.timeLimitHours, 2.5);
  assert.equal(cfg.tokenBudget, 500000);
  const bare = parseLoopStartArgs('t measure="cat x" direction=min');
  assert.equal(bare.timeLimitHours, undefined);
  assert.equal(bare.tokenBudget, undefined);
  const bad = parseLoopStartArgs('t measure="cat x" direction=min time=0 tokens=-5');
  assert.equal(bad.timeLimitHours, undefined);
  assert.equal(bad.tokenBudget, undefined);
});

test("parseLoopStartArgs: force flag off by default, on with 1/true", () => {
  assert.equal(parseLoopStartArgs('t measure="cat x" direction=min').force, false);
  assert.equal(parseLoopStartArgs('t measure="cat x" direction=min force=1').force, true);
  assert.equal(parseLoopStartArgs('t measure="cat x" direction=min force=true').force, true);
  assert.equal(parseLoopStartArgs('t measure="cat x" direction=min force=0').force, false);
});

// ---- loopBranchName ----

test("loopBranchName: format is pi-glla-loop/<timestamp>-<slug>", () => {
  const name = loopBranchName("2026-07-20T18:30:00Z", "Reduce TODO count");
  assert.match(name, /^pi-glla-loop\/\d{14}-reduce-todo-count$/);
});

test("loopBranchName: empty slug falls back to 'loop'", () => {
  const name = loopBranchName("2026-07-20T18:30:00Z", "!!!");
  assert.match(name, /^pi-glla-loop\/\d{14}-loop$/);
});

test("loopBranchName: slug is capped at 30 chars", () => {
  const name = loopBranchName("2026-07-20T18:30:00Z", "a very long target description that goes on and on and on");
  const slug = name.split("-")[0] ? name.slice(name.indexOf("/") + 16) : "";
  assert.ok(slug.length <= 30, `slug too long: ${slug}`);
});

test("applyRefinement: target-only change keeps baseline and stall state", () => {
  const loop = freshLoop({ bestValue: 3, lastValue: 4, stallCount: 1, iteration: 7 });
  applyRefinement(loop, {
    at: "2026-07-21T01:00:00.000Z", iteration: 7,
    oldTarget: "reduce warnings", newTarget: "reduce eslint warnings in src/",
    oldMeasureCmd: "m1", newMeasureCmd: "m1",
  }, null);
  assert.equal(loop.target, "reduce eslint warnings in src/");
  assert.equal(loop.bestValue, 3);
  assert.equal(loop.stallCount, 1);
  assert.equal(loop.refinements!.length, 1);
});

test("applyRefinement: measure change re-baselines and resets stall", () => {
  const loop = freshLoop({ bestValue: 3, lastValue: 4, stallCount: 2, iteration: 7 });
  applyRefinement(loop, {
    at: "2026-07-21T01:00:00.000Z", iteration: 7,
    oldTarget: "t", newTarget: "t",
    oldMeasureCmd: "m1", newMeasureCmd: "m2",
  }, 42);
  assert.equal(loop.measureCmd, "m2");
  assert.equal(loop.bestValue, 42);
  assert.equal(loop.lastValue, 42);
  assert.equal(loop.stallCount, 0);
  assert.equal(loop.refinements!.length, 1);
});

// ---- v0.23.0: metricless spec loops (measure=none) ----

function freshMetriclessLoop(overrides: Partial<LoopState> = {}): LoopState {
  return {
    target: "keep improving SPEC.md",
    iteration: 0,
    maxIterations: 10,
    plateauWindow: 3,
    stallCount: 0,
    bestValue: null,
    lastValue: null,
    active: true,
    history: [],
    startedAt: "2026-07-20T00:00:00Z",
    ...overrides,
  };
}

test("parseLoopStartArgs: measure=none yields a metricless config", () => {
  const cfg = parseLoopStartArgs('"keep improving SPEC.md" measure=none');
  assert.equal(cfg.target, "keep improving SPEC.md");
  assert.equal(cfg.measureCmd, "");
  assert.equal(cfg.direction, undefined);
  assert.equal(cfg.maxIterations, 0); // v0.23.6: metricless + no explicit max = unbounded
});

test("parseLoopStartArgs: measure=NONE is case-insensitive", () => {
  const cfg = parseLoopStartArgs('"work the spec" measure=NONE max=5');
  assert.equal(cfg.measureCmd, "");
  assert.equal(cfg.maxIterations, 5);
});

test("parseLoopStartArgs: direction with measure=none throws", () => {
  assert.throws(() => parseLoopStartArgs('"x" measure=none direction=min'), /direction= is meaningless/);
});

test("parseLoopStartArgs: explicit max= caps even a metricless loop", () => {
  const cfg = parseLoopStartArgs('"x" measure=none max=50');
  assert.equal(cfg.maxIterations, 50);
});

test("parseLoopStartArgs: max=0 = truly unbounded; absent max = 50", () => {
  assert.equal(parseLoopStartArgs('"x" measure="echo 1" direction=min max=0').maxIterations, 0);
  assert.equal(parseLoopStartArgs('"x" measure="echo 1" direction=min').maxIterations, 50);
});

test("applyMetriclessTick: iterates without plateau and never improves", () => {
  const loop = freshMetriclessLoop({ maxIterations: 0 });
  for (let i = 0; i < 20; i++) {
    const outcome = applyMetriclessTick(loop, "2026-07-20T01:00:00Z");
    assert.equal(outcome.kind, "continue");
    if (outcome.kind === "continue") assert.equal(outcome.improved, false);
  }
  assert.equal(loop.iteration, 20);
  assert.equal(loop.stallCount, 0); // no numbers, no stalls — plateau can never fire
  assert.equal(loop.active, true); // max=0 = unbounded: still going past 20
});

test("applyMetriclessTick: max iterations still stops the loop", () => {
  const loop = freshMetriclessLoop({ maxIterations: 3 });
  applyMetriclessTick(loop, "2026-07-20T01:00:00Z");
  applyMetriclessTick(loop, "2026-07-20T01:01:00Z");
  const outcome = applyMetriclessTick(loop, "2026-07-20T01:02:00Z");
  assert.equal(outcome.kind, "stop");
  assert.match(outcome.kind === "stop" ? outcome.reason : "", /max iterations reached \(3\)/);
  assert.equal(loop.active, false);
});

test("applyMetriclessTick: time and token bounds still stop the loop", () => {
  const byTime = freshMetriclessLoop({ maxIterations: 0, timeLimitHours: 1 });
  const t = applyMetriclessTick(byTime, "2026-07-20T02:00:00Z"); // 2h after start
  assert.equal(t.kind, "stop");
  assert.match(t.kind === "stop" ? t.reason : "", /time bound/);
  const byTokens = freshMetriclessLoop({ maxIterations: 0, tokenBudget: 1000, tokensUsed: 1500 });
  const tk = applyMetriclessTick(byTokens, "2026-07-20T00:30:00Z");
  assert.equal(tk.kind, "stop");
  assert.match(tk.kind === "stop" ? tk.reason : "", /token budget/);
});

test("applyMeasurement: max=0 = no iteration cap for measured loops either", () => {
  const loop = freshLoop({ maxIterations: 0, plateauWindow: 100 });
  for (let i = 0; i < 15; i++) {
    const outcome = applyMeasurement(loop, 5, "2026-07-20T01:00:00Z");
    assert.equal(outcome.kind, "continue");
  }
  assert.equal(loop.active, true);
});

// ---- /loop respec (v0.24.3) ----

test("resolveSpecFile: finds SPEC.md in root, prefers it over spec.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "respec-"));
  try {
    writeFileSync(join(dir, "SPEC.md"), "# Spec\n");
    writeFileSync(join(dir, "spec.md"), "# other\n");
    assert.equal(resolveSpecFile(dir), join(dir, "SPEC.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSpecFile: spec.md fallback; null when absent; root only (no subdir crawl)", () => {
  const dir = mkdtempSync(join(tmpdir(), "respec-"));
  try {
    assert.equal(resolveSpecFile(dir), null);
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "SPEC.md"), "# nested\n");
    assert.equal(resolveSpecFile(dir), null, "subdirectories are never searched");
    writeFileSync(join(dir, "spec.md"), "# Spec\n");
    assert.equal(resolveSpecFile(dir), join(dir, "spec.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("respecTarget: names the spec, reads critically, rotates implement/audit", () => {
  const t = respecTarget("SPEC.md");
  assert.ok(t.includes("SPEC.md"), "names the resolved spec file");
  assert.ok(/critically/.test(t), "spec-suck protection: read critically");
  assert.ok(/never force the code to match a bad spec/.test(t), "bad-spec escape");
  assert.ok(/one iteration implements/.test(t) && /the next audits/.test(t), "implement/audit rotation");
});

test("resolveSpecFiles: returns all root specs in priority order (v0.24.4)", () => {
  const dir = mkdtempSync(join(tmpdir(), "respec-"));
  try {
    assert.deepEqual(resolveSpecFiles(dir), []);
    writeFileSync(join(dir, "spec.md"), "# a\n");
    assert.deepEqual(resolveSpecFiles(dir), [join(dir, "spec.md")]);
    writeFileSync(join(dir, "SPEC.md"), "# b\n");
    assert.deepEqual(resolveSpecFiles(dir), [join(dir, "SPEC.md"), join(dir, "spec.md")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- v0.25.1: toolsamerepeat= kwarg (stuck-detection rework item 8) ----

test("parseLoopStartArgs: toolsamerepeat=N parses; 0 disables the legacy check", () => {
  const a = parseLoopStartArgs('"polish the UI" measure="echo 1" direction=min toolsamerepeat=0');
  assert.equal(a.toolSameRepeat, 0);
  const b = parseLoopStartArgs('"polish the UI" measure="echo 1" direction=min toolsamerepeat=7');
  assert.equal(b.toolSameRepeat, 7);
  // Absent = default (undefined → REPETITION.toolResultRepeat downstream):
  const c = parseLoopStartArgs('"polish the UI" measure="echo 1" direction=min');
  assert.equal(c.toolSameRepeat, undefined);
  // Non-numeric garbage degrades to default, never throws:
  const d = parseLoopStartArgs('"polish the UI" measure="echo 1" direction=min toolsamerepeat=abc');
  assert.equal(d.toolSameRepeat, undefined);
});

test("v0.29.0: /loop audit — metric loop over open findings; plateau = the well is dry", () => {
  // User design (2026-07-29): "the looper running audits to see where to
  // progress and what to fix" — the thing that fires at the end of goals
  // and lists. Unlike respec (metricless) this has an HONEST metric: the
  // orchestrator counts open findings, so the plateau stop terminates it.
  const SRC = readFileSync("extensions/goal-loop.ts", "utf-8");
  const GOAL = readGoalRuntimeSource();
  assert.match(SRC, /if \(sub === "audit"\) \{/);
  assert.match(SRC, /target: auditTarget\(\),\s*\n\s*measureCmd: auditMeasureCmd\(\),\s*\n\s*direction: "max",/);
  // v0.35.0: no stacking over an active goal or loop is silent; the shared
  // activation path offers update / replace / cancel after the loop spec is
  // confirmed.
  assert.match(SRC, /resolveLoopStartConflict\(ctx, cfg\.target\)/);
  assert.match(SRC, /chooseObjectiveConflict/);
  // drain suggestion (suggestion, not auto-start — consent per v0.28.28):
  assert.match(GOAL, /List complete\. \/loop audit to sweep the project for the next batch of work\./);
  // the measure is orchestrator-counted and single-number in all file states:
  const F = readFileSync("extensions/goal-loop-forever.ts", "utf-8");
  assert.match(F, /export const AUDIT_FINDINGS_REL = "\.pi-glla\/audit-loop\/findings\.md";/);
  assert.match(F, /export function auditMeasureCmd\(\): string/);
  assert.match(F, /export function auditTarget\(\): string/);
  const measureCmd = auditMeasureCmd();
  assert.ok(measureCmd.includes("grep -cE '^- \\[[xX]\\] FIX' .pi-glla/audit-loop/findings.md"), measureCmd);
  assert.ok(measureCmd.includes("echo ${c:-0}"), measureCmd);
  // the target carries the honesty laws:
  const t = auditTarget();
  assert.match(t, /Append every NEW finding as one checkbox line/);
  assert.match(t, /never delete, rewrite, or reorder existing lines/);
  assert.match(t, /never fabricate findings to look busy/);
  assert.match(t, /never mark a finding fixed without the fix commit existing/);
  assert.match(t, /plateau stop ends the loop when the well is dry/);
  // v0.29.18: FIX-FIRST — the backlog drains before new hunting (hegemon
  // iter 26: discovery 8-12/iter vs fixes 1/iter + "no new action" turns
  // with 18 open boxes). Fix is step 1; re-audit runs on cadence only;
  // a zero-closure iteration with open boxes is explicitly unacceptable.
  assert.match(t, /FIX-FIRST: the open backlog comes down before new hunting/);
  assert.match(t, /Every iteration: \(1\) FIX the highest-severity OPEN finding/);
  assert.match(t, /RE-AUDIT on cadence, not every iteration/);
  assert.match(t, /ONLY when no OPEN findings remain, when roughly ten iterations have passed/);
  assert.match(t, /"no new action this turn" is never an acceptable iteration while open boxes exist/);
  // the old audit-every-iteration template is gone:
  assert.ok(!t.includes("Every iteration: (1) run a FRESH audit pass"), "old template superseded");
  // live-loop migration pins (goal.ts — session-load path stays there):
  assert.match(GOAL, /audit_loop_target_migrated/);
  assert.match(GOAL, /state\.loop\?\.kind === "audit" && state\.loop\.target\?\.includes\("Every iteration: \(1\) run a FRESH audit pass"\)/);
  // reviewer: fire-audit-on-clean is OPT-IN, not default (the auditor already
  // verified the work — a reflexive re-scan pays for verification twice):
  const R = readFileSync("extensions/reviewer.ts", "utf-8");
  const defaultIdx = R.indexOf("export const DEFAULT_REVIEWER_CONFIG");
  const defaultBlock = R.slice(defaultIdx, defaultIdx + 900);
  assert.match(defaultBlock, /cascade: \["convert-findings-to-list", "queue-leftovers", "notify-and-idle"\]/);
  assert.doesNotMatch(defaultBlock, /fire-audit-on-clean/);
});

// ---- v0.35.4: findings-file counting + parse regression ----

test("v0.35.4: auditMeasureCmd counts closed FIX findings only (DECIDED/DEFERRED excluded)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "glla-measure-"));
  try {
    mkdirSync(join(cwd, ".pi-glla/audit-loop"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi-glla/audit-loop/findings.md"),
      [
        "# findings",
        "- [ ] FIX: LOW: open one",
        "- [x] FIX: MEDIUM: closed fix one — fixed in abc123",
        "- [x] FIX: LOW: closed fix two — fixed in def456",
        "- [x] DECIDED: a direction call was resolved (2026-08-11)",
        "- [x] DEFERRED: a direction call was parked (2026-08-11)",
        "- [?] DECIDE: still-open question",
      ].join("\n") + "\n",
    );
    const out = runIn(cwd, auditMeasureCmd());
    assert.equal(out, "2", "only the two closed FIX boxes count");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("v0.35.4: countOpenAuditFindings/topOpenAuditFinding tolerate aligned open boxes", () => {
  const cwd = mkdtempSync(join(tmpdir(), "glla-open-"));
  try {
    mkdirSync(join(cwd, ".pi-glla/audit-loop"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi-glla/audit-loop/findings.md"),
      [
        "# findings",
        "- [ ] FIX: LOW: normal box",
        "- [  ] FIX: MEDIUM: aligned two-space box",
        "- [	] FIX: HIGH: tab box",
        "- [x] FIX: MEDIUM: closed one — fixed in aa11", 
      ].join("\n") + "\n",
    );
    assert.equal(countOpenAuditFindings(cwd), 3, "all three open box shapes count");
    const top = topOpenAuditFinding(cwd);
    assert.equal(top, "FIX: LOW: normal box", "top open finding is the first box line");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("v0.35.4: parseLoopStartArgs keeps =-bearing text inside quotes and restores unknown keys", () => {
  const quoted = parseLoopStartArgs('"make a=b work" measure="echo 1" direction=min');
  assert.equal(quoted.target, "make a=b work", "an = pair inside the quoted target is not consumed as a key");
  assert.equal(quoted.measureCmd, "echo 1");
  assert.equal(quoted.direction, "min");
  const unknown = parseLoopStartArgs('fix x=y measure="echo 1" direction=min');
  assert.equal(unknown.target, "fix x=y", "an unknown key stays in the target instead of vanishing");
  assert.equal(unknown.direction, "min");
  // known keys are still consumed anywhere outside quotes:
  const mixed = parseLoopStartArgs('make b=c and d=e work measure="echo 1" direction=min branch=1');
  assert.equal(mixed.target, "make b=c and d=e work", "multiple unknown = pairs stay in the target");
  assert.equal(mixed.branch, true);
  // a typo'd key no longer silently disappears from the config AND target:
  const typo = parseLoopStartArgs('t direcion=min measure="echo 1" direction=min');
  assert.equal(typo.target, "t direcion=min", "the typo is visible in the target");
  assert.equal(typo.direction, "min");
});

function runIn(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8" }).trim();
}
