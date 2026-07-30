// pi-goal-list-loop-audit — v0.26.1
// tests/stall-handling.test.ts
//
// Stall handling: send-path ledger instrumentation, refire-streak
// escalation, compaction hook, widget surface. Motivating incident:
// hegemon 2026-07-25/26 — 619 heartbeat_refires over 23.5h with zero
// loop turns; the send path was silent and the nudge counter (which
// counts TURNS) could never catch a zombie that runs none.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_STALL_ESCALATION_REFIRES,
  shouldEscalateStall,
} from "../extensions/goal-loop-core.ts";
import { loadSettings, saveSettings } from "../extensions/goal-settings.ts";
import { buildStatusText, buildWidgetLines } from "../extensions/goal-loop-display.ts";

const SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");

test("escalation gate: threshold semantics (0 = never, N = fire at streak N)", () => {
  assert.equal(shouldEscalateStall(5, 5), true);
  assert.equal(shouldEscalateStall(4, 5), false);
  assert.equal(shouldEscalateStall(6, 5), true);
  assert.equal(shouldEscalateStall(999, 0), false, "0 disables escalation (legacy spin)");
  assert.equal(DEFAULT_STALL_ESCALATION_REFIRES, 5);
});

test("send paths are ledgered: sent AND failed, loop and goal", () => {
  for (const ev of ["loop_turn_sent", "loop_turn_send_failed", "goal_continuation_sent", "goal_continuation_send_failed"]) {
    assert.ok(SRC.includes(`"${ev}"`), `missing ledger event ${ev}`);
  }
  // The failure branch must capture the error message (was: silent catch).
  assert.match(SRC, /loop_turn_send_failed", \{ error: err instanceof Error/);
});

test("refire streak: incremented on refire, ledgered, reset only on REAL activity", () => {
  assert.match(SRC, /consecutiveStalls\+\+;\n\s*appendLedger\(ctx\.cwd, "heartbeat_refire", \{ nudgesSoFar: heartbeatNudges, consecutiveStalls \}\)/);
  // agent_end and tool_call are real activity:
  assert.match(SRC, /if \(isForeignCtx\(ctx\)\) return;\n\s*noteActivity\(true\);/);
  assert.match(SRC, /toolCallsThisTurn\+\+;\n\s*noteActivity\(true\);/);
  // the heartbeat refire itself must NOT reset the streak:
  const def = SRC.match(/function noteActivity\(real = false\): void \{[\s\S]*?\}/)![0];
  assert.match(def, /if \(real\) consecutiveStalls = 0;/);
});

test("escalation: streak at threshold stops the loop / pauses the goal, loudly", () => {
  // v0.26.5: the escalation block is shared via escalateStallNow(ctx, threshold):
  assert.match(SRC, /function escalateStallNow\(ctx: ExtensionContext, threshold: number\): boolean/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "stall_escalated", \{ threshold, kind:/);
  assert.match(SRC, /stalled: \$\{threshold\} continuation refires landed no turn/);
  assert.match(SRC, /notifyExternal\(ctx, "Loop stopped: stalled \(continuation not landing\)\."\)/);
  assert.match(SRC, /notifyExternal\(ctx, `\$\{goalNoun\(\)\} paused: stalled \(continuation not landing\)\."?`?\)/);
  // the escalation return happens BEFORE the schedule (no more refires):
  const escIdx = SRC.indexOf('"stall_escalated"');
  const refireScheduleIdx = SRC.indexOf('re-firing continuation (stall');
  assert.ok(escIdx < refireScheduleIdx, "escalation precedes the refire schedule");
});

test("session_compact hook: re-arms the chain when idle with no timer pending", () => {
  assert.match(SRC, /pi\.on\("session_compact", async \(_event: any, ctx: ExtensionContext\) => \{/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "session_compact", \{\}\)/);
  assert.match(SRC, /appendLedger\(c\.cwd, "compaction_refire", \{\}\)/);
  // only when nothing is scheduled and the session is idle:
  assert.match(SRC, /c\.isIdle\(\) && !c\.hasPendingMessages\(\) && continuationTimer === null && loopTimer === null && isSupervising\(\)/);
});

test("widget + status surface the streak only while nonzero", () => {
  const loop = {
    active: true, target: "reconcile the spec", measureCmd: "", iteration: 0,
    maxIterations: 0, stallCount: 0, plateauWindow: 5, startedAt: new Date(Date.now() - 3600_000).toISOString(),
    history: [],
  };
  const state: any = { loop, goal: undefined, list: [] };
  const quiet = buildWidgetLines(state, null, Date.now(), undefined, undefined, { stalls: 0 })!;
  const stalled = buildWidgetLines(state, null, Date.now(), undefined, undefined, { stalls: 3 })!;
  assert.ok(!quiet.some((l) => l.includes("stalls:")), "no stalls note at 0");
  assert.ok(stalled.some((l) => l.includes("stalls:3")), "stalls note at 3");
  const statusQuiet = buildStatusText(state, null, Date.now(), undefined, { stalls: 0 })!;
  const statusStalled = buildStatusText(state, null, Date.now(), undefined, { stalls: 7 })!;
  assert.ok(!statusQuiet.includes("stalls:"));
  assert.ok(statusStalled.includes("stalls:7"));
});

test("settings: stallEscalationRefires round-trips through save/load", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-stall-"));
  saveSettings("project", dir, { stallEscalationRefires: 3 });
  assert.equal(loadSettings(dir).stallEscalationRefires, 3);
  saveSettings("project", dir, { stallEscalationRefires: 0 });
  assert.equal(loadSettings(dir).stallEscalationRefires, 0, "0 persists (never-escalate opt-out)");
});

test("/glla surface: stallescalation completion + key=value parser branch", () => {
  assert.match(SRC, /\["stallescalation=", "N: heartbeat refires without a turn/);
  assert.match(SRC, /key === "stallescalation" \|\| key === "stallescalationrefires"/);
});

// =================================================================
// v0.28.4 — P1–P3 (audit Stream 5): nudge before the brake; unclosed-status
// block in every continuation; post-restore grace.
// =================================================================

const PROMPT = fs.readFileSync("prompts/goal-loop-continuation.md", "utf-8");

test("P1: graduated stall escalation entry before the brake (sender + wiring)", () => {
  assert.match(SRC, /function sendStallEscalation\(ctx: ExtensionContext, nudges: number\): void/);
  assert.match(SRC, /\[STALL WARNING \$\{nudges\}\/\$\{HEARTBEAT_MAX_NUDGES\}\] The last turn produced no tool calls\./);
  assert.match(SRC, /If the goal is DONE, call complete_goal NOW — prose closes nothing/);
  assert.match(SRC, /If you are BLOCKED, call pause_goal with the blocker and a suggested action\./);
  assert.match(SRC, /ONE more unproductive turn pauses the goal\./);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "stall_escalation_nudge", \{ nudges, remaining \}\)/);
  // wired at nudge>=1 for active goals only (loops keep runLoopTick), and the
  // send path is stale-aware like every other autonomous send:
  assert.match(SRC, /if \(heartbeatNudges >= 1 && state\.goal && state\.goal\.status === "active" && !isLoopActive\(\)\)/);
  assert.match(SRC, /goStaleTerminal\(ctx, "sendStallEscalation"\)/);
});

test("P2: every continuation carries the unclosed-status block", () => {
  assert.match(PROMPT, /## State\n\n\*\*State: ACTIVE — not yet auditor-approved\.\*\*/);
  assert.match(PROMPT, /Prose closes nothing/);
  assert.match(PROMPT, /A done-but-unclosed goal is a bug, not a resting state\./);
  // and the STALLS section names the graduated warning:
  assert.match(PROMPT, /\[STALL WARNING n\/3\]/);
});

test("P3: post-restore grace — armed on restore resume, skips accounting, ledgered", () => {
  assert.match(SRC, /let postRestoreGraceTurns = 0;/);
  assert.match(SRC, /postRestoreGraceTurns = 2;\n        scheduleContinuation\(ctx, true\);/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "post_restore_grace", \{ remaining: postRestoreGraceTurns \}\)/);
  // grace check sits BEFORE the accounting call:
  const graceIdx = SRC.indexOf("if (postRestoreGraceTurns > 0) {");
  const acctIdx = SRC.indexOf("heartbeatNudges = accountTurnForNudgesRich(");
  assert.ok(graceIdx > 0 && graceIdx < acctIdx, "grace precedes nudge accounting");
});

test("v0.28.24: session_compact resets the send-rearm storm streaks + opens the post-compaction grace", () => {
  // π-web nearly escalated a "send-retry storm" pause during a legitimate
  // 3.5-minute compaction; junk-runner burned all 5 stall refires in the 5
  // minutes right after a 196k-token compact. Both are fixed at the hook:
  const hookIdx = SRC.indexOf('pi.on("session_compact"');
  const resetIdx = SRC.indexOf("continuationRearmStreak = 0; continuationRearmSince = 0;\n    loopRearmStreak = 0; loopRearmSince = 0;\n    compactionGraceUntil = Date.now() + COMPACTION_GRACE_MS;");
  assert.ok(hookIdx > 0 && resetIdx > hookIdx, "streak reset + grace arm inside the session_compact hook");
  assert.match(SRC, /const COMPACTION_GRACE_MS = 3 \* 60_000;/);
  // the grace check gates the heartbeat's stall/refire machinery:
  assert.match(SRC, /if \(Date\.now\(\) < compactionGraceUntil\) return;/);
  const graceGate = SRC.indexOf("if (Date.now() < compactionGraceUntil) return;");
  const refire = SRC.indexOf('appendLedger(ctx.cwd, "heartbeat_refire"');
  assert.ok(graceGate > 0 && graceGate < refire, "grace gate precedes the refire path");
});

test("v0.29.1: completion lifecycle survives the wedged-queue window (storm suppression + stranded recovery + brake cap)", () => {
  const src = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  // 1. The storm escalation NEVER pauses the audit lifecycle — an isolated
  //    auditor's minutes of silence is the storm detector's exact trigger
  //    shape (pully/hellhunter/junk-runner: "complete ending in a pause
  //    retry storm"). The audit lifecycle owns its own pauses.
  const escIdx = src.indexOf("function escalateSendRearmStorm");
  const esc = src.slice(escIdx, escIdx + 3000);
  assert.ok(esc.indexOf('status === "auditing" || completionAuditInFlight || state.goal.pendingCompletion') < esc.indexOf('state.goal.status === "active"'),
    "the audit-lifecycle suppression precedes the active-goal pause");
  assert.match(esc, /send_rearm_escalated_suppressed/);
  // 2. Stranded-audit watchdog: "auditing" with no in-flight audit = the
  //    result never landed (pully: 12h+ stuck). Stored claim → direct
  //    auditor retry; else resume active so the agent re-completes.
  const hbIdx = src.indexOf("function heartbeatTick");
  const hb = src.slice(hbIdx, hbIdx + 4200);
  assert.match(hb, /stranded_audit_recovered/);
  assert.match(hb, /state\.goal\?\.status === "auditing" &&\s*\n\s*!completionAuditInFlight/);
  assert.match(hb, /retryStoredCompletionAudit\(ctx, "quota-retry"\)/);
  assert.ok(hb.indexOf("stranded_audit_recovered") < hb.indexOf("pending_latch_stuck"),
    "stranded-audit recovery runs before the latch watchdog");
  // 3. Error-brake cycle cap: the v0.28.25 ladder slows the thrash but never
  //    stops it (4+ pause↔retry cycles in all three incident ledgers).
  assert.match(src, /if \(errorBrakeStreak >= 6\) \{/);
  assert.match(src, /error_brake_capped/);
  assert.match(src, /6 error-brakes in a row; the provider has been erroring for an extended window/);
});

test("v0.29.1: zombie-twin guard — drafts/enqueues duplicating a goal completed <24h ago are refused loudly", () => {
  const src = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  // Junk-runner field case: the just-approved close re-drafted itself 3
  // minutes later and autoaccept waved it in (9h of storm for nothing).
  assert.match(src, /const DUPLICATE_LOOKBACK_MS = 24 \* 60 \* 60 \* 1000;/);
  assert.match(src, /function recentlyCompletedObjectives\(cwd: string\)/);
  // goal_archived carries the objective going forward (retro fallback reads
  // the archived file's ## Objective section):
  assert.match(src, /appendLedger\(ctx\.cwd, "goal_archived", \{ goalId: goal\.id, status, stopReason, objective: goal\.objective\.slice\(0, 300\) \}\)/);
  assert.match(src, /md\.split\("## Objective"\)/);
  // enqueue path filters + reports:
  assert.match(src, /list_duplicate_skipped/);
  assert.match(src, /Skipped \$\{skipped\} item\(s\) duplicating work COMPLETED in the last 24h/);
  // draft path refuses before activation (autoaccept OR confirmed alike):
  const draftIdx = src.indexOf("draft_duplicate_skipped");
  assert.ok(draftIdx > -1 && src.slice(draftIdx - 1600, draftIdx).includes("recentlyCompletedObjectives(liveCtx.cwd).has(normalizeObjective(p.objective.trim()))"));
  assert.match(src, /This draft duplicates a goal that was COMPLETED within the last 24 hours/);
});

test("v0.29.2: git discipline law — no invented identities or branches, in every execution prompt", () => {
  // Field-observed 2026-07-30: a phase agent branded itself
  // "phase-e-agent <phase-e@local>" on main-history commits; other projects
  // gained invented local git configs (darklord-dev@dracon.local). The
  // global identity was correct all along — agents just improvised.
  const cont = fs.readFileSync("prompts/goal-loop-continuation.md", "utf-8");
  assert.match(cont, /Git discipline: never touch identity or branches/);
  assert.match(cont, /no `git config user\.\*`/);
  assert.match(cont, /phase-e-agent <phase-e@local>/);
  assert.match(cont, /never invent one/);
  const metric = fs.readFileSync("prompts/goal-loop-forever.md", "utf-8");
  assert.match(metric, /Git discipline: commit with the repo's configured identity as-is/);
  assert.match(metric, /never invent `<task>-agent/);
  const metricless = fs.readFileSync("prompts/goal-loop-forever-metricless.md", "utf-8");
  assert.match(metricless, /Git discipline: commit with the repo's configured identity as-is/);
  const forever = fs.readFileSync("extensions/goal-loop-forever.ts", "utf-8");
  assert.match(forever, /repo's configured\s*\n?\s*\*?\s*identity, on the current branch — no invented/);
});

test("v0.29.3: no empty allowlist warning; the session-load arbitration offers the wipe escape", () => {
  const src = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  // 1. The tool-heal warn used to fire with "0 agent tool(s) … re-activated
  //    ()" at every pi start (darklord screenshot). Warn only on a real heal.
  assert.match(src, /if \(!toolHealNotified && missing\.length > 0\) \{/);
  // 2. Loop-vs-goal arbitration on session load now offers wipe — for
  //    pre-guard stacked leftovers, arbitrating between two artifacts the
  //    user doesn't remember was the odd part ("i feel like wipe does").
  assert.match(src, /"Wipe everything — clean slate for stale leftovers \(\/glla wipe\)"/);
  // 3. The decision prompt executes wipe options (cmdGllaWipe keeps its own
  //    Confirm — destructive actions keep their gate).
  assert.ok(src.includes("/\\(\\/glla wipe\\)\\s*$/.test(label)"));
  assert.match(src, /await cmdGllaWipe\(ctx\);\s*\n\s*return true;/);
});

test("v0.29.4: user aborts stand the chain down and never count toward stalls (the Esc-spam loop)", () => {
  const src = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  // Pully field case 2026-07-30: launch auto-fired, the user Esc-spammed,
  // every abort re-fired the continuation AND counted toward the stall
  // brake — STALL WARNING 1/3, 2/3, then a bogus "stalled" pause.
  // 1. Aborted turns are exempt from the unproductive-turn accounting
  //    (same shape as the 0.28.13 provider-error exemption):
  assert.match(src, /else if \(lastA\?\.stopReason === "aborted"\) \{/);
  assert.match(src, /stall_nudge_exempt_aborted/);
  // 2. An abort stands the chain DOWN — no fall-through to
  //    scheduleContinuation. The stand-down return sits inside the aborted
  //    branch, before the healthy-turn else:
  const abortIdx = src.indexOf('else if (stopReason === "aborted")');
  const block = src.slice(abortIdx, abortIdx + 2200);
  assert.match(block, /abort_stand_down/);
  assert.match(block, /standing down — turn aborted by user \(not counted toward stalls\)/);
  assert.ok(block.indexOf("abort_stand_down") < block.indexOf("} else {"),
    "the stand-down returns before the healthy-turn branch — no re-fire");
  // 3. The 5-abort loud pause remains as the backstop:
  assert.match(block, /5 consecutive aborts \(user interrupted\)/);
});

test("v0.29.5: the stand-down survives the heartbeat + autoResume is GLOBAL-only", () => {
  const src = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  const settings = fs.readFileSync("extensions/goal-settings.ts", "utf-8");
  // 1. Without a stand-down flag the 60s heartbeat refire would defeat the
  //    0.29.4 abort stand-down within a minute (isSupervising + idle + no
  //    timer = refire, and the goal stays ACTIVE while standing down):
  assert.match(src, /let abortedStandDown = false;/);
  assert.match(src, /abortedStandDown = true; \/\/ v0\.29\.5: heartbeat\/compaction refires must not resurrect/);
  assert.match(src, /if \(abortedStandDown\) return;\n  if \(!fire\) return;/);
  // 2. Any explicit schedule ends the stand-down (resume/activate):
  assert.match(src, /abortedStandDown = false; \/\/ v0\.29\.5: any explicit schedule ends the stand-down/);
  // 3. The post-compaction refire also respects it:
  assert.match(src, /isSupervising\(\) && !abortedStandDown\) \{/);
  // 4. autoResume is GLOBAL-only (user directive: "not supporting project
  //    level setting for it now, just global") — the restore gate and the
  //    reviewer enqueue gate read loadGlobalSettings(), never the project
  //    cascade. junk-runner had a stale project-local opt-in that kept
  //    auto-firing its list at every bare pi launch.
  assert.match(settings, /export function loadGlobalSettings\(\): Settings \{/);
  assert.match(src, /resolveEffectiveAggressiveSettings\(loadGlobalSettings\(\)\)\.autoResume/);
  assert.match(src, /autoActivate: loadGlobalSettings\(\)\.autoResume === true/);
  assert.ok(!src.includes("resolveEffectiveAggressiveSettings(loadSettings(ctx.cwd)).autoResume"), "no project-cascade autoResume read remains");
});
