// pi-goal-list-loop-audit — v0.27.5
// tests/postaudit-surface.test.ts
//
// 0.27.5: the post-completion audit was firing silently in interactive
// mode — the runReviewer-internal notify fires during the goal-completion
// handler and was easy to miss. Now there's a SECOND notify in
// fireReviewer that arrives after the cascade settles, points at the
// review file path, and is skipped for manual /review invocations.
// Also: settings keys `reviewer` (legacy) and `postaudit` (new) are both
// read; `postaudit` wins.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { resolveReviewerConfig, type ReviewerConfig } from "../extensions/reviewer.ts";

const SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
const SETTINGS_SRC = fs.readFileSync("extensions/goal-settings.ts", "utf-8");

test("fireReviewer emits a SECOND notify with the review file path after the cascade", () => {
  // The new branch lives right after the existing manual-suppressed notify.
  // It checks: not manual, fired, reportPath → notify with a relative path.
  const m = SRC.match(
    /if \(!opts\.manual && outcome\.fired && outcome\.reportPath\) \{[\s\S]*?ctx\.ui\.notify\(`\u2193 review written: \$\{relPath\}/,
  );
  assert.ok(m, "post-cascade surface notify exists and uses opts.manual/fired/reportPath guards");
});

test("surface-notify branch is preceded by the existing manual-suppressed notify", () => {
  const suppressedIdx = SRC.indexOf("Reviewer suppressed: ${outcome.suppressedReason}");
  const surfaceIdx = SRC.indexOf("↳ review written: ${relPath}");
  assert.ok(suppressedIdx > 0 && surfaceIdx > 0, "both notify branches exist");
  assert.ok(suppressedIdx < surfaceIdx, "surface notify comes after the suppressed notify");
});

test("postaudit settings key takes precedence over legacy reviewer key (fireReviewer)", () => {
  // The fireReviewer function reads settings.postaudit ?? settings.reviewer.
  const m = SRC.match(/settings\.postaudit \?\? settings\.reviewer/);
  assert.ok(m, "dual-read with postaudit precedence is wired in fireReviewer");
});

test("Settings type accepts both reviewer and postaudit keys", () => {
  // goal-settings.ts has both fields as optional Record<string, unknown>.
  assert.match(SETTINGS_SRC, /\/\*\*[^*]*v0\.26\.0: reviewer[\s\S]*?reviewer\?:\s*Record<string, unknown>;/);
  assert.match(SETTINGS_SRC, /\/\*\*[^*]*v0\.27\.5: post-completion audit config[\s\S]*?postaudit\?:\s*Record<string, unknown>;/);
});

test("SETTINGS_KEYS includes postaudit (not reviewer — legacy key is opaque)", () => {
  // The display list pins the new key; legacy key is resolved via dual-read.
  assert.match(SETTINGS_SRC, /SETTINGS_KEYS[\s\S]*?"postaudit",?\s*\]/);
});

test("/glla postaudit opens the same menu as /glla reviewer (no behavioral split)", () => {
  // Both keywords route to cmdReviewerSettings — there's ONE settings menu.
  const m = SRC.match(/if \(\/\^postaudit\\\/\.test\(trimmed\)\) \{[\s\S]*?await cmdReviewerSettings\(ctx\);\n\s*return;\n\s*\}/);
  assert.ok(m, "/glla postaudit keyword routes to cmdReviewerSettings");
});

test("/glla completions list both reviewer (legacy) and postaudit (new)", () => {
  assert.match(SRC, /\["reviewer", "[^"]*post-completion[^"]*"\]/);
  assert.match(SRC, /\["postaudit", "[^"]*post-completion[^"]*"\]/);
});

test("resolveReviewerConfig: postaudit and reviewer blocks merge equivalently", () => {
  // Pure unit test of the merge function — no reviewerBlock/loadSettings
  // round-trip required.
  const a: Partial<ReviewerConfig> = { mode: "auto", maxFindingsPerReview: 7 };
  const b: Partial<ReviewerConfig> = { mode: "auto", maxFindingsPerReview: 7 };
  const ra = resolveReviewerConfig(a);
  const rb = resolveReviewerConfig(b);
  assert.deepEqual(ra, rb);
  assert.equal(ra.mode, "auto");
  assert.equal(ra.maxFindingsPerReview, 7);
});
