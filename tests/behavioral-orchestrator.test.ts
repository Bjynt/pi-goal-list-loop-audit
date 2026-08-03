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

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import activate, { __testOnlyResetStaleFlag, __testOnlyRunFanOutListAuditFindings, runDetachedCompletionWithFallback } from "../extensions/loops/goal.js";

// v0.29.5: autoResume is GLOBAL-only now — tests opt in by writing the
// harness's global settings path, and afterEach resets it so the opt-in
// never leaks into later tests (module state is shared process-wide).
const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true } : {}));
}
afterEach(() => setGlobalAutoResume(false));

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

async function waitUntil(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for detached-auditor state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function writeFakeAuditor(cwd: string, verdict: "approved" | "disapproved", delayMs = 0): string {
  const script = path.join(cwd, "fake-auditor-pi.mjs");
  fs.writeFileSync(script, `#!/usr/bin/env node
let input = "";
let handled = false;
process.stdin.on("data", async (chunk) => {
  input += chunk;
  if (handled || !input.includes("\\n")) return;
  handled = true;
  await new Promise((resolve) => setTimeout(resolve, ${delayMs}));
  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  const report = ${JSON.stringify(verdict === "approved" ? "<evidence>\\npinned\\n</evidence>\\n<approved/>" : "## Required fixes\\n- fix the pinned gap\\n<disapproved/>")};
  emit({ type: "tool_execution_start", toolCallId: "fake-read", toolName: "read", args: { path: "README.md" } });
  emit({ type: "tool_execution_end", toolCallId: "fake-read" });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: report } });
  emit({ type: "agent_settled" });
});
// Keep stdin open: pi RPC treats EOF as shutdown, not end-of-prompt.
`);
  fs.chmodSync(script, 0o700);
  return script;
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

test("v0.34.18: blank startup waits for the transcript before autoresume, while explicit resume and loaded history still work", async () => {
  const session = MAIN_SM as { buildSessionContext?: () => { messages: unknown[] } };
  session.buildSessionContext = () => ({ messages: [] });
  try {
    const cwd = tmpCwd();
    seedState(cwd, { goal: seedGoal() });
    setGlobalAutoResume(true);
    pi.sent.length = 0;
    const ctx = await freshSession(cwd, "startup");
    await tick();
    assert.equal((readState(cwd).goal as { status: string }).status, "active", "the blank startup does not pause or mutate the saved goal");
    assert.equal(pi.sent.length, 0, "blank startup sends no continuation");
    assert.ok(ctx.ui.matching("has not loaded a conversation yet").length >= 1, "the initialization barrier is visible");
    assert.ok(fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").includes('"session_waiting_for_load"'), "the wait is ledgered");

    await pi.command("goal", "resume", ctx);
    await tick();
    assert.ok(pi.sent.length >= 1, "explicit /goal resume releases the startup barrier");

    const listCwd = tmpCwd();
    seedState(listCwd, { list: [{ id: "blank-head", objective: "queued blank-start item — done when pinned", addedAt: new Date().toISOString() }] });
    pi.sent.length = 0;
    await freshSession(listCwd, "startup");
    await tick();
    const listState = readState(listCwd);
    assert.equal(listState.goal, null, "blank startup does not activate the queue head");
    assert.equal(listState.list?.length, 1, "blank startup preserves the queued item");
    assert.equal(pi.sent.length, 0, "blank startup sends no list continuation");

    const loopCwd = tmpCwd();
    seedState(loopCwd, { loop: seedLoop() });
    pi.sent.length = 0;
    await freshSession(loopCwd, "startup");
    await tick();
    assert.equal((readState(loopCwd).loop as { active: boolean }).active, true, "blank startup does not deactivate the loop");
    assert.equal(pi.sent.length, 0, "blank startup sends no loop continuation");

    session.buildSessionContext = () => ({ messages: [{ role: "user", content: "restored" }] });
    const loadedCwd = tmpCwd();
    seedState(loadedCwd, { goal: seedGoal() });
    pi.sent.length = 0;
    const loaded = await freshSession(loadedCwd, "startup");
    await tick();
    assert.equal((readState(loadedCwd).goal as { status: string }).status, "active", "loaded startup history permits autoresume");
    assert.ok(loaded.ui.matching("resuming goal").length >= 1, "loaded startup announces autoresume");
    assert.ok(pi.sent.length >= 1, "loaded startup sends the continuation");
  } finally {
    delete session.buildSessionContext;
  }
});

test("T3c (v0.28.21): interrupted goal HELDS by default — the 0.28.3 exemption is superseded; autoresume=on auto-resumes", async () => {
  // Default: even an infra-interrupted goal loads HELD (user directive:
  // "load it on session load but not auto start it"). The marker STAYS.
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ interruptedAt: new Date().toISOString(), interruptedReason: "extension api stale (sendContinuation)" }) });
  pi.sent.length = 0;
  const ctx = await freshSession(cwd, "startup");
  await tick();
  const g = readState(cwd).goal as { status: string; interruptedAt?: string };
  assert.equal(g.status, "paused", "held like everything else by default");
  assert.ok(g.interruptedAt, "interrupt marker PRESERVED (no auto-resume happened)");
  assert.ok(ctx.ui.matching("held on restore").length >= 1, "held notify");
  assert.equal(pi.sent.length, 0, "no continuation fired");

  // Opt-in: autoresume=on keeps the 0.28.3 recovery semantics.
  const cwd2 = tmpCwd();
  seedState(cwd2, { goal: seedGoal({ interruptedAt: new Date().toISOString(), interruptedReason: "extension api stale (sendContinuation)" }) });
  setGlobalAutoResume(true);
  pi.sent.length = 0;
  const ctx2 = await freshSession(cwd2, "startup");
  await tick();
  const g2 = readState(cwd2).goal as { status: string; interruptedAt?: string };
  assert.equal(g2.status, "active", "autoresume=on auto-resumes");
  assert.equal(g2.interruptedAt, undefined, "interrupt marker cleared by the auto-resume it promised");
  assert.ok(ctx2.ui.matching("auto-resumed after the stale-handle interrupt").length >= 1, "interrupt-resume notify");
  assert.ok(pi.sent.length >= 1, "continuation actually sent");
});

