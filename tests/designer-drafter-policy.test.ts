import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildSeedGrillMessage,
  buildTaskList,
  extractAgentRole,
  findNextPendingTask,
  LONG_RUNNING_JUDGMENT_POLICY,
  parseListItemDeclaration,
} from "../extensions/goal-loop-core.ts";
import {
  buildAgentOverrideMd,
  syncSubagentModelOverrides,
} from "../extensions/goal-loop-subagents.ts";
import { resolveDrafterModel } from "../extensions/drafter-model.ts";
import { buildSettingsRows } from "../extensions/settings-menu.ts";
import type { Settings } from "../extensions/goal-settings.ts";

test("long-running judgment policy is explicit and question-gated", () => {
  assert.match(LONG_RUNNING_JUDGMENT_POLICY, /durable, maintainable root-cause fix/);
  assert.match(LONG_RUNNING_JUDGMENT_POLICY, /genuine decision boundary/);
  assert.match(LONG_RUNNING_JUDGMENT_POLICY, /DECIDE question/);
  const seeded = buildSeedGrillMessage("[DRAFT]", "ship the plugin", "propose_goal_draft");
  assert.match(seeded, /LONG-RUNNING JUDGMENT POLICY/);
  assert.match(seeded, /irreversible\/destructive external action/);
});

test("explicit Designer declarations are consumed without changing ordinary design prose", () => {
  const ordinary = extractAgentRole("Design the settings flow");
  assert.equal(ordinary.agentRole, undefined);
  assert.equal(ordinary.objective, "Design the settings flow");

  const parsed = parseListItemDeclaration("Fix the settings flow. Agent: Designer. Parallel: yes. Done when: npm test");
  assert.equal(parsed.objective, "Fix the settings flow");
  assert.equal(parsed.agentRole, "designer");
  assert.equal(parsed.parallelSafe, true);
  assert.equal(parsed.verificationContract, "npm test");
});

test("task plans preserve Designer routing and expose it on the next pending task", () => {
  const list = buildTaskList([
    { title: "Design the change", agentRole: "designer", subtasks: ["Implement it"] },
    { title: "Verify the result" },
  ]);
  assert.equal(list.tasks[0]!.agentRole, "designer");
  const next = findNextPendingTask(list.tasks);
  assert.deepEqual(next, { id: "1", title: "Design the change", agentRole: "designer" });
});

test("Designer is a managed read-only role and remains available without a pin", () => {
  const md = buildAgentOverrideMd("Designer");
  assert.doesNotMatch(md, /^model:/m);
  assert.match(md, /DESIGNER ROLE/);
  assert.match(md, /read, bash, grep, find, ls/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-designer-role-"));
  const sync = syncSubagentModelOverrides({ agentDir: dir, strategy: "inherit-parent", overrides: {} });
  assert.ok(sync.written.includes("Designer"));
  assert.ok(fs.existsSync(path.join(dir, "agents", "Designer.md")));
});

function fakeContext() {
  const session = { provider: "test", id: "session" };
  const backup = { provider: "test", id: "backup" };
  const last = { provider: "test", id: "last" };
  const models = new Map([["test/backup", backup], ["test/last", last], ["test/session", session]]);
  const registry = {
    find(provider: string, id: string) { return models.get(`${provider}/${id}`); },
    getAvailable() { return [...models.values()]; },
    hasConfiguredAuth(model: any) { return model !== last; },
  };
  return { ctx: { model: session, modelRegistry: registry } as any, session, backup, last };
}

test("drafter resolution walks its own ordered chain and falls back to the session", () => {
  const { ctx, backup, session } = fakeContext();
  const resolved = resolveDrafterModel(ctx, {
    drafterModel: "test/missing",
    drafterModelFallbacks: ["test/backup", "test/last"],
    forbiddenModels: [],
  });
  assert.equal(resolved.selected?.model, backup);
  assert.deepEqual(resolved.candidates.map((c) => c.ref), ["test/backup", "test/session"]);
  assert.equal(resolved.candidates.at(-1)?.model, session);
});

test("drafter resolution skips forbidden candidates without inspecting provider text", () => {
  const { ctx, backup } = fakeContext();
  const resolved = resolveDrafterModel(ctx, {
    drafterModel: "test/backup",
    drafterModelFallbacks: [],
    forbiddenModels: ["test/backup"],
  });
  assert.equal(resolved.selected?.model, ctx.model);
  assert.notEqual(resolved.selected?.model, backup);
});

test("drafter keeps a configured current primary so its fallback remains reachable", () => {
  const { ctx, session, backup } = fakeContext();
  const resolved = resolveDrafterModel(ctx, {
    drafterModel: "test/session",
    drafterModelFallbacks: ["test/backup"],
    forbiddenModels: [],
  });
  assert.equal(resolved.selected?.model, session);
  assert.deepEqual(resolved.candidates.map((candidate) => candidate.ref), ["test/session", "test/backup"]);
});

test("settings expose drafting-only primary and fallback controls", () => {
  const rows = buildSettingsRows({
    drafterModel: "test/primary",
    drafterModelFallbacks: ["test/backup"],
  } as Settings, {
    drafterModel: { value: "test/primary", source: "global" },
    drafterModelFallbacks: { value: ["test/backup"], source: "global" },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get("drafterModel")?.valueText, "test/primary");
  assert.equal(byId.get("drafterModelFallbacks")?.valueText, "test/backup");
  assert.match(byId.get("drafterModelFallbacks")!.description, /main or auditor chains are unchanged/);
});

test("drafting recovery stays on the dedicated chain and uses the existing interview", () => {
  const queueSource = fs.readFileSync("extensions/loops/goal-list-queue.ts", "utf8");
  const activationSource = fs.readFileSync("extensions/loops/goal-activation.ts", "utf8");
  assert.match(queueSource, /DRAFTER_RECOVERY_PROMPT/);
  assert.match(queueSource, /drafter_model_fallback_exhausted/);
  assert.match(queueSource, /Main and auditor recovery chains are unchanged/);
  assert.match(activationSource, /handleDrafterModelFailure/);
  assert.match(activationSource, /draftingTarget !== null/);
  assert.match(activationSource, /Leave the interview open/);
});

test("continuation prompt names the explicit Designer hand-off syntax", () => {
  const prompt = fs.readFileSync(path.resolve("prompts", "goal-loop-continuation.md"), "utf8");
  assert.match(prompt, /Agent: Designer/);
  assert.match(prompt, /Role: designer/);
  assert.match(prompt, /continue inline/);
});
