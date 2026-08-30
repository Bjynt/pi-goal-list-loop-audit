import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd } from "./harness/mock-pi.js";

test("production record_goal_judgment persists facts and refreshUI renders durable first", async () => {
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ id: "durable-production-ui", status: "active", autoContinue: false }),
  });
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "durable-production-ui" } });
  await pi.fire("session_start", { reason: "startup" }, ctx);

  const result = await pi.runTool("record_goal_judgment", {
    choice: "inline",
    reason: "The durable root-cause fix is safe to ship now.",
    durableFix: "pin plaque ordering",
    deferRecommendations: [
      "defer until the next pass",
      "use a cosmetic workaround",
      "wait for another review",
    ],
    durableBlocked: false,
  }, ctx);
  assert.match(result.content[0]?.text ?? "", /Recorded durable-vs-defer judgment: inline/);

  const persisted = readState(cwd).goal?.durableDeferRecommendation;
  assert.deepEqual(persisted, {
    durableFix: "pin plaque ordering",
    deferRecommendations: [
      "defer until the next pass",
      "use a cosmetic workaround",
      "wait for another review",
    ],
    durableBlocked: false,
  });

  const lines = ctx.ui.widgets["pi-glla"] as string[] | undefined;
  assert.ok(lines, "record_goal_judgment must repaint the production widget");
  const rendered = lines.join("\n");
  const durableIndex = lines.findIndex((line) => line.includes("1. Durable fix"));
  const deferIndex = lines.findIndex((line) => line.includes("2. Defer / workaround"));
  assert.ok(durableIndex >= 0, `durable plaque missing:\n${rendered}`);
  assert.ok(deferIndex >= 0, `defer plaque missing:\n${rendered}`);
  assert.ok(durableIndex < deferIndex, `durable plaque must render first:\n${rendered}`);
  assert.match(lines[durableIndex]!, /recommended/);
  assert.match(rendered, /selected: inline \(durable fix\)/);

  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.match(ledger, /"type":"durable_defer_choice"/);
  assert.match(ledger, /"durableDeferRecommendation":\{"durableFix":"pin plaque ordering"/);

  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});
