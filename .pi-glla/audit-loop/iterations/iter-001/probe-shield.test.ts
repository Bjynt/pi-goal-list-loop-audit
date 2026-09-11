// pi-goal-list-loop-audit — iteration 1 audit-redteam probe
// .pi-glla/audit-loop/iterations/iter-001/probe-shield.test.ts
//
// Targeted experiment: does the regression_shield (extensions/goal-loop-shield.ts)
// accept a hallucinated approval when the verification contract is written in a
// shape that defeats its substring/segment matching? Four attack classes are
// pinned here; the test exposes any class that the shield does NOT refuse and
// records it as the iteration-1 finding.
//
// The attacks probe the per-item matching in checkRegressionShield:
//   - candidate tokenization (top-3 longest tokens, len >= 5)
//   - the no-candidates-fallback (normalizeForMatch)
//   - the segment-decomposition for compound tokens
//
// If the test GREEN-bars, every hallucinated approval is correctly rejected
// (passed:false). If a probe RED-bars, that class fooled the shield — the
// matching section in goal-loop-shield.ts is the remediation site.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  checkRegressionShield,
  contractItems,
  parseAuditorVerdict,
} from "../../../../extensions/goal-loop-shield.ts";

test("iter-001/attack-A: contract with diffuse short items — paraphrase approval must be refused", () => {
  // Items with no token >= 5 chars fall through to the no-candidates branch
  // (normalizeForMatch). A hallucinated report that paraphrases the items
  // should NOT pass.
  const contract = "Done when:\n- OK\n- yes\n- go";
  const items = contractItems(contract);
  assert.deepEqual(items, ["OK", "yes", "go"], "all three short items survive contractItems");
  const report = "<evidence>the task is fully done now.</evidence>\n<approved/>";
  const r = checkRegressionShield(report, contract);
  assert.equal(r.passed, false, "diffuse-item paraphrase must NOT pass the shield");
  assert.equal(r.hasEvidenceBlock, true);
});

test("iter-001/attack-B: file-path-only contract — naming any file with that stem must NOT pass", () => {
  // The contract's only distinctive token is `extension`. A hallucinated
  // approval that drops the file stem from a different `extension*` file
  // is supposed to fail because the contract asked for the literal stem
  // referenced. Test that a same-stem prose line is refused.
  const contract = "Done when: a new file named exactly `my_feature.ts` is created at the project root";
  const items = contractItems(contract);
  // items should not include "Done when"
  assert.ok(items.length === 1, "one contract item extracted");
  assert.ok(items[0].includes("my_feature.ts"), "literal filename token is in the item");
  // Hallucinated report: quotes a different unrelated extension file.
  const report = "<evidence>File created: extensions/extension.ts (new code in here).\n<approved/>";
  const r = checkRegressionShield(report, contract);
  assert.equal(r.passed, false, "report that names a same-stem-but-different file must NOT pass");
});

test("iter-001/attack-C: mechanical-check laundering — verb-only contract must still demand a real command", () => {
  // Pure-verb contracts ("run tests", "build") have no distinctive tokens
  // beyond the verb. A hallucinated report that says "tests ran" must not
  // pass when no command is named.
  const contract = "Done when: run the tests and confirm they pass";
  const items = contractItems(contract);
  assert.equal(items.length, 1);
  const report = "<evidence>the tests were run and they passed.</evidence>\n<approved/>";
  const r = checkRegressionShield(report, contract);
  assert.equal(r.passed, false, "vague verb contract must not be satisfied by prose confirmation");
});

test("iter-001/attack-D: evidence-block word re-use — repeating contract prose OUTSIDE evidence must not pass", () => {
  // The shield restricts matching to inside <evidence>...</evidence>. A report
  // that quotes the contract verbatim in prose and then approves without
  // evidence should fail with hasEvidenceBlock:false, not by token reuse.
  const contract = "Done when: ts build succeeds without errors";
  const items = contractItems(contract);
  assert.equal(items.length, 1);
  const report = [
    "Summary: ts build succeeds without errors per contract.",
    "No evidence collected.",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, contract);
  assert.equal(r.passed, false);
  assert.equal(r.hasEvidenceBlock, false, "no evidence block at all");
});

test("iter-001/parseAuditorVerdict: case-insensitive verdict — <APPROVED/> on its own line must register", () => {
  // Verdict line is case-insensitive per the regex. A capital-only verdict
  // must register; a verdict embedded in prose must NOT.
  const approved = "long report\n<APPROVED/>";
  const r1 = parseAuditorVerdict(approved);
  assert.equal(r1.approved, true);
  const embedded = "long report\nand <approved/> somewhere inside";
  const r2 = parseAuditorVerdict(embedded);
  assert.equal(r2.approved, false, "verdict only on the final nonblank line");
  assert.equal(r2.disapproved, false);
});

test("iter-001/parseAuditorVerdict: wire-newline normalized — `\\n`-encoded <disapproved/> still parses", () => {
  // RPC/test transports serialize newlines as literal \\n. The verdict
  // parser MUST normalize those without relaxing the final-line gate.
  const wireEncoded = "long report\\n<disapproved/>";
  const r = parseAuditorVerdict(wireEncoded);
  assert.equal(r.disapproved, true);
  assert.equal(r.approved, false);
});
