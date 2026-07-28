// pi-goal-list-loop-audit — v0.28.7
// tests/behavioral-orchestrator.test.ts
//
// Behavioral pins for goal.ts's ORCHESTRATOR paths (audit Stream 4: T1, T2,
// T3, T5) — the first tests that register goal.ts on a fake ExtensionAPI and
// DRIVE its handlers instead of regex-matching its source.
//
// FILE-LEVEL DESIGN (do not reorder casually):
// goal.ts is a singleton module; bun test shares module state process-wide
// (verified). The stale-handle flag (extensionApiStale) LATCHES and cannot
// be un-latched from outside. Therefore this file runs:
//   1-5  T3 restore-gate branches   (sends must land — clean flag required)
//   6    T5 foreign-session guards  (needs ownerSession claimed by test 1)
//   7    T2 stale send → terminal   (clean→latched transition observable;
//                                    LATCHES the flag from here on)
//   8    T1a stale confirm          (works with the flag latched)
//   9    T1b stale creation         (works with the flag latched)
// Every test uses its own tmp cwd; session_start re-reads state from that
// cwd's .pi-glla, so tests stay independent despite shared module state.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import activate, { __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, seedLoop, staleError, tick, type MockCtx } from "./harness/mock-pi.js";

const GOAL_SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager" };

function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}

async function freshSession(cwd: string, reason: string): Promise<MockCtx> {
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason }, ctx);
  return ctx;
}

// ────────────────────────────────────────────────────────────────────
// T3 — session_start restore-gate branches (goal.ts session_start handler)
// ────────────────────────────────────────────────────────────────────

test("T3a: active goal + human load (startup) + default settings → HELD for explicit resume", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() });
  const ctx = await freshSession(cwd, "startup");
  const g = readState(cwd).goal as { status: string; pauseReason?: string; pauseSuggestedAction?: string };
  assert.equal(g.status, "paused");
  assert.equal(g.pauseReason, "restored on session load — held for explicit resume");
  assert.match(g.pauseSuggestedAction ?? "", /\/goal resume to continue/);
  assert.ok(ctx.ui.matching("held on restore").length >= 1, "held notify shown");
});

test("T3c: interrupted goal outranks the DEFAULT hold — auto-resumes on human load", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ interruptedAt: new Date().toISOString(), interruptedReason: "extension api stale (sendContinuation)" }) });
  pi.sent.length = 0;
  const ctx = await freshSession(cwd, "startup");
  await tick();
  const g = readState(cwd).goal as { status: string; interruptedAt?: string };
  assert.equal(g.status, "active", "still active (not held)");
  assert.equal(g.interruptedAt, undefined, "interrupt marker cleared by the auto-resume it promised");
  assert.ok(ctx.ui.matching("auto-resumed after the stale-handle interrupt").length >= 1, "interrupt-resume notify");
  assert.ok(pi.sent.length >= 1, "continuation actually sent");
});

test("T3b: active goal + reload → auto-resumes (in-session machinery never strands work)", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() });
  pi.sent.length = 0;
  const ctx = await freshSession(cwd, "reload");
  await tick();
  const g = readState(cwd).goal as { status: string };
  assert.equal(g.status, "active");
  assert.ok(ctx.ui.matching("resuming goal").length >= 1, "resume notify");
  assert.ok(pi.sent.length >= 1, "continuation actually sent");
});

test("T3d: active loop + human load → HELD_ON_RESTORE (loop deactivated loudly, not silently dropped)", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop() });
  const ctx = await freshSession(cwd, "startup");
  const l = readState(cwd).loop as { active: boolean; stopReason?: string };
  assert.equal(l.active, false);
  assert.equal(l.stopReason, "held: restored in a fresh session");
  assert.ok(ctx.ui.matching("loop held on restore").length >= 1, "held notify names the loop");
});

