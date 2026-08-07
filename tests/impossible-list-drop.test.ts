// pi-goal-list-loop-audit — v0.34.70
// tests/impossible-list-drop.test.ts
//
// note.md 2026-08-07: "auto drop impossible ones i think or auto adjust
// instead of stopping" — instead of stopping the /list queue on an
// impossible item, auto-drop it (with a ledgered reason) and advance.
//
// DEFINED IMPOSSIBLE STATE (the rule lives in the extension, pause_goal
// handler): a /list item paused as kind="blocked" with NO resume path (no
// non-empty suggestedAction) — the pause itself declares "blocked forever,
// no way forward". Every internal blocked pause (restore hold, audit retry
// horizon, abort wall, …) carries a suggestedAction, so only an
// agent-authored blocked pause that offers no way forward reaches the rule.
//
// Contract: the impossible-state rule is defined in the extension, the
// behavior is ledgered (list_item_impossible + list_item_auto_dropped) and
// tested; suite green + tsc clean.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { readState } from "../extensions/goal-loop-core.js";
import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import {
  MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, seedLoop, tick,
  type MockCtx,
} from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true } : {}));
}

const pi = new MockPi();
activate(pi.api);
const MAIN_SM = { name: "main-session-manager" };

function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}
async function freshSession(cwd: string, reason: string): Promise<MockCtx> {
  __testOnlyResetOwnerSession();
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason }, ctx);
  return ctx;
}
afterEach(() => {
  setGlobalAutoResume(false);
  pi.execHandler = null;
  __testOnlyResetOwnerSession();
});