test("T3b (v0.28.21): active goal + reload → HELD by default; autoresume=on → auto-resumes", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() });
  pi.sent.length = 0;
  const ctx = await freshSession(cwd, "reload");
  await tick();
  const g = readState(cwd).goal as { status: string };
  assert.equal(g.status, "paused", "reload HOLDS by default now");
  assert.ok(ctx.ui.matching("held on restore").length >= 1, "held notify");
  assert.equal(pi.sent.length, 0, "no continuation fired");

  const cwd2 = tmpCwd();
  seedState(cwd2, { goal: seedGoal() });
  setGlobalAutoResume(true);
  pi.sent.length = 0;
  const ctx2 = await freshSession(cwd2, "reload");
  await tick();
  const g2 = readState(cwd2).goal as { status: string };
  assert.equal(g2.status, "active");
  assert.ok(ctx2.ui.matching("resuming goal").length >= 1, "resume notify");
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

test("v0.29.14: live audit loop on open-count/min migrates to closed-count/max on load (discovery no longer reads as regression)", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({
    active: false,
    stopReason: HELD,
    kind: "audit",
    direction: "min",
    bestValue: 20,
    stallCount: 4,
    measureCmd: "c=$(grep -cE '^- \\[ \\]' .pi-glla/audit-loop/findings.md 2>/dev/null); echo ${c:-0}",
  }) });
  await freshSession(cwd, "startup");
  const l = readState(cwd).loop as { direction?: string; measureCmd?: string; bestValue: number | null; stallCount: number; kind?: string };
  assert.equal(l.direction, "max", "direction flipped to max");
  assert.ok(l.measureCmd!.includes("\\[[xX]\\]"), "closed-count measure");
  assert.equal(l.bestValue, null, "pinned best nulled — next measure is the honest baseline");
  assert.equal(l.stallCount, 0, "plateau stall streak reset");
  assert.equal(l.kind, "audit");
});

test("v0.29.18: live audit loop on the audit-every-iteration target migrates to FIX-FIRST on load", async () => {
  // Field (hegemon iter 26, 2026-07-30): the audit-every-iteration target
  // made discovery (8-12 findings/iter) outpace fixes (1/iter) and allowed
  // "no new action this turn" iterations with 18 open boxes — the user
  // watched it find and present instead of fix ("the goal would be audit
  // to fix then audit then fix again no?"). Target-only swap: metric is
  // unchanged, so best/stall survive.
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({
    active: false,
    stopReason: HELD,
    kind: "audit",
    direction: "max",
    bestValue: 70,
    stallCount: 2,
    target: "Audit the project for real problems and fix them, iteration by iteration. Every iteration: (1) run a FRESH audit pass over the codebase — spawn Explore subagents for breadth — hunting real issues.",
  }) });
  await freshSession(cwd, "startup");
  const l = readState(cwd).loop as { target?: string; bestValue: number | null; stallCount: number };
  assert.ok(l.target!.includes("FIX-FIRST"), "target swapped to the fix-first template");
  assert.ok(!l.target!.includes("Every iteration: (1) run a FRESH audit pass"), "old template gone");
  assert.equal(l.bestValue, 70, "metric unchanged — best survives");
  assert.equal(l.stallCount, 2, "stall streak survives");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
  assert.ok(ledger.includes("audit_loop_target_migrated"), "migration ledgered");
});

test("v0.34.16: lifecycle handoff resumes same-process replacement but quit does not bypass restore consent", async () => {
  setGlobalAutoResume(false);
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() });
  const first = await freshSession(cwd, "startup");
  await pi.command("goal", "resume", first);
  await tick();
  assert.equal((readState(cwd).goal as { status: string }).status, "active", "fixture is actively supervising before replacement");

  await pi.fire("session_shutdown", { reason: "reload" }, first);
  const handoffPath = path.join(cwd, ".pi-glla", "session-handoff.json");
  assert.equal(JSON.parse(fs.readFileSync(handoffPath, "utf8")).reason, "reload", "replacement debt records its lifecycle reason");
  const replacement = ownerCtx(cwd);
  await pi.fire("session_start", { reason: "reload" }, replacement);
  await tick();
  assert.equal((readState(cwd).goal as { status: string }).status, "active", "same-process replacement consumes handoff debt");
  assert.equal(fs.existsSync(handoffPath), false, "handoff debt is single-use");
  const replacementLedger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.ok(replacementLedger.includes('"session_handoff_resumed"'), "handoff consumption is ledger-visible");

  const quitCwd = tmpCwd();
  seedState(quitCwd, { goal: seedGoal() });
  const quitSession = await freshSession(quitCwd, "startup");
  await pi.command("goal", "resume", quitSession);
  await tick();
  await pi.fire("session_shutdown", { reason: "quit" }, quitSession);
  const quitHandoff = path.join(quitCwd, ".pi-glla", "session-handoff.json");
  assert.equal(fs.existsSync(quitHandoff), false, "explicit quit leaves no continuation debt");
  const afterQuit = ownerCtx(quitCwd);
  await pi.fire("session_start", { reason: "startup" }, afterQuit);
  const quitGoal = readState(quitCwd).goal as { status: string; pauseReason?: string };
  assert.equal(quitGoal.status, "paused", "quit does not get same-pid rebind consent");
  assert.match(quitGoal.pauseReason ?? "", /held for explicit resume/);
  const quitLedger = fs.readFileSync(path.join(quitCwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.ok(quitLedger.includes('"session_handoff_suppressed"'), "quit suppression is ledger-visible");

  const foreignCwd = tmpCwd();
  seedState(foreignCwd, { goal: seedGoal() });
  fs.writeFileSync(path.join(foreignCwd, ".pi-glla", "session-handoff.json"), JSON.stringify({ pid: process.pid + 1, at: new Date().toISOString(), reason: "reload" }));
  const foreignSession = await freshSession(foreignCwd, "startup");
  const foreignGoal = readState(foreignCwd).goal as { status: string };
  assert.equal(foreignGoal.status, "paused", "foreign-process debt cannot resume a cold session");
  assert.equal(fs.existsSync(path.join(foreignCwd, ".pi-glla", "session-handoff.json")), false, "foreign debt is consumed and discarded");
  assert.ok(foreignSession.ui.matching("held on restore").length >= 1, "foreign debt falls back to the normal restore gate");
});

