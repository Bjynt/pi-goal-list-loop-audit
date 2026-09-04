// pi-goal-list-loop-audit — v0.38.13 (good completion summary)
//
// Field complaint (note.md Next, Screenshot_20260903_204003/204005): the
// `✓ done:` notify mashed all six labels into one line with each value
// hard-sliced mid-word (`0 o…`, `qu…`, `belo…`) — and repeated the agent's
// prose paragraph above it. The chat notify now carries one `Label: value`
// line per label with word-boundary cuts; the single-line projection stays
// for width-bound surfaces (TUI widget, external notifies) but also cuts
// at word boundaries from here on.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import {
  clipSummaryValue,
  compactCompletionSummary,
  completionSummaryLines,
  terminalCompletionSummaryLines,
} from "../extensions/completion-summary.js";
import { seedGoal } from "./harness/mock-pi.js";

const SIX = [
  "Outcome: shipped the thing",
  "Changed: extensions/example.ts",
  "Evidence: commit abc123",
  "Tests: bun test — pass",
  "Unresolved: none",
  "Next: follow-ups below",
].join("\n");

test("clip cuts at a word boundary, never mid-word", () => {
  assert.equal(clipSummaryValue("alpha beta gamma delta", 12), "alpha beta…");
  assert.equal(clipSummaryValue("alpha beta gamma delta", 11), "alpha beta…");
  assert.equal(clipSummaryValue("short", 24), "short", "short values pass through with no ellipsis");
  assert.equal(clipSummaryValue("  padded   value  ", 24), "padded value", "whitespace collapses first");
});

test("clip hard-cuts only long tokens without spaces", () => {
  const hash = "f5466da30d1c59ff1af1234567890abcdef12345678";
  const clipped = clipSummaryValue(`evidence ${hash} on main`, 24);
  assert.ok(clipped.endsWith("…"), "still bounded");
  assert.ok(clipped.length <= 24, "still within budget");
});

test("lines project one label per line, in order, word-bounded", () => {
  const lines = completionSummaryLines(SIX);
  assert.equal(lines.length, 6);
  for (const label of ["Outcome:", "Changed:", "Evidence:", "Tests:", "Unresolved:", "Next:"]) {
    assert.ok(lines.some((l) => l.startsWith(label)), `${label} heads its own line`);
  }
  assert.equal(lines[0], "Outcome: shipped the thing");
  assert.doesNotMatch(lines.join("\n"), / · /, "no single-line mash separator");
});

test("lines keep missing labels as not recorded and never mid-word cut", () => {
  const lines = completionSummaryLines("Outcome: did the work with many words beyond the small budget here");
  assert.equal(lines[1], "Changed: not recorded");
  assert.ok(lines[0]!.endsWith("…") || lines[0] === "Outcome: did the work with many words beyond the small budget here");
  if (lines[0]!.endsWith("…")) {
    assert.doesNotMatch(lines[0]!, /\S…$/, "ellipsis follows a word break, not a fragment");
  }
  const empty = completionSummaryLines(undefined);
  assert.equal(empty.length, 6);
  assert.ok(empty.every((l) => l.endsWith("not recorded")), "empty source keeps every label");
});

test("compact stays one line but cuts at word boundaries now", () => {
  const compact = compactCompletionSummary([
    "Outcome: alpha beta gamma delta epsilon",
    "Changed: extensions/example.ts",
    "Evidence: commit abc123",
    "Tests: bun test — pass",
    "Unresolved: none",
    "Next: none",
  ].join("\n"), 24);
  assert.ok(!compact.includes("\n"), "single-line contract holds for the widget/external surfaces");
  assert.ok(compact.includes("alpha beta gamma delta…"), "cut fills the budget then lands on the word break");
  assert.ok(!compact.includes("epsilon…") && !compact.includes("epsi…"), "the tail is cut, never mid-word");
});

test("terminal lines resolve through the same facts as the compact recap", () => {
  const lines = terminalCompletionSummaryLines({
    goal: seedGoal({
      status: "active",
      objective: "terminal lines projection",
      completionSummary: SIX,
    }) as any,
    status: "complete",
    stopReason: "auditor approved",
    archivePath: ".pi-glla/archive/terminal-lines.md",
  });
  assert.equal(lines.length, 6);
  assert.equal(lines[0], "Outcome: shipped the thing");
  assert.equal(lines[5], "Next: follow-ups below");
});

test("the ✓ done chat notifies use the line block; external keeps the single line", () => {
  const hooks = fs.readFileSync("extensions/loops/goal-auditor-hooks.ts", "utf8");
  assert.match(hooks, /terminalCompletionSummaryLines\(/);
  assert.match(hooks, /✓ done — auditor /);
  assert.match(hooks, /recapLines\.join\("\\n"\)/);
  const tools = fs.readFileSync("extensions/loops/goal-tools.ts", "utf8");
  assert.equal(tools.match(/terminalCompletionSummaryLines\(/g)?.length ?? 0, 2, "both tool ✓ done paths use the block");
  assert.match(tools, /notifyExternal\(ctx, `Goal complete \(auditor approved\): \$\{recap\}`\)/, "external notify keeps the compact line");
});