test("T3e: no active goal + queued list + reload → head item auto-activates", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { list: [{ id: "item-1", objective: "queued head objective — done when pinned", addedAt: new Date().toISOString() }] });
  pi.sent.length = 0;
  const ctx = await freshSession(cwd, "reload");
  await tick();
  const s = readState(cwd);
  const g = s.goal as { status: string; objective: string; policy: string } | null;
  assert.ok(g, "a goal exists after restore");
  assert.equal(g!.objective, "queued head objective — done when pinned");
  assert.equal(g!.policy, "list");
  assert.equal(g!.status, "active");
  assert.ok(ctx.ui.matching("activated").length >= 1, "activation notify");
  assert.ok(pi.sent.length >= 1, "continuation sent for the activated head");
});

// ────────────────────────────────────────────────────────────────────
// T5 — foreign-session tool guard (subagent ctx must not mutate state)
// ────────────────────────────────────────────────────────────────────

test("T5: mutating tools refuse a foreign (subagent) session ctx", async () => {
  const cwd = tmpCwd();
  await freshSession(cwd, "startup"); // owner = MAIN_SM (claimed in test 1)
  const foreign = makeMockCtx(cwd, { sessionManager: { name: "SUBAGENT-session-manager" } });
  for (const tool of ["complete_goal", "pause_goal", "list_add", "propose_loop_draft", "complete_task"]) {
    const res = await pi.runTool(tool, tool === "list_add" ? { items: ["x"] } : { id: "t-1" }, foreign);
    assert.match(res.content[0]!.text, /only the MAIN session owns/, `${tool} refuses foreign ctx`);
  }
});

test("T5: guard coverage pin — every mutating tool routes through foreignToolGuard", () => {
  // Per-tool block scan: a NEW or renamed mutating tool that forgets the
  // guard fails this pin (the audit's T5 regression shape). list_status is
  // read-only and explicitly exempt.
  const MUTATING = ["complete_goal", "pause_goal", "complete_task", "update_task_status", "propose_goal_draft", "propose_loop_draft", "propose_loop_refine", "list_add", "list_activate", "propose_task_list"];
  const blocks = GOAL_SRC.split("pi.registerTool(defineTool({").slice(1);
  const byName = new Map<string, string>();
  for (const block of blocks) {
    const m = block.match(/name: "([a-z_]+)"/);
    if (m) byName.set(m[1]!, block);
  }
  for (const tool of MUTATING) {
    const block = byName.get(tool);
    assert.ok(block, `tool ${tool} not found among registered tools`);
    assert.ok(block!.includes("foreignToolGuard(execCtx)"), `mutating tool ${tool} is MISSING the foreign-session guard`);
  }
  assert.ok(byName.has("list_status"), "list_status still registered");
  assert.ok(!byName.get("list_status")!.includes("foreignToolGuard"), "list_status is read-only — guard would be noise");
});

// ────────────────────────────────────────────────────────────────────
// T2 — stale send → goStaleTerminal (goal stays ACTIVE + interrupt marker)
// LATCHES the process-wide stale flag — everything below runs stale.
// ────────────────────────────────────────────────────────────────────

test("T2: a stale send on agent_end continuation → goal ACTIVE + interrupt marker + loud notify", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "start behavioral stale target — done when pinned", ctx);
  await tick();
  assert.equal((readState(cwd).goal as { status: string }).status, "active", "goal created and active");
  pi.sendMessageError = staleError();
  pi.sent.length = 0;
  await pi.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "still working" }], stopReason: "end_turn" }] }, ctx);
  await tick();
  pi.sendMessageError = null; // cleanup BEFORE asserts — a failed assert must not poison later tests
  const g = readState(cwd).goal as { status: string; interruptedAt?: string; interruptedReason?: string };
  assert.equal(g.status, "active", "stale terminal keeps the goal ACTIVE (auto-resumes on restart)");
  assert.ok(g.interruptedAt, "interrupt marker set");
  assert.match(g.interruptedReason ?? "", /extension api stale/);
  assert.ok(ctx.ui.matching("restart pi").length >= 1, "loud restart guidance");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
  assert.ok(ledger.includes('"extension_api_stale"'), "stale terminal ledgered");
});

// ────────────────────────────────────────────────────────────────────
// T1 — stale paths on the two creation entry points (flag latched from T2)
// ────────────────────────────────────────────────────────────────────

