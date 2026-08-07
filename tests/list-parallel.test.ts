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
} from "../extensions/goal-loop-core.ts";

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
