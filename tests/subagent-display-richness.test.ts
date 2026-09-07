// pi-goal-list-loop-audit — v0.38.22
// tests/subagent-display-richness.test.ts
//
// Display-unification richness ladder: quiet (default, audit 2026-09-07 —
// exceptions-only; healthy fan-out lives on the fleet panel) shows
// troubled (non-fresh) rows only, rich shows all rows, compact keeps the
// count line. Pins: default/normalization, bucketed
// silence stability (no per-second widget-key churn — the v0.37.1 jumping
// must not return through rich lines), the HUNG-never-silent invariant,
// and width safety.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  assembleAgentsExtras,
  hasHungWorker,
  renderAgentsWidgetLines,
  type AgentsPanelRow,
} from "../extensions/goal-agents-panel.js";
import { DEFAULT_SETTINGS, normalizeLoadedSettings } from "../extensions/goal-settings.js";

function row(over: Partial<AgentsPanelRow> = {}): AgentsPanelRow {
  return {
    recordId: "rec-1234567890",
    agentType: "worker",
    summary: "ui fixes",
    status: "running",
    phase: "active",
    spawnedAt: Date.now() - 200_000,
    lastProgressAt: Date.now() - 30_000,
    toolUses: 36,
    outputTokens: 1200,
    silentMs: 30_000,
    evidence: "live",
    ...over,
  };
}

test("audit 2026-09-07 richness defaults to quiet (exceptions-only) and normalizes junk", () => {
  assert.equal(DEFAULT_SETTINGS.subagentDisplayRichness, "quiet", "quiet default");
  const junk = normalizeLoadedSettings({ subagentDisplayRichness: "verbose" } as never);
  assert.equal(junk.subagentDisplayRichness, "quiet", "junk falls back to quiet, never blanks the display");
  const unset = normalizeLoadedSettings({});
  assert.equal(unset.subagentDisplayRichness, "quiet", "unset means quiet");
});

test("v0.38.23 rich assembles single-line glyph rows, no header; compact keeps the line; quiet hides healthy workers", () => {
  const rows = [row(), row({ recordId: "rec-abcdef", summary: "art batch", silentMs: 65_000 })];
  const rich = assembleAgentsExtras(rows, "rich", 1_000_000);
  assert.ok(rich, "rich shows workers");
  // v0.38.23 Option-2: one glyph-first row per worker, no task-linkage
  // header (the card head already names the objective), no ids.
  assert.equal(rich!.lines.length, 2, "one row per worker");
  assert.match(rich!.lines[0]!, /^▶ worker · art batch · active 1m00s$/, "stalest first within rank; age before any suffix");
  assert.match(rich!.lines[1]!, /^▶ worker · ui fixes · active 30s$/, "healthy row: glyph + name + age, no state word");
  assert.ok(!rich!.lines.some((l) => l.includes("rec-")), "ids live in /glla agents, not the widget");
  assert.ok(rich!.line.startsWith("● 2 agents"), "count line kept");

  const compact = assembleAgentsExtras(rows, "compact", 1_000_000);
  assert.ok(compact?.line.startsWith("● 2 agents"), "compact keeps the count line");
  assert.deepEqual(compact!.lines, [], "compact splices no detail rows");

  // Audit 2026-09-06 (DECIDED: show count line): quiet hides only at zero
  // tracked — tracked-but-healthy keeps the compact count line.
  // Audit 2026-09-07 (DECIDED: exceptions-only): quiet splices troubled
  // (non-fresh) rows; fresh healthy rows live on the fleet panel.
  const quiet = assembleAgentsExtras(rows, "quiet", 1_000_000);
  assert.equal(quiet?.line, assembleAgentsExtras(rows, "compact", 1_000_000)?.line, "quiet keeps the healthy count line");
  assert.deepEqual(quiet!.lines, [], "fresh healthy rows stay off the card");
  assert.equal(assembleAgentsExtras([], "quiet", 1_000_000), undefined, "quiet hides when zero tracked");

  const mixed = assembleAgentsExtras(
    [row(), row({ recordId: "rec-aging", summary: "old work", silentMs: 6 * 60_000 })],
    "quiet",
    1_000_000,
  );
  assert.equal(mixed!.lines.length, 1, "quiet splices the troubled row only");
  assert.ok(!mixed!.lines.some((l) => l.includes("ui fixes")), "fresh row stays on the fleet panel");

  const hung = assembleAgentsExtras([row({ status: "hung" })], "quiet", 1_000_000);
  assert.ok(hung?.line.includes("⚠"), "HUNG is never silent, even on quiet");
  assert.equal(hung!.lines.length, 1, "HUNG row surfaces under quiet");
  assert.ok(!hung!.lines.some((l) => l.includes("rec-")), "troubled rows still keep ids out of the widget");
});

test("v0.38.22 detailed lines bucket silence — identical output seconds apart", () => {
  const a = renderAgentsWidgetLines([row({ silentMs: 31_000 })], 1_000_000);
  const b = renderAgentsWidgetLines([row({ silentMs: 34_000 })], 1_003_000);
  assert.deepEqual(a, b, "no per-second widget-key churn");
  const c = renderAgentsWidgetLines([row({ silentMs: 31_000 })], 1_000_000);
  const d = renderAgentsWidgetLines([row({ silentMs: 95_000 })], 1_064_000);
  assert.notDeepEqual(c, d, "genuine silence growth still surfaces");
});

test("v0.38.22 hasHungWorker covers hung + aborting, ignores ended", () => {
  assert.equal(hasHungWorker([row()]), false, "healthy running worker is not hung");
  assert.equal(hasHungWorker([row({ status: "hung" })]), true, "hung fires");
  assert.equal(hasHungWorker([row({ action: "abort-requested" })]), true, "aborting fires");
  assert.equal(hasHungWorker([row({ status: "ended", endedOk: true })]), false, "ended workers never fire");
  assert.equal(hasHungWorker([]), false, "zero workers, zero presence");
});

test("v0.38.23 every rich line is width-safe; long summaries truncate cell-aware", () => {
  const wide = assembleAgentsExtras(
    [row({ summary: "a".repeat(100), recordId: "r".repeat(60) })],
    "rich",
    1_000_000,
  )!;
  for (const line of [wide.line, ...wide.lines]) {
    assert.ok(line.length <= 100, `width-safe: ${line.length} chars`);
  }
  assert.match(wide.lines[0]!, /^▶ worker · a+… · active 30s$/, "long summary truncates, age survives");
});