test("T1a: stale Confirm in propose_goal_draft → NOT-a-rejection guidance, no goal created", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "", ctx); // no args → drafting mode (seed send is a no-op now: stale)
  await pi.fire("message_start", { message: { role: "user" } }, ctx); // the seed itself (skipped)
  await pi.fire("message_start", { message: { role: "user" } }, ctx); // a real reply (counted)
  ctx.ui.selectImpl = async () => {
    throw staleError();
  };
  ctx.ui.confirmImpl = async () => {
    throw staleError();
  };
  const res = await pi.runTool("propose_goal_draft", { objective: "drafted objective — done when x", verificationContract: "x" }, ctx);
  assert.match(res.content[0]!.text, /NOT a rejection — do NOT refine or re-propose/);
  assert.match(res.content[0]!.text, /Tell the user to restart pi/);
  assert.equal(readState(cwd).goal, null, "nothing was created — and nothing was REFUSED either");
});

test("T1b: stale /goal start → goal persisted to .pi-glla with interrupt marker + honest notify", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "reload");
  pi.sessionNameError = staleError(); // the entry probe trips on getSessionName
  await pi.command("goal", "start stale-created objective — done when pinned", ctx);
  pi.sessionNameError = null; // cleanup BEFORE asserts
  const g = readState(cwd).goal as { status: string; interruptedAt?: string; interruptedReason?: string } | null;
  assert.ok(g, "goal persisted despite the doomed handle");
  assert.equal(g!.status, "active");
  assert.ok(g!.interruptedAt, "interrupt marker set (fresh session auto-resumes it)");
  assert.equal(g!.interruptedReason, "created in a stale session");
  assert.ok(ctx.ui.matching(".pi-glla").length >= 1, "honest 'state is safe' notify, not a 'starting now' lie");
});

// ── v0.28.12: auto-accept escape hatch in draft dialogs ────────────────
// The polis incident: a 14-item batch Confirm gave no hint that /glla
// autoaccept=on existed. Every draft-class dialog is now a 3-choice
// select; the ALWAYS choice persists project autoAcceptDrafts and accepts.

test("auto-accept escape hatch: ALWAYS choice persists project autoAcceptDrafts and accepts the draft", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "", ctx); // drafting mode
  await pi.fire("message_start", { message: { role: "user" } }, ctx);
  await pi.fire("message_start", { message: { role: "user" } }, ctx); // floor satisfied
  let selectTitle = "";
  ctx.ui.selectImpl = async (title: string) => {
    selectTitle = title;
    return "Yes — and always auto-accept drafts (sets autoAcceptDrafts for this project)";
  };
  const res = await pi.runTool("propose_goal_draft", { objective: "hatch objective — done when pinned", verificationContract: "pinned" }, ctx);
  ctx.ui.selectImpl = undefined; // cleanup BEFORE asserts
  assert.match(res.content[0]!.text, /Goal activated|activated|Begin work/i, "draft accepted, not rejected");
  assert.match(selectTitle, /Confirm goal/, "the dialog rendered as the goal confirm");
  const g = readState(cwd).goal as { status: string } | null;
  assert.ok(g && g.status === "active", "goal created by the ALWAYS choice");
  const onDisk = JSON.parse(fs.readFileSync(path.join(cwd, ".pi-glla", "settings.json"), "utf-8")) as { autoAcceptDrafts?: boolean };
  assert.equal(onDisk.autoAcceptDrafts, true, "persisted to PROJECT settings (survives restart, project-scoped)");
  assert.ok(ctx.ui.matching("auto-accept ON").length >= 1, "loud notify names the undo path");
});

test("escape hatch: a later draft skips the dialog entirely once autoAcceptDrafts landed", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "settings.json"), JSON.stringify({ autoAcceptDrafts: true }));
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "", ctx);
  await pi.fire("message_start", { message: { role: "user" } }, ctx);
  let selectCalled = false;
  ctx.ui.selectImpl = async () => { selectCalled = true; return "No"; };
  const res = await pi.runTool("propose_goal_draft", { objective: "second objective — done when pinned", verificationContract: "pinned" }, ctx);
  ctx.ui.selectImpl = undefined;
  assert.equal(selectCalled, false, "no dialog once the setting is on");
  assert.match(res.content[0]!.text, /activated|Begin work/i);
  assert.ok(ctx.ui.matching("auto-accepted").length >= 1, "the auto-accept notify says why");
});

