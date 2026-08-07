// pi-goal-list-loop-audit — v0.34.51
// tests/mode-command-guidance.test.ts
//
// Pins the "centralize mode-aware pause, tweak, and resume commands" goal
// (20260805064515-ha8se5): generated auditor, stall, continuation, and pause
// guidance must render `/goal ...` for standalone goals and `/list ...` for
// list items — with regression tests at three levels:
//   1. source pins — no hardcoded `/goal <cmd>` literals left in generated
//      guidance strings (goal.ts), mode-aware widget strings (display.ts);
//   2. behavioral — `/list pause` on a list-policy item notifies with
//      "/list resume to continue" while `/goal pause` says "/goal resume";
//   3. widget — the wait countdown and no-verdict fallback render the
//      mode-correct resume command.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, tick, type MockCtx } from "./harness/mock-pi.js";
import { buildWidgetLines } from "../extensions/goal-loop-display.js";
import type { Goal } from "../extensions/goal-loop-core.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true } : {}));
}
afterEach(() => {
  setGlobalAutoResume(false);
  pi.execHandler = null;
  __testOnlyResetOwnerSession(); // release the shared owner claim so later/parallel files are unaffected
});

const GOAL_SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
const DISPLAY_SRC = fs.readFileSync("extensions/goal-loop-display.ts", "utf-8");
const CORE_SRC = fs.readFileSync("extensions/goal-loop-core.ts", "utf-8");

const pi = new MockPi();
activate(pi.api);
const MAIN_SM = { name: "main-session-manager" };
function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}
async function freshSession(cwd: string, reason: string): Promise<MockCtx> {
  __testOnlyResetOwnerSession(); // behavioral-orchestrator's owner claim precedes this file (shared process)
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason }, ctx);
  return ctx;
}

const NOW = Date.parse("2026-07-21T12:00:00Z");
function goalOf(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "20260721120000-abcdef",
    objective: "Create x.txt containing ok",
    status: "active",
    policy: "goal",
    autoContinue: true,
    usage: { tokensUsed: 12_400, tokensLimit: 1_000_000 },
    createdAt: "2026-07-21T11:57:00Z",
    updatedAt: "2026-07-21T11:57:00Z",
    ...overrides,
  };
}

// ---- level 1: source pins ----

