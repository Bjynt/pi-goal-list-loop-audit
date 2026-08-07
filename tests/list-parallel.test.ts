// pi-goal-list-loop-audit — v0.2.0
// tests/list-parallel.test.ts
//
// v0.34.76 (OPEN-ISSUES 1.11): the parallelSafe DECLARATION on /list items.
// Pins: the `Parallel:` marker parse (truthy/falsy/absent, line-start +
// inline, marker consumed), parse order vs the `Done when:` contract, the
// enqueue path carrying the flag into state + disk sidecar, the disk
// round-trip (readQueueFromDisk), and the status surfaces ([parallel] tag).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  extractParallelFlag,
  parseListItemDeclaration,
  readQueueFromDisk,
  writeQueueItemFile,
  newGoalId,
  nowIso,
  readState,
} from "../extensions/goal-loop-core.ts";
import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, seedState, seedGoal, tick } from "./harness/mock-pi.js";

import { test, beforeEach } from "node:test";

// ONE module-level pi, like behavioral-orchestrator: registerAgentTools runs
// once per extension instance (toolsRegistered is module state), so a fresh
// MockPi per test would never have its tools registered.
const pi = new MockPi();
activate(pi.api);

beforeEach(() => {
  // The owner session is module state — without the reset a later test's
  // session_start is foreign-gated and never re-reads its seeded state.
  __testOnlyResetOwnerSession();
});

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-gla-list-parallel-test-"));
}

test("extractParallelFlag: truthy values mark the item parallel-safe", () => {
  for (const value of ["yes", "true", "1", "safe", "parallel"]) {
    const r = extractParallelFlag(`Run the scans. Parallel: ${value}`);
    assert.equal(r.parallelSafe, true, `"${value}" must parse parallel-safe`);
    assert.equal(r.objective, "Run the scans.", "marker consumed from the objective");
  }
});

test("extractParallelFlag: falsy values explicitly opt out", () => {
  for (const value of ["no", "false", "0", "none", "off"]) {
    const r = extractParallelFlag(`Ship the migration. Parallel: ${value}`);
    assert.equal(r.parallelSafe, false, `"${value}" must parse not-safe`);
    assert.equal(r.objective, "Ship the migration.", "marker consumed");
  }
});

test("extractParallelFlag: no marker → undefined (unknown, not false)", () => {
  const r = extractParallelFlag("Just a normal item with no declaration.");
  assert.equal(r.parallelSafe, undefined);
  assert.equal(r.objective, "Just a normal item with no declaration.");
});

test("extractParallelFlag: inline marker mid-line, case-insensitive", () => {
  const r = extractParallelFlag("Write docs first, PARALLEL: yes, then ship.");
  assert.equal(r.parallelSafe, true);
  assert.equal(r.objective, "Write docs first, then ship.");
});

test("parseListItemDeclaration: marker stripped BEFORE the contract split", () => {
  const d = parseListItemDeclaration("Fix the exporter. Parallel: yes. Done when: grep -q ok out.json");
  assert.equal(d.parallelSafe, true);
  assert.equal(d.objective, "Fix the exporter"); // inline-contract split strips the trailing period (existing behavior)
  assert.equal(d.verificationContract, "grep -q ok out.json");
  assert.ok(!d.verificationContract.includes("parallel"), "contract never carries the declaration");
});

test("parseListItemDeclaration: a parallel marker after Done when: still strips cleanly", () => {
  const d = parseListItemDeclaration("Create x.txt\nDone when: grep -q ok x.txt\nParallel: no");
  assert.equal(d.parallelSafe, false);
  assert.equal(d.objective, "Create x.txt");
  assert.equal(d.verificationContract, "Done when: grep -q ok x.txt"); // line-based blocks keep their marker line (existing convention)
  assert.ok(!d.verificationContract.includes("parallel"), "contract never carries the declaration");
});

test("parseListItemDeclaration: parallel marker inside a multi-line objective is consumed", () => {
  const d = parseListItemDeclaration("Step one\nStep two. Parallel: safe\nStep three");
  assert.equal(d.parallelSafe, true);
  assert.equal(d.objective, "Step one\nStep two.\nStep three");
  assert.equal(d.verificationContract, "");
});

