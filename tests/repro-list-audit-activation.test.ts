// Repro attempt 2: EXACT live event sequence from the dracon-platform ledger:
//   session_start(startup) → session_shutdown(resume) → session_start(resume)
//   → /list audit
// The live ledger showed: sidecar written, disk_first logged, state persisted
// with list:[], list_imported logged, NO activation. The harness previously
// reproduced the enqueue fine with just startup+resume session_starts.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

function readLedger(cwd: string): Array<{ type: string; value: any }> {
  const file = path.join(cwd, ".pi-glla", "active.jsonl");
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("repro: live sequence startup/shutdown(resume)/rebound(resume) then /list audit", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true }));
  const pi = new MockPi();
  activate(pi.api);
  const cwd = tmpCwd();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "main-session-manager" } });

  // Exact live sequence (from active.jsonl 20:01:43-20:01:53 UTC window):
  await pi.fire("session_start", { reason: "startup" }, ctx); // logs session_rebound(startup) + session_waiting_for_load
  await pi.fire("session_shutdown", { reason: "resume" }, ctx); // logs session_shutdown(resume)
  await pi.fire("session_start", { reason: "resume" }, ctx); // logs session_rebound(resume) + id_invalidation

  // The user's command:
  await pi.command("list", "audit", ctx);

  const ledger = readLedger(cwd);
  const stateEvents = ledger.filter((e) => e.type === "state");
  const lastState = stateEvents[stateEvents.length - 1];
  const goals = fs.readdirSync(path.join(cwd, ".pi-glla", "goals")).filter((n) => n.endsWith(".md"));
  const notified = pi.sent.filter((m) => JSON.stringify(m).includes("activated"));

  console.log("=== ledger tail ===");
  for (const e of ledger.slice(-10)) console.log(e.type, JSON.stringify(e.value).slice(0, 150));
  console.log("=== goals:", goals, "| notify-activated:", notified.length > 0);
  console.log("=== last state list:", JSON.stringify(lastState?.value?.list));

  assert.ok(goals.length === 1 || notified.length > 0, "a list item should have been activated (goal md or notify)");
  // v0.34.122 (fix): activation CONSUMES the item — the final state line
  // carries the active goal with the queue emptied. The pre-fix bug kept
  // the item stuck in a frozen list (enqueue persisted [] and nothing
  // activated); the fix makes the enqueue persist the item and the
  // activation take it off.
  const lastGoal = lastState?.value?.goal as { id?: string } | null | undefined;
  assert.ok(lastGoal && typeof lastGoal.id === "string", "final state must carry the activated goal");
  const lastList = lastState?.value?.list as unknown[] | undefined;
  assert.ok(Array.isArray(lastList) && lastList.length === 0, "final state.list must be consumed by activation");
});
