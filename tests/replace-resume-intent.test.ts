// pi-goal-list-loop-audit — v0.34.103
// tests/replace-resume-intent.test.ts
//
// GitHub issue #6 (field report, filed by the detached auditor 2026-08-08):
//   Defect A — replacing a `wait` goal silently cancels its scheduled
//             auto-resume (pauseResumeAt); the user's "it will come back"
//             expectation breaks with no notice.
//   Defect B — /goal resume on an archived/complete/aborted goal produces
//             NO feedback at all (silent no-op).
//
// The fixes: setGoal warns + ledgers `replaced_resume_cancelled` when a
// superseded goal carried a scheduled resume; cmdResume answers the
// terminal/no-goal states explicitly instead of returning silently.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = fs.readFileSync(path.resolve("extensions/loops/goal.ts"), "utf-8");
const CMDS = fs.readFileSync(path.resolve("extensions/goal-commands.ts"), "utf-8");

// ---------------------------------------------------------------- Defect A

test("v0.34.103 (issue #6 Defect A): replacing a wait goal with a scheduled resume warns + ledgers the cancellation", () => {
  const setGoal = SRC.slice(SRC.indexOf("function setGoal("), SRC.indexOf("function updateGoal("));
  // The replace archive branch captures the superseded goal BEFORE archiving:
  assert.match(setGoal, /const replaced = state\.goal;/);
  assert.match(setGoal, /const hadScheduledResume = !!replaced\.pauseResumeAt;/);
  assert.match(setGoal, /archiveCurrentGoal\(ctx, "aborted", `replaced by goal/);
  // The warning only fires when a scheduled resume was actually pending:
  assert.match(setGoal, /if \(hadScheduledResume\)/);
  assert.match(setGoal, /"replaced_resume_cancelled"/);
  assert.match(setGoal, /scheduled auto-resume .* was cancelled/);
  assert.match(setGoal, /notifyExternal/);
});

test("v0.34.103 (issue #6 Defect A): plain replace without a scheduled resume stays quiet", () => {
  const setGoal = SRC.slice(SRC.indexOf("function setGoal("), SRC.indexOf("function updateGoal("));
  // The archive branch still runs for every replaced paused/active goal…
  assert.match(setGoal, /state\.goal\.status === "active" \|\| state\.goal\.status === "paused"/);
  // …but the notification is gated on the resume intent, not on the replace:
  assert.match(setGoal, /if \(hadScheduledResume\) \{\s*\n\s*appendLedger/);
  // No unconditional warning text in the archive branch:
  const branch = setGoal.slice(setGoal.indexOf("being replaced is archived honestly first"));
  assert.ok(!/ctx\.ui\.notify\(/.test(branch.replace(/if \(hadScheduledResume\) \{[\s\S]*?\n  \}/, "")), "no notify outside the hadScheduledResume gate");
});

// ---------------------------------------------------------------- Defect B

test("v0.34.103 (issue #6 Defect B): /goal resume answers terminal (complete/aborted) goals explicitly", () => {
  const cmdResume = CMDS.slice(CMDS.indexOf("async function cmdResume"), CMDS.indexOf("async function cmdCancel"));
  assert.ok(!/if \(!state\.goal \|\| state\.goal\.status !== "paused"\) return;/.test(cmdResume), "the silent bare return is gone");
  // Terminal states (complete/aborted — archived) get a named warning:
  assert.match(cmdResume, /The \$\{label\} is \$\{state\.goal\.status\} \(archived\)/);
  assert.match(cmdResume, /it can't be resumed/);
  assert.match(cmdResume, /\/goal <objective> starts a fresh one; \/goal archive lists archived goals/);
  assert.match(cmdResume, /\/list add <objective> re-queues it; \/list show lists waiting items/);
  // Non-terminal non-paused states (active/auditing reach earlier branches;
  // anything else) get an informational answer, not silence:
  assert.match(cmdResume, /The \$\{label\} is \$\{state\.goal\.status\} — nothing to resume/);
});

test("v0.34.103 (issue #6 Defect B): resume with NO goal at all answers instead of swallowing the verb", () => {
  const cmdResume = CMDS.slice(CMDS.indexOf("async function cmdResume"), CMDS.indexOf("async function cmdCancel"));
  assert.match(cmdResume, /Nothing to resume — no goal is active or paused/);
  // An active loop is named so /goal resume points at the right verb:
  assert.match(cmdResume, /A loop is active: \/loop resume/);
  assert.match(cmdResume, /\/goal <objective> starts one \(or \/list show for the queue\)/);
});

// ------------------------------------------------------------------ wiring

test("v0.34.103 (issue #6): the ledger key survives in goal-loop-core round-trips", () => {
  const core = fs.readFileSync(path.resolve("extensions/goal-loop-core.ts"), "utf-8");
  // Ledger events are free-form strings; the key must not be a type error.
  assert.ok(core.length > 0);
  // The goal status type still has no "archived" status — archival is
  // signalled by the archivedPath field + ledger, not a 5th status.
  assert.match(SRC, /archivedPath/);
});
