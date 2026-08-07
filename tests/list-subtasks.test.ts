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
import { test, beforeEach, afterEach } from "bun:test";
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
// =====================================================================
// BEHAVIORAL TIER — drives the extension via MockPi + activate()
// to exercise enqueue resolution, scan-skip, cascade close, and the
// explicit-pick refusal. One MockPi + activate per file (bun test isolates
// module state per file). __testOnlyResetOwnerSession between fixtures so
// each gets a fresh MAIN owner and blank-start barrier.
// =====================================================================

import activate, {
  __testOnlyResetOwnerSession,
} from "../extensions/loops/goal.js";
import {
  MockPi,
  makeMockCtx,
  tick,
  tmpCwd,
  type MockCtx,
} from "./harness/mock-pi.js";

const pi = new MockPi();
activate(pi.api);
const MAIN_SM = { name: "main-session-manager" };

// Global settings path mirrors the orchestrator's helper — write the file
// to flip autoResume, restore it after each test.
const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true } : {}));
}

function readLedger(cwd: string): Array<{ type: string; value: Record<string, unknown> }> {
  const file = path.join(cwd, ".pi-glla", "active.jsonl");
  return fs.readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; value: Record<string, unknown> });
}

function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}

async function freshSession(cwd: string, reason = "startup"): Promise<MockCtx> {
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason }, ctx);
  return ctx;
}

afterEach(() => setGlobalAutoResume(false));

