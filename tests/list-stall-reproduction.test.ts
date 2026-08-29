// pi-goal-list-loop-audit — v0.36.0
// tests/list-stall-reproduction.test.ts
//
// Durable MockPi reproductions for the screenshot-shaped `LIST QUEUED` card.
// The card is not, by itself, evidence that list execution wedged:
//
//   * a standalone `/goal` completion deliberately leaves waiting list work
//     for explicit `/list next` consent;
//   * a list-sourced completion promotes its successor through
//     `archiveCurrentGoal()` and records the settle window.
//
// These tests assert both state and ledger transitions so a future change
// cannot mistake the intentional queue boundary for a silent stall.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlyResetTerminalFlags,
} from "../extensions/loops/goal.js";
import { clearContinuationTimer } from "../extensions/goal-continuation.js";
import { buildWidgetLines } from "../extensions/goal-loop-display.js";
import { readState } from "../extensions/goal-loop-core.js";
import {
  MockPi,
  makeMockCtx,
  seedState,
  tick,
  tmpCwd,
} from "./harness/mock-pi.js";

function ledgerTypes(cwd: string): string[] {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

function resetRuntime(): void {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  clearContinuationTimer();
}

async function startSession(pi: MockPi, cwd: string) {
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `stall-repro-${cwd}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(20);
  return ctx;
}

test("screenshot-shaped queue after standalone goal completion is an intentional waiting state", async () => {
  const pi = new MockPi();
  activate(pi.api);
  const cwd = tmpCwd();
  seedState(cwd, { goal: null, list: [] });
  resetRuntime();
  const ctx = await startSession(pi, cwd);

  await pi.command("goal", "standalone audit pass — done when archived", ctx);
  await tick(20);
  await pi.runTool("list_add", {
    items: [
      "queue one — done when pinned",
      "queue two — done when pinned",
      "queue three — done when pinned",
      "queue four — done when pinned",
    ],
  }, ctx);
  await tick(20);

  const before = readState(cwd);
  assert.equal(before.goal?.policy, "goal");
  assert.equal(before.goal?.status, "active");
  assert.equal(before.list?.length, 4);
  assert.match(ctx.ui.statuses["pi-glla"] ?? "", /4 queued/);
  assert.match(buildWidgetLines(before)?.join("\n") ?? "", /4 queued/);

  // This is the same terminal archive fence used after an approved detached
  // auditor result. A standalone goal is not a list item and must not consume
  // the queue implicitly.
  const archiveCurrentGoal = (globalThis as any).archiveCurrentGoal as (
    context: unknown,
    status: "complete",
    reason: string,
  ) => boolean;
  assert.equal(archiveCurrentGoal(ctx, "complete", "auditor approved"), true);
  await tick(20);

  const after = readState(cwd);
  assert.equal(after.goal, null);
  assert.equal(after.list?.length, 4);
  assert.match(ctx.ui.statuses["pi-glla"] ?? "", /LIST QUEUED.*4 waiting/);
  assert.match(buildWidgetLines(after)?.join("\n") ?? "", /list queued.*4 waiting/i);
  assert.match(buildWidgetLines(after)?.join("\n") ?? "", /\/list next starts the queue/);

  const types = ledgerTypes(cwd);
  const archivedAt = types.lastIndexOf("goal_archived");
  assert.ok(archivedAt >= 0);
  assert.equal(types.slice(archivedAt + 1).includes("list_completion_settle_armed"), false);

  // The visible recovery action is live and does not require a reload.
  await pi.command("list", "next", ctx);
  const activated = readState(cwd);
  assert.equal(activated.goal?.policy, "list");
  assert.equal(activated.goal?.objective, "queue one — done when pinned");
  assert.equal(activated.list?.length, 3);
  clearContinuationTimer();
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("list-sourced completion promotes the successor and records the settle transition", async () => {
  const pi = new MockPi();
  activate(pi.api);
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: null,
    list: [
      { id: "stall-repro-head", objective: "head list item — done when pinned", addedAt: new Date().toISOString(), queueOrder: 0 },
      { id: "stall-repro-tail", objective: "successor list item — done when pinned", addedAt: new Date().toISOString(), queueOrder: 1 },
    ],
  });
  resetRuntime();
  const ctx = await startSession(pi, cwd);

  await pi.command("list", "next", ctx);
  assert.equal(readState(cwd).goal?.objective, "head list item — done when pinned");
  assert.equal(readState(cwd).list?.length, 1);

  const archiveCurrentGoal = (globalThis as any).archiveCurrentGoal as (
    context: unknown,
    status: "complete",
    reason: string,
  ) => boolean;
  assert.equal(archiveCurrentGoal(ctx, "complete", "auditor approved list item"), true);
  await tick(20);

  const after = readState(cwd);
  assert.equal(after.goal?.policy, "list");
  assert.equal(after.goal?.objective, "successor list item — done when pinned");
  assert.equal(after.goal?.status, "active");
  assert.equal(after.list?.length, 0);
  assert.ok(ledgerTypes(cwd).includes("list_completion_settle_armed"));
  clearContinuationTimer();
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});
