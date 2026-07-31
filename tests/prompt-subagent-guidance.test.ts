// pi-goal-list-loop-audit — v0.25.0
// tests/prompt-subagent-guidance.test.ts
//
// Eager-continuation contract item 4: all four agent-facing prompts lead
// with subagent guidance — the phrases the fan-out behavior depends on.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const PROMPTS = [
  "goal-loop-continuation.md",
  "goal-loop-draft.md",
  "goal-loop-forever.md",
  "goal-loop-forever-metricless.md",
];

import { listAuditCollectTarget, projectAuditTarget } from "../extensions/goal-loop-forever.ts";

function readPrompt(name: string): string {
  return fs.readFileSync(path.resolve("prompts", name), "utf-8");
}

const FOREVER_SRC = fs.readFileSync(path.resolve("extensions/goal-loop-forever.ts"), "utf-8");

for (const name of PROMPTS) {
  test(`${name}: contains subagent fan-out guidance (item 4)`, () => {
    const p = readPrompt(name);
    assert.match(p, /Agent/, `${name} mentions the Agent tool`);
    assert.ok(
      /Default to subagents|in parallel|parallel/i.test(p),
      `${name} says "Default to subagents" or "parallel"`,
    );
    assert.ok(
      /Eager continuation|just continue/i.test(p),
      `${name} says "Eager continuation" or "just continue"`,
    );
    assert.match(p, /Explore/, `${name} names the Explore agent`);
    assert.ok(/general-purpose|Plan/.test(p), `${name} names general-purpose or Plan`);
  });
}

// ---------- v0.34.0: eager parallelism with ROI ----------

test("v0.34.0: continuation prompt — parallel execution with ROI guardrails", () => {
  const c = readPrompt("goal-loop-continuation.md");
  assert.match(c, /Parallel execution, with ROI/, "the framing: parallelism that pays, not ceremony");
  assert.match(c, /if you can do it faster inline, do it inline/, "ROI guardrail against ceremony spawning");
  assert.match(c, /DISJOINT file footprints/, "parallel implementation requires disjoint chunks");
  assert.match(c, /isolation: "worktree"/, "delegated implementation runs in worktrees");
  assert.match(c, /you own the final tree/, "the main session lands the merges");
  assert.match(c, /BLOCKERS:/, "blocker channel");
  assert.match(c, /untrusted/, "subagent output is untrusted input");
  assert.match(c, /Settle before completing/, "no complete_goal with open background agents");
  assert.match(c, /Auditor rehearsal/, "rehearse the contract before completing");
});

test("v0.34.0: forever prompts carry the ROI law + untrusted-output hygiene", () => {
  for (const f of ["prompts/goal-loop-forever.md", "prompts/goal-loop-forever-metricless.md"]) {
    const c = readPrompt(f.replace("prompts/", ""));
    assert.match(c, /ROI law: subagents pay when they parallelize or protect context/, f);
    assert.match(c, /never spawn\s*one for work you can do faster inline|never spawn one for work you can do faster inline/, f);
    assert.match(c, /untrusted/, f);
  }
});

test("v0.34.0: audit templates demand the parallel fan-out shape (both)", () => {
  assert.match(FOREVER_SRC, /spawn AT LEAST 3 Explore subagents in ONE message, one per subsystem, so the survey runs in parallel/);
  const collect = listAuditCollectTarget("x");
  const oneshot = projectAuditTarget("x");
  for (const [name, t] of [["collect", collect], ["oneshot", oneshot]] as const) {
    assert.match(t, /AT LEAST 3 Explore subagents in ONE message/, name);
  }
});

test("v0.34.0: divergence bail — 3+ trailing regressions append a reassessment note", () => {
  const g = fs.readFileSync(path.resolve("extensions/loops/goal.ts"), "utf-8");
  assert.match(g, /let trailingRegressions = 0;/);
  assert.match(g, /trailingRegressions >= 3/, "bail threshold");
  assert.match(g, /consecutive regressions — every recent change moved the metric the WRONG way/);
  assert.match(g, /if \(a === null \|\| b === null\) break;/, "metricless ticks carry no value — the walk stops");
  assert.match(g, /strategyNote2 = strategyNote/, "note rides the strategy channel (note-only, nothing auto-stops)");
});
