// pi-goal-list-loop-audit — v0.26.2
// tests/reviewer-modes.test.ts
//
// Reviewer modes + the auto-loop cascade: default (Confirm-gated),
// auto (everything actionable becomes /list items, zero Confirms),
// report (report + notify only). Plus improvement-class extraction
// and the auto-mode refire-window relaxation for list-complete.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_REVIEWER_CONFIG,
  classifyFindingText,
  resolveReviewerConfig,
  reviewerMenuOptions,
  runReviewer,
  type ReviewerDeps,
} from "../extensions/reviewer.ts";

const SRC_GOAL = fs.readFileSync("extensions/loops/goal.ts", "utf-8");

function mkDeps(cwd: string, over: Partial<ReviewerDeps> = {}) {
  const calls = { enqueued: [] as string[][], proposed: [] as string[], notified: [] as string[], ledgered: [] as string[] };
  const deps: ReviewerDeps = {
    cwd,
    nowMs: Date.parse("2026-07-26T12:00:00Z"),
    ledgerEntries: [],
    sources: [],
    enqueueListItems: (objs) => calls.enqueued.push(objs),
    proposeGoal: (obj) => calls.proposed.push(obj),
    notify: (m) => calls.notified.push(m),
    ledger: (t) => calls.ledgered.push(t),
    ...over,
  };
  return { deps, calls };
}

const GOAL_SRC = { kind: "goal" as const, goalId: "g1", objective: "audit screens", terminal: "goal-complete" };
const LIST_SRC = { kind: "list" as const, goalId: "g9", objective: "last item", terminal: "goal-complete" };
const AUTO = { ...resolveReviewerConfig(), mode: "auto" as const };
const REPORT = { ...resolveReviewerConfig(), mode: "report" as const };

test("auto mode: architectural findings enqueue to /list — proposeGoal NEVER called", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-mode-"));
  const { deps, calls } = mkDeps(dir, {
    sources: [{ name: "audit", text: "We should rewrite the schema to normalize events." }],
  });
  const out = runReviewer(AUTO, GOAL_SRC, deps);
  assert.equal(out.fired, true);
  assert.equal(calls.proposed.length, 0, "auto mode never proposes (no Confirm)");
  assert.equal(calls.enqueued.length, 1);
  assert.match(calls.enqueued[0]![0]!, /rewrite the schema/);
});

test("auto mode: clean completion enqueues the audit as a /list item (no Confirm)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-mode-"));
  const { deps, calls } = mkDeps(dir, { sources: [{ name: "archive", text: "All done. Tests pass." }] });
  const out = runReviewer(AUTO, GOAL_SRC, deps);
  assert.equal(out.report!.cascadeStep, "fire-audit-on-clean");
  assert.equal(calls.proposed.length, 0);
  assert.equal(calls.enqueued.length, 1);
  assert.match(calls.enqueued[0]![0]!, /regression scan/i);
});

test("report mode: report written + notified, but nothing enqueued or proposed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-mode-"));
  const { deps, calls } = mkDeps(dir, {
    sources: [{ name: "archive", text: "TODO: fix parser\nWe should rewrite the schema" }],
  });
  const out = runReviewer(REPORT, GOAL_SRC, deps);
  assert.equal(out.fired, true);
  assert.equal(out.report!.cascadeStep, "report-only");
  assert.equal(out.enqueued, 0);
  assert.equal(out.proposed, 0);
  assert.equal(calls.enqueued.length, 0);
  assert.equal(calls.proposed.length, 0);
  assert.ok(out.reportPath && fs.existsSync(out.reportPath), "report still written");
  assert.match(fs.readFileSync(out.reportPath!, "utf-8"), /\*\*Mode\*\*: report/);
});

test("improvement-class extraction: 'consider adding X' / 'could be improved' enqueue without Confirm", () => {
  assert.equal(classifyFindingText("consider adding a retry queue for failed jobs"), "refactor");
  assert.equal(classifyFindingText("the startup path could be improved a lot"), "refactor");
  assert.equal(classifyFindingText("nice to have: dark mode for the HUD"), "refactor");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-mode-"));
  const { deps, calls } = mkDeps(dir, { sources: [{ name: "archive", text: "consider adding a retry queue for failed jobs" }] });
  runReviewer(resolveReviewerConfig(), GOAL_SRC, deps);
  assert.equal(calls.enqueued.length, 1);
  assert.equal(calls.proposed.length, 0);
});

test("auto mode: refire window skipped for list-complete, enforced for goal-complete and in default mode", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-mode-"));
  const now = Date.parse("2026-07-26T12:00:00Z");
  const recent = [{ type: "reviewer_fired", at: new Date(now - 60_000).toISOString() }];
  // auto + list-complete → fires despite the recent fire:
  const a = runReviewer(AUTO, LIST_SRC, mkDeps(dir, { ledgerEntries: recent }).deps);
  assert.equal(a.fired, true, "auto mode list-complete ignores the refire window");
  // auto + goal-complete → still suppressed:
  const b = runReviewer(AUTO, GOAL_SRC, mkDeps(dir, { ledgerEntries: recent }).deps);
  assert.equal(b.fired, false, "auto mode goal-complete still respects the window");
  // default + list-complete → suppressed:
  const c = runReviewer(resolveReviewerConfig(), LIST_SRC, mkDeps(dir, { ledgerEntries: recent }).deps);
  assert.equal(c.fired, false, "default mode list-complete respects the window");
});

test("auto mode: the per-day cap still bounds everything", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-mode-"));
  const entries = Array.from({ length: 20 }, (_, i) => ({ type: "reviewer_fired", at: `2026-07-26T${String(i).padStart(2, "0")}:00:00Z` }));
  const { deps } = mkDeps(dir, { ledgerEntries: entries, nowMs: Date.parse("2026-07-26T23:30:00Z") });
  const out = runReviewer(AUTO, LIST_SRC, deps);
  assert.equal(out.fired, false);
  assert.match(out.suppressedReason!, /day cap/);
});

test("menu: Mode option cycles default → auto → report", () => {
  const def = reviewerMenuOptions(DEFAULT_REVIEWER_CONFIG);
  assert.match(def[1]!, /Mode — default/);
  assert.match(def[1]!, /auto = auto-loop/);
  const auto = reviewerMenuOptions({ ...DEFAULT_REVIEWER_CONFIG, mode: "auto" });
  assert.match(auto[1]!, /Mode — auto/);
  assert.equal(def.length, 9, "one new menu row");
  // the goal.ts handler maps the Mode row to the cycle:
  assert.match(SRC_GOAL, /choice\.startsWith\("Mode"\)\) save\(\{ mode: cfg\.mode === "default" \? "auto" : cfg\.mode === "auto" \? "report" : "default" \}\)/);
});

test("/review accepts a mode override and rejects unknown modes", () => {
  assert.match(SRC_GOAL, /const mode = modeArg === "auto" \|\| modeArg === "report" \|\| modeArg === "default" \? modeArg : undefined;/);
  assert.match(SRC_GOAL, /Unknown mode "\$\{modeArg\}" — use auto \| report \| default\./);
  assert.match(SRC_GOAL, /\{ manual: true, mode \}\)/);
});

test("config: mode defaults to 'default' and merges from project settings", () => {
  assert.equal(DEFAULT_REVIEWER_CONFIG.mode, "default");
  assert.equal(resolveReviewerConfig({ mode: "auto" }).mode, "auto");
  assert.equal(resolveReviewerConfig().mode, "default");
});
