// pi-goal-list-loop-audit — v0.38.12 (last-wins)
//
// The user's rule: the newest session owns the folder and the newest
// objective owns the goal slot. Making a new objective retires the old
// one — no ownership dead-ends, no archival-failure refusals.
//
// Part A (sessions): supersedeLiveOwnerRoot steals a live root for a main
// host (workers never steal); the dethroned session stands down via
// noteOwnershipStanding (notify once, ledger the transition).
// Part B (objectives): an archive fence no longer refuses the new
// objective — the old objective is preserved in the ledger and the new
// goal starts anyway (driven behaviorally through propose_goal_draft).

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, seedState, seedGoal, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";
import { readState } from "../extensions/goal-loop-core.ts";
import {
  noteOwnershipStanding,
  supersedeLiveOwnerRoot,
  __testOnlyResetOwnerHeartbeat,
  __testOnlyResetStandDownNotice,
} from "../extensions/state-root-owner.js";
import {
  claimProcessOwner,
  ownerFilePath,
  readOwnerFile,
  refreshOwnershipStanding,
  __testOnlyResetOwnershipRecheck,
} from "../extensions/loops/goal-session.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobal(value: Record<string, unknown>): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(value));
}

const pi = new MockPi();
activate(pi.api);
const MAIN_SM = { name: "last-wins-main-sm" };

const children: ChildProcess[] = [];
afterEach(() => {
  setGlobal({ aggressiveMode: false });
  __testOnlyResetOwnerSession();
  __testOnlyResetOwnerHeartbeat();
  __testOnlyResetStandDownNotice();
  __testOnlyResetOwnershipRecheck();
  pi.execHandler = null;
  for (const c of children.splice(0)) {
    try { c.kill("SIGKILL"); } catch { /* already gone */ }
  }
  try { execSync(`pkill -f 'sleep 777[34]'`); } catch { /* none left */ }
});

function writeOwner(cwd: string, record: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(ownerFilePath(cwd)), { recursive: true });
  fs.writeFileSync(ownerFilePath(cwd), JSON.stringify(record));
}
function spawnSleep(marker = "77773"): ChildProcess {
  const c = spawn("sleep", [marker], { stdio: "ignore" });
  children.push(c);
  return c;
}
function readLedger(cwd: string): Array<{ type: string; value?: any }> {
  let raw = "";
  try {
    raw = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
  } catch {
    return []; // refused/quiet paths may write nothing at all
  }
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}
async function freshSession(cwd: string): Promise<MockCtx> {
  __testOnlyResetOwnerSession();
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason: "reload" }, ctx);
  await tick();
  return ctx;
}

// ── Part A: newest session wins ─────────────────────────────────────────

test("last-wins: a main host steals a live root — the old owner is never signaled", async () => {
  const cwd = tmpCwd();
  const prev = spawnSleep();
  await new Promise((r) => setTimeout(r, 100));
  writeOwner(cwd, { pid: prev.pid, at: Date.now(), ownerSessionId: "old-session" });
  const out = supersedeLiveOwnerRoot(cwd, { isMainHost: true, bySession: "new-session" });
  assert.equal(out, "stolen");
  assert.equal(readOwnerFile(cwd)?.pid, process.pid, "we own the root now");
  assert.equal(prev.kill(0), true, "the previous owner was never signaled");
  const ev = readLedger(cwd).filter((l) => l.type === "owner_superseded");
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.value.prevPid, prev.pid);
  assert.equal(ev[0]!.value.bySession, "new-session");
});

test("last-wins: a worker contact never steals — the main session keeps the root", async () => {
  const cwd = tmpCwd();
  const prev = spawnSleep();
  await new Promise((r) => setTimeout(r, 100));
  writeOwner(cwd, { pid: prev.pid, at: Date.now(), ownerSessionId: "main-session" });
  const out = supersedeLiveOwnerRoot(cwd, { isMainHost: false, bySession: "subagent" });
  assert.equal(out, "refused");
  assert.equal(readOwnerFile(cwd)?.pid, prev.pid, "main session undisturbed");
  assert.equal(prev.kill(0), true);
  assert.equal(readLedger(cwd).filter((l) => l.type === "owner_superseded").length, 0);
});

