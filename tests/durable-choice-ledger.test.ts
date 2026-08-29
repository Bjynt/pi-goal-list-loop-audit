import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import activate from "../extensions/loops/goal.js";
import { buildDurableChoiceRecord } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd } from "./harness/mock-pi.js";

function readLedger(cwd: string): Array<{ type: string; value?: Record<string, unknown> }> {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; value?: Record<string, unknown> });
}

test("durable-vs-defer judgment is an explicit bounded ledger choice", async () => {
  const pi = new MockPi();
  activate(pi.api);
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ id: "durable-choice-test", status: "active", autoContinue: false }),
  });
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "durable-choice-test" } });
  await pi.fire("session_start", { reason: "test" }, ctx);

  const inline = await pi.runTool("record_goal_judgment", {
    choice: "inline",
    reason: "The root-cause fix is safe and keeps the confirmed contract intact.",
  }, ctx);
  assert.match(inline.content[0]?.text ?? "", /Recorded durable-vs-defer judgment: inline/);

  const rejected = await pi.runTool("record_goal_judgment", {
    choice: "deferred",
    reason: "The durable migration is blocked by a missing external permission.",
  }, ctx);
  assert.match(rejected.content[0]?.text ?? "", /requires a durable follow-up/);

  const deferred = await pi.runTool("record_goal_judgment", {
    choice: "deferred",
    reason: "The durable migration is blocked by a missing external permission.",
    followUp: "Retry after the permission is granted; do not treat the workaround as final.",
  }, ctx);
  assert.match(deferred.content[0]?.text ?? "", /Recorded durable-vs-defer judgment: deferred/);

  const choices = readLedger(cwd).filter((entry) => entry.type === "durable_defer_choice");
  assert.equal(choices.length, 2);
  assert.deepEqual(choices.map((entry) => entry.value?.choice), ["inline", "deferred"]);
  assert.equal(choices[0]?.value?.goalId, "durable-choice-test");
  assert.equal(choices[1]?.value?.followUp, "Retry after the permission is granted; do not treat the workaround as final.");
});

test("durable-choice payload compacts model-authored rationale", () => {
  const record = buildDurableChoiceRecord("inline", "  root-cause\n  fix  ", "  keep\n  the follow-up bounded  ");
  assert.deepEqual(record, {
    choice: "inline",
    reason: "root-cause fix",
    followUp: "keep the follow-up bounded",
  });
  assert.equal(buildDurableChoiceRecord("deferred", "   ").reason, "");
});
