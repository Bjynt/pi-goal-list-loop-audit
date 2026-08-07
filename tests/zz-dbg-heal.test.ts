import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, tick } from "./harness/mock-pi.js";

const pi = new MockPi();
activate(pi.api);
const MAIN_SM = { name: "main-session-manager" };
const GOAL_ID = "20260804122233-abcdef";

test("debug heal", async () => {
  __testOnlyResetStaleFlag(); __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, ".pi-glla", "goals"), { recursive: true });
  const mdPath = path.join(cwd, ".pi-glla", "goals", `${GOAL_ID}.md`);
  fs.writeFileSync(mdPath, "# Goal\n\n**Status**: active\n**Policy**: list\n\n## Objective\n\n> x\n");
  seedState(cwd, { goal: seedGoal({ id: GOAL_ID, policy: "lits", status: "active" }) });
  const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
  await pi.fire("session_start", { reason: "reload" }, ctx);
  await tick();
  console.log("MD exists:", fs.existsSync(mdPath));
  await pi.command("list", "pause", ctx);
  console.log("ALL NOTIFIES:", JSON.stringify(ctx.ui.notifies.map(n => n.message), null, 1));
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
  console.log("LEDGER tail:", ledger.split("\n").filter(Boolean).slice(-4).join("\n"));
  fs.rmSync(cwd, { recursive: true, force: true });
});