test("queue sidecar round-trips the parallelSafe flag", () => {
  const cwd = tmpCwd();
  try {
    const item = { id: newGoalId(), objective: "scan a and b", parallelSafe: true, addedAt: nowIso() };
    writeQueueItemFile(cwd, item);
    const fromDisk = readQueueFromDisk(cwd);
    assert.equal(fromDisk.length, 1);
    assert.equal(fromDisk[0]!.id, item.id);
    assert.equal(fromDisk[0]!.parallelSafe, true, "parallelSafe survives the disk round-trip");
    // A legacy sidecar without the flag stays undefined.
    const legacy = { id: newGoalId(), objective: "old item", addedAt: nowIso() };
    writeQueueItemFile(cwd, legacy);
    const fromDisk2 = readQueueFromDisk(cwd);
    const legacyBack = fromDisk2.find((i) => i.id === legacy.id)!;
    assert.equal(legacyBack.parallelSafe, undefined);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Behavioral: the enqueue path + the status surfaces ─────────────────────

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true } : {}));
}

function makePi() {
  return pi;
}

function enqueuedItems(cwd: string) {
  return readState(cwd).list ?? [];
}

const fs2 = fs; // keep fs in scope for the behavioral tests below

const ITEMS = [
  "Run the a-scan. Parallel: yes. Done when: grep -q ok a.txt",
  "Run the b-scan. Parallel: yes",
  "Do the migration. Parallel: no",
  "Plain item with no declaration",
];

test("list_add parses the declaration into the queue state + disk + status", async () => {
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  try {
    // An ACTIVE goal so the new items queue instead of auto-activating.
    seedState(cwd, { goal: seedGoal({ policy: "goal", status: "active", objective: "busy" }) });
    const pi = makePi();
    const ctx = makeMockCtx(cwd);
    await pi.fire("session_start", { reason: "startup" }, ctx);
    await tick();
    await pi.runTool("list_add", { items: ITEMS }, ctx);

    // Schema accepts the declaration: state carries parallelSafe, the marker
    // is consumed from the objective.
    const queued = enqueuedItems(cwd);
    assert.equal(queued.length, 4);
    const [a, b, mig, plain] = queued;
    assert.equal(a!.parallelSafe, true);
    assert.equal(a!.objective, "Run the a-scan"); // inline-contract split strips the trailing period (pinned in the pure tests)
    assert.equal(a!.verificationContract, "grep -q ok a.txt");
    assert.equal(b!.parallelSafe, true);
    assert.equal(b!.objective, "Run the b-scan.");
    assert.equal(mig!.parallelSafe, false, "Parallel: no explicitly opts out");
    assert.equal(mig!.objective, "Do the migration.");
    assert.equal(plain!.parallelSafe, undefined, "no marker → unknown");

    // Disk sidecars carry it (survives /reload + the disk-first fallback).
    const fromDisk = readQueueFromDisk(cwd);
    assert.equal(fromDisk.filter((i) => i.parallelSafe === true).length, 2);
    assert.equal(fromDisk.filter((i) => i.parallelSafe === false).length, 1);

    // Status surface: list_status renders the [parallel] tag.
    const res = await pi.runTool("list_status", {}, ctx);
    const text = res.content.map((c) => c.text).join("\n");
    assert.ok(text.includes("[parallel]"), "list_status shows the declaration tag");
    assert.ok(text.includes("Run the a-scan [parallel]"), "the tagged line reads correctly");
    assert.ok(text.includes("Run the b-scan [parallel]"));
    assert.ok(!/Do the migration\. \[parallel\]/.test(text), "Parallel: no is NOT tagged");
    assert.ok(!/Plain item[^\n]*\[parallel\]/.test(text), "undeclared item is not tagged");
  } finally {
    fs2.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a declared item activating into a goal carries the CLEAN objective (no marker leak)", async () => {
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  try {
    seedState(cwd, { goal: seedGoal({ policy: "goal", status: "complete", objective: "previously done" }) }); // completed goal → not a blank startup; the first queued item auto-activates
    const pi = makePi();
    const ctx = makeMockCtx(cwd);
    await pi.fire("session_start", { reason: "startup" }, ctx);
    await tick();
    await pi.runTool("list_add", { items: ["Ship the fix. Parallel: yes. Done when: grep -q ok fix.txt"] }, ctx);
    await tick();
    const s = readState(cwd);
    assert.ok(s.goal, "the item auto-activated");
    assert.equal(s.goal!.objective, "Ship the fix"); // inline-contract split strips the trailing period
    assert.ok(!s.goal!.objective.includes("Parallel"), "no marker leak into the active goal");
    assert.equal(s.goal!.verificationContract, "grep -q ok fix.txt");
  } finally {
    fs2.rmSync(cwd, { recursive: true, force: true });
  }
});
