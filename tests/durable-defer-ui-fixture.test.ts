import assert from "node:assert/strict";
import { test } from "node:test";

import { buildWidgetLines } from "../extensions/goal-loop-display.ts";
import type { Goal, State } from "../extensions/goal-loop-core.ts";

const NOW = Date.parse("2026-08-29T23:00:00Z");

function goal(): Goal {
  return {
    id: "20260829230000-durable",
    objective: "Keep the durable recommendation visible in the goal card",
    status: "active",
    policy: "goal",
    autoContinue: true,
    usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: "2026-08-29T22:59:00Z",
    updatedAt: "2026-08-29T22:59:00Z",
  };
}

test("deterministic goal-card fixture keeps the durable plaque first after three defers", () => {
  const state: State = { goal: goal(), list: [] };
  const lines = buildWidgetLines(
    state,
    null,
    NOW,
    undefined,
    140,
    {
      durableDeferRecommendation: {
        durableFix: "pin plaque ordering",
        deferRecommendations: [
          "defer until the next pass",
          "use a cosmetic workaround",
          "wait for another review",
        ],
      },
    },
  )!;
  const rendered = lines.join("\n");
  const durableIndex = lines.findIndex((line) => line.includes("1. Durable fix"));
  const deferIndex = lines.findIndex((line) => line.includes("2. Defer / workaround"));
  const selectedIndex = lines.findIndex((line) => line.includes("selected: inline (durable fix)"));

  assert.ok(durableIndex >= 0, `durable plaque missing:\n${rendered}`);
  assert.ok(deferIndex >= 0, `defer plaque missing:\n${rendered}`);
  assert.ok(selectedIndex >= 0, `selection missing:\n${rendered}`);
  assert.ok(durableIndex < deferIndex, `durable plaque must render before defer:\n${rendered}`);
  assert.ok(durableIndex < selectedIndex, `durable recommendation must not be presented after defer choices:\n${rendered}`);
  assert.match(lines[durableIndex]!, /recommended/);
  assert.doesNotMatch(lines[deferIndex]!, /recommended/);
  assert.match(rendered, /judgment: 3 prior defer recommendations · durable action evaluated first/);
});