test("last-wins: quiet paths still reclaim without supersede noise", () => {
  const cwd = tmpCwd();
  assert.equal(supersedeLiveOwnerRoot(cwd, { isMainHost: true }), "reclaimed");
  assert.equal(readOwnerFile(cwd)?.pid, process.pid);
  // Dead owner reclaims through the normal claim — no owner_superseded.
  const cwd2 = tmpCwd();
  writeOwner(cwd2, { pid: 2 ** 30 + 3, at: Date.now() - 1000 });
  assert.equal(supersedeLiveOwnerRoot(cwd2, { isMainHost: true }), "reclaimed");
  assert.equal(readOwnerFile(cwd2)?.pid, process.pid);
  assert.equal(readLedger(cwd2).filter((l) => l.type === "owner_superseded").length, 0);
});

test("last-wins: the dethroned session stands down once, then recovers when the holder dies", async () => {
  const cwd = tmpCwd();
  assert.equal(claimProcessOwner(cwd), true);
  const notes: string[] = [];
  const ctx = { cwd, ui: { notify: (m: string) => { notes.push(String(m)); } } } as unknown as Parameters<typeof noteOwnershipStanding>[0];
  noteOwnershipStanding(ctx);
  assert.equal(notes.length, 0, "owner holding: silent");
  // A newer session steals the root out from under us.
  const holder = spawnSleep();
  await new Promise((r) => setTimeout(r, 100));
  writeOwner(cwd, { pid: holder.pid, at: Date.now() });
  __testOnlyResetOwnershipRecheck();
  noteOwnershipStanding(ctx);
  assert.equal(refreshOwnershipStanding(cwd), "lost");
  assert.equal(notes.length, 1, "exactly one stand-down notice");
  assert.match(notes[0]!, /now read-only/);
  const down = readLedger(cwd).filter((l) => l.type === "owner_stood_down");
  assert.equal(down.length, 1);
  assert.equal(down[0]!.value.ownerPid, holder.pid);
  // Repeat polls stay silent.
  __testOnlyResetOwnershipRecheck();
  noteOwnershipStanding(ctx);
  assert.equal(notes.length, 1, "no repeat notice for the same holder");
  assert.equal(readLedger(cwd).filter((l) => l.type === "owner_stood_down").length, 1);
  // The holder dies: heartbeat reclaims, standing returns to held, no new notice.
  holder.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 100));
  __testOnlyResetOwnerHeartbeat();
  __testOnlyResetOwnershipRecheck();
  const { refreshOwnerHeartbeat } = await import("../extensions/state-root-owner.js");
  refreshOwnerHeartbeat(cwd);
  assert.equal(readOwnerFile(cwd)?.pid, process.pid, "dead holder reclaimed");
  noteOwnershipStanding(ctx);
  assert.equal(refreshOwnershipStanding(cwd), "held");
  assert.equal(notes.length, 1, "recovery is silent");
});