test("v0.34.23: host replacement with a new SessionManager is not rejected as foreign", async () => {
  __testOnlyResetStaleFlag();
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() });
  const first = await freshSession(cwd, "startup");
  await pi.command("goal", "resume", first);
  await tick();

  const replacement = makeMockCtx(cwd, { sessionManager: { name: "replacement-session-manager" } });
  pi.sent.length = 0;
  await pi.fire("session_start", { reason: "resume", previousSessionFile: "/tmp/previous-session.json" }, replacement);
  await tick();

  assert.ok(replacement.ui.matching("resuming goal").length >= 1, "replacement session ran the restore gate");
  assert.ok(pi.sent.length >= 1, "replacement session sent the continuation");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.ok(ledger.includes('"session_rebind_without_shutdown"'), "replacement without shutdown is ledgered");

  // A normal subagent startup with a different manager must still be ignored.
  const foreign = makeMockCtx(cwd, { sessionManager: { name: "subagent-session-manager" } });
  pi.sent.length = 0;
  await pi.fire("session_start", { reason: "startup" }, foreign);
  await tick();
  assert.equal(pi.sent.length, 0, "subagent startup did not steal host ownership");
});

test("v0.34.20: registered tools use the replacement invocation context without session_shutdown", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() });
  const first = await freshSession(cwd, "startup");
  await pi.command("goal", "resume", first);
  await tick();
  const replacement = ownerCtx(cwd);
  // Some pi replacement paths deliver session_start without a preceding
  // session_shutdown. The tool registry must not retain the first ctx.
  await pi.fire("session_start", { reason: "reload" }, replacement);
  const result = await pi.runTool("pause_goal", { reason: "replacement context probe", kind: "blocked" }, replacement);
  assert.match(result.content[0]!.text, /Goal paused/);
  assert.ok(replacement.ui.matching("replacement context probe").length >= 1, "replacement UI received the tool result");
  assert.equal(first.ui.matching("replacement context probe").length, 0, "registration-time UI was not reused");
});

test("T3e (v0.28.21): no active goal + queued list + reload → NOT activated by default; autoresume=on → head activates", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { list: [{ id: "item-1", objective: "queued head objective — done when pinned", addedAt: new Date().toISOString() }] });
  pi.sent.length = 0;
  const ctx = await freshSession(cwd, "reload");
  await tick();
  const s = readState(cwd);
  assert.equal(s.goal, null, "nothing activated by default");
  assert.ok(ctx.ui.matching("waiting").length >= 1, "waiting notify names the queue");
  assert.equal(pi.sent.length, 0, "no continuation fired");

  const cwd2 = tmpCwd();
  seedState(cwd2, { list: [{ id: "item-1", objective: "queued head objective — done when pinned", addedAt: new Date().toISOString() }] });
  setGlobalAutoResume(true);
  pi.sent.length = 0;
  const ctx2 = await freshSession(cwd2, "reload");
  await tick();
  const s2 = readState(cwd2);
  const g = s2.goal as { status: string; objective: string; policy: string } | null;
  assert.ok(g, "a goal exists after restore");
  assert.equal(g!.objective, "queued head objective — done when pinned");
  assert.equal(g!.policy, "list");
  assert.equal(g!.status, "active");
  assert.ok(ctx2.ui.matching("activated").length >= 1, "activation notify");
  assert.ok(pi.sent.length >= 1, "continuation sent for the activated head");
});

// ────────────────────────────────────────────────────────────────────
// v0.34.24 — accepted dispatch is not start proof
// ────────────────────────────────────────────────────────────────────

