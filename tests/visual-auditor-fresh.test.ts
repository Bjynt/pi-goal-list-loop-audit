/**
 * pi-goal-list-loop-audit — v0.36.x
 * Visual auditor fresh pictures — prompt injection before verdict
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { buildGoalAuditorPrompt, isVisualGoal } from "../extensions/goal-loop-auditor.js";

function seedGoal(overrides: Record<string, unknown> = {}): any {
  return {
    id: "visual-test",
    objective: overrides.objective ?? "test objective — done when pinned",
    verificationContract: overrides.verificationContract ?? "",
    status: "active",
    policy: "goal",
    filePath: "test.md",
    auditHistory: [],
    ...overrides,
  };
}

test("isVisualGoal detects UI/screenshot/visual goals", () => {
  assert.equal(isVisualGoal(seedGoal({ objective: "Make visual auditor take fresh pictures for visual goals" })), true);
  assert.equal(isVisualGoal(seedGoal({ objective: "Fix screenshot rendering bug in the dashboard page" })), true);
  assert.equal(isVisualGoal(seedGoal({ objective: "UI audit of the studio page — check image alignment" })), true);
  assert.equal(isVisualGoal(seedGoal({ objective: "Fix chrome extension host boundary", verificationContract: "capture fresh screenshot via mmx/chrome" })), true);
  assert.equal(isVisualGoal(seedGoal({ objective: "Fix loop measure regression", verificationContract: "measure returns correct value" })), false);
  assert.equal(isVisualGoal(seedGoal({ objective: "Proactive evidence gathering before draft" })), false);
});

test("visual auditor prompt injects fresh mmx/chrome capture before verdict", () => {
  const visual = seedGoal({
    objective: "Make visual auditor take fresh pictures for visual goals — currently visual problems pass through because auditor reuses old evidence",
    verificationContract: "for goals touching UI/screenshots, auditor captures a fresh screenshot via mmx/chrome, critiques it, and feeds the critique back into the audit verdict, with a test or fixture pinning the path.",
  });
  const prompt = buildGoalAuditorPrompt(visual, "completion", "verification");
  assert.match(prompt, /VISUAL AUDIT — FRESH EVIDENCE REQUIRED/, "header injected");
  assert.match(prompt, /mmx vision describe --image/, "fresh mmx command present");
  assert.match(prompt, /chrome screenshot/, "chrome alternative present");
  assert.match(prompt, /critique what is shown versus the objective/, "critique instruction");
  assert.match(prompt, /Do NOT reuse stale image descriptions/, "stale reuse blocked");
  assert.match(prompt, /<evidence>/, "evidence section still required");
});

test("non-visual goals keep the original prompt without fresh capture", () => {
  const nonVisual = seedGoal({
    objective: "Triage the loadable Explore child-session path",
    verificationContract: "bounded reproduction, no model switch",
  });
  const prompt = buildGoalAuditorPrompt(nonVisual, "completion", "verification");
  assert.doesNotMatch(prompt, /VISUAL AUDIT — FRESH EVIDENCE REQUIRED/);
  assert.doesNotMatch(prompt, /FRESH screenshot via/);
  // Original contract still enforced
  assert.match(prompt, /You are the independent completion auditor/);
});

test("visual prompt fixture pins the exact mmx command shape", () => {
  const g = seedGoal({ objective: "Screenshot regression in the studio — visual check", verificationContract: "screenshot" });
  const p = buildGoalAuditorPrompt(g, null, null);
  // Pin the exact flag set the executor's vision-assist skill uses.
  assert.match(p, /mmx vision describe --image <path> --quiet --non-interactive/);
  assert.match(p, /Example:.*mmx vision describe --image/);
});
