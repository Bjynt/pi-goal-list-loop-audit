// pi-goal-list-loop-audit — v0.35.33
// tests/plan-mode.test.ts
//
// note.md Now item (2026-08-22): the spec-based strategy is double truth —
// the spec always goes stale next to the code. The user's pivot: keep the
// regular draft as the fast path, and add PLAN MODE verbs (`/goal plan`,
// `/list plan`, `/loop plan`) — an EXTENDED draft for greenfield/megaplan
// work where the standard 5–7-question interview is too shallow. Research
// first, multi-round interviewing, structured expanded objective — but the
// SAME trust machinery: propose_*_draft + Confirm card still gate activation,
// and there is NO separate artifact (the objective itself is the single
// truth; depth is a prompt-level concern).
//
// respec stays untouched (user decision: "keep respec and work on it").

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { draftingTemplateFile, routeGoalArgs, LIST_MUTATING_SUBCOMMANDS } from "../extensions/goal-loop-core.js";

const ROOT = path.resolve(__dirname, "..");
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), "utf-8");

test("v0.35.33: /goal plan routes as a sub with the seed as rest", () => {
  const bare = routeGoalArgs("plan");
  assert.equal(bare.kind, "sub");
  assert.equal((bare as { name: string }).name, "plan");
  const seeded = routeGoalArgs("plan build a greenfield crawler with tests");
  assert.equal(seeded.kind, "sub");
  const r = seeded as { name: string; rest: string };
  assert.equal(r.name, "plan");
  assert.equal(r.rest, "build a greenfield crawler with tests");
});

test("v0.35.33: plain objectives are NOT captured by the plan verb", () => {
  // An objective that merely contains the word must still be a set.
  const r = routeGoalArgs("make the plan page render server-side");
  assert.equal(r.kind, "set");
  // Bare /goal (empty) is still the regular draft.
  assert.equal(routeGoalArgs("").kind, "draft");
  // Regular subs unchanged.
  assert.deepEqual(routeGoalArgs("start do it now"), { kind: "sub", name: "start", rest: "do it now" });
});

test("v0.35.33: draftingTemplateFile swaps prompts per target × depth", () => {
  assert.equal(draftingTemplateFile("goal", "normal"), "goal-loop-draft.md");
  assert.equal(draftingTemplateFile("list", "normal"), "goal-loop-draft.md");
  assert.equal(draftingTemplateFile("loop", "normal"), "goal-loop-forever-draft.md");
  assert.equal(draftingTemplateFile("goal", "plan"), "goal-loop-plan.md");
  assert.equal(draftingTemplateFile("list", "plan"), "goal-loop-plan.md");
  assert.equal(draftingTemplateFile("loop", "plan"), "goal-loop-plan-loop.md");
});

test("v0.35.33: both plan prompt files exist, carry the drafting markers, and mandate Confirm-gated proposals", () => {
  const goal = read("prompts/goal-loop-plan.md");
  assert.ok(goal.includes("[GOAL DRAFTING]"), "list replacement mechanism keys on this marker");
  assert.ok(goal.includes("propose_goal_draft"));
  assert.match(goal, /Research BEFORE questions|research the code FIRST|Read the actual code/i);
  assert.match(goal, /ROUNDS/i);
  assert.match(goal, /Confirm dialog is the ONLY activation path|nothing activates until the user confirms/i);
  assert.ok(goal.includes("Do NOT start implementing"));

  const loop = read("prompts/goal-loop-plan-loop.md");
  assert.ok(loop.includes("[LOOP DRAFTING]"));
  assert.ok(loop.includes("propose_loop_draft"));
  assert.match(loop, /ROUNDS/i);
  assert.match(loop, /Confirm dialog is the ONLY activation path/i);

  // The regular drafts ship unchanged alongside (fast path intact).
  assert.ok(fs.existsSync(path.join(ROOT, "prompts/goal-loop-draft.md")));
  assert.ok(fs.existsSync(path.join(ROOT, "prompts/goal-loop-forever-draft.md")));
});

test("v0.35.33: source pins — depth flag plumbing end to end", () => {
  const queue = read("extensions/loops/goal-list-queue.ts");
  // startDrafting takes depth and records it on the session global.
  assert.ok(queue.includes('depth: "normal" | "plan" = "normal"'), "startDrafting signature");
  assert.ok(queue.includes("draftingDepth = depth;"), "depth lands on the session global");
  assert.ok(queue.includes("draftingTemplateFile(target, depth)"), "template selection goes through the pure helper");
  assert.ok(queue.includes("DEEP PLANNING MODE"), "the user-facing hint names the mode");

  const session = read("extensions/loops/goal-session.ts");
  assert.ok(session.includes('defineGoalRuntimeGlobal("draftingDepth"'), "runtime-global registration");
  const globals = read("extensions/loops/goal-runtime-globals.ts");
  assert.ok(globals.includes("var draftingDepth: any;"), "ambient declaration");
  const ui = read("extensions/loops/goal-ui.ts");
  assert.ok(/clearDraftingState[\s\S]*?draftingDepth = "normal";/.test(ui), "clearDraftingState resets depth — no stale plan mode across sessions");
});

test("v0.35.33: source pins — all three verbs dispatch with depth plan", () => {
  const commands = read("extensions/goal-commands.ts");
  assert.ok(commands.includes('startDrafting(ctx, "goal", route.rest || undefined, "plan")'), "/goal plan");
  assert.ok(commands.includes('startDrafting(ctx, "list", rest || undefined, "plan")'), "/list plan");
  const loop = read("extensions/goal-loop.ts");
  assert.ok(loop.includes('startDrafting(ctx, "loop", rest || undefined, "plan")'), "/loop plan — before the natural-language fallthrough");
});

test("v0.35.33: /list plan is gated as a mutating subcommand on stale handles", () => {
  assert.ok(LIST_MUTATING_SUBCOMMANDS.has("plan"), "sends a seed — same mutation class as add");
});

test("v0.35.33: completions advertise the plan verb on all three commands", () => {
  const activation = read("extensions/loops/goal-activation.ts");
  const goalBlock = activation.slice(activation.indexOf('registerCommand("goal"'), activation.indexOf('registerCommand("glla"'));
  const listBlock = activation.slice(activation.indexOf('registerCommand("list"'), activation.indexOf('registerCommand("loop"'));
  const loopBlock = activation.slice(activation.indexOf('registerCommand("loop"'));
  assert.ok(/\["plan",/.test(goalBlock), "/goal completions");
  assert.ok(/\["plan",/.test(listBlock), "/list completions");
  assert.ok(/\["plan",/.test(loopBlock), "/loop completions");
});
