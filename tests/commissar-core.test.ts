// Tests for the commissar core module (extensions/goal-commissar.ts):
// - parseCommissarVerdict: <adherent/> / <wanting>reason</wanting> final-line gate
// - buildCommissarPrompt: role framing, verdict contract, goal + evidence blocks
// Real modules, no copies (v0.23.7).

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Goal } from "../extensions/goal-loop-core.ts";
import {
  parseCommissarVerdict,
  buildCommissarPrompt,
} from "../extensions/goal-commissar.ts";

function activeGoal(): Goal {
  return {
    id: "20260823170000-comm1",
    objective: "Ship the commissar watchdog feature",
    status: "active",
    policy: "goal",
    autoContinue: true,
    verificationContract: "bun test tests/commissar-core.test.ts green",
    usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: "2026-08-23T17:00:00Z",
    updatedAt: "2026-08-23T17:10:00Z",
  };
}

// ---- parseCommissarVerdict ----

test("parseCommissarVerdict: adherent", () => {
  const r = parseCommissarVerdict(
    "Evidence shows steady commits toward the objective.\n\n<adherent/>",
  );
  assert.deepEqual(r, { adherent: true, wanting: false, reason: undefined });
});

test("parseCommissarVerdict: wanting with reason", () => {
  const r = parseCommissarVerdict(
    "Ledger shows 9 stalled turns.\n<wanting>no progress for 9 consecutive turns</wanting>",
  );
  assert.deepEqual(r, {
    adherent: false,
    wanting: true,
    reason: "no progress for 9 consecutive turns",
  });
});

test("parseCommissarVerdict: no marker in body is not a verdict (final-line gate)", () => {
  const r = parseCommissarVerdict(
    "<wanting>drafted in prose</wanting>\n\nThe report continues after a stray marker.",
  );
  assert.equal(r.wanting, false);
  assert.equal(r.adherent, false);
});

test("parseCommissarVerdict: literal-\\n wire normalization", () => {
  const r = parseCommissarVerdict(
    "report body\\n<wanting>drifted out of scope</wanting>",
  );
  assert.equal(r.wanting, true);
  assert.equal(r.reason, "drifted out of scope");
});

test("parseCommissarVerdict: empty output has no verdict", () => {
  const r = parseCommissarVerdict("");
  assert.deepEqual(r, { adherent: false, wanting: false, reason: undefined });
});

test("parseCommissarVerdict: wanting without reason yields undefined reason", () => {
  const r = parseCommissarVerdict("<wanting></wanting>");
  assert.equal(r.wanting, true);
  assert.equal(r.reason, undefined);
});

test("parseCommissarVerdict: long reasons are capped at 300 chars", () => {
  const r = parseCommissarVerdict(`<wanting>${"x".repeat(400)}</wanting>`);
  assert.equal(r.reason?.length, 300);
});

// ---- buildCommissarPrompt ----

test("commissar prompt frames a watchdog, not a completion auditor", () => {
  const prompt = buildCommissarPrompt(activeGoal());
  assert.match(prompt, /adherence commissar/);
  assert.match(prompt, /NOT judging whether the goal is finished/);
  // Verdict vocabulary is the commissar's own, not the auditor's.
  assert.doesNotMatch(prompt, /<approved\/>|<disapproved\/>|<impossible>/);
  assert.match(prompt, /<adherent\/>/);
  assert.match(prompt, /<wanting>/);
});

test("commissar prompt embeds the goal markdown and evidence-free default", () => {
  const goal = activeGoal();
  const prompt = buildCommissarPrompt(goal, null);
  assert.match(prompt, /<goal>/);
  assert.match(
    prompt,
    new RegExp(goal.objective.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.ok(
    !prompt.includes("<evidence>"),
    "no empty evidence block when digest absent",
  );
});

test("commissar prompt carries the orchestrator evidence digest with cross-check warning", () => {
  const prompt = buildCommissarPrompt(
    activeGoal(),
    "last 3 turns produced no tool calls",
  );
  assert.match(prompt, /<evidence>/);
  assert.match(prompt, /last 3 turns produced no tool calls/);
  assert.match(prompt, /cross-check it against the raw ledger/);
});

test("commissar prompt mandates read-only inspection and ledger sources", () => {
  const prompt = buildCommissarPrompt(activeGoal());
  assert.match(
    prompt,
    /Do not mutate files or run destructive\/state-changing commands/,
  );
  assert.match(prompt, /\.pi-glla\/active\.jsonl/);
});

// ---- v0.37.0 loop-mode prompt ----

import { buildCommissarLoopPrompt } from "../extensions/goal-commissar.ts";

test("loop commissar prompt frames the watchdog around honest iteration", () => {
  const p = buildCommissarLoopPrompt({
    target: "cut benchmark p99",
    measureCmd: "bun bench",
    direction: "min",
    iteration: 7,
    maxIterations: 50,
    stallCount: 2,
    plateauWindow: 5,
    bestValue: 120,
    lastValue: 131,
    history: [
      { iteration: 6, value: 128, improved: true },
      { iteration: 7, value: 131, improved: false },
    ],
  });
  assert.match(p, /adherence commissar/);
  assert.match(p, /NOT judging whether the target is fully achieved/);
  assert.match(p, /fabricate\/ignore its output/, "measure fabrication is WANTING");
  assert.match(p, /Editing the measure, bounds, or ledger/, "gaming the metric is WANTING");
  assert.match(p, /<adherent\/>/);
  assert.match(p, /<wanting>one-line reason<\/wanting>/);
});

test("loop commissar prompt embeds loop state and measured trajectory", () => {
  const p = buildCommissarLoopPrompt({
    target: "cut benchmark p99",
    measureCmd: "bun bench",
    direction: "min",
    iteration: 7,
    maxIterations: 50,
    stallCount: 2,
    plateauWindow: 5,
    bestValue: 120,
    lastValue: 131,
    history: [
      { iteration: 6, value: 128, improved: true },
      { iteration: 7, value: 131, improved: false },
    ],
  }, "recent ledger digest line");
  assert.match(p, /"target": "cut benchmark p99"/);
  assert.match(p, /"measureCmd": "bun bench"/);
  assert.match(p, /iter 6: value=128 improved=true/);
  assert.match(p, /iter 7: value=131 improved=false/);
  assert.match(p, /<evidence>\nrecent ledger digest line\n<\/evidence>/);
  assert.match(p, /cross-check it against the raw ledger/);
});

test("loop commissar prompt tolerates an unmeasured fresh loop", () => {
  const p = buildCommissarLoopPrompt({ target: "brand-new loop" });
  assert.match(p, /\(no measured iterations yet\)/);
  assert.match(p, /"bestValue": null/);
});