test("v0.34.24: continuation dispatch waits for owner start proof and clears its sidecar", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  pi.sent.length = 0;
  await pi.command("goal", "start dispatch proof target — done when pinned", ctx);
  await tick();
  assert.equal(pi.sent.length, 1, "the initial continuation was dispatched once");
  const content = pi.sent[0]!.message.content ?? "";
  const sidecar = path.join(cwd, ".pi-glla", "continuation-dispatch.json");
  assert.ok(fs.existsSync(sidecar), "accepted dispatch remains durably pending until a start proof");

  const foreign = makeMockCtx(cwd, { sessionManager: { name: "dispatch-proof-subagent" } });
  await pi.fire("before_agent_start", { prompt: content }, foreign);
  assert.ok(fs.existsSync(sidecar), "foreign-session start cannot acknowledge the main dispatch");

  await pi.fire("before_agent_start", { prompt: content }, ctx);
  assert.equal(fs.existsSync(sidecar), false, "owner before_agent_start acknowledges and clears the sidecar");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.match(ledger, /continuation_start_acknowledged/);
  assert.match(ledger, /"source":"before_agent_start"/);
  await pi.command("goal", "pause", ctx);
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
test("T2b: stale before compaction → no late rebind, refire, or misleading active UI", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "stale then compact — done when pinned", ctx);
  await tick();
  pi.sent.length = 0;
  pi.sendMessageError = staleError();
  const before = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  await pi.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "boundary" }], stopReason: "end_turn" }] }, ctx);
  await tick();
  pi.sendMessageError = null;
  // Reproduce the field ordering: pi invalidates the extension first, then
  // emits/finishes compaction, but never delivers session_start.
  await pi.fire("session_compact", {}, ctx);
  await pi.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "late old event" }], stopReason: "end_turn" }] }, ctx);
  await tick(2_200);
  const after = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  const g = readState(cwd).goal as { status: string; interruptedAt?: string };
  assert.equal(g.status, "active", "persisted goal remains recoverable");
  assert.ok(g.interruptedAt, "stale marker survives the later compact");
  assert.equal((after.match(/"extension_api_stale"/g) ?? []).length, 1, "stale terminal fires once");
  assert.doesNotMatch(after, /"compaction_refire"/, "late compact cannot schedule a refire");
  assert.doesNotMatch(after, /"compaction_grace_refire"/, "late compact cannot schedule a grace refire");
  assert.equal(pi.sent.length, 0, "no continuation is sent after stale terminal");
  const status = ctx.ui.statuses["pi-glla"] ?? "";
  assert.match(status, /interrupted — stale handle/);
  const widget = (ctx.ui.widgets["pi-glla"] as string[] | undefined) ?? [];
  assert.ok(widget.some((line) => line.includes("host session lost")), "widget identifies the orphaned host session");
  assert.ok(widget.some((line) => line.includes("/reload to rebind")), "widget gives lifecycle recovery guidance");
  assert.notEqual(after, before, "terminal marker and ledger are durably written");
});

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
  assert.match(res.content[0]!.text, /Wait for a fresh session_start/);
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
  setGlobalAutoResume(true); // v0.28.21: reload holds by default; this test needs the loop ACTIVE
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
  setGlobalAutoResume(true); // v0.28.21: keep the loop ACTIVE through the reload
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
  setGlobalAutoResume(true); // v0.28.21: keep the goal ACTIVE through the reload
  const ctx2 = await freshSession(cwd2, "reload");
  await pi.command("loop", "", ctx2); // enter loop drafting (slash-bar gate)
  const r3 = await pi.runTool("propose_loop_draft", { target: "loop over goal", measureCmd: "none" }, ctx2);
  assert.match(r3.content[0]!.text, /A goal is active/, "propose_loop_draft blocked over live goal");
});

test("one-active-thing: /goal resume guard remains; the load-time combo is auto-arbitrated (v0.29.6)", async () => {
  __testOnlyResetStaleFlag();
  // The 0.28.21 behavioral setup (paused goal + live loop after a reload)
  // is unreachable now: v0.29.6 arbitration resolves the stack AT LOAD.
  // The in-session guard stays (pause a goal → start a loop → /goal resume):
  const SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  assert.match(SRC, /A loop is active — one active thing/);
  const cwd = tmpCwd();
  seedState(cwd, {
    loop: seedLoop({ active: true, startedAt: "2026-07-30T00:00:00.000Z" }),
    goal: seedGoal({ status: "paused", objective: "paused goal — done when pinned", updatedAt: "2026-07-29T00:00:00.000Z" }),
  });
  setGlobalAutoResume(true); // keep the surviving loop ACTIVE through the reload
  const ctx = await freshSession(cwd, "reload");
  await tick();
  const s = readState(cwd);
  assert.equal((s.goal as { status: string }).status, "aborted", "older goal auto-archived at load");
  assert.equal((s.loop as { active: boolean }).active, true, "the surviving loop resumed");
  assert.ok(ctx.ui.matching("Stacked state auto-arbitrated").length >= 1, "arbitration notify");
});

test("v0.29.6: stacked state at load is AUTO-ARBITRATED — most recent activity keeps the slot, loser archived (supersedes the 0.28.21 picker)", async () => {
  __testOnlyResetStaleFlag();
  // (a) loop more recent → goal archived; the surviving loop is then held
  // by the restore gate (default hold-everything).
  const cwd = tmpCwd();
  seedState(cwd, {
    loop: seedLoop({ active: true, startedAt: "2026-07-30T00:00:00.000Z" }),
    goal: seedGoal({ updatedAt: "2026-07-29T00:00:00.000Z" }),
  });
  pi.sent.length = 0;
  const ctx = await freshSession(cwd, "startup");
  await tick();
  const s = readState(cwd);
  assert.equal((s.goal as { status: string }).status, "aborted", "the older goal was auto-archived");
  assert.equal((s.loop as { active: boolean }).active, false, "the surviving loop is then held by the restore gate");
  assert.ok(ctx.ui.matching("Stacked state auto-arbitrated").length >= 1, "arbitration notify");
  assert.equal(pi.sent.length, 0, "nothing fired");

  // (b) goal more recent → loop stopped with an honest reason; the goal survives (held).
  const cwd2 = tmpCwd();
  seedState(cwd2, {
    loop: seedLoop({ active: true, startedAt: "2026-07-28T00:00:00.000Z", iteration: 7 }),
    goal: seedGoal({ updatedAt: "2026-07-30T00:00:00.000Z" }),
  });
  pi.sent.length = 0;
  const ctx2 = await freshSession(cwd2, "startup");
  await tick();
  const s2 = readState(cwd2);
  assert.equal((s2.loop as { active: boolean; stopReason?: string }).active, false, "loop stopped");
  assert.match((s2.loop as { stopReason?: string }).stopReason ?? "", /auto-arbitrated/, "honest stop reason");
  assert.ok(s2.goal && (s2.goal as { status: string }).status !== "aborted", "the newer goal survives");
  assert.ok(ctx2.ui.matching("Stacked state auto-arbitrated").length >= 1, "arbitration notify");
});