test("last-wins wiring: session_start supersedes under hostLifecycleStart, agent_end notes standing", () => {
  const activation = fs.readFileSync("extensions/loops/goal-activation.ts", "utf8");
  assert.match(activation, /supersedeLiveOwnerRoot\(ctx\.cwd, \{ isMainHost: true/);
  assert.match(activation, /if \(!ownsRoot && hostLifecycleStart\)/);
  assert.match(activation, /noteOwnershipStanding\(ctx\); \/\/ v0\.38\.12/);
  const session = fs.readFileSync("extensions/loops/goal-session.ts", "utf8");
  assert.match(session, /if \(!isForeignCtx\(ctx\) && !isWorkerSessionCtx\(ctx\)\) refreshOwnershipStanding\(ctx\.cwd\);/);
});

// ── Part B: newest objective wins ───────────────────────────────────────

async function activateFreshObjective(cwd: string, oldId: string, fence: boolean): Promise<{ ctx: MockCtx; newId: string }> {
  setGlobal({ autoResume: true, aggressiveMode: false });
  seedState(cwd, {
    goal: seedGoal({ id: oldId, objective: "Repaint the old shed", status: "active" }),
  });
  const ctx = await freshSession(cwd);
  if (fence) {
    // The winner must appear AFTER restore settles: the continuation
    // guard treats a pre-existing archive file as "already archived"
    // and clears the live goal before replacement can run. No await
    // between the fence and the command, so no timer can interleave.
    fs.mkdirSync(path.join(cwd, ".pi-glla", "archive"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi-glla", "archive", `${oldId}.md`), "# pre-existing winner\n");
  }
  // /goal start bypasses drafting (explicit user command) and drives
  // cmdSet → setGoal, which is where the replacement branch lives. (The
  // draft tool preserves a live goal by design — replacement is explicit.)
  await pi.command("goal", "start FRESH objective — Done when pinned", ctx);
  await tick();
  const goal = readState(cwd).goal as { id: string; objective: string } | null;
  assert.ok(goal && /FRESH objective/.test(goal.objective), "the new objective activates");
  return { ctx, newId: goal.id };
}

test("last-wins: an archive fence no longer refuses the new objective — old is ledgered, new starts", async () => {
  const cwd = tmpCwd();
  const oldId = "20260904000000-fenc01";
  const { ctx, newId } = await activateFreshObjective(cwd, oldId, true);
  const goal = readState(cwd).goal as { id: string; objective: string };
  assert.match(goal.objective, /FRESH objective/, "the new objective owns the slot");
  assert.notEqual(goal.id, oldId);
  const unarchived = readLedger(cwd).filter((l) => l.type === "goal_superseded_unarchived");
  assert.equal(unarchived.length, 1, "the old objective is preserved, not dropped");
  assert.equal(unarchived[0]!.value.oldGoalId, oldId);
  assert.match(unarchived[0]!.value.objective as string, /old shed/i);
  assert.equal(unarchived[0]!.value.replacedBy, newId);
  const notifies = (ctx.ui as { notifies: Array<{ message: string }> }).notifies.map((n) => n.message).join("\n");
  assert.match(notifies, /starts anyway/, "the user is told the new objective won");
  assert.doesNotMatch(notifies, /New objective not started/, "the old refusal is gone");
  // The pre-existing archive winner is byte-for-byte untouched.
  assert.equal(fs.readFileSync(path.join(cwd, ".pi-glla", "archive", `${oldId}.md`), "utf8"), "# pre-existing winner\n");
});

test("last-wins control: without a fence the old objective still archives honestly", async () => {
  const cwd = tmpCwd();
  const oldId = "20260904000000-clea01";
  const { ctx } = await activateFreshObjective(cwd, oldId, false);
  assert.ok(fs.existsSync(path.join(cwd, ".pi-glla", "archive", `${oldId}.md`)), "old objective archived");
  assert.equal(readLedger(cwd).filter((l) => l.type === "goal_superseded_unarchived").length, 0);
  const notifies = (ctx.ui as { notifies: Array<{ message: string }> }).notifies.map((n) => n.message).join("\n");
  assert.match(notifies, /was superseded by the new objective/);
});

test("last-wins source pins: setGoal preserves-then-proceeds, refusal text gone", () => {
  const src = fs.readFileSync("extensions/loops/goal-orchestrator.ts", "utf8");
  const setGoal = src.slice(src.indexOf("function setGoal("), src.indexOf("function updateGoal("));
  assert.match(setGoal, /goal_superseded_unarchived/);
  assert.match(setGoal, /starts anyway/);
  assert.ok(!setGoal.includes("New objective not started — the current"), "the archival-failure refusal is gone");
  assert.match(setGoal, /archiveCurrentGoal\(ctx, "aborted", replacementReason\)/, "honest archive is still attempted first");
});
