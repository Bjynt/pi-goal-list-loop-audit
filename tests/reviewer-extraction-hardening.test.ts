// pi-goal-list-loop-audit — v0.26.3
// tests/reviewer-extraction-hardening.test.ts
//
// Live false-positive regression: the reviewer fired on the 0.26.2
// completion and matched 3 junk "architectural" findings (a test name,
// the INSTALL.md mode-matrix table row, and ship-doc prose) — every one
// a reviewer-vocabulary self-match. These tests pin the exact lines.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  classifyFindingText,
  extractFindings,
  resolveReviewerConfig,
  runReviewer,
  type ReviewerDeps,
} from "../extensions/reviewer.ts";

// The exact 3 junk findings from the live 0.26.2 review report:
const LIVE_FALSE_POSITIVES = [
  'Docs: CHANGELOG `[0.26.2]` entry and INSTALL.md reviewer mode matrix (default/auto/report × problems/architectural/clean) with auto-loop and safety description.',
  '47:test("auto mode: architectural findings enqueue to /list — proposeGoal NEVER called", ...',
  '| Mode | Problems / improvements found | Architectural | Clean completion |',
];

test("the 3 live false-positive lines extract NOTHING", () => {
  for (const line of LIVE_FALSE_POSITIVES) {
    assert.equal(classifyFindingText(line), undefined, `still matching: ${line.slice(0, 60)}`);
  }
});

test("code lines are skipped (test/it/assert/const/import/…)", () => {
  assert.equal(classifyFindingText('test("architectural rewrite happens here", () => {})'), undefined);
  assert.equal(classifyFindingText('  it("should rewrite the schema", ...)'), undefined);
  assert.equal(classifyFindingText('const rewrite = loadSchema("x");'), undefined);
  assert.equal(classifyFindingText('import { rewrite } from "./schema";'), undefined);
  assert.equal(classifyFindingText('assert.equal(rewriteCount, 3);'), undefined);
});

test("markdown table rows are skipped", () => {
  assert.equal(classifyFindingText("| rewrite | new dependency | schema change |"), undefined);
  assert.equal(classifyFindingText("  | Mode | Architectural | Clean |"), undefined);
});

test("reviewer-report vocabulary is skipped (self-match prevention)", () => {
  assert.equal(classifyFindingText("Architectural-class findings are proposed as /goal, Confirm required"), undefined);
  assert.equal(classifyFindingText("the reviewer found 3 architectural-class finding(s)"), undefined);
  assert.equal(classifyFindingText("**Cascade step**: propose-goal — schema change discussed"), undefined);
  assert.equal(classifyFindingText("default/auto/report × problems/architectural/clean — schema change column"), undefined);
});

test("real architectural + strategic text still classifies", () => {
  assert.equal(classifyFindingText("we should rewrite the event schema to normalize it"), "architectural");
  assert.equal(classifyFindingText("this needs a new dependency on zod"), "architectural");
  assert.equal(classifyFindingText("requires a schema change in the ledger format"), "architectural");
  assert.equal(classifyFindingText("a redesign of the widget layer is due"), "architectural");
  assert.equal(classifyFindingText("should we deprecate the old API?"), "strategic");
  assert.equal(classifyFindingText("TODO: fix the null deref"), "bug");
});

test("full runReviewer over 0.26.2-style source text produces zero architectural findings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-harden-"));
  const calls = { proposed: [] as string[], enqueued: [] as string[][] };
  const deps: ReviewerDeps = {
    cwd: dir,
    nowMs: Date.parse("2026-07-26T13:00:00Z"),
    ledgerEntries: [],
    sources: [{ name: "archive", text: LIVE_FALSE_POSITIVES.join("\n") }],
    enqueueListItems: (objs) => calls.enqueued.push(objs),
    proposeGoal: (obj) => calls.proposed.push(obj),
    notify: () => {},
    ledger: () => {},
  };
  const out = runReviewer(resolveReviewerConfig(), { kind: "goal", goalId: "g1", objective: "ship 0.26.2", terminal: "goal-complete" }, deps);
  assert.equal(out.fired, true);
  assert.equal(out.report!.findings.length, 0, "the live junk lines produce no findings at all");
  // Zero findings = clean completion → the audit cascade step fires BY
  // DESIGN; the invariant is that it is the ONLY proposal (no junk
  // architectural /goal proposals from the false-positive lines).
  assert.equal(calls.proposed.length, 1);
  assert.match(calls.proposed[0]!, /regression scan/i);
});

test("extraction dedupe + cap still work after hardening", () => {
  const findings = extractFindings(
    [{ name: "x", text: "TODO: fix the parser null deref\nTODO: fix the parser null deref\nTODO: fix the cache key" }],
    10,
  );
  assert.equal(findings.length, 2, "duplicates collapse");
  assert.ok(findings.every((f) => f.class === "bug"));
});