test("carryover via /list next (pause): summary fires BEFORE the stale item activates; paused goal archived, held loop kept", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ status: "paused", objective: "stale paused goal" }),
    list: [seedListItem("carryover head item"), seedListItem("second item")],
    loop: seedLoop({ active: false, stopReason: HELD, target: "stale held loop" }),
  });
  const ctx = await freshSession(cwd, "startup");
  await pi.command("list", "next", ctx);
  await tick();
  const s = readState(cwd);
  assert.equal((s.goal as { status: string; objective: string }).status, "active", "head item activated");
  assert.match((s.goal as { objective: string }).objective, /carryover head item/);
  assert.equal((s.list as unknown[]).length, 1, "one item consumed");
  assert.equal((s.loop as { stopReason?: string })?.stopReason, HELD, "held loop kept under pause");
  assert.equal(ctx.ui.matching("Carryover from before this session").length, 1, "ONE summary on the list path too");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
  assert.ok(ledger.includes("replaced by new list (carryover)"), "paused goal archived on the list path");
});

test("carryover via /list next (clear): the stale queue is dropped BEFORE activation — nothing activates", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "settings.json"), JSON.stringify({ carryover: "clear" }));
  seedState(cwd, {
    goal: seedGoal({ status: "paused", objective: "stale paused goal" }),
    list: [seedListItem("stale item one"), seedListItem("stale item two")],
    loop: seedLoop({ active: false, stopReason: HELD, target: "stale held loop" }),
  });
  const ctx = await freshSession(cwd, "startup");
  await pi.command("list", "next", ctx);
  await tick();
  const s = readState(cwd);
  assert.ok(!s.goal || (s.goal as { status: string }).status !== "active", "NO stale item activated after clear");
  assert.equal((s.list as unknown[]).length, 0, "queue dropped before activation");
  assert.equal((s.loop as { stopReason?: string })?.stopReason, "cleared: carryover", "held loop dismissed");
  assert.ok(ctx.ui.matching("Carryover cleared").length >= 1, "clear summary shown");
  assert.ok(ctx.ui.matching("List is empty").length >= 1, "nothing-to-activate notice");
});

test("carryover=resume: legacy silent stacking — no summary, queue + held loop untouched", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "settings.json"), JSON.stringify({ carryover: "resume" }));
  seedState(cwd, {
    goal: seedGoal({ status: "paused", objective: "stale paused goal" }),
    list: [seedListItem("stale item one"), seedListItem("stale item two")],
    loop: seedLoop({ active: false, stopReason: HELD, target: "stale held loop" }),
  });
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "start fresh work — done when pinned", ctx);
  await tick();
  const s = readState(cwd);
  assert.equal((s.goal as { status: string }).status, "active", "new goal active");
  assert.equal((s.list as unknown[]).length, 2, "queue untouched (legacy stacking)");
  assert.equal((s.loop as { stopReason?: string })?.stopReason, HELD, "held loop untouched");
  assert.equal(ctx.ui.matching("Carryover").length, 0, "NO summary under resume (legacy silent)");
});


test("/list audit: queues a collect-only audit item with the restart-safe marker", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("list", "audit the renderer", ctx);
  await tick();
  const s = readState(cwd);
  const active = s.goal as { objective: string; policy: string } | null;
  const queued = s.list as Array<{ objective: string }>;
  const text = (active?.objective ?? "") + "|" + queued.map((i) => i.objective).join("|");
  assert.ok(text.includes("[LIST-AUDIT-COLLECT]"), `collect marker in the item: ${text.slice(0, 160)}`);
  assert.ok(text.includes("Scope: the renderer"), "focus threaded through");
  assert.ok(
    ctx.ui.matching("CHANGES NO CODE").length >= 1,
    "the route notify states the collect-only contract",
  );
});

// ---- v0.28.23: decision picker popup (/goal decide) ----

function seedDecisionGoal(): Record<string, unknown> {
  return seedGoal({
    status: "paused",
    pauseKind: "decision",
    pauseReason: "auditor disapproved completion — pick a path",
    pauseOptions: ["Fix the disapproval gap, then continue (/goal resume)", "Tweak the objective — /goal tweak <new text>", "Cancel the goal (/goal cancel)"],
    pauseRecommended: 1,
    pauseSuggestedAction: "Pick one, then /goal resume.",
  });
}

