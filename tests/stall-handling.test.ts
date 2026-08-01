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
  assert.match(def, /if \(real\) \{ consecutiveStalls = 0;/);
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
});

test("v0.29.21: session_compact arms a SECOND settle refire at grace expiry", () => {
  // Field (hellhunter 2026-07-31): auto-compact at 195.8k after two
  // output-limit turns → zero continuation rearm attempts after the
  // compact event → ~4 min of apparent death until the post-grace
  // heartbeat recovered (04:31 → 04:34:48). The 2s settle almost always
  // loses (pi is mid-compact then); the grace-expiry settle fires the
  // moment the machinery un-suppresses instead of waiting a heartbeat
  // interval.
  const hookIdx = SRC.indexOf('pi.on("session_compact"');
  const firstSettleIdx = SRC.indexOf("scheduleSessionTimeout(() => {", hookIdx);
  const graceSettleIdx = SRC.indexOf("scheduleSessionTimeout(() => {", firstSettleIdx + 1);
  assert.ok(hookIdx > 0 && firstSettleIdx > hookIdx && graceSettleIdx > firstSettleIdx, "grace settle inside the session_compact hook, after the fast settle");
  const block = SRC.slice(graceSettleIdx, graceSettleIdx + 900);
  assert.match(block, /appendLedger\(c\.cwd, "compaction_grace_refire", \{\}\)/, "ledger event names the recovery");
  assert.ok(block.includes("if (isLoopActive()) scheduleLoopTick(c);"), "loop refire line");
  assert.ok(block.includes("else scheduleContinuation(c, true);"), "goal refire line");
  assert.match(block, /COMPACTION_GRACE_MS \+ 2_000/, "fires at grace expiry (+2s epsilon)");
  assert.match(block, /c\.isIdle\(\) && !c\.hasPendingMessages\(\) && continuationTimer === null && loopTimer === null/, "same guards as the 2s settle");
  assert.match(block, /!abortedStandDown/, "user stand-down still wins");
  assert.ok(SRC.includes("const sessionTimeouts = new Set<NodeJS.Timeout>();"), "settle timer is tracked for shutdown cleanup");
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
  const hb = src.slice(hbIdx, hbIdx + 12000); // v0.34.14: heartbeat grew again (0.33.1 discharge, 0.34.11 watchdog, 0.34.13 recovery)
  assert.match(hb, /stranded_audit_recovered/);
  assert.match(hb, /state\.goal\?\.status === "auditing" &&\s*\n\s*!completionAuditInFlight/);
  assert.match(hb, /retryStoredCompletionAudit\(ctx, "quota-retry"\)/);
  assert.ok(hb.indexOf("stranded_audit_recovered") < hb.indexOf("pending_latch_stuck"),
    "stranded-audit recovery runs before the latch watchdog");
  // 3. Error-brake cycle cap: the v0.28.25 ladder slows the thrash but never
  //    stops it (4+ pause↔retry cycles in all three incident ledgers).
  assert.match(src, /if \(brakeStreak >= 6\) \{/);
  assert.match(src, /error_brake_capped/);
  assert.match(src, /6 error-brakes in a row; the provider has been erroring for an extended window/);
});

test("v0.29.9: hourly top-of-hour probe — the park keeps retrying on clock-hour boundaries", () => {
  const src = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  // The park is no longer terminal: a probe is scheduled for the next
  // top-of-hour boundary (+60s grace) via the shared quota-retry timer.
  assert.match(src, /const probeMs = msUntilNextHourBoundary\(Date\.now\(\)\);/);
  assert.ok(src.includes('"Hourly rate-limit probe"'));
  assert.match(src, /hourly_rate_probe/);
  assert.match(src, /via: "hourly-rate-probe"/);
  // The probe ONLY fires while still error-parked (user pauses/resumes/
  // cancels are never stomped), and it re-checks kind + reason.
  assert.match(src, /state\.goal\.pauseKind === "error"\s*\n\s*&& \(state\.goal\.pauseReason \?\? ""\)\.includes\("error-brakes in a row"\)/);
  // The park messaging names the hourly probe (no more "no more auto-retries").
  assert.match(src, /Probing at the top of each hour — rate-limit windows typically expire on clock-hour boundaries/);
  assert.ok(!src.includes("no more auto-retries"), "park is no longer terminal");
});

test("v0.29.9: msUntilNextHourBoundary — next clock-hour + grace, correct across the day", async () => {
  const { msUntilNextHourBoundary } = await import("../extensions/goal-loop-backoff.ts");
  // 10:47:30 → 11:01:00 = 12.5 minutes + 60s grace.
  const t = new Date("2026-07-30T10:47:30").getTime();
  assert.equal(msUntilNextHourBoundary(t), (12 * 60 + 30 + 60) * 1000);
  // Exactly on the hour → the NEXT hour + grace (never 0/negative).
  const onHour = new Date("2026-07-30T10:00:00").getTime();
  assert.equal(msUntilNextHourBoundary(onHour), (60 * 60 + 60) * 1000);
  // Custom grace.
  assert.equal(msUntilNextHourBoundary(t, 0), (12 * 60 + 30) * 1000);
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

test("v0.29.3/0.29.6: no empty allowlist warning; stacked states AUTO-ARBITRATE (picker superseded)", () => {
  const src = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  // 1. The tool-heal warn used to fire with "0 agent tool(s) … re-activated
  //    ()" at every pi start (darklord screenshot). Warn only on a real heal.
  assert.match(src, /if \(!toolHealNotified && missing\.length > 0\) \{/);
  // 2. v0.29.6: the arbitration picker is GONE — stacked states resolve
  //    deterministically at load (most recent activity keeps the slot;
  //    the loser is archived, never wiped). The notify names /glla wipe
  //    for users who want the full clean slate.
  assert.match(src, /Stacked state auto-arbitrated \(one active thing\)/);
  assert.ok(src.includes("stacked_state_auto_arbitrated"));
  assert.ok(!src.includes("Wipe everything — clean slate for stale leftovers"), "the picker's wipe option is superseded by auto-arbitration");
  // 3. The decision prompt still executes wipe-labelled options if a
  //    future pause offers one (cmdGllaWipe keeps its own Confirm —
  //    destructive actions keep their gate).
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

test("v0.29.16 — zombie-run watchdog: busy + zero stream events for 20 min = hung provider stream, loud Esc guidance", () => {
  // Field (hellhunter + hegemon 2026-07-30): MiniMax streams died silently
  // (no error, no timeout — pi has no read timeout). pi reported BUSY
  // forever, continuations queued into the void, and the busy flag hid
  // the wedge from every other watchdog (busy≠wedged law). The detector
  // uses a stream-only clock (message_update / tool_call / agent_start /
  // turn_start / agent_end) — heartbeat-internal noteActivity() must never
  // touch it. Detection + guidance only: Esc is the user's call.
  const SRC = fs.readFileSync(new URL("../extensions/loops/goal.ts", import.meta.url), "utf8");
  assert.ok(SRC.includes("ZOMBIE_RUN_SILENT_MS = 20 * 60_000"), "20-min silence threshold");
  assert.ok(SRC.includes("ZOMBIE_RUN_ALERT_THROTTLE_MS = 10 * 60_000"), "alert throttle");
  assert.ok(SRC.includes("let lastStreamActivityAt = Date.now();"), "separate stream clock");
  assert.match(SRC, /isSupervising\(\) && !idle && streamSilentMs >= ZOMBIE_RUN_SILENT_MS/, "branch fires on busy + stream-silent");
  assert.match(SRC, /appendLedger\(ctx\.cwd, "zombie_run_suspected"/, "ledgered");
  assert.ok(SRC.includes("Press Esc to abort the zombie turn — the goal/loop refires itself"), "Esc guidance");
  assert.match(SRC, /pi\.on\("message_update"/, "stream deltas feed the clock");
  assert.match(SRC, /pi\.on\("agent_start"/, "run starts feed the clock");
  assert.match(SRC, /pi\.on\("turn_start"/, "turn starts feed the clock");
  // the heartbeat's own bookkeeping must NOT reset the stream clock:
  const noteIdx = SRC.indexOf("function noteActivity(real = false): void {");
  const noteBody = SRC.slice(noteIdx, noteIdx + 220);
  assert.ok(!noteBody.includes("lastStreamActivityAt"), "noteActivity never touches the stream clock");
});

test("v0.32.1: post-compaction resume debt + deterministic resync (pi-goal-x's lesson)", () => {
  const SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  assert.match(SRC, /let postCompactResumeOwed = false;/);
  assert.match(SRC, /let postCompactResyncPending = false;/);
  assert.match(SRC, /postCompactResumeOwed = true;/); // armed in session_compact
  assert.match(SRC, /compaction_resume_owed_refire/); // heartbeat retries the debt every post-grace tick
  assert.match(SRC, /\[POST-COMPACTION RESYNC\]/); // deterministic re-anchor block
  assert.match(SRC, /content: resync \+ continuationPrompt/); // goal path prepends
  assert.match(SRC, /content: loopResync \+ loopPrompt/); // loop path prepends
  assert.match(SRC, /if \(resync\) postCompactResyncPending = false; \/\/ consumed only by a landed send/);
  // discharged by a real turn start (agent_start), not by the send itself
  assert.match(SRC, /pi\.on\("agent_start", \(\) => \{\n    lastStreamActivityAt = Date\.now\(\);\n    \/\/ v0\.32\.1/);
});

// ---------- v0.34.5: subagent-aware wedge alert ----------

test("v0.34.5: wedge alert names a subagent wait when the in-flight call is one", () => {
  const g = fs.readFileSync(path.resolve("extensions/loops/goal.ts"), "utf-8");
  assert.match(g, /SUBAGENT WAIT/, "the alert names the wait type");
  assert.match(g, /t\.name === "get_subagent_result" \|\| t\.name === "Agent"/, "detects both wait shapes");
  assert.match(g, /tool-use\/token counters have stopped moving between checks is hung, not thinking/, "the liveness check is in the message");
  assert.match(g, /subagentWait: subWaits\.size > 0/, "ledger marks subagent waits distinctly");
});

// ---------- v0.34.11: unanswered-continuation watchdog ----------

test("v0.34.11: unanswered-continuation watchdog (accepted send, no turn — hellhunter list-transition wedge)", () => {
  const g = fs.readFileSync(path.resolve("extensions/loops/goal.ts"), "utf-8");
  assert.match(g, /const CONTINUATION_UNANSWERED_MS = 150_000;/, "2.5min threshold");
  assert.match(g, /const CONTINUATION_UNANSWERED_THROTTLE_MS = 300_000;/, "5min re-alert throttle");
  // Disarm signal: real activity (agent_end/tool_call via noteActivity(true)) AFTER the last send.
  assert.match(g, /if \(real\) \{ consecutiveStalls = 0; lastRealActivityAt = lastActivityAt; \}/, "real activity stamps lastRealActivityAt");
  assert.match(g, /lastRealActivityAt < lastContinuationSentAt/, "armed only when no activity since the send");
  // Both send paths stamp the send time (goal continuations AND loop turns).
  assert.match(g, /appendLedger\(ctx\.cwd, "goal_continuation_sent", \{ goalId \}\);\n    lastContinuationSentAt = Date\.now\(\);/);
  assert.match(g, /appendLedger\(ctx\.cwd, "loop_turn_sent", \{ iteration: loop\.iteration \}\);\n    lastContinuationSentAt = Date\.now\(\);/);
  // Loud + actionable + ledger-visible; re-sends explicitly don't unstick (hegemon law).
  assert.match(g, /continuation_unanswered/);
  assert.match(g, /A fresh session_start will rebind the \$\{isLoopActive\(\) \? "loop" : "goal\/list item"\}/);
});

// ---------- v0.34.12: eager-continuation settle + wait countdown ----------

test("v0.34.12: eager continuation settles 2.5s past agent_end (hellhunter 60s-per-turn blackhole tax)", () => {
  const g = fs.readFileSync(path.resolve("extensions/loops/goal.ts"), "utf-8");
  assert.match(g, /const EAGER_CONTINUATION_SETTLE_MS = Number\(process\.env\.GLLA_EAGER_SETTLE_MS \?\? 2_500\);/, "2.5s default, env-overridable");
  assert.match(g, /scheduleContinuation\(ctx, false, EAGER_CONTINUATION_SETTLE_MS\);\n  \}\);/, "agent_end eager path settles");
  // Test harness zeroes it so tick() flushes keep working.
  const setup = fs.readFileSync(path.resolve("tests/harness/setup.ts"), "utf-8");
  assert.match(setup, /process\.env\.GLLA_EAGER_SETTLE_MS \?\?= "0";/);
});

test("v0.34.12: wait-pause status line counts down live + ticker survives the wait (pully field request)", () => {
  const d = fs.readFileSync(path.resolve("extensions/goal-loop-display.ts"), "utf-8");
  assert.match(d, /rms <= 0 \? " · resuming…" : ` · resumes in \$\{fmtElapsed\(rms\)\}`;/, "live countdown, honest past-resumeAt");
  const g = fs.readFileSync(path.resolve("extensions/loops/goal.ts"), "utf-8");
  assert.match(g, /isSupervising\(\) \|\| \(state\.goal\?\.status === "paused" && !!state\.goal\.pauseResumeAt\)/, "ticker keeps rendering through a timed wait");
});

// ---------- v0.34.13: auto-recovery ladder ("keep going unless we MUST stop") ----------

test("v0.34.16: wedges hand off through pi lifecycle — no terminal self-reload", () => {
  const g = fs.readFileSync(path.resolve("extensions/loops/goal.ts"), "utf-8");
  assert.match(g, /const SESSION_HANDOFF_FILE = "session-handoff\.json";/, "durable handoff marker");
  assert.match(g, /writeSessionHandoff\(ctx, shutdownReason\);/, "shutdown persists resume debt");
  assert.match(g, /clearSessionOwnedTimers\(\);/, "shutdown clears old-context timers");
  assert.match(g, /const handoffResume = consumeSessionHandoff\(ctx\.cwd\);/, "fresh session consumes debt");
  assert.ok(!g.includes("attemptAutoReload"), "no terminal transport");
  assert.ok(!g.includes("auto_reload_injected"), "no reload injection ledger");
  assert.match(g, /A fresh session_start will rebind the/, "watchdogs explain the lifecycle cure");
  assert.match(g, /const recoveryResume = consumeRecoveryResume\(ctx\.cwd\);/, "old markers remain one-release compatible");
});

// ---------- v0.34.14: /reload rebind always resumes + auditor streak law ----------

test("v0.34.14: /reload rebind resumes mid-work — the 'list is not continuing' fix (hellhunter)", () => {
  const g = fs.readFileSync(path.resolve("extensions/loops/goal.ts"), "utf-8");
  assert.match(g, /const SESSION_OWNER_FILE = "session-owner\.json";/, "pid sidecar");
  assert.match(g, /return prevPid !== null && prevPid === process\.pid;/, "same pid = /reload rebind, not cold boot");
  assert.match(g, /const rebindResume = claimSessionOwnerAndDetectRebind\(ctx\.cwd\);/, "restore detects rebind");
  assert.match(g, /appendLedger\(ctx\.cwd, "rebind_resume", \{ pid: process\.pid \}\);/, "rebind resumes are ledger-visible");
  // Cold boots (new pid) still honor autoresume=off; lifecycle handoff and
  // same-pid rebind are explicit same-process continuations.
  assert.ok((g.match(/if \(autoResume \|\| recoveryResume \|\| rebindResume \|\| handoffResume\) \{/g) ?? []).length >= 2, "goal + loop branches");
});

test("v0.34.14: 3-strike pause names the hanging-verification cause (pully ssh/sudo stall)", () => {
  const g = fs.readFileSync(path.resolve("extensions/loops/goal.ts"), "utf-8");
  assert.match(g, /a verification command is hanging \(ssh\/sudo\/long test runs stall the stream\)/, "pauseReason names both causes");
  assert.match(g, /model broken or a verification command hanging/, "notify names both causes");
});

// ---------- v0.34.15: persisted error brake + quota cards + queue-stuck probe ----------

test("v0.34.15: errorBrakeStreak persists ON THE GOAL — the 6-brake park survives /reload (hegemon 429 churn)", () => {
  const g = fs.readFileSync(path.resolve("extensions/loops/goal.ts"), "utf-8");
  const core = fs.readFileSync(path.resolve("extensions/goal-loop-core.ts"), "utf-8");
  const schema = fs.readFileSync(path.resolve("schemas/goal.schema.json"), "utf-8");
  assert.match(core, /errorBrakeStreak\?: number;/);
  assert.match(schema, /"errorBrakeStreak": \{ "type": "number" \}/);
  assert.match(g, /const brakeStreak = state\.goal!\.errorBrakeStreak \?\? 0;/);
  assert.match(g, /errorBrakeStreak: brakeStreak \+ 1,/);
  assert.ok(!g.includes("let errorBrakeStreak"), "module-state streak gone — reloads no longer reset the ladder");
});

test("v0.34.15: quota walls are CLASSIFIED on the card — resuming won't help, switch /model", () => {
  const g = fs.readFileSync(path.resolve("extensions/loops/goal.ts"), "utf-8");
  assert.match(g, /const quotaWall = \/rate\.\?limit\|usage limit\|quota\|insufficient\|credits\/i\.test\(detail\);/);
  assert.match(g, /Provider quota\/rate-limit wall — resuming won't help until the window resets\. Switch \/model/);
  assert.ok((g.match(/quotaWall/g) ?? []).length >= 5, "both pause branches + notifies classify");
});

test("v0.34.16: queue-stuck probe — a send queued-without-a-turn is reported without terminal injection", () => {
  const g = fs.readFileSync(path.resolve("extensions/loops/goal.ts"), "utf-8");
  assert.match(g, /GLLA_QUEUE_STUCK_MS \?\? 45_000/);
  assert.match(g, /appendLedger\(ctx\.cwd, "queue_stuck_detected"/);
  assert.match(g, /A fresh session_start will rebind the/);
  assert.match(g, /if \(lastRealActivityAt > sentAt\) return;/, "real work disarms");
  assert.match(g, /if \(!ctx\.hasPendingMessages\(\)\) return;/, "consumed message = healthy — even an instant 429 consumes");
  assert.match(g, /if \(!ctx\.isIdle\(\)\) return;/, "running turn = healthy");
  assert.match(g, /if \(!isSupervising\(\)\) return;/, "paused/completed disarms");
  assert.ok((g.match(/armQueueStuckProbe\(ctx, lastContinuationSentAt\);/g) ?? []).length === 2, "armed on BOTH goal + loop sends");
});