test("mode-aware helpers exist and route by policy", () => {
  assert.match(CORE_SRC, /export function workCommandRoot\(mode: Policy \| "loop" \| undefined\)/);
  assert.match(CORE_SRC, /export function workCommand\(/);
  assert.match(GOAL_SRC, /const activeGoalSurfaceCommand = \(command: string\): string => workCommand\(state\.goal\?\.policy, command\);/);
  assert.match(GOAL_SRC, /const activeGoalStatusCommand = \(\): string => state\.goal\?\.policy === "list" \? `\$\{activeGoalRoot\(\)\} show` : `\$\{activeGoalRoot\(\)\} status`;/);
});

test("no hardcoded /goal <cmd> literals remain in generated guidance (goal.ts)", () => {
  // Generated guidance = strings attached to notifications, pause actions,
  // tool texts, and status lines. Routing literals (command parsing,
  // mode-aware ternaries, ledger `via:` values) are intentionally excluded.
  // Allowed: deliberate SURFACE MAPS that enumerate every surface's real
  // commands (tool vocabulary descriptions, the /glla status deep map) —
  // these are cross-surface references, not active-surface guidance.
  const SURFACE_MAP = [/deep: \/goal status/, /\/list remove N/, /status\|pause\|resume\|cancel\|tweak/];
  const hard: string[] = [];
  for (const [i, raw] of GOAL_SRC.split("\n").entries()) {
    const s = raw.trim();
    if (s.startsWith("//") || s.startsWith("*")) continue;
    if (!/(pauseSuggestedAction|notify\(|lines\.push|text:|description:)/.test(raw)) continue;
    if (/["`][^"`]*\/goal (pause|resume|tweak|cancel|decide|status)/.test(raw)) {
      if (SURFACE_MAP.some((re) => re.test(raw))) continue;
      hard.push(`${i + 1}: ${s.slice(0, 120)}`);
    }
  }
  assert.deepEqual(hard, [], "hardcoded /goal guidance literals");
  // The helper is actually used across all four command kinds.
  for (const cmd of ["pause", "resume", "tweak", "cancel", "decide"]) {
    assert.ok(GOAL_SRC.includes(`activeGoalSurfaceCommand("${cmd}")`), `${cmd} guidance is interpolated`);
  }
  assert.ok(GOAL_SRC.includes("activeGoalStatusCommand()"), "status guidance is interpolated");
});

test("widget resume hints are mode-aware ternaries (display.ts)", () => {
  const ternaries = DISPLAY_SRC.match(/isList \? "\/list resume" : "\/goal resume"/g) ?? [];
  // v0.34.64: the wait-countdown ternary was removed (the auto-retrying line
  // owns the wait now, no manual nudge); interrupted-card hint + no-verdict
  // fallback remain.
  assert.ok(ternaries.length >= 2, `expected >=2 mode-aware resume ternaries, got ${ternaries.length}`);
});

// ---- level 2: behavioral (pause guidance) ----

test("goal-policy pause notifies with /goal resume", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ policy: "goal", status: "active" }) });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  await pi.command("goal", "pause", ctx);
  assert.ok(ctx.ui.matching("/goal resume to continue").length >= 1, "goal pause says /goal resume");
  assert.equal(ctx.ui.matching("/list resume").length, 0, "goal pause must not say /list resume");
});

test("list-policy pause notifies with /list resume", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ policy: "list", status: "active", objective: "list item one — done when pinned" }),
    list: [{ id: "w1", objective: "waiting item", addedAt: new Date().toISOString() }],
  });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  await pi.command("list", "pause", ctx);
  assert.ok(ctx.ui.matching("/list resume to continue").length >= 1, "list pause says /list resume");
  assert.equal(ctx.ui.matching("/goal resume").length, 0, "list pause must not say /goal resume");
});

// ---- level 3: widget rendering ----

test("widget wait countdown is uniform auto-retrying (no manual resume hint — v0.34.64)", () => {
  // v0.34.64: the wait card no longer nudges "or /goal resume now" — the
  // auto-retrying line owns the wait (autoResume:true honors "keep going";
  // the recovery-cleared path un-parks when the condition resolves). Both
  // goal and list cards show the same uniform countdown.
  const base = {
    status: "paused" as const,
    pauseReason: "waiting for provider window",
    pauseKind: "wait" as const,
    pauseResumeAt: new Date(NOW + 60_000).toISOString(),
    autoResume: true,
  };
  const goalCard = buildWidgetLines({ goal: goalOf(base) }, null, NOW)!;
  assert.ok(goalCard.some((l) => l.includes("auto-retrying") && l.includes("next probe in")), `goal card: ${goalCard.join("\n")}`);
  assert.ok(!goalCard.some((l) => l.includes("resume now")), "no manual resume nudge on the wait card");
  const listCard = buildWidgetLines({ goal: goalOf({ ...base, policy: "list" }) }, null, NOW)!;
  assert.ok(listCard.some((l) => l.includes("auto-retrying") && l.includes("next probe in")), `list card: ${listCard.join("\n")}`);
  assert.ok(!listCard.some((l) => l.includes("/goal resume now")), "list card must not say /goal resume now");
});

test("widget no-verdict fallback action is mode-aware", () => {
  const base = {
    status: "paused" as const,
    pauseReason: "completion audit blocked — no verdict",
    pauseSuggestedAction: undefined,
    pauseKind: "blocked" as const,
    pendingCompletion: {
      completionSummary: "claim",
      at: new Date(NOW - 5_000).toISOString(),
      phase: "recovery-pending" as const,
    },
  };
  const goalCard = buildWidgetLines({ goal: goalOf(base) }, null, NOW)!;
  assert.ok(goalCard.some((l) => l.includes("/goal resume starts one fresh auditor")), `goal fallback: ${goalCard.join("\n")}`);
  const listCard = buildWidgetLines({ goal: goalOf({ ...base, policy: "list" }) }, null, NOW)!;
  assert.ok(listCard.some((l) => l.includes("/list resume starts one fresh auditor")), `list fallback: ${listCard.join("\n")}`);
  assert.ok(!listCard.some((l) => l.includes("/goal resume starts one fresh auditor")), "list fallback must not say /goal resume");
});