test("/goal decide: content pick → decision sent to the agent + goal resumes", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedDecisionGoal() });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  assert.equal((readState(cwd).goal as { status: string }).status, "paused", "decision pause survives reload");
  // Swap in content-only options (the seeded defaults are command options).
  const g0 = readState(cwd).goal as unknown as Record<string, unknown>;
  g0.pauseOptions = ["Surgical Done when: clause", "Deliver the missing polish (~2-3 hours)", "Reword the objective to accept SUPERSEDED"];
  g0.pauseRecommended = 3;
  // v0.30.0: rewrite the last STATE entry in place — session_start now
  // also ledgers session_rebound, so the last line is no longer
  // guaranteed to be a state entry (and truncating the ledger drops
  // history readState still needs).
  const lines = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8").trim().split("\n");
  const stateIdx = lines.map((l) => (JSON.parse(l) as { type?: string }).type).lastIndexOf("state");
  assert.ok(stateIdx >= 0, "a state entry exists to rewrite");
  const entry = JSON.parse(lines[stateIdx]!);
  entry.value.goal = g0;
  lines[stateIdx] = JSON.stringify(entry);
  fs.writeFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), lines.join("\n") + "\n");
  // Re-load so the module state picks up the content options.
  const ctx2 = await freshSession(cwd, "reload");
  await tick();
  const ui = (ctx2 as { ui: { selectImpl?: (t: string, o: string[]) => Promise<string | undefined> } }).ui;
  let shownTitle = "";
  ui.selectImpl = (title, options) => {
    shownTitle = title;
    return Promise.resolve(options[0]); // a content option
  };
  await pi.command("goal", "decide", ctx2);
  await tick();
  assert.match(shownTitle, /Decision needed — seeded test objective/);
  assert.match(shownTitle, /auditor disapproved completion/);
  const msgs = pi.userMessages.map((m) => m.message);
  assert.ok(msgs.some((m) => /Decision for the paused goal .*Surgical Done when: clause/.test(m)), `decision message: ${msgs.join(" | ")}`);
  const g = readState(cwd).goal as { status: string; pauseKind?: string; pauseOptions?: string[] };
  assert.equal(g.status, "active", "pick resumes the goal");
  assert.equal(g.pauseKind, undefined, "pause fields cleared on resume");
});

test("/goal decide: Escape (undefined) → goal stays paused, nothing sent", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedDecisionGoal() });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  const before = pi.userMessages.length;
  await pi.command("goal", "decide", ctx); // mock select returns undefined by default = Escape
  await tick();
  assert.equal((readState(cwd).goal as { status: string }).status, "paused");
  assert.equal(pi.userMessages.length, before, "no decision message on Escape");
});

test("/goal decide: command option (/goal cancel) runs the command, not a message", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedDecisionGoal() });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  const ui = (ctx as { ui: { selectImpl?: (t: string, o: string[]) => Promise<string | undefined> } }).ui;
  ui.selectImpl = (_t, options) => Promise.resolve(options[2]); // "Cancel the goal (/goal cancel)"
  const before = pi.userMessages.length;
  await pi.command("goal", "decide", ctx);
  await tick();
  const g = readState(cwd).goal as { status: string } | null;
  assert.ok(!g || g.status === "aborted", `goal aborted via command pick, got ${g?.status}`);
  assert.equal(pi.userMessages.length, before, "command picks don't message the agent");
});

test("/goal decide: no pending decision → notify, no picker", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() }); // active, no pause
  const ctx = await freshSession(cwd, "reload");
  await tick();
  await pi.command("goal", "decide", ctx);
  const ui = ctx.ui as unknown as { matching(sub: string): Array<{ message: string }> };
  assert.ok(ui.matching("No pending decision").length > 0, "explains why no picker opened");
});

// ---- v0.28.24: goal ids are internal plumbing — user-facing surfaces never show them ----

test("/goal status + /goal pause: no goal id in user-facing text (v0.28.24)", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  const g = readState(cwd).goal as { id: string; objective: string };
  const ui = ctx.ui as unknown as { matching(sub: string): Array<{ message: string }> };

  await pi.command("goal", "status", ctx);
  const statusMsgs = ui.matching("seeded test objective");
  assert.ok(statusMsgs.length > 0, "status shows the objective");
  assert.ok(!statusMsgs.some((m) => m.message.includes(g.id)), `status must not show the id ${g.id}`);
  assert.ok(!statusMsgs.some((m) => m.message.startsWith("[20")), "no [id] tag prefix");

  await pi.command("goal", "pause", ctx);
  const pauseMsgs = ui.matching("paused");
  assert.ok(pauseMsgs.length > 0, "pause notifies");
  assert.ok(!pauseMsgs.some((m) => m.message.includes(g.id)), "pause notify names the objective, not the id");
  assert.ok(pauseMsgs.some((m) => /paused/.test(m.message) && /seeded test objective/.test(m.message)), "pause notify carries the short objective");
});

test("goal-start notify has no (id: …) suffix (v0.28.24 source pin)", () => {
  const src = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  assert.ok(!src.includes("(id: ${goal.id})"), "started/saved notifies dropped the id suffix");
  assert.ok(!src.includes("List item ${state.goal.id} paused"), "list-pause notify names the item");
});

