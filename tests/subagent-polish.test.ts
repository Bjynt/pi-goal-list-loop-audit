// pi-goal-list-loop-audit — current pi-subagents integration polish

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildAgentOverrideMd,
  resolveEffectiveSubagentModel,
  syncSubagentModelOverrides,
  OVERRIDABLE_AGENT_TYPES,
} from "../extensions/goal-loop-subagents.ts";
import { isSubagentProviderFailure } from "../extensions/quota-retry.ts";

test("current pi-subagents roles expose complete model-pin definitions", () => {
  assert.deepEqual([...OVERRIDABLE_AGENT_TYPES].sort(), ["Designer", "delegate", "oracle", "researcher", "reviewer", "scout", "worker"]);
  const worker = buildAgentOverrideMd("worker", "minimax/MiniMax-M3");
  assert.match(worker, /model: minimax\/MiniMax-M3/);
  assert.match(worker, /systemPromptMode: replace/);
  assert.match(worker, /defaultContext: fork/);
  assert.match(worker, /x-managed-by: pi-goal-list-loop-audit/);
});

test("strategy-driven sync writes only the GLLA-owned Designer role", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-subagent-"));
  const sync = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent", overrides: {} });
  assert.deepEqual(sync.written, ["Designer"]);
  assert.ok(fs.existsSync(path.join(dir, "agents", "Designer.md")));
  assert.ok(!fs.existsSync(path.join(dir, "agents", "scout.md")), "scout already inherits the parent in current pi-subagents");
  const sync2 = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent", overrides: { scout: "minimax/MiniMax-M3" } });
  assert.deepEqual(sync2.written, ["scout"]);
  assert.match(fs.readFileSync(path.join(dir, "agents", "scout.md"), "utf-8"), /model: minimax\/MiniMax-M3/);
});

test("repair detection: externally deleted/altered Designer files are re-written and flagged", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-subagent-repair-"));
  const first = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent", overrides: {} });
  assert.deepEqual(first.written, ["Designer"]);
  assert.deepEqual(first.repaired, []);
  const noop = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent", overrides: {} });
  assert.deepEqual(noop.written, []);
  const syncState = JSON.parse(fs.readFileSync(path.join(dir, "agents", ".glla-subagent-sync.json"), "utf8"));
  assert.deepEqual(syncState.written, ["Designer"]);
  fs.unlinkSync(path.join(dir, "agents", "Designer.md"));
  const second = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent", overrides: {} });
  assert.deepEqual(second.written, ["Designer"]);
  assert.deepEqual(second.repaired, ["Designer"]);
  fs.appendFileSync(path.join(dir, "agents", "Designer.md"), "\n# user scribble\n");
  const third = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent", overrides: {} });
  assert.deepEqual(third.repaired, ["Designer"]);
});

test("effective resolution: per-type pin > inherit-parent > current agent default", () => {
  assert.equal(
    resolveEffectiveSubagentModel("worker", { subagentModelOverrides: { worker: "x/y" } }, "p/s"),
    "x/y (per-type pin)",
  );
  assert.equal(
    resolveEffectiveSubagentModel("worker", { subagentModelStrategy: "inherit-parent" }, "p/s"),
    "p/s (inherits session)",
  );
  assert.equal(
    resolveEffectiveSubagentModel("scout", { subagentModelStrategy: "agent-default" }),
    "(agent default)",
  );
});

test("subagent provider failure: any failed Agent payload, without classification", () => {
  assert.equal(isSubagentProviderFailure("Agent", true, "Error: 403 Key limit exceeded"), true);
  assert.equal(isSubagentProviderFailure("Agent", true, JSON.stringify({ error: "429 rate limit" })), true);
  assert.equal(isSubagentProviderFailure("Agent", true, "file not found"), true);
  assert.equal(isSubagentProviderFailure("Agent", false, "403 Key limit exceeded"), false);
  assert.equal(isSubagentProviderFailure("bash", true, "403 Key limit exceeded"), false);
});
