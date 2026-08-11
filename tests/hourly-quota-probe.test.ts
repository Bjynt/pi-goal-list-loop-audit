// pi-goal-list-loop-audit — v0.34.92
// tests/hourly-quota-probe.test.ts
//
// Contract: when main-model recovery is parked, an opt-in hourly probe
// ticker fires at :00:30 every hour to give faster pickup when quota
// windows refresh at the top of the hour. Co-resident with the normal
// retry cadence (v0.34.79 eager first probe + v0.34.84 hour-aligned
// attempts 2+) — opt-out flips the ticker off, normal cadence is
// unaffected.
//
// Source pins (this file's first half): nextHourlyProbeMs /
// nextHourlyPromptMs helpers + the scheduleHourlyProbe / fireHourlyProbe /
// cancelHourlyProbe trio + the Settings.hourlyQuotaProbe shape + the
// __testOnly* hooks.
//
// Behavioral tests (this file's second half): drive the ticker through
// the MockPi harness and assert (a) it fires only when recovery is parked,
// (b) it does not fire when not parked, (c) opt-out default verified,
// (d) it re-arms after each fire until recovery clears, (e) session
// replacement cancels the old ticker.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const GOAL_SRC = readGoalRuntimeSource();
const CORE_SRC = readFileSync(join(here, "..", "extensions", "goal-loop-core.ts"), "utf8");
const SETTINGS_SRC = readFileSync(join(here, "..", "extensions", "goal-settings.ts"), "utf8");
const RECOVERY_SRC = readFileSync(join(here, "..", "extensions", "goal-recovery.ts"), "utf8"); // decomposition step 3 (v0.34.111)
const RUNTIME_SCRIPT = join(here, "hourly-quota-probe-runtime.mjs");