// ────────────────────────────────────────────────────────────────────
// v0.34.20: behavioral lifecycle coverage for delayed work. The source pins
// catch wiring drift; these tests hold an actual async operation across a
// replacement and prove the old generation cannot mutate the new session.

 test("v0.34.21 lifecycle: completion audit from a replaced generation leaves the stored claim intact", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const first = await freshSession(cwd, "startup");
  await pi.command("goal", "start lifecycle completion target — done when pinned", first);
  await tick();
  const originalModel = (first as unknown as { model: unknown }).model;
  try {
    // No model makes the isolated auditor return immediately without a
    // provider call; the replacement is delivered at its await boundary.
    (first as unknown as { model: unknown }).model = undefined;
    const audit = pi.runTool("complete_goal", {
      completionSummary: "The lifecycle regression is covered.",
      verificationSummary: "The replacement session must retain this claim.",
    }, first);
    await Promise.resolve();
    const claimed = readState(cwd).goal as { status: string; pendingCompletion?: { completionSummary?: string; phase?: string; attemptId?: string } };
    assert.equal(claimed.status, "auditing", "the claim is persisted before the auditor starts");
    assert.equal(claimed.pendingCompletion?.completionSummary, "The lifecycle regression is covered.");
    assert.equal(claimed.pendingCompletion?.phase, "running", "the durable claim records an active audit attempt");
    assert.ok(claimed.pendingCompletion?.attemptId, "the attempt has a durable id");

    const replacement = ownerCtx(cwd);
    await pi.fire("session_start", { reason: "reload" }, replacement);
    const result = await audit;
    assert.match(result.content[0]!.text, /detached auditor queued|verdict will be applied asynchronously/i, "complete_goal returns without waiting on the old generation");

    const after = readState(cwd).goal as { status: string; pendingCompletion?: { completionSummary?: string; phase?: string } };
    assert.ok(["auditing", "paused"].includes(after.status), "the replacement keeps the audit lifecycle recoverable");
    assert.equal(after.pendingCompletion?.completionSummary, "The lifecycle regression is covered.", "the durable claim survived");
    assert.ok(["running", "recovery-pending"].includes(after.pendingCompletion?.phase ?? ""), "the fresh lifecycle uses an explicit phase");
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.match(ledger, /"audit_recovery_pending"/, "replacement marks the old attempt as recovery-pending");
    assert.match(ledger, /"audit_recovery_started"/, "replacement starts a fresh stored-claim attempt immediately");
    assert.doesNotMatch(ledger, /"goal_archived"/, "the stale audit did not archive the goal");
    assert.equal(first.ui.matching("Goal complete").length, 0, "the old UI did not receive a completion notice");
    assert.equal(first.ui.matching("auditor approved").length, 0, "the old generation did not apply a detached result");
    await pi.fire("session_shutdown", { reason: "quit" }, replacement);
  } finally {
    (first as unknown as { model: unknown }).model = originalModel;
  }
});

test("v0.34.22: complete_goal returns while a detached auditor finishes and archives approval", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const fakePi = writeFakeAuditor(cwd, "approved", 350);
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = fakePi;
  try {
    const ctx = await freshSession(cwd, "startup");
    await pi.command("goal", "start detached approval target — done when pinned", ctx);
    await tick();
    const started = Date.now();
    const result = await pi.runTool("complete_goal", {
      completionSummary: "The detached completion path is covered.",
      verificationSummary: "The fake auditor will inspect the pinned artifact.",
    }, ctx);
    const elapsed = Date.now() - started;
    assert.match(result.content[0]!.text, /detached auditor queued/i);
    assert.ok(elapsed < 300, `complete_goal waited ${elapsed}ms for the worker`);
    const claimed = readState(cwd).goal as { status: string; pendingCompletion?: { phase?: string } };
    assert.equal(claimed.status, "auditing", "claim is durable before the detached result");
    assert.equal(claimed.pendingCompletion?.phase, "running");
    await waitUntil(() => (readState(cwd).goal as { status?: string } | null)?.status === "complete");
    assert.ok(fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").includes('"goal_archived"'), "approval archived the goal");
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  } finally {
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.34.22: detached disapproval resumes the goal with a durable report", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const fakePi = writeFakeAuditor(cwd, "disapproved", 0);
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = fakePi;
  try {
    const ctx = await freshSession(cwd, "startup");
    await pi.command("goal", "start detached disapproval target — done when pinned", ctx);
    await tick();
    await pi.runTool("complete_goal", { completionSummary: "Claim", verificationSummary: "Evidence" }, ctx);
    await waitUntil(() => {
      const goal = readState(cwd).goal as { status?: string; pendingCompletion?: unknown; auditHistory?: unknown[] } | null;
      return goal?.status === "active" && !goal.pendingCompletion && (goal.auditHistory?.length ?? 0) > 0;
    });
    const goal = readState(cwd).goal as { status: string; auditHistory?: Array<{ disapproved?: boolean }> };
    assert.equal(goal.status, "active");
    assert.equal(goal.auditHistory?.at(-1)?.disapproved, true);
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  } finally {
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.34.22: an old detached result cannot archive after session replacement", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const fakePi = writeFakeAuditor(cwd, "approved", 450);
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = fakePi;
  try {
    const first = await freshSession(cwd, "startup");
    await pi.command("goal", "detached stale result target — done when pinned", first);
    await tick();
    await pi.runTool("complete_goal", { completionSummary: "old claim", verificationSummary: "old evidence" }, first);
    const before = readState(cwd).goal as { status: string; pendingCompletion?: { attemptId?: string } };
    assert.equal(before.status, "auditing");
    const oldAttempt = before.pendingCompletion?.attemptId;
    assert.ok(oldAttempt);

    await pi.fire("session_shutdown", { reason: "quit" }, first);
    const replacement = await freshSession(cwd, "startup");
    await new Promise((resolve) => setTimeout(resolve, 900));
    const after = readState(cwd).goal as { status: string; pendingCompletion?: { attemptId?: string; phase?: string } } | null;
    assert.ok(after, "replacement retained the goal instead of archiving it");
    assert.equal(after?.pendingCompletion?.attemptId, oldAttempt, "cold replacement kept the stored claim for explicit resume");
    assert.equal(after?.pendingCompletion?.phase, "recovery-pending");
    assert.notEqual(after?.status, "complete");
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.doesNotMatch(ledger, /"goal_archived"/, "the old worker result cannot archive after replacement");
    await pi.fire("session_shutdown", { reason: "quit" }, replacement);
  } finally {
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.34.21 lifecycle: cold startup holds a recovered claim until explicit resume", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({
      status: "auditing",
      pendingCompletion: {
        completionSummary: "saved claim",
        verificationSummary: "saved evidence",
        at: new Date().toISOString(),
        phase: "running",
        attemptId: "old-attempt",
      },
    }),
  });
  const ctx = await freshSession(cwd, "startup");
  await tick();
  const goal = readState(cwd).goal as { status: string; pendingCompletion?: { phase?: string } };
  assert.equal(goal.status, "auditing", "cold startup does not auto-run the stored audit");
  assert.equal(goal.pendingCompletion?.phase, "recovery-pending", "old running attempt is made explicit");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.doesNotMatch(ledger, /"audit_recovery_started"/, "no recovery starts without lifecycle/explicit consent");
  assert.ok(ctx.ui.matching("Completion audit recovery is pending").length >= 1, "the hold is explained");
  assert.ok((ctx.ui.widgets["pi-glla"] as string[]).some((line) => line.includes("recovery pending")), "the widget does not claim the auditor is running");
});

