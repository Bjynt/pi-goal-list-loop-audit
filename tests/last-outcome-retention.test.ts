// pi-goal-list-loop-audit — v0.35.30
// tests/last-outcome-retention.test.ts
//
// Field report (2026-08-22, screenshots Screenshot_20260822_151220/162044):
// "goal gets closed before final audit, so auditor never approves." The
// lifecycle was actually correct — the verdict approved and archived — but
// closeArchivedSlot nulled the widget slot immediately, so after the agent's
// turn ended the surface went blank and the only trace of the approval was
// one transient toast. To a user returning later this is indistinguishable
// from "closed without an audit".
//
// Fix under test: a durable state.lastOutcome record written at slot close,
// rendered as ONE dim widget line while no goal/list/loop occupies the slot,
// retained 24h, cleared by /glla wipe.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { buildWidgetLines, LAST_OUTCOME_RETENTION_MS } from "../extensions/goal-loop-display.js";
import type { State } from "../extensions/goal-loop-core.js";

const NOW = 1_800_000_000_000;

function emptyState(overrides: Partial<State> = {}): State {
  return { goal: null, ...overrides } as State;
}

test("v0.35.30: a fresh approved outcome renders as a ✓ done line with reason and recap", () => {
  const lines = buildWidgetLines(emptyState({
    lastOutcome: {
      at: new Date(NOW - 5 * 60_000).toISOString(),
      ok: true,
      title: "auditor minimax/MiniMax-M3 approved (complete-goal)",
      recap: "Expanded the curated pair set to full C(11,2) coverage — 55 pages prerendered.",
    },
  }), undefined, NOW, undefined, 220)!;
  assert.equal(lines.length, 1, "history, not a second surface");
  assert.match(lines[0]!, /✓ done/);
  assert.match(lines[0]!, /auditor minimax\/MiniMax-M3 approved/);
  assert.match(lines[0]!, /55 pages prerendered/);
});

test("v0.35.30: an aborted outcome renders the ▪ ended shape", () => {
  const lines = buildWidgetLines(emptyState({
    lastOutcome: {
      at: new Date(NOW - MIN()).toISOString(),
      ok: false,
      title: "user cancelled",
    },
  }), undefined, NOW)!;
  assert.match(lines[0]!, /▪ ended/);
  assert.match(lines[0]!, /user cancelled/);
  assert.doesNotMatch(lines[0]!, /✓ done/, "no success glyph on an abort");
});

function MIN(): number { return 60_000; }

test("v0.35.30: the retention line expires silently after 24h", () => {
  const fresh = buildWidgetLines(emptyState({
    lastOutcome: { at: new Date(NOW - (LAST_OUTCOME_RETENTION_MS - 60_000)).toISOString(), ok: true, title: "x" },
  }), undefined, NOW);
  const stale = buildWidgetLines(emptyState({
    lastOutcome: { at: new Date(NOW - (LAST_OUTCOME_RETENTION_MS + 60_000)).toISOString(), ok: true, title: "x" },
  }), undefined, NOW);
  assert.ok(fresh, "inside the window → visible");
  assert.equal(stale, undefined, "outside the window → gone");
  // A garbage timestamp must never crash the render — treated as expired.
  assert.equal(buildWidgetLines(emptyState({ lastOutcome: { at: "not-a-date", ok: true, title: "x" } }), undefined, NOW), undefined);
});

test("v0.35.30: a live goal outranks the retention line even if lastOutcome lingers", () => {
  const goal = {
    id: "20260822160000-ret", objective: "current work", verificationContract: "", status: "active",
    policy: "goal", autoContinue: true, usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: "", updatedAt: "", revision: 0, turns: 0, fileWrites: 0, bashCalls: 0,
  } as never;
  const lines = buildWidgetLines({ goal, lastOutcome: { at: new Date(NOW).toISOString(), ok: true, title: "old" } } as State, undefined, NOW)!;
  assert.ok(!lines.some((l) => l.includes("✓ done · old")), "retention line never shadows live work");
});

test("v0.35.30: source pins — slot close writes lastOutcome; wipe clears it", () => {
  const orch = require("node:fs").readFileSync("extensions/loops/goal-orchestrator.ts", "utf-8");
  assert.match(orch, /closeArchivedSlot[\\s\\S]{0,800}lastOutcome: \{\s*\n\s*at: nowIso\(\)/, "closeArchivedSlot records the terminal outcome");
  assert.match(orch, /ok: status === "complete"/, "approved vs aborted is recorded");
  const cmds = require("node:fs").readFileSync("extensions/goal-commands.ts", "utf-8");
  assert.match(cmds, /lastOutcome: undefined/, "/glla wipe clears the retention record");
});
