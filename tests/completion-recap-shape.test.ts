import { test } from "node:test";
import * as assert from "node:assert/strict";

import { renderGoalMarkdown, type Goal } from "../extensions/goal-loop-core.ts";
import { buildWidgetLines } from "../extensions/goal-loop-display.ts";

const NOW = Date.parse("2026-08-19T05:20:00Z");

const RECAP = [
  "Outcome: Shipped the completion-summary policy review.",
  "Changed: Added audit/COMPLETION-SUMMARY-POLICY-2026-08-19.md.",
  "Evidence: Focused source review and the policy artifact.",
  "Tests: bun test tests/goal-loop-core.test.ts — 52 passed, 0 failed.",
  "Unresolved: No source fix is supported by the current evidence.",
  "Next: Apply the template to future completion claims.",
].join("\n");

function completedGoal(): Goal {
  return {
    id: "20260819052000-recap1",
    objective: "Define a useful structured end-of-goal summary",
    status: "complete",
    policy: "list",
    autoContinue: true,
    completionSummary: RECAP,
    usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: "2026-08-19T05:00:00Z",
    updatedAt: "2026-08-19T05:20:00Z",
  };
}

test("structured completion recap survives archive rendering and the terminal widget", () => {
  const goal = completedGoal();
  const archived = renderGoalMarkdown(goal);

  assert.match(archived, /^## Completion summary$/m);
  for (const label of ["Outcome", "Changed", "Evidence", "Tests", "Unresolved", "Next"]) {
    assert.match(archived, new RegExp(`^${label}: .+`, "m"), `${label} remains in the archived recap`);
  }

  const widget = buildWidgetLines(
    { goal, list: [] },
    null,
    NOW,
    undefined,
    600,
  );
  assert.ok(widget);
  assert.equal(widget.length, 1, "the compact terminal surface remains one line");
  for (const label of ["Outcome", "Changed", "Evidence", "Tests", "Unresolved", "Next"]) {
    assert.match(widget[0]!, new RegExp(`${label}:`), `${label} remains visible in a wide recap projection`);
  }
  assert.match(widget[0]!, /✓ done/);
  assert.match(widget[0]!, /took 20m/);
});