test("v0.34.20 lifecycle: fan-out confirmation from the old generation cannot queue into its replacement", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const first = await freshSession(cwd, "startup");
  const findingsDir = path.join(cwd, ".pi-glla", "audit-loop");
  fs.mkdirSync(findingsDir, { recursive: true });
  fs.writeFileSync(path.join(findingsDir, "findings.md"), "- [ ] HIGH: lifecycle finding (goal.ts:1)\n");

  let confirmEntered = false;
  let releaseConfirm!: (value: boolean) => void;
  const confirmation = new Promise<boolean>((resolve) => { releaseConfirm = resolve; });
  first.ui.confirmImpl = async () => {
    confirmEntered = true;
    return confirmation;
  };
  const fanout = __testOnlyRunFanOutListAuditFindings(cwd);
  for (let i = 0; i < 50 && !confirmEntered; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(confirmEntered, true, "fan-out reached the confirmation boundary");

  const replacement = ownerCtx(cwd);
  await pi.fire("session_start", { reason: "reload" }, replacement);
  releaseConfirm(true);
  await fanout;

  const after = readState(cwd);
  assert.equal(after.list?.length ?? 0, 0, "old confirmation did not enqueue into the replacement session");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.doesNotMatch(ledger, /"list_audit_fanout"/, "no stale fan-out mutation was ledgered");
  assert.equal(replacement.ui.matching("Queued ").length, 0, "replacement UI did not claim the old consent landed");
  await pi.fire("session_shutdown", { reason: "quit" }, replacement);
});

test("v0.34.20 lifecycle: loop measurement abandons the old generation after replacement", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({ active: true, measureCmd: "echo 7" }) });
  setGlobalAutoResume(true); // keep the seeded loop active through reload
  let measureStarted = false;
  let releaseMeasure!: () => void;
  const measureGate = new Promise<void>((resolve) => { releaseMeasure = resolve; });
  let calls = 0;
  pi.execHandler = async () => {
    calls++;
    measureStarted = true;
    await measureGate;
    return { code: 0, stdout: "7", stderr: "" };
  };
  try {
    const first = await freshSession(cwd, "reload");
    const oldTick = pi.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "measured" }], stopReason: "end_turn" }] }, first);
    for (let i = 0; i < 50 && !measureStarted; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(measureStarted, true, "loop tick reached the asynchronous measure");

    const replacement = ownerCtx(cwd);
    await pi.fire("session_start", { reason: "reload" }, replacement);
    // Prevent the replacement's restore scheduling from starting another turn;
    // the assertion is about the already-running old tick.
    await pi.fire("session_shutdown", { reason: "quit" }, replacement);
    releaseMeasure();
    await oldTick;

    const loop = readState(cwd).loop as { iteration: number; lastValue?: number | null };
    assert.equal(loop.iteration, 1, "the old tick did not advance the persisted loop");
    assert.equal(loop.lastValue, null, "the old measure did not update loop state");
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.equal((ledger.match(/"loop_measured"/g) ?? []).length, 0, "the old tick did not persist a measurement");
    assert.equal(calls, 1, "replacement cleanup prevented a second old-generation measure");
  } finally {
    releaseMeasure();
    pi.execHandler = null;
  }
});

test("v0.34.25: a resolved auditor model failure advances to the session fallback without a verdict", async () => {
  const calls: string[] = [];
  const result = await runDetachedCompletionWithFallback(
    [
      { model: "provider/primary", via: "setting" },
      { model: "provider/session", via: "session-fallback" },
    ],
    async (candidate) => {
      calls.push(candidate.model as string);
      if (candidate.via === "setting") {
        return {
          approved: false,
          disapproved: false,
          output: "",
          model: candidate.model as string,
          thinkingLevel: "high",
          error: "pi exited without an agent_settled RPC event",
        };
      }
      return {
        approved: true,
        disapproved: false,
        output: "<evidence>fallback read</evidence>\\n<approved/>",
        model: candidate.model as string,
        thinkingLevel: "high",
      };
    },
    { sleep: async () => {}, shouldRetry: () => true },
  );
  assert.deepEqual(calls, ["provider/primary", "provider/primary", "provider/session"], "the primary is retried once, then the session fallback is detached");
  assert.equal(result.result.approved, true);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.via, "session-fallback");
});