test("source pin: all five draft-class dialogs route through confirmDraft with the 3-choice ALWAYS option", () => {
  const sites = ["Confirm list batch", "Confirm list item", "Confirm goal", "Confirm loop", "Confirm loop spec refinement", "Confirm task list"];
  for (const s of sites) assert.ok(GOAL_SRC.includes(s), `dialog exists: ${s}`);
  const callsites = GOAL_SRC.split("confirmDraft(").length - 1;
  assert.ok(callsites >= 6, `helper + 5 call sites (got ${callsites})`);
  assert.match(GOAL_SRC, /Yes — and always auto-accept drafts \(sets autoAcceptDrafts for this project\)/);
  assert.match(GOAL_SRC, /saveSettings\("project", ctx\.cwd, \{ autoAcceptDrafts: true \}\)/);
  assert.match(GOAL_SRC, /if \(isStaleApiError\(err\)\) return "stale";/, "stale fallback preserved inside the helper");
});

// ────────────────────────────────────────────────────────────────────
// 429-exemption: provider-error turns must NOT feed the stall watchdog
// (endless-td 2026-07-28: 4 MiniMax-M3 429s paused a healthy goal)
// ────────────────────────────────────────────────────────────────────

test("error turns: 3 consecutive stopReason=error agent_ends leave the goal ACTIVE + ledger the exemption", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "start behavioral 429 target — done when pinned", ctx);
  await tick();
  assert.equal((readState(cwd).goal as { status: string }).status, "active", "goal created and active");
  const errTurn = { messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "429: rate_limit_error" }] };
  for (let i = 0; i < 3; i++) {
    await pi.fire("agent_end", errTurn, ctx);
    await tick();
  }
  const g = readState(cwd).goal as { status: string; pauseReason?: string };
  assert.equal(g.status, "active", "3 consecutive provider-error turns must NOT pause the goal");
  assert.ok(!g.pauseReason, "no stall pause reason recorded");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
  assert.ok(ledger.includes('"stall_nudge_exempt_error"'), "exemption ledgered");
});

test("error turns: a real nudge before the errors still counts after they pass (counter neither resets nor increments)", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "start behavioral mixed target — done when pinned", ctx);
  await tick();
  const nudgeTurn = { messages: [{ role: "assistant", content: [{ type: "text", text: "hmm" }], stopReason: "end_turn" }] };
  const errTurn = { messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "500 upstream" }] };
  // 1 short nudge (count=1) → 2 error turns (exempt) → 2 more short nudges (count=2,3 → pause).
  // If errors wrongly incremented, the pause would land one turn earlier;
  // if they wrongly reset, it would never land here.
  await pi.fire("agent_end", nudgeTurn, ctx); await tick();
  await pi.fire("agent_end", errTurn, ctx); await tick();
  await pi.fire("agent_end", errTurn, ctx); await tick();
  assert.equal((readState(cwd).goal as { status: string }).status, "active", "still active after 1 nudge + 2 errors");
  await pi.fire("agent_end", nudgeTurn, ctx); await tick();
  assert.equal((readState(cwd).goal as { status: string }).status, "active", "still active at nudge count 2");
  await pi.fire("agent_end", nudgeTurn, ctx); await tick();
  const g = readState(cwd).goal as { status: string; pauseReason?: string };
  assert.equal(g.status, "paused", "third real nudge pauses (errors neither reset nor incremented)");
  assert.match(g.pauseReason ?? "", /unproductive turns/);
});

// ────────────────────────────────────────────────────────────────────
// v0.28.14 — lifecycle consolidation: carryover resolution + /loop cancel
// + one-active-thing tool guards
// ────────────────────────────────────────────────────────────────────

const HELD = "held: restored in a fresh session";
const seedListItem = (objective: string) => ({ id: `item-${Math.random().toString(36).slice(2, 8)}`, objective, addedAt: new Date().toISOString() });

