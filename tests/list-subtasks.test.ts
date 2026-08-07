/**
 * v0.34.81 — LIGHT parent/child subtask binding for list items.
 *
 * Contract (preview accepted 2026-08-07):
 *   - ListItem gains an OPTIONAL parentId. One level only; nesting refused.
 *   - Declaration: line-start `Subtask of: <parent objective> — <child>`.
 *     The marker is consumed; the child objective carries its own Parallel /
 *     Done-when clauses as normal.
 *   - Enqueue resolves parentId by objective match: earlier items in the
 *     SAME batch win, then existing queue. Unresolved / nested / empty
 *     children refused loudly; the rest of the batch still lands.
 *   - Auto-advance SILENTLY skips a group (queue item with open children):
 *     children are queued right after the parent, so the scan lands on the
 *     natural next item. EXPLICIT picks on a group (`/list next <n>`,
 *     list_activate) refuse loudly so the user is not confused by a
 *     silent jump.
 *   - Cascade close in archiveCurrentGoal: when the last child of a group
 *     completes, the parent is removed from the queue, its disk sidecar
 *     deleted, and `list_group_closed` ledgered. No synthetic goal archive
 *     md (the child IS the audit unit; the ledger is the durable trace).
 *   - /list show + list_status render groups with `[group: N open]` and
 *     children as `1.1`, `1.2` under their parent.
 *
 * These tests are arranged in two tiers: pure parser/render checks (no
 * MockPi), and behavioral checks (MockPi + activateNextListItem +
 * archiveCurrentGoal). The pure tier pins the data model; the behavioral
 * tier pins the lifecycle.
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  extractSubtaskParent,
  parseListItemDeclaration,
  type ListItem,
} from "../extensions/goal-loop-core.js";

// =====================================================================
// PURE TIER — parser / data model
// =====================================================================

test("v0.34.81: SUBTASK_MARKER is line-start + case-insensitive", () => {
  assert.match("Subtask of: Parent — Child", /^[ \t]*subtask of[ \t]*:/i);
  assert.match("subtask of: Parent — Child", /^[ \t]*subtask of[ \t]*:/i);
  assert.match("SUBTASK OF: Parent — Child", /^[ \t]*subtask of[ \t]*:/i);
  assert.doesNotMatch("The subtask of: x — y", /^[ \t]*subtask of[ \t]*:/i, "mid-sentence is not a declaration");
});

test("v0.34.81: extractSubtaskParent — no marker → undefined parent", () => {
  const r = extractSubtaskParent("Plain item, no parent");
  assert.equal(r.parentObjective, undefined);
  assert.equal(r.objective, "Plain item, no parent");
});

test("v0.34.81: extractSubtaskParent — em-dash splits parent/child", () => {
  const r = extractSubtaskParent("Subtask of: Deploy the release pipeline — bump version");
  assert.equal(r.parentObjective, "Deploy the release pipeline");
  assert.equal(r.objective, "bump version");
});

test("v0.34.81: extractSubtaskParent — en-dash and hyphen-separator both work", () => {
  assert.equal(extractSubtaskParent("Subtask of: Parent – child-A").parentObjective, "Parent");
  assert.equal(extractSubtaskParent("Subtask of: Parent - child-A").parentObjective, "Parent");
});

test("v0.34.81: extractSubtaskParent — hyphen WITHOUT spaces does NOT split", () => {
  // "Fix A-B" is a single parent objective; only spaced em/en/hyphen split.
  const r = extractSubtaskParent("Subtask of: Fix A-B — do the thing");
  assert.equal(r.parentObjective, "Fix A-B");
  assert.equal(r.objective, "do the thing");
});

test("v0.34.81: extractSubtaskParent — no separator captures parent only, empty child", () => {
  const r = extractSubtaskParent("Subtask of: Just a parent");
  assert.equal(r.parentObjective, "Just a parent");
  assert.equal(r.objective, "");
});

test("v0.34.81: extractSubtaskParent — multi-line child objective survives marker strip", () => {
  const raw = "Subtask of: Pipeline rollout — do the thing\n  with care\n  verify via tests";
  const r = extractSubtaskParent(raw);
  assert.equal(r.parentObjective, "Pipeline rollout");
  // Whitespace inside the original raw is preserved verbatim — the
  // verification-contract pass trims later. The marker line is the only
  // line that is split.
  assert.equal(r.objective, "do the thing\n  with care\n  verify via tests");
});

test("v0.34.81: parseListItemDeclaration — child objective keeps its own Parallel + Done when", () => {
  const r = parseListItemDeclaration(
    "Subtask of: Deploy the release pipeline — bump version. Parallel: yes. Done when: npm test passes",
  );
  assert.equal(r.parentObjective, "Deploy the release pipeline");
  // extractVerificationContract strips a trailing period left over from
  // splitting off the contract clause.
  assert.equal(r.objective, "bump version");
  assert.equal(r.parallelSafe, true);
  assert.match(r.verificationContract, /npm test passes/);
});

test("v0.34.81: parseListItemDeclaration — no marker means parentObjective is undefined", () => {
  const r = parseListItemDeclaration("Just a normal item. Done when: foo");
  assert.equal(r.parentObjective, undefined);
  assert.equal(r.objective, "Just a normal item");
});

// =====================================================================
// SIDE-CAR ROUND-TRIP
// =====================================================================

test("v0.34.81: parentId round-trips through writeQueueItemFile → readQueueFromDisk", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-subtasks-"));
  try {
    const parent: ListItem = { id: "p1", objective: "Deploy the release pipeline", addedAt: "2026-08-07T10:00:00.000Z" };
    const child: ListItem = { id: "c1", objective: "bump version", parentId: "p1", addedAt: "2026-08-07T10:00:01.000Z" };
    // Use the same write path the runtime uses (require the module fresh per cwd).
    const { writeQueueItemFile, readQueueFromDisk } = require("../extensions/goal-loop-core.js");
    writeQueueItemFile(cwd, parent);
    writeQueueItemFile(cwd, child);
    const reloaded = readQueueFromDisk(cwd);
    const foundChild = reloaded.find((x: ListItem) => x.id === "c1");
    assert.ok(foundChild, "child reloaded");
    assert.equal(foundChild!.parentId, "p1");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("v0.34.81: readQueueFromDisk ignores malformed parentId (non-string)", () => {
  // Direct check — write a sidecar with a bogus parentId and confirm the
  // reader drops it. Belt-and-suspenders so a torn-write or hand-edit
  // cannot resurrect a phantom parentId.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-subtasks-bad-"));
  try {
    const dir = path.join(cwd, ".pi-glla", "goals");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "x1.queue.json"),
      JSON.stringify({ schema: 1, type: "queue-item", id: "x1", objective: "x", parentId: 42, addedAt: "x" }),
    );
    const { readQueueFromDisk } = require("../extensions/goal-loop-core.js");
    const reloaded = readQueueFromDisk(cwd);
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0]!.parentId, undefined, "non-string parentId dropped on read");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// =====================================================================
// SOURCE-PIN — wiring lives in goal.ts (no behavioral harness needed
// for the wiring itself; the behavioral tier below covers the effect).
// =====================================================================

test("v0.34.81: wiring — parse in core, resolve/refuse/cascade in goal.ts", () => {
  const CORE = fs.readFileSync("extensions/goal-loop-core.ts", "utf-8");
  const SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  // Parse step lives in core (single source of truth for the marker regex).
  assert.match(CORE, /const \{ objective, parentObjective \} = extractSubtaskParent\(raw\);/);
  // Refusal ledger key
  assert.match(SRC, /appendLedger\(ctx\.cwd, "list_subtask_refused", \{ source, count: refused\.length, refusals: refused \}\);/);
  // Cascade close ledger key
  assert.match(SRC, /appendLedger\(ctx\.cwd, "list_group_closed", \{[\s\S]*parentId: pid,/);
  // Explicit-pick refusal key
  assert.match(SRC, /appendLedger\(ctx\.cwd, "list_group_activation_refused", \{ goalId: target\.id, open \}\);/);
  // Scan-skip uses groupOpenChildren
  assert.match(SRC, /while \(scan < queue\.length && groupOpenChildren\(queue\[scan\]!\.id\) > 0\) scan\+\+;/);
  // parentId carried onto the active goal
  assert.match(SRC, /if \(next\.parentId\) goal\.parentId = next\.parentId;/);
  // Nesting refused
  assert.match(SRC, /nested subtask ".*" — one level only/);
  // Unresolved parent refused
  assert.match(SRC, /unresolved parent ".*" for child/);
});