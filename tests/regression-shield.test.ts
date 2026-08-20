// pi-goal-list-loop-audit — v0.2.0
// tests/regression-shield.test.ts
//
// Unit tests for the regression_shield: contract item extraction and the
// evidence-enforcement check. This is the core anti-bamboozle hardening —
// the tests pin both the accept and reject paths.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  checkRegressionShield,
  contractItems,
} from "../extensions/goal-loop-shield.ts";

// ---- contractItems ----

test("contractItems: strips the 'Done when:' marker line", () => {
  const items = contractItems("Done when:\n- npm test passes\n- grep -q ok x.txt");
  assert.deepEqual(items, ["npm test passes", "grep -q ok x.txt"]);
});

test("contractItems: handles inline single-line contracts", () => {
  const items = contractItems("Done when: grep -q world hello.txt");
  assert.deepEqual(items, ["grep -q world hello.txt"]);
});

test("contractItems: strips bullets and numbering", () => {
  const items = contractItems("- first check\n* second check\n1. third check\n2) fourth check");
  assert.deepEqual(items, ["first check", "second check", "third check", "fourth check"]);
});

test("contractItems: drops empty lines", () => {
  const items = contractItems("one\n\n\n  \ntwo");
  assert.deepEqual(items, ["one", "two"]);
});

// ---- checkRegressionShield ----

const CONTRACT = "Done when:\n- curl returns 200 from /healthz\n- npm test exits 0";

test("passes: evidence block present, all items referenced", () => {
  const report = [
    "Audit report.",
    "<evidence>",
    "Item: curl returns 200 from /healthz",
    "Output:",
    "HTTP/1.1 200 OK",
    "Item: npm test exits 0",
    "Output:",
    "Tests: 12 passed, 0 failed",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, CONTRACT);
  assert.equal(r.passed, true);
  assert.equal(r.hasEvidenceBlock, true);
  assert.deepEqual(r.missingItems, []);
});

test("rejects: approval without an evidence block", () => {
  const report = "I checked /healthz and npm test, both fine.\n<approved/>";
  const r = checkRegressionShield(report, CONTRACT);
  assert.equal(r.passed, false);
  assert.equal(r.hasEvidenceBlock, false);
});

test("rejects: evidence block but an item is not addressed", () => {
  const report = [
    "<evidence>",
    "Item: curl returns 200 from /healthz",
    "Output: HTTP/1.1 200 OK",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, CONTRACT);
  assert.equal(r.passed, false);
  assert.equal(r.hasEvidenceBlock, true);
  assert.deepEqual(r.missingItems, ["npm test exits 0"]);
});

test("rejects: bamboozle-style empty evidence block", () => {
  const report = "<evidence>\n</evidence>\n<approved/>";
  const r = checkRegressionShield(report, CONTRACT);
  assert.equal(r.passed, false);
});

test("distinctive-token matching: references the item by a filename", () => {
  // The auditor may not quote the item verbatim; referencing hello.txt counts.
  const report = [
    "<evidence>",
    "Checked the file:",
    "$ cat hello.txt",
    "world",
    "$ grep -q world hello.txt && echo PASS",
    "PASS",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, "Done when: grep -q world hello.txt");
  assert.equal(r.passed, true);
});

test("case-insensitive matching", () => {
  const report = "<evidence>\nItem: NPM TEST exits 0\nOutput: ok\n</evidence>\n<approved/>";
  const r = checkRegressionShield(report, "Done when:\n- npm test exits 0");
  assert.equal(r.passed, true);
});

// ---- v0.22.6: false-rejection fixes (the hegemon case: three genuine
// <approved/> audits were shield-converted to disapprovals on vocabulary) ----

test("contractItems: excludes 'Out of scope' boundary lines", () => {
  const items = contractItems("Done when:\n- npm test passes\n- Out of scope: gameplay changes, dev-route gating");
  assert.deepEqual(items, ["npm test passes"]);
});

