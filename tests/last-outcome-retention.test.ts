// pi-goal-list-loop-audit — v0.35.30
// tests/last-outcome-retention.test.ts
//
// Field report (2026-08-28, Screenshot_20260828_062720): an approved
// completion appeared twice — once as the final notification and once as a
// retained `lastOutcome` widget line. The duplicate made the completed goal
// look like a live item that had not been removed.
//
// Fix under test: the approved notification remains the single live-session
// completion signal; archive/ledger history stays durable, while the live
// slot and legacy lastOutcome widget row are cleared/hidden.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { buildWidgetLines } from "../extensions/goal-loop-display.js";
import { persistStateLine } from "../extensions/goal-state.js";
import { readState, ledgerPath } from "../extensions/goal-loop-core.js";
import type { State } from "../extensions/goal-loop-core.js";

const NOW = 1_800_000_000_000;

function emptyState(overrides: Partial<State> = {}): State {
  return { goal: null, ...overrides } as State;
}

test("v0.35.72: a legacy approved lastOutcome never repaints a completed row", () => {
  const lines = buildWidgetLines(emptyState({
    lastOutcome: {
      at: new Date(NOW - 5 * 60_000).toISOString(),
      ok: true,
      title: "auditor minimax/MiniMax-M3 approved (complete-goal)",
      recap: "Expanded the curated pair set to full C(11,2) coverage — 55 pages prerendered.",
    },
  }), undefined, NOW, undefined, 220);
  assert.equal(lines, undefined, "the archive/notification is the only completion surface");
});

test("v0.35.72: a legacy aborted lastOutcome also stays hidden", () => {
  const lines = buildWidgetLines(emptyState({
    lastOutcome: {
      at: new Date(NOW - 60_000).toISOString(),
      ok: false,
      title: "user cancelled",
    },
  }), undefined, NOW);
  assert.equal(lines, undefined, "terminal history must not leave a live widget row");
});

test("v0.35.72: a live goal remains the only rendered surface", () => {
  const goal = {
    id: "20260822160000-ret", objective: "current work", verificationContract: "", status: "active",
    policy: "goal", autoContinue: true, usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: "", updatedAt: "", revision: 0, turns: 0, fileWrites: 0, bashCalls: 0,
  } as never;
  const lines = buildWidgetLines({ goal, lastOutcome: { at: new Date(NOW).toISOString(), ok: true, title: "old" } } as State, undefined, NOW)!;
  assert.ok(!lines.some((l) => l.includes("✓ done · old")), "legacy history never shadows live work");
});

test("v0.35.72: source pins — slot close clears lastOutcome; wipe remains a clean slate", () => {
  const fs = require("node:fs");
  const orch = fs.readFileSync("extensions/loops/goal-orchestrator.ts", "utf-8");
  const closeIdx = orch.indexOf("const closeArchivedSlot = () => {");
  assert.ok(closeIdx > 0, "closeArchivedSlot exists");
  const closeBody = orch.slice(closeIdx, closeIdx + 900);
  assert.ok(closeBody.includes("lastOutcome: undefined"), "slot close clears the legacy terminal outcome");
  assert.ok(!closeBody.includes("lastOutcome: {"), "slot close does not create a second live outcome surface");
  assert.ok(closeBody.includes("goal: null"), "the slot still closes");
  const cmds = fs.readFileSync("extensions/goal-commands.ts", "utf-8");
  assert.ok(cmds.includes("lastOutcome: undefined"), "/glla wipe clears the retention record");
});

// ---- v0.35.34: compatibility — legacy state remains safely readable ----

const OUTCOME: NonNullable<State["lastOutcome"]> = {
  at: "2026-08-23T01:40:00.000Z",
  ok: true,
  title: "auditor approved (complete-goal)",
  recap: "Plan mode shipped: three verbs, two prompts, full gate green.",
};

test("v0.35.34: lastOutcome round-trips through persistStateLine → readState (durable across restarts)", () => {
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-outcome-dur-"));
  try {
    persistStateLine(cwd, { goal: null, lastOutcome: OUTCOME } as State);
    const restored = readState(cwd);
    assert.deepEqual(restored.lastOutcome, OUTCOME);
    // A later state event without the field must NOT resurrect it, but an
    // earlier event's value persists until overwritten (spread semantics).
    persistStateLine(cwd, { goal: null } as State);
    assert.equal(readState(cwd).lastOutcome, undefined);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("v0.35.34: corrupt lastOutcome lines degrade to absent, never throw", () => {
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-outcome-corrupt-"));
  try {
    fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
    const bad = [
      null,
      "garbage",
      123,
      [1, 2],
      { ok: true },                       // missing at + title
      { at: "", ok: true, title: "x" },   // empty at
      { at: "2026-08-23T00:00:00Z" },     // missing ok/title
      { at: "2026-08-23T00:00:00Z", ok: "yes", title: "x" }, // ok not boolean
    ];
    for (const value of bad) {
      fs.writeFileSync(ledgerPath(cwd), JSON.stringify({ type: "state", at: new Date().toISOString(), value: { lastOutcome: value } }) + "\n");
      assert.equal(readState(cwd).lastOutcome, undefined, JSON.stringify(value));
    }
    // A raw malformed envelope line is skipped by the existing try/catch path.
    fs.writeFileSync(ledgerPath(cwd), "{broken json\n");
    assert.equal(readState(cwd).lastOutcome, undefined);
    // recap is optional but must be a non-empty string when present.
    const partial = { type: "state", at: new Date().toISOString(), value: { lastOutcome: { ...OUTCOME, recap: 42 } } };
    fs.writeFileSync(ledgerPath(cwd), JSON.stringify(partial) + "\n");
    const restored = readState(cwd).lastOutcome;
    assert.ok(restored && restored.title === OUTCOME.title);
    assert.equal(restored!.recap, undefined);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