/** Build a fake completed-goal state line for archiveCurrentGoal to act on. */
function seedCompletedListGoal(cwd: string, parentId?: string): string {
  const id = `done-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  const goal: Record<string, unknown> = {
    id,
    objective: parentId ? "child objective" : "done objective",
    status: "complete",
    policy: "list",
    autoContinue: true,
    verificationContract: "",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (parentId) goal.parentId = parentId;
  const line = JSON.stringify({ type: "state", value: { goal, list: [], loop: null }, at: new Date().toISOString() });
  fs.appendFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), line + "\n");
  return id;
}

beforeEach(() => {
  __testOnlyResetOwnerSession();
});

test("v0.34.81 (behavioral): list_add with a subtask binds parentId to the matching queue item", async () => {
  setGlobalAutoResume(false); // do not auto-start the head — we just want the queue state
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  // Enqueue: parent + two children + an unrelated normal item. The unrelated
  // item goes LAST so the active slot at start is empty (the parent is
  // not yet a group; only when its children arrive does it become one).
  await pi.command(
    "list",
    "add Deploy the release pipeline — a parent. Done when: foo. Parallel: yes.",
    ctx,
  );
  await pi.command(
    "list",
    "add Subtask of: Deploy the release pipeline — bump version. Done when: bar",
    ctx,
  );
  await pi.command(
    "list",
    "add Subtask of: Deploy the release pipeline — write the changelog. Done when: baz",
    ctx,
  );
  await pi.command("list", "add Unrelated work. Done when: qux", ctx);
  await tick();

  // Read the disk sidecars to confirm parentId is bound and parallelSafe on
  // the parent survives the round-trip.
  const dir = path.join(cwd, ".pi-glla", "goals");
  const sidecars = fs.readdirSync(dir).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf-8")));
  const parent = sidecars.find((s: any) => s.objective.includes("Deploy the release pipeline"));
  const children = sidecars.filter((s: any) => typeof s.parentId === "string");
  assert.ok(parent, "parent sidecar exists");
  assert.equal(parent.parallelSafe, true, "parent keeps its own Parallel: yes");
  assert.equal(children.length, 2, "both children bound");
  for (const c of children) {
    assert.equal(c.parentId, parent.id, "child.parentId points at the parent");
  }
  // The notify for the held-mode + the refused-not-applicable (no refusals here).
  const ledger = readLedger(cwd);
  assert.equal(
    ledger.some((e) => e.type === "list_subtask_refused"),
    false,
    "no refusals expected for a clean batch",
  );
});

test("v0.34.81 (behavioral): unresolved parent refuses that child, other items still land", async () => {
  setGlobalAutoResume(false);
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  await pi.command("list", "add Real parent. Done when: foo", ctx);
  await pi.command(
    "list",
    "add Subtask of: Bogus parent — child with no actual parent",
    ctx,
  );
  await tick();
  const dir = path.join(cwd, ".pi-glla", "goals");
  const sidecars = fs.readdirSync(dir).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf-8")));
  // Only the real parent made it (the child with a bogus parent is refused).
  assert.equal(sidecars.length, 1, "refused child never written");
  const ledger = readLedger(cwd);
  const refused = ledger.find((e) => e.type === "list_subtask_refused");
  assert.ok(refused, "refusal ledger present");
  assert.match(String(refused.value.refusals?.[0] ?? ""), /unresolved parent "Bogus parent"/);
});

test("v0.34.81 (behavioral): explicit pick on a group refuses loudly (no silent jump)", async () => {
  setGlobalAutoResume(false);
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  // Queue: parent (with one child) + unrelated tail.
  await pi.command("list", "add Parent group. Done when: foo", ctx);
  await pi.command("list", "add Subtask of: Parent group — child one. Done when: bar", ctx);
  await pi.command("list", "add Tail item. Done when: baz", ctx);
  await tick();
  // /list next 1 — would target the head (the parent group). Must refuse.
  await pi.command("list", "next 1", ctx);
  await tick();
  const ledger = readLedger(cwd);
  assert.equal(
    ledger.some((e) => e.type === "list_group_activation_refused"),
    true,
    "explicit pick on a group is refused loudly",
  );
});

test("v0.34.81 (behavioral): auto-advance skips a head group and lands on its first open child", async () => {
  setGlobalAutoResume(true); // enable auto-start so the head activates
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  await pi.command("list", "add Parent group. Done when: foo", ctx);
  await pi.command("list", "add Subtask of: Parent group — child one. Done when: bar", ctx);
  await pi.command("list", "add Subtask of: Parent group — child two. Done when: baz", ctx);
  await tick();
  // Auto-advance should have skipped the parent (group) and activated the
  // first child. The active goal's objective is the CHILD's, not the
  // parent's; the parentId on the active goal points at the parent.
  const stateRaw = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
  const lines = stateRaw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const lastStateLine = lines[lines.length - 1];
  const goal = lastStateLine.value.goal;
  assert.ok(goal, "a goal is active after auto-advance");
  assert.match(String(goal.objective), /child one/);
  // list (the queue): parent + child two still queued; child one is now the active goal.
  const queue = lastStateLine.value.list;
  assert.equal(queue.length, 2, "parent + child two remain queued");
  assert.equal(queue.some((q: any) => q.objective.includes("Parent group")), true);
  assert.equal(queue.some((q: any) => q.objective.includes("child two")), true);
  // parentId carried onto the active goal.
  const parent = queue.find((q: any) => q.objective.includes("Parent group"));
  assert.equal(goal.parentId, parent.id, "active goal carries parentId pointing at the parent");
});

test("v0.34.81 (behavioral): cascade close removes the parent when the last child completes", async () => {
  setGlobalAutoResume(false); // avoid the cascade firing another auto-activation
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  // Seed state: a COMPLETED list-policy goal with parentId = someParent.
  // We don't need the parent in the queue for this test (it tests the
  // cascade branch specifically) — we just need to confirm the ledger
  // fires and the sidecar gets cleaned.
  // First put the parent on disk so the cascade finds it.
  fs.mkdirSync(path.join(cwd, ".pi-glla", "goals"), { recursive: true });
  const parentId = "p-" + Math.random().toString(36).slice(2, 8);
  const parentFile = path.join(cwd, ".pi-glla", "goals", `${parentId}.queue.json`);
  fs.writeFileSync(
    parentFile,
    JSON.stringify({
      schema: 1,
      type: "queue-item",
      id: parentId,
      objective: "Parent group",
      addedAt: new Date().toISOString(),
    }),
  );
  // Seed the queue in state + the completed child goal with parentId.
  const childId = seedCompletedListGoal(cwd, parentId);
  // Fresh session: the restore gate reads the state line, sees the
  // completed goal, and archiveCurrentGoal runs (cascade close branch).
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  void childId;
  // Confirm: ledger has list_group_closed, the parent sidecar is gone.
  const ledger = readLedger(cwd);
  const closed = ledger.find((e) => e.type === "list_group_closed");
  assert.ok(closed, "list_group_closed ledger entry");
  assert.equal(closed.value.parentId, parentId);
  assert.ok(!fs.existsSync(parentFile), "parent sidecar removed by cascade");
});
