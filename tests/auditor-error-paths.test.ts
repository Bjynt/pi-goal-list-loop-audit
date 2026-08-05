import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Regression guard for the v0.11.1 audit critical: infrastructure failures
// (exceptions, missing model, aborts) must return disapproved:false so the
// three-way split routes them to the infra path, not the disapproval branch.
const SRC = readFileSync(
  path.resolve(__dirname, "../extensions/goal-loop-auditor.ts"),
  "utf-8",
);

test("catch block never returns disapproved: true", () => {
  const catchIdx = SRC.lastIndexOf("} catch");
  assert.ok(catchIdx > 0, "auditor has a catch block");
  const catchBody = SRC.slice(catchIdx);
  assert.ok(!/disapproved:\s*true/.test(catchBody), "catch must not mark disapproved");
});

test("infra-flavored returns (no model / aborted) are not disapprovals", () => {
  for (const marker of ["no model (session model also unset)", "Auditor aborted."]) {
    const idx = SRC.indexOf(marker);
    assert.ok(idx > 0, `found: ${marker}`);
    // the return object containing this marker must not set disapproved:true
    const window = SRC.slice(Math.max(0, idx - 300), idx);
    const lastDisapproved = window.lastIndexOf("disapproved:");
    assert.ok(lastDisapproved >= 0, `return before '${marker}' sets disapproved`);
    assert.match(window.slice(lastDisapproved), /disapproved:\s*false/, `'${marker}' must be disapproved:false`);
  }
});

test("auditor watchdog exits are infrastructure failures, never verdicts", () => {
  assert.match(SRC, /toolActive: Boolean\(progress\.currentTool\)/, "long active read-only tools bypass inactivity only");
  assert.match(SRC, /AUDITOR_WALL_TIMEOUT_MS/);
  for (const marker of ["watchdogFailure === \"wall\"", "watchdogFailure === \"inactivity\""]) {
    const idx = SRC.indexOf(marker);
    assert.ok(idx >= 0, `watchdog branch exists: ${marker}`);
    const window = SRC.slice(idx, idx + 650);
    assert.match(window, /approved:\s*false/);
    assert.match(window, /disapproved:\s*false/);
    assert.match(window, /infrastructure failure, not a verdict/);
  }
});

test("semantic verdict-quality failures and shield blocks keep distinct categories", () => {
  assert.match(SRC, /treated as disapproved\./, "approval without evidence tools is a semantic disapproval");
  const shield = SRC.slice(SRC.indexOf("if (!shield.passed)"), SRC.indexOf("progress.phase = \"complete\"", SRC.indexOf("if (!shield.passed)")));
  assert.match(shield, /approved:\s*true/);
  assert.match(shield, /disapproved:\s*false/);
  assert.match(shield, /regressionShieldPassed:\s*false/);
  assert.doesNotMatch(shield, /error:/, "a shield block is not infrastructure failure");
});
