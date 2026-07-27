// pi-goal-list-loop-audit — v0.27.0
// tests/settings-menu-complete.test.ts
//
// "I want to see every option when I type /glla — better organized, with
// info about them on the right." The settings menu now shows every key in
// sections, each row `label — value [source] — what it does`.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

const SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
const MENU = SRC.slice(SRC.indexOf("async function openSettingsUI"), SRC.indexOf("async function cmdSettings"));

test("every settings key has a menu row with a description", () => {
  for (const row of [
    "Auto-resume on load", "Auto-accept drafts", "Aggressive mode",
    "Auditor model", "Auditor thinking", "Audit cap", "Audit feedback chars", "Quota retry minutes",
    "Wedge alert minutes", "Stuck max interventions", "Stall escalation refires",
    "Subagent model strategy", "Subagent Explore pin", "Subagent Plan pin", "Subagent general-purpose pin",
    "Notify command", "Token limit per goal", "Reviewer config",
  ]) {
    const re = new RegExp("`" + row.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^`]*—[^`]*`");
    assert.ok(re.test(MENU), `row with description: ${row}`);
  }
});

test("menu is organized into named sections; headers are selectable no-ops", () => {
  for (const section of ["── Keep-going ──", "── Auditor ──", "── Stall brakes ──", "── Subagents ──", "── Other ──"]) {
    assert.ok(MENU.includes(`"${section}"`), section);
  }
  assert.match(MENU, /startsWith\("──"\)\) continue;/);
});

test("previously-missing handlers exist: autoresume tri-state, autoaccept, auditcap, stallescalation, reviewer", () => {
  assert.match(MENU, /choice\.startsWith\("Auto-resume"\)/);
  assert.match(MENU, /autoResume: v\.startsWith\("on"\) \? true : v\.startsWith\("off"\) \? false : undefined/);
  assert.match(MENU, /choice\.startsWith\("Auto-accept drafts"\)/);
  assert.match(MENU, /choice\.startsWith\("Audit cap"\)/);
  assert.match(MENU, /choice\.startsWith\("Stall escalation"\)/);
  assert.match(MENU, /choice\.startsWith\("Reviewer config"\)/);
  assert.match(MENU, /await cmdReviewerSettings\(ctx\)/);
});

test("headless fallback lists the stall brakes too", () => {
  assert.match(SRC, /fmt\("stallEscalationRefires", "stallEscalation"\)/);
  assert.match(SRC, /fmt\("wedgeAlertMinutes", "wedgeAlert"\)/);
});