function readLedger(cwd: string): Array<{ type: string; value?: any }> {
  const raw = fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf-8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function runPauseTool(ctx: MockCtx, params: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  return pi.runTool("pause_goal", params, ctx) as Promise<{ content: Array<{ type: string; text: string }> }>;
}

/** Active /list item + a queued follow-up — the auto-advance target. */
async function impossibleFixture(extra: Record<string, unknown> = {}) {
  setGlobalAutoResume(true); // keep the active goal ACTIVE past the restore gate
  const cwd = tmpCwd();
  try {
    const goal = seedGoal({
      policy: "list",
      status: "active",
      objective: "impossible item A",
      ...(extra.goal as Record<string, unknown> | undefined),
    });
    seedState(cwd, {
      goal,
      list: extra.list !== undefined
        ? (extra.list as unknown[])
        : [{ id: "q-item-2", objective: "second list item" }],
      ...((extra.state ?? {}) as Record<string, unknown>),
    });
    const ctx = await freshSession(cwd, "reload");
    await tick();
    return { cwd, ctx, goal };
  } catch (err) {
    fs.rmSync(cwd, { recursive: true, force: true });
    throw err;
  }
}

test("rule: blocked + no resume path on a /list item → auto-dropped (ledgered) and the queue advances", async () => {
  const { cwd, ctx, goal } = await impossibleFixture();
  const before = readState(cwd).goal as { id: string };

  const res = await runPauseTool(ctx, { reason: "the API is gone and nothing else can do this", kind: "blocked" });
  await tick();

  // Detection + drop ledgered with the item id.
  const impossible = readLedger(cwd).filter((l) => l.type === "list_item_impossible");
  assert.equal(impossible.length, 1);
  assert.equal((impossible[0]!.value as { itemId: string }).itemId, before.id);
  assert.match((impossible[0]!.value as { reason: string }).reason, /API is gone/);
  const dropped = readLedger(cwd).filter((l) => l.type === "list_item_auto_dropped");
  assert.equal(dropped.length, 1);
  assert.equal((dropped[0]!.value as { itemId: string }).itemId, before.id);
  // The queue advanced to the next item — the list did NOT stop.
  const after = readState(cwd).goal as { objective: string; status: string; policy: string };
  assert.equal(after.objective, "second list item", "advanced to the queued follow-up");
  assert.equal(after.status, "active");
  assert.equal(after.policy, "list");
  assert.equal(readState(cwd).list?.length, 0, "queue drained");
  // Surfaced: warning notify + tool result text.
  assert.ok(ctx.ui.matching("auto-dropped as impossible").length >= 1, "drop notify");
  assert.match(res.content[0]!.text, /auto-dropped as impossible/);
  assert.ok(ctx.ui.matching("advancing to the next item").length >= 1, "advance notify");
});

test("guard: blocked WITH a resume path stays paused — never overridden", async () => {
  const { cwd, ctx, goal } = await impossibleFixture();
  const before = readState(cwd).goal as { id: string };

  const res = await runPauseTool(ctx, {
    reason: "need the user to fix the API key",
    kind: "blocked",
    suggestedAction: "/goal resume after fixing the API key",
  });
  await tick();

  assert.equal(readLedger(cwd).filter((l) => l.type === "list_item_impossible").length, 0, "no impossible detection");
  const after = readState(cwd).goal as { id: string; status: string; objective: string; pauseKind?: string };
  assert.equal(after.id, before.id, "same item stays");
  assert.equal(after.status, "paused", "regular blocked pause is preserved");
  assert.equal(after.pauseKind, "blocked");
  assert.equal(after.objective, "impossible item A", "no advance — the follow-up stays queued");
  assert.equal(readState(cwd).list?.length, 1, "queue untouched");
  assert.match(res.content[0]!.text, /Goal paused/);
});

test("guard: blocked + no resume path on a plain GOAL is not a list drop", async () => {
  const { cwd, ctx, goal } = await impossibleFixture({
    goal: { policy: "goal" as const, objective: "plain goal objective" },
  });
  const before = readState(cwd).goal as { id: string };

  await runPauseTool(ctx, { reason: "cannot proceed", kind: "blocked" });
  await tick();

  assert.equal(readLedger(cwd).filter((l) => l.type === "list_item_impossible").length, 0, "goal pauses never ledger list drops");
  const after = readState(cwd).goal as { id: string; status: string };
  assert.equal(after.id, before.id);
  assert.equal(after.status, "paused", "stays a normal paused goal");
});

test("last item: drop still ledgered, list goes empty, no advance possible", async () => {
  const { cwd, ctx, goal } = await impossibleFixture({ list: [] });
  const before = readState(cwd).goal as { id: string };

  const st0 = readState(cwd).goal as any;
  console.log("DBG4 pre-pause:", JSON.stringify({ id: st0.id, status: st0.status, policy: st0.policy, objective: st0.objective }));
  console.log("DBG4 list:", JSON.stringify((readState(cwd).list ?? []).map((i: any) => i.objective)));
  const res4 = await runPauseTool(ctx, { reason: "nobody can build this", kind: "blocked" });
  console.log("DBG4 tool:", res4.content[0]!.text);
  await tick();

  console.log("DBG4 ledger:", readLedger(cwd).map((l) => l.type).join(","));
  assert.equal(readLedger(cwd).filter((l) => l.type === "list_item_auto_dropped").length, 1, "drop ledgered even for the last item");
  const after = readState(cwd).goal as { id: string; status: string };
  assert.equal(after.id, before.id, "no advance when the queue is empty");
  assert.equal(after.status, "paused");
  assert.equal(readState(cwd).list?.length, 0);
  assert.ok(ctx.ui.matching("the list is now empty").length >= 1, "empty-list notify");
});

test("loop hold: drop ledgered but NO advance while a loop owns the surface", async () => {
  const { cwd, ctx, goal } = await impossibleFixture({
    state: { loop: seedLoop({ active: true }) },
  });
  const before = readState(cwd).goal as { id: string };

  const st0 = readState(cwd).goal as any;
  console.log("DBG5 pre-pause:", JSON.stringify({ id: st0.id, status: st0.status, policy: st0.policy, objective: st0.objective, pauseKind: st0.pauseKind }));
  console.log("DBG5 list:", JSON.stringify((readState(cwd).list ?? []).map((i: any) => i.objective)), "loop:", JSON.stringify((readState(cwd).loop as any)?.active));
  const res5 = await runPauseTool(ctx, { reason: "cannot be done", kind: "blocked" });
  console.log("DBG5 tool:", res5.content[0]!.text);
  await tick();

  console.log("DBG5 ledger:", readLedger(cwd).map((l) => l.type).join(","));
  assert.equal(readLedger(cwd).filter((l) => l.type === "list_item_auto_dropped").length, 1, "drop ledgered");
  const after = readState(cwd).goal as { id: string; status: string };
  assert.equal(after.id, before.id, "one-active-thing choke point: no advance over a live loop");
  assert.ok(ctx.ui.matching("a running loop holds the surface").length >= 1, "loop-hold notify");
});
