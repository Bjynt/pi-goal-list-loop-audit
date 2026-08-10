// Repro attempt: /list audit after a session startup+resume — the live
// dracon-platform session showed: sidecar written, state persisted with
// list:[], and NO activation (no goal file, no "List item #1 activated"
// notify). Reproduce that sequence with the harness.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, type MockCtx } from "./harness/mock-pi.js";
import { writeQueueItemFile, queueItemPath, readQueueFromDisk, type ListItem } from "../extensions/goal-loop-core.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

function readLedger(cwd: string): Array<{ type: string; value: any }> {
  const file = path.join(cwd, ".pi-glla", "active.jsonl");
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("repro: /list audit after startup+resume activates the queued item", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true }));
  const pi = new MockPi();
  activate(pi.api);
  const cwd = tmpCwd();

  // Simulate the live session's lifecycle: fresh startup, then resume.
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "main-session-manager" } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await pi.fire("session_start", { reason: "resume" }, ctx);

  // Pre-existing orphaned sidecars (as accumulated in the live workspace).
  const orphans: Array<{ id: string; objective: string }> = [];
  for (let i = 0; i < 3; i++) {
    const item: ListItem = { id: `orphan-${i}`, objective: `[LIST-AUDIT-COLLECT] orphan pass ${i}`, addedAt: new Date().toISOString() };
    orphans.push(item);
    writeQueueItemFile(cwd, item);
  }

  // The user's command.
  await pi.command("list", "audit", ctx);

  // What happened?
  const ledger = readLedger(cwd);
  const stateEvents = ledger.filter((e) => e.type === "state");
  const lastState = stateEvents[stateEvents.length - 1];
  const diskFirst = ledger.filter((e) => e.type === "list_queue_disk_first");
  const imported = ledger.filter((e) => e.type === "list_imported");
  const blocked = ledger.filter((e) => e.type === "list_activation_blocked_loop" || e.type === "faulty_objective_list_activation_blocked" || e.type === "list_autoactivation_held");
  const goals = fs.readdirSync(path.join(cwd, ".pi-glla", "goals")).filter((n) => n.endsWith(".md"));
  const sidecars = fs.readdirSync(path.join(cwd, ".pi-glla", "goals")).filter((n) => n.endsWith(".queue.json"));
  const notified = pi.sent.filter((m) => JSON.stringify(m).includes("activated"));

  console.log("=== ledger tail ===");
  for (const e of ledger.slice(-8)) console.log(e.type, JSON.stringify(e.value).slice(0, 160));
  console.log("=== diskFirst:", diskFirst.length, "imported:", imported.length, "blocked:", blocked.length);
  console.log("=== last state list:", JSON.stringify(lastState?.value?.list));
  console.log("=== goals dir:", goals, "sidecars:", sidecars.length, "of which restored-to-memory:", readQueueFromDisk(cwd).length);
  console.log("=== activation notify:", notified.length > 0 ? JSON.stringify(notified[0].message).slice(0, 160) : "NONE");

  // The live-session symptom: sidecar written but state.list empty + no activation.
  // Assert the EXPECTED behavior (this should fail if we reproduced the bug):
  assert.ok(goals.length === 1 || notified.length > 0, "a list item should have been activated (goal md or notify)");
  const lastList = lastState?.value?.list as unknown[] | undefined;
  assert.ok(Array.isArray(lastList) && lastList.length > 0, "state.list should contain the queued item");
});
