// throwaway debug — delete after use
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal } from "./harness/mock-pi.js";
import { __testOnlyHeartbeatTick, __testOnlyResetZombieRunWatchdog } from "../extensions/goal-heartbeat.js";
import activate from "../extensions/loops/goal.js";

const MAIN_SM = {};
const pi = new MockPi();
activate(pi.api);

function readLedger(cwd: string): any[] {
  try {
    const raw = fs.readFileSync(`${cwd}/.pi-glla/ledger.jsonl`, "utf8");
    return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

test("debug starved", async () => {
  (globalThis as any).__testOnlyResetStaleFlag?.();
  (globalThis as any).__testOnlyResetOwnerSession?.();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ objective: "debug starved" }) });
  const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
  await pi.fire("session_start", { reason: "reload" }, ctx);
  (globalThis as any).compactionGraceUntil = 0;
  (globalThis as any).postCompletionSettleUntil = 0;
  const g = globalThis as any;
  console.log("noteContextStarvedYield:", typeof g.noteContextStarvedYield);
  console.log("isContextStarvedRefused:", typeof g.isContextStarvedRefused);
  console.log("lastActivityAt setter:", typeof g.lastActivityAt);
  g.lastActivityAt = Date.now() - 120_000;
  console.log("after backdate:", Date.now() - g.lastActivityAt);
  g.noteContextStarvedYield();
  g.noteContextStarvedYield();
  console.log("refused now:", g.isContextStarvedRefused?.());
  __testOnlyHeartbeatTick();
  console.log("ledger:", readLedger(cwd).map((e) => e.type).join(","));
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});
