// pi-goal-list-loop-audit — v0.34.3
// tests/resume-rekick.test.ts
//
// Hellhunter 2026-08-01: the widget said "list item · active", the agent
// sat idle (the continuation driving the new head never landed after a
// prose-only turn), and /glla resume answered "Nothing to resume — no
// paused goal/list-item, no held loop". Technically true, practically
// wrong: an ACTIVE-but-idle goal is exactly what the user means by
// "resume". Both resume surfaces now re-kick instead of shrugging.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = fs.readFileSync(path.resolve("extensions/loops/goal.ts"), "utf-8");

test("v0.34.3: /glla resume re-kicks an ACTIVE-but-idle goal instead of 'Nothing to resume'", () => {
  const gllaResume = SRC.slice(SRC.indexOf("async function cmdGllaResume"));
  const rek = gllaResume.indexOf('g.status === "active"');
  const nothing = gllaResume.indexOf("Nothing to resume — no paused goal/list-item");
  assert.ok(rek > -1, "the active-goal re-kick branch exists");
  assert.ok(nothing > rek, "the re-kick is checked BEFORE the 'Nothing to resume' fallback");
  assert.match(gllaResume, /ACTIVE but idle — re-firing its continuation/);
  assert.match(gllaResume, /scheduleContinuation\(ctx, true\)/);
});

test("v0.34.3: /glla resume re-kicks an ACTIVE loop too", () => {
  const gllaResume = SRC.slice(SRC.indexOf("async function cmdGllaResume"));
  assert.match(gllaResume, /state\.loop\?\.active/);
  assert.match(gllaResume, /scheduleLoopTick\(ctx\)/);
  assert.match(gllaResume, /An audit is in flight/, "auditing gets an informative answer, not a re-kick");
});

test("v0.34.3: /goal resume (/list resume) re-kicks instead of silently returning", () => {
  const cmdResume = SRC.slice(SRC.indexOf("async function cmdResume"));
  const rek = cmdResume.indexOf('state.goal.status === "active"');
  const silent = cmdResume.indexOf('if (!state.goal || state.goal.status !== "paused") return;');
  assert.ok(rek > -1, "the active re-kick branch exists in cmdResume");
  assert.ok(silent > rek, "the re-kick precedes the paused-only early return");
  assert.match(cmdResume, /isLoopActive\(\)/, "one-active-thing: an active loop still wins over the re-kick");
});

test("v0.34.3: re-kicks are ledger-visible (resume_rekick)", () => {
  const n = SRC.split('"resume_rekick"').length - 1;
  assert.ok(n >= 3, `expected >= 3 resume_rekick ledger sites (glla-goal, glla-loop, /goal resume), got ${n}`);
});
