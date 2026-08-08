import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Regression guard for the v0.11.1 audit critical: infrastructure failures
// (exceptions, missing model, aborts) must return disapproved:false so the
// three-way split routes them to the infra path, not the disapproval branch.
//
// v0.34.108: the in-process runGoalCompletionAuditor (goal-loop-auditor.ts)
// was dead code and removed. These pins moved to the production path
// (goal-loop-auditor-process.ts + scripts/goal-auditor-worker.mjs), which
// owns all verdict construction today.
const SRC = readFileSync(
  path.resolve(__dirname, "../extensions/goal-loop-auditor-process.ts"),
  "utf-8",
);

function infraBody(): string {
  const idx = SRC.indexOf("function infra(");
  assert.ok(idx > 0, "infra helper exists");
  return SRC.slice(idx, SRC.indexOf("function stampToken"));
}

test("catch block never returns disapproved: true", () => {
  // The worker's run loop catches RPC/session exceptions and converts them
  // through infra() — never a disapproval.
  const catchIdx = SRC.lastIndexOf("} catch (error)");
  assert.ok(catchIdx > 0, "production auditor has a catch block");
  const catchBody = SRC.slice(catchIdx);
  assert.ok(!/disapproved:\s*true/.test(catchBody), "catch must not mark disapproved");
  assert.ok(catchBody.includes("infra("), "catch routes through the infra helper");
});

test("infra-flavored returns (no model / aborted) are not disapprovals", () => {
  for (const marker of ["no auditor model", "Auditor aborted."]) {
    const idx = SRC.indexOf(marker);
    assert.ok(idx > 0, `found: ${marker}`);
    // the return object containing this marker must not set disapproved:true
    const window = SRC.slice(Math.max(0, idx - 300), idx);
    const lastDisapproved = window.lastIndexOf("disapproved:");
    assert.ok(lastDisapproved >= 0, `return before '${marker}' sets disapproved`);
    assert.match(window.slice(lastDisapproved), /disapproved:\s*false/, `'${marker}' must be disapproved:false`);
  }
  // The infra() helper itself is disapproved:false by construction.
  assert.match(infraBody(), /disapproved:\s*false/);
  assert.match(infraBody(), /approved:\s*false/);
  assert.match(infraBody(), /error:/);
});

test("auditor watchdog exits are infrastructure failures, never verdicts", () => {
  // The worker's stall watchdog (GLLA_AUDITOR_STALL_MS brake) exits with an
  // infra-flavored result; the parent's wall-timeout watchdog rejects with
  // "auditor wall timeout", never a verdict.
  assert.match(SRC, /wall timeout/);
  assert.match(SRC, /GLLA_AUDITOR_STALL_MS/, "worker stall brake env var honored");
  const worker = readFileSync(
    path.resolve(__dirname, "../scripts/goal-auditor-worker.mjs"),
    "utf-8",
  );
  for (const marker of ["stall watchdog fired", "finish(false"]) {
    const idx = worker.indexOf(marker);
    if (idx < 0) continue;
    const window = worker.slice(idx, idx + 400);
    assert.match(window, /not a verdict|infrastructure|watchdog/i);
  }
  // Parent wall-timeout: infra result, not disapproved.
  const wallIdx = SRC.indexOf("wall timeout");
  assert.ok(wallIdx > 0, "wall timeout branch exists");
  assert.match(SRC.slice(Math.max(0, wallIdx - 400), wallIdx), /infra\(|approved:\s*false/);
});

test("semantic verdict-quality failures and shield blocks keep distinct categories", () => {
  assert.match(SRC, /treated as disapproved\./, "approval without evidence tools is a semantic disapproval");
  const shield = SRC.slice(SRC.indexOf("if (!shield.passed)"), SRC.indexOf("progress.phase = \"complete\"", SRC.indexOf("if (!shield.passed)")));
  assert.match(shield, /approved:\s*false/);
  assert.match(shield, /disapproved:\s*false/);
  assert.match(shield, /regressionShieldPassed:\s*false/);
  assert.doesNotMatch(shield, /error:/, "a shield block is not infrastructure failure");
});