test("carryover pause (default): new goal over stale paused goal+list+held loop → ONE summary, goal archived, list+loop kept", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ status: "paused", objective: "stale paused goal from yesterday" }),
    list: [seedListItem("stale list item one"), seedListItem("stale list item two")],
    loop: seedLoop({ active: false, stopReason: HELD, target: "stale held loop" }),
  });
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "start brand new goal — done when pinned", ctx);
  await tick();
  const s = readState(cwd);
  const g = s.goal as { status: string; objective: string };
  assert.equal(g.status, "active", "new goal active");
  assert.match(g.objective, /brand new goal/);
  assert.equal((s.list as unknown[]).length, 2, "pause policy KEEPS the waiting list");
  assert.equal((s.loop as { stopReason?: string })?.stopReason, HELD, "pause policy KEEPS the held loop");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
  assert.ok(ledger.includes('"carryover_resolved"'), "resolution ledgered");
  assert.ok(ledger.includes("replaced by new goal (carryover)"), "stale paused goal archived honestly, not orphaned");
  const notes = ctx.ui.matching("Carryover from before this session");
  assert.equal(notes.length, 1, "exactly ONE summary notify");
  assert.match(notes[0]!.message, /2 waiting list item/);
  assert.match(notes[0]!.message, /held loop/);
});

test("carryover=clear: new goal drops the queue, dismisses the held loop, archives the paused goal", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "settings.json"), JSON.stringify({ carryover: "clear" }));
  seedState(cwd, {
    goal: seedGoal({ status: "paused", objective: "stale paused goal" }),
    list: [seedListItem("stale list item")],
    loop: seedLoop({ active: false, stopReason: HELD, target: "stale held loop" }),
  });
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "start fresh work — done when pinned", ctx);
  await tick();
  const s = readState(cwd);
  assert.equal((s.list as unknown[]).length, 0, "queue dropped");
  assert.equal((s.loop as { stopReason?: string })?.stopReason, "cleared: carryover", "held loop dismissed");
  assert.equal((s.goal as { status: string }).status, "active", "new goal active");
  assert.ok(ctx.ui.matching("Carryover cleared").length >= 1, "clear summary shown");
});

test("/loop cancel: first-class alias stops the loop (stopReason recorded)", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({ active: true }) });
  const ctx = await freshSession(cwd, "reload");
  await pi.command("loop", "cancel", ctx);
  await tick();
  const loop = readState(cwd).loop as { active: boolean; stopReason?: string };
  assert.equal(loop.active, false, "loop stopped");
  assert.equal(loop.stopReason, "stopped by user (/loop cancel)", "cancel verb recorded");
  assert.ok(ctx.ui.matching("Loop stopped").length >= 1, "stop summary shown");
});

test("one-active-thing tool guards: list_activate + propose_loop_draft + propose_goal_draft refuse over the wrong active kind", async () => {
  __testOnlyResetStaleFlag();
  // Active loop blocks list_activate and propose_goal_draft.
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({ active: true }), list: [seedListItem("queued thing")] });
  const ctx = await freshSession(cwd, "reload");
  const r1 = await pi.runTool("list_activate", { n: 1 }, ctx);
  assert.match(r1.content[0]!.text, /A loop is active/, "list_activate blocked over live loop");
  await pi.command("goal", "", ctx); // enter drafting (the early guard needs no interview)
  const r2 = await pi.runTool("propose_goal_draft", { objective: "goal over loop — done when pinned" }, ctx);
  assert.match(r2.content[0]!.text, /A loop is active/, "propose_goal_draft blocked over live loop");
  assert.equal((readState(cwd).loop as { active: boolean }).active, true, "loop untouched");

  // Active goal blocks propose_loop_draft (before the measure even test-runs).
  const cwd2 = tmpCwd();
  seedState(cwd2, { goal: seedGoal() });
  const ctx2 = await freshSession(cwd2, "reload");
  const r3 = await pi.runTool("propose_loop_draft", { target: "loop over goal", measureCmd: "none" }, ctx2);
  assert.match(r3.content[0]!.text, /A goal is active/, "propose_loop_draft blocked over live goal");
});