test("compound tokens match via segments (left-cropped → left + cropped)", () => {
  const report = [
    "<evidence>",
    "P0: map canvas now fills the viewport at 1920x895 — screenshot shows the full-width map,",
    "no cropped strip on the left edge.",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(
    report,
    "Done when:\n- P0 play-phaser regression fixed — map canvas fills viewport width at 1920x895 (screenshot shows full-width map, no left-cropped strip).",
  );
  assert.equal(r.passed, true);
});

test("prose punctuation glued to tokens does not break matching (file/element.)", () => {
  const report = [
    "<evidence>",
    "P2 polish: type rhythm and contrast improvements shipped, each scoped to a single file",
    "(one element at a time); surfaces feel tangibly more premium.",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(
    report,
    "Done when:\n- P2 polish items shipped: type rhythm / contrast / micro-anim surfaces that tangibly improve premium feel, each scoped to a single file/element.",
  );
  assert.equal(r.passed, true);
});

test("top-3 candidate matching tolerates contract-only vocabulary", () => {
  // The single-longest-word rule demanded "regression"'s longer sibling
  // verbatim; a natural report that says "screenshot" + "viewport" counts.
  const report = [
    "<evidence>",
    "Final premium-feel pass captured: 12 screenshots under .pi/chrome-screenshots/audit-2026-07-21/final/",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(
    report,
    "Done when:\n- Goal ends when: every audit row is fixed OR DEFER-with-reason, AND a final premium-feel screenshot pass of the whole game is captured under .pi/chrome-screenshots/audit-2026-07-21/final/.",
  );
  assert.equal(r.passed, true);
});

test("still rejects: bamboozle report that never touches the item's vocabulary", () => {
  const report = [
    "<evidence>",
    "I ran the checks and everything looks good. The work is complete and correct.",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(
    report,
    "Done when:\n- P0 play-phaser regression fixed — map canvas fills viewport width at 1920x895.",
  );
  assert.equal(r.passed, false);
  assert.equal(r.missingItems.length, 1);
});

// ---- v0.34.77 (GitHub #5): non-ASCII (Chinese) contract items — the token
// extraction regex was ASCII-only, so pure-CJK lines produced zero candidates
// and could never be matched against the evidence block. ----

const ZH_CONTRACT = "Done when:\n- 调研报告文件存在且包含以下章节：\n- 包含「横向对比表」，至少对比 5 个工具/方案\n- README 包含 Markdown 渲染说明";

test("CJK: a verbatim-quoted Chinese item passes (token is one CJK word, not delimiters)", () => {
  const report = [
    "Audit report.",
    "<evidence>",
    "Item: 调研报告文件存在且包含以下章节：",
    "Output:",
    "$ ls reports/调研.pdf",
    "调研报告文件存在且包含以下章节",
    "Item: 包含「横向对比表」，至少对比 5 个工具/方案",
    "Output:",
    "横向对比表 rendered",
    "Item: README 包含 Markdown 渲染说明",
    "Output:",
    "README section: Markdown rendering",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, ZH_CONTRACT);
  assert.equal(r.passed, true, JSON.stringify(r.missingItems));
  assert.deepEqual(r.missingItems, []);
});

test("CJK: a quote that drops the trailing full-width colon still matches", () => {
  // The auditor copied the item without its final ： — the candidate token
  // (colon stripped by the split) is a substring of the report either way.
  const report = [
    "<evidence>",
    "Item: 调研报告文件存在且包含以下章节",
    "Output:",
    "found",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, "Done when:\n- 调研报告文件存在且包含以下章节：");
  assert.equal(r.passed, true, JSON.stringify(r.missingItems));
});

test("CJK: a Chinese line with no ASCII letters is one candidate token", () => {
  const r = checkRegressionShield(
    "<evidence>\nItem: 调研报告文件存在且包含以下章节\nOutput: ok\n</evidence>\n<approved/>",
    "Done when:\n- 调研报告文件存在且包含以下章节",
  );
  assert.equal(r.passed, true);
});

test("CJK: an English-only paraphrase of a Chinese item is still rejected (strict shield)", () => {
  const report = [
    "<evidence>",
    "Item: the research report file exists and contains the following sections",
    "Output: confirmed",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, ZH_CONTRACT);
  assert.equal(r.passed, false);
  assert.ok(r.missingItems.length >= 1);
});

test("CJK: mixed item matches on its ASCII token even when CJK words are not quoted", () => {
  // 包含「横向对比表」… also carries the ASCII token Markdown via README line.
  const report = [
    "<evidence>",
    "README includes a Markdown rendering section.",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, "Done when:\n- README 包含 Markdown 渲染说明");
  assert.equal(r.passed, true);
});

test("ASCII behavior is unchanged: distinctive-token + compound matching still work", () => {
  const report = [
    "<evidence>",
    "Checked the file:",
    "$ cat hello.txt",
    "world",
    "$ grep -q world hello.txt && echo PASS",
    "PASS",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, "Done when: grep -q world hello.txt");
  assert.equal(r.passed, true);
  // compound segments still match
  const r2 = checkRegressionShield(
    "<evidence>\nno cropped strip on the left edge\n</evidence>\n<approved/>",
    "Done when:\n- left-cropped strip absent",
  );
  assert.equal(r2.passed, true);
});

// ---- v0.23.4: preamble lines are not items (darklord field bug) ----

test("contractItems: 'Done when ALL of the following are true:' preamble is dropped", () => {
  const items = contractItems([
    "Done when ALL of the following are true:",
    "1. combat-debug route renders without console errors",
    "2. art-demo-v7 variants persist across reload",
  ].join("\n"));
  assert.deepEqual(items, [
    "combat-debug route renders without console errors",
    "art-demo-v7 variants persist across reload",
  ]);
});

test("contractItems: preamble without trailing colon is also dropped", () => {
  const items = contractItems("Done when all of the following are true\n- tests pass cleanly");
  assert.deepEqual(items, ["tests pass cleanly"]);
});

test("shield passes a genuine approval that a preamble-only false positive used to block", () => {
  const report = [
    "<evidence>",
    "combat-debug renders: bun test src/lib — 42 pass, 0 fail.",
    "variants persist: reloaded the page, localStorage key art-demo-v7 intact.",
    "</evidence>",
    "<approved/>",
  ].join("\n");
  const r = checkRegressionShield(report, [
    "Done when ALL of the following are true:",
    "1. combat-debug route renders without console errors",
    "2. art-demo-v7 variants persist across reload",
  ].join("\n"));
  assert.equal(r.passed, true);
  assert.deepEqual(r.missingItems, []);
});

test("extractMechanicalCheckCommands: extracts backticked and raw shell commands", async () => {
  const { extractMechanicalCheckCommands, runMechanicalPreAuditChecks } = await import("../extensions/goal-loop-shield.ts");
  const contract = [
    "Done when:",
    "1. Run `npm test` and ensure 0 failures",
    "2. `tsc --noEmit` passes with zero errors",
    "3. cargo test --lib passes cleanly",
    "4. The UI displays the dark theme correctly",
  ].join("\n");
  const cmds = extractMechanicalCheckCommands(contract);
  assert.deepEqual(cmds, ["npm test", "tsc --noEmit", "cargo test --lib"]);

  const res = runMechanicalPreAuditChecks(process.cwd(), ["node -e 'process.exit(0)'"]);
  assert.equal(res.passed, true);

  const failRes = runMechanicalPreAuditChecks(process.cwd(), ["node -e 'console.error(\"boom\"); process.exit(2)'"]);
  assert.equal(failRes.passed, false);
  assert.equal(failRes.exitCode, 2);
  assert.match(failRes.output!, /boom/);
});