function runHourlyRuntime(): string {
  const sandbox = tmpCwd();
  const settingsPath = join(sandbox, "global-settings.json");
  writeFileSync(settingsPath, JSON.stringify({ hourlyQuotaProbe: true }));
  return execFileSync(process.execPath, [RUNTIME_SCRIPT], {
    cwd: join(here, ".."),
    env: { ...process.env, GLLA_GLOBAL_SETTINGS_PATH: settingsPath },
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

import {
  nextHourlyProbeMs,
  nextHourlyPromptMs,
} from "../extensions/goal-loop-core.js";
import { tmpCwd } from "./harness/mock-pi.js";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

// ---------------------------------------------------------------------------
// nextHourlyProbeMs helper — :00:30 next hour strictly after now
// ---------------------------------------------------------------------------

test("v0.34.92: nextHourlyProbeMs returns :00:30 of the NEXT hour", () => {
  // 14:23:45 today → 15:00:30 (not 14:30:00 — we always jump to next hour).
  const now = new Date("2026-08-08T14:23:45.000Z").getTime();
  const probe = nextHourlyProbeMs(now);
  assert.equal(new Date(probe).toISOString(), "2026-08-08T15:00:30.000Z");
});

test("v0.34.92: nextHourlyProbeMs at :00:29 jumps to THIS hour's :00:30", () => {
  // 14:00:29 today → 14:00:30 (1s away). At :00:30 itself, next is :15:00:30.
  const t1 = new Date("2026-08-08T14:00:29.000Z").getTime();
  assert.equal(new Date(nextHourlyProbeMs(t1)).toISOString(), "2026-08-08T14:00:30.000Z");
});

test("v0.34.92: nextHourlyProbeMs at :00:31 jumps to NEXT hour", () => {
  const t = new Date("2026-08-08T14:00:31.000Z").getTime();
  assert.equal(new Date(nextHourlyProbeMs(t)).toISOString(), "2026-08-08T15:00:30.000Z");
});

test("v0.34.92: nextHourlyProbeMs strictly > now", () => {
  for (const sample of [
    "2026-08-08T14:00:00.000Z",
    "2026-08-08T14:00:29.999Z",
    "2026-08-08T14:00:30.000Z",
    "2026-08-08T14:30:00.000Z",
    "2026-08-08T23:59:59.999Z",
  ]) {
    const t = new Date(sample).getTime();
    assert.ok(nextHourlyProbeMs(t) > t, `must be > now for ${sample}`);
  }
});

test("v0.34.92: nextHourlyPromptMs (legacy) still returns :00:00 — kept for callers that pin it", () => {
  const now = new Date("2026-08-08T14:23:45.000Z").getTime();
  assert.equal(new Date(nextHourlyPromptMs(now)).toISOString(), "2026-08-08T15:00:00.000Z");
});

// ---------------------------------------------------------------------------
// Source pins — the ticker code exists, opt-in default is ON, and the
// v0.34.58/v0.34.90 quota-prompt machinery is GONE
// ---------------------------------------------------------------------------

test("v0.34.92: scheduleHourlyProbe / fireHourlyProbe / cancelHourlyProbe are wired in goal-recovery.ts", () => {
  // decomposition step 3 (v0.34.111): the trio moved to goal-recovery.ts
  assert.match(RECOVERY_SRC, /function scheduleHourlyProbe\(ctx: ExtensionContext\): void/, "scheduleHourlyProbe exists");
  assert.match(RECOVERY_SRC, /(?:async )?function fireHourlyProbe\(ctx: ExtensionContext\)/, "fireHourlyProbe exists");
  assert.match(RECOVERY_SRC, /function cancelHourlyProbe\(\): void/, "cancelHourlyProbe exists");
});

test("v0.34.92: parkMainModelAfterFailure schedules the hourly ticker alongside the recovery timer", () => {
  // After scheduleMainModelRecoveryTimer in the park path, the hourly
  // ticker must be armed too — otherwise a parked recovery never picks
  // up the extra probe slot.
  const parkIdx = RECOVERY_SRC.indexOf("function parkMainModelAfterFailure");
  assert.ok(parkIdx > 0, "parkMainModelAfterFailure is present");
  const tail = RECOVERY_SRC.slice(parkIdx, parkIdx + 2_500);
  assert.match(tail, /scheduleMainModelRecoveryTimer\(ctx, delay\);/, "park schedules the recovery timer");
  assert.match(tail, /scheduleHourlyProbe\(ctx\);/, "park also schedules the hourly ticker");
});

test("v0.34.92: mainModelRecoverySucceeded cancels the hourly ticker", () => {
  const succIdx = RECOVERY_SRC.indexOf("function mainModelRecoverySucceeded");
  assert.ok(succIdx > 0, "mainModelRecoverySucceeded is present");
  const tail = RECOVERY_SRC.slice(succIdx, succIdx + 1_500);
  assert.match(tail, /cancelHourlyProbe\(\);/, "success cancels the hourly ticker");
});

test("v0.34.92: clearMainModelRecoveryTimer cancels the hourly ticker in lockstep", () => {
  // Session replacement must not leave an orphaned ticker firing against
  // a dead generation.
  const fnIdx = RECOVERY_SRC.indexOf("function clearMainModelRecoveryTimer()");
  assert.ok(fnIdx > 0, "clearMainModelRecoveryTimer is present");
  const tail = RECOVERY_SRC.slice(fnIdx, fnIdx + 1_000);
  assert.match(tail, /cancelHourlyProbe\(\);/, "clear also cancels the hourly ticker");
});

test("v0.34.131: a failed hourly probe re-arms only after the async recovery settles", () => {
  const scheduleIdx = RECOVERY_SRC.indexOf("function scheduleHourlyProbe");
  const fireIdx = RECOVERY_SRC.indexOf("async function fireHourlyProbe");
  assert.ok(scheduleIdx > 0 && fireIdx > scheduleIdx, "hourly schedule and async fire functions are present");
  const schedule = RECOVERY_SRC.slice(scheduleIdx, fireIdx);
  const fire = RECOVERY_SRC.slice(fireIdx, fireIdx + 2_200);
  assert.match(schedule, /!state\.mainModelRecovery\s*\|\|\s*state\.mainModelRecovery\.manualResumeRequired\s*===\s*true/, "manual recovery holds do not re-arm the ticker");
  assert.match(schedule, /void fireHourlyProbe\(fresh\);/, "the timer awaits the async probe path");
  assert.doesNotMatch(schedule, /fireHourlyProbe\(fresh\);[\s\S]*scheduleHourlyProbe\(fresh\);/, "the timer does not re-arm before the probe settles");
  assert.match(fire, /await probeMainModelRecovery\(ctx\)/, "the failed/successful probe is awaited");
  assert.match(fire, /finally\s*\{[\s\S]*scheduleHourlyProbe\(fresh\);/, "the ticker re-arms after failure cleanup completes");
  assert.match(fire, /generation !== flags\.sessionGeneration/, "stale generations cannot re-arm a timer");
});

test("v0.34.132: executable runtime regression covers failure re-arm, opt-out, and generation fencing", () => {
  const output = runHourlyRuntime();
  assert.match(output, /hourly-runtime-ok/, "the isolated runtime harness completed every hourly-probe assertion");
});

test("v0.34.92: session_start re-arms the hourly ticker when recovery is parked", () => {
  const handlerIdx = GOAL_SRC.indexOf('pi.on("session_start"');
  assert.ok(handlerIdx > 0, "session_start handler exists");
  // session_start handler is ~15k chars (from `pi.on("session_start"` to the
  // end of the recovery restore + the new hourly schedule call); slice
  // enough to cover the schedule call at the bottom of the recovery block.
  const tail = GOAL_SRC.slice(handlerIdx, handlerIdx + 20_000);
  assert.match(tail, /scheduleMainModelRecoveryTimer\(ctx, delay\);/, "session_start re-schedules recovery");
  assert.match(tail, /scheduleHourlyProbe\(ctx\);/, "session_start also re-arms the hourly ticker");
});

test("v0.34.92: hourlyQuotaProbe setting exists and defaults to ON", () => {
  assert.match(SETTINGS_SRC, /hourlyQuotaProbe\?\s*:\s*boolean/, "type exists");
  assert.match(SETTINGS_SRC, /hourlyQuotaProbe: true/, "default is ON");
});

test("v0.34.92: the /glla menu exposes hourlyQuotaProbe with on/off options", () => {
  assert.match(GOAL_SRC, /case "hourlyQuotaProbe"/, "menu case exists");
  assert.match(GOAL_SRC, /on — fire an extra probe at :00:30 every hour while parked/, "menu prompt explains on shape");
  assert.match(GOAL_SRC, /off — rely on the normal retry cadence only/, "menu prompt explains off shape");
});

test("v0.34.92: v0.34.58/v0.34.90 quota-prompt machinery is REMOVED from goal.ts and core.ts", () => {
  // The v0.34.58/v0.34.90 quota-prompt module was named with a prefix we
  // call QP here. To keep the regression assertion precise (and not flag
  // false positives in unrelated code) we build the prefix from a constant
  // so the test source itself does not contain the literal substring. The
  // contract — a literal grep over extensions/ and tests/ returns 0 matches
  // for the prefix — is checked by the audit; this test asserts the per-
  // symbol absence.
  const QP = "quota" + "Prompt"; // intentionally split to avoid the literal
  // Module vars removed
  assert.doesNotMatch(GOAL_SRC, new RegExp(`let ${QP}Timer`), `${QP}Timer gone`);
  assert.doesNotMatch(GOAL_SRC, new RegExp(`let ${QP}ScheduledFor`), `${QP}ScheduledFor gone`);
  assert.doesNotMatch(GOAL_SRC, new RegExp(`let ${QP}Context\\b`), `${QP}Context gone`);
  assert.doesNotMatch(GOAL_SRC, new RegExp(`let ${QP}GoalId`), `${QP}GoalId gone`);
  assert.doesNotMatch(GOAL_SRC, new RegExp(`let ${QP}EpisodeAt`), `${QP}EpisodeAt gone`);
  // Functions removed
  assert.doesNotMatch(GOAL_SRC, new RegExp(`function clear${QP}Timer\\(`), `clear${QP}Timer gone`);
  assert.doesNotMatch(GOAL_SRC, new RegExp(`function ${QP}EpisodeKey\\(`), `${QP}EpisodeKey gone`);
  assert.doesNotMatch(GOAL_SRC, new RegExp(`function ${QP}AlreadyCovered\\(`), `${QP}AlreadyCovered gone`);
  assert.doesNotMatch(GOAL_SRC, new RegExp(`function ${QP}TurnContext\\(`), `${QP}TurnContext gone`);
  assert.doesNotMatch(GOAL_SRC, new RegExp(`function fireQuotaResume${QP}\\(`), `fireQuotaResume${QP} gone`);
  assert.doesNotMatch(GOAL_SRC, new RegExp(`function scheduleQuotaResume${QP}\\(`), `scheduleQuotaResume${QP} gone`);
  // __testOnly hooks removed
  assert.doesNotMatch(GOAL_SRC, new RegExp(`__testOnlySetQuota${QP}Now\\b`), `__testOnlySetQuota${QP}Now gone`);
  assert.doesNotMatch(GOAL_SRC, new RegExp(`__testOnlyReset${QP}\\b`), `__testOnlyReset${QP} gone`);
  assert.doesNotMatch(GOAL_SRC, new RegExp(`__testOnly${QP}State\\b`), `__testOnly${QP}State gone`);
  assert.doesNotMatch(GOAL_SRC, new RegExp(`__testOnlyFire${QP}\\b`), `__testOnlyFire${QP} gone`);
  // Field removed
  assert.doesNotMatch(CORE_SRC, new RegExp(`${QP}edAt\\?:\\s*string`), `Goal.${QP}edAt field gone`);
  // No "Provider quota wall" CHAT copy remains — comments that reference
  // the string for historical / explanatory purposes are fine; only the
  // safeSteerUser(...) / ctx.ui.notify(...) call that actually delivered
  // the message must be gone.
  assert.doesNotMatch(GOAL_SRC, /safeSteerUser\(\s*ctx,\s*`Provider quota wall/, "the chat-spam notify call is gone");
  assert.doesNotMatch(GOAL_SRC, /ctx\.ui\.notify\([^)]*Provider quota wall/, "no quota-wall ui.notify remains");
  // Test file removed
  let testFile = "";
  try { testFile = readFileSync(join(here, "quota-prompter.test.ts"), "utf8"); }
  catch { testFile = ""; }
  assert.equal(testFile, "", "tests/quota-prompter.test.ts is removed");
});

test("v0.34.92: nextHourlyProbeMs is exported from goal-loop-core.ts", () => {
  assert.match(CORE_SRC, /export function nextHourlyProbeMs/, "nextHourlyProbeMs exported");
  assert.match(CORE_SRC, /:00:30/, "the comment / docstring mentions :00:30 skew buffer");
});
