// pi-goal-list-loop-audit — v0.2.0
// tests/list-queue.test.ts
//
// Unit tests for loop 2 (/list): queue persistence + state restore.
// The activation flow (activateNextListItem) needs an ExtensionContext, so
// it's covered by the live tmux smoke instead; here we pin the pure parts:
// readState restoring `list` from the ledger, and round-trip of queue events.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  appendLedger,
  newGoalId,
  nowIso,
  readState,
  takeAt,
} from "../extensions/goal-loop-core.ts";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-gla-list-test-"));
}

test("readState restores an empty list when no state exists", () => {
  const cwd = tmpCwd();
  try {
    const s = readState(cwd);
    assert.equal(s.goal, null);
    assert.deepEqual(s.list, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("readState restores list from the latest state event", () => {
  const cwd = tmpCwd();
  try {
    const item = { id: newGoalId(), objective: "do thing one", addedAt: nowIso() };
    const item2 = { id: newGoalId(), objective: "do thing two", addedAt: nowIso() };
    appendLedger(cwd, "state", { goal: null, list: [item, item2] });
    const s = readState(cwd);
    assert.equal(s.goal, null);
    assert.equal(s.list!.length, 2);
    assert.equal(s.list![0]!.objective, "do thing one");
    assert.equal(s.list![1]!.objective, "do thing two");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("latest state event wins for the list", () => {
  const cwd = tmpCwd();
  try {
    const item = { id: newGoalId(), objective: "first", addedAt: nowIso() };
    appendLedger(cwd, "state", { goal: null, list: [item] });
    appendLedger(cwd, "state", { goal: null, list: [] }); // cleared
    const s = readState(cwd);
    assert.deepEqual(s.list, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("list events (list_added etc.) do not corrupt state restore", () => {
  const cwd = tmpCwd();
  try {
    const item = { id: newGoalId(), objective: "queued", addedAt: nowIso() };
    appendLedger(cwd, "state", { goal: null, list: [item] });
    appendLedger(cwd, "list_added", { id: item.id, objective: item.objective });
    appendLedger(cwd, "goal_created", { goalId: "x", objective: "y", policy: "list" });
    const s = readState(cwd);
    assert.equal(s.list!.length, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("state event without a list field restores as empty list (v0.1.0 compat)", () => {
  const cwd = tmpCwd();
  try {
    // v0.1.0 wrote { goal } only — must not break on upgrade.
    appendLedger(cwd, "state", { goal: null });
    const s = readState(cwd);
    assert.equal(s.goal, null);
    assert.deepEqual(s.list, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("takeAt: head is the FIFO default", () => {
  const r = takeAt(["a", "b", "c"], 1)!;
  assert.equal(r[0], "a");
  assert.deepEqual(r[1], ["b", "c"]);
});

test("takeAt: middle item", () => {
  const r = takeAt(["a", "b", "c"], 2)!;
  assert.equal(r[0], "b");
  assert.deepEqual(r[1], ["a", "c"]);
});

test("takeAt: last item", () => {
  const r = takeAt(["a", "b", "c"], 3)!;
  assert.equal(r[0], "c");
  assert.deepEqual(r[1], ["a", "b"]);
});

test("takeAt: out of range returns null", () => {
  assert.equal(takeAt(["a"], 0), null);
  assert.equal(takeAt(["a"], 2), null);
  assert.equal(takeAt([], 1), null);
  assert.equal(takeAt(["a"], 1.5), null);
});

test("v0.28.28: unsolicited enqueue (reviewer) does not auto-start the head unless autoResume is on", () => {
  const SRC = readGoalRuntimeSource();
  const CMDS = fs.readFileSync("extensions/goal-commands.ts", "utf-8");
  // junk-runner hydra: user cancelled a goal and the next reviewer-enqueued
  // item started itself (twice). Enqueue is not consent to start.
  assert.match(CMDS, /function enqueueItems\(ctx: ExtensionContext, texts: string\[\], source: string, opts\?: \{ autoActivate\?: boolean \}\): number/);
  assert.match(CMDS, /opts\?\.autoActivate === false/);
  // v0.34.81 (LIGHT parent/child): the count reflects items ACTUALLY
  // written (post-refusals) — `itemsToWrite.length` — so a refused
  // subtask does not over-report in the held-mode notify.
  assert.match(CMDS, /Queued \$\{itemsToWrite\.length\} item\(s\) from \$\{source\} — \/list next when ready \(auto-start is opt-in: enable Auto-resume in \/glla settings\)\./);
  assert.match(CMDS, /appendLedger\(ctx\.cwd, "list_autoactivation_held", \{ source, count: itemsToWrite\.length \}\);/);
  // the reviewer call site passes the gate; user-driven imports keep default:
  assert.match(SRC, /enqueueItems\(ctx, objectives, "reviewer", \{ autoActivate: loadGlobalSettings\(\)\.autoResume === true \}\)/); // v0.29.5: global-only
});

test("v0.29.4: auto-accepted drafts START (supersedes the 0.28.28 autoResume hold)", () => {
  const SRC = readGoalRuntimeSource();
  // User decision 2026-07-30: the held draft was "not desired behavior" —
  // autoAcceptDrafts is the pre-consent for in-session drafts; autoResume
  // now gates ONLY launch-time restore. The zombie-twin guard (0.29.1)
  // refuses duplicates upstream, so starting is safe.
  assert.match(SRC, /auto-accepted drafts START \(autoAcceptDrafts is the/);
  assert.match(SRC, /an auto-accepted draft STARTS — autoAcceptDrafts is the/);
  assert.ok(!SRC.includes("autoaccept-autoresume-off"), "the autoResume draft-hold is gone");
  assert.ok(!SRC.includes('appendLedger(liveCtx.cwd, "draft_held"'), "no draft_held ledger event remains");
});

test("v0.28.28: goal provenance — setGoal threads `via` into the record + goal_created ledger", () => {
  const SRC = readGoalRuntimeSource();
  assert.match(SRC, /function setGoal\(goal: Goal, ctx: ExtensionContext, via = "user"\): void/);
  assert.match(SRC, /goal\.createdVia = via;/);
  assert.match(SRC, /"goal_created", \{ goalId: goal\.id, objective: goal\.objective, policy: goal\.policy, via \}/);
  assert.match(SRC, /setGoal\(goal, ctx, "list-cascade"\);/);
  assert.match(SRC, /setGoal\(goal, liveCtx, autoAccept \? "draft-autoaccepted" : "draft-confirmed"\);/);
  const CORE = fs.readFileSync("extensions/goal-loop-core.ts", "utf-8");
  assert.match(CORE, /createdVia\?: string;/);
  const SCHEMA = fs.readFileSync("schemas/goal.schema.json", "utf-8");
  assert.match(SCHEMA, /"createdVia": \{ "type": "string" \}/);
});

test("v0.28.28: /glla log [N] — human-readable ledger tail, noise-filtered", () => {
  const SRC = fs.readFileSync("extensions/goal-commands.ts", "utf-8");
  assert.match(SRC, /if \(\/\^log\(\?:\\s\|\$\)\/\.test\(trimmed\)\) \{/);
  assert.match(SRC, /function cmdLog\(args: string, ctx: ExtensionContext\): void/);
  assert.match(SRC, /const LOG_NOISE = new Set\(\["state", "send_rearm_start", "heartbeat_suppressed_tick"\]\);/);
  assert.match(SRC, /entries\.filter\(\(e\) => !LOG_NOISE\.has\(e\.type\)\)/);
  assert.match(SRC, /parseInt\(nMatch\?\.\[1\] \?\? "15", 10\)/);
});

test("v0.28.33: /glla wipe — renamed from reset (too close to /glla resume); reset redirects without acting", () => {
  const SRC = fs.readFileSync("extensions/goal-commands.ts", "utf-8");
  assert.match(SRC, /if \(\/\^wipe\(\?:\\s\|\$\)\/\.test\(trimmed\)\) \{/);
  assert.match(SRC, /async function cmdGllaWipe\(ctx: ExtensionContext\): Promise<void>/);
  // destructive → Confirm dialog with the full summary:
  assert.match(SRC, /await ctx\.ui\.confirm\("Wipe glla state\?"/);
  assert.match(SRC, /History stays in \.pi-glla \(archive \+ ledger\); the live state is wiped\./);
  // honest close-out: goal archived (not dropped), list + loop ledgered:
  assert.match(SRC, /appendLedger\(ctx\.cwd, "glla_wipe", \{ goalId: live/);
  assert.match(SRC, /archiveCurrentGoal\(ctx, "aborted", "user wipe \(\/glla wipe\)"\);/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "list_cleared", \{ via: "glla_wipe"(, count: n)? \}\);/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "loop_stopped", \{ reason: "user wipe \(\/glla wipe\)"/);
  assert.match(SRC, /state\.loop = undefined;/);
  // already-clean short-circuit:
  assert.match(SRC, /glla state is already clean — no goal, no list, no loop\./);
  // the typo trap: /glla reset redirects WITHOUT executing:
  assert.match(SRC, /\/glla reset is now \/glla wipe \(renamed — too close to \/glla resume\)\. Nothing was done\./);
});
test("v0.34.119: /glla cancel cancels the whole list objective, while standalone goals/loops keep their own paths", () => {
  const SRC = fs.readFileSync("extensions/goal-commands.ts", "utf-8");
  assert.match(SRC, /if \(\/\^resume\(\?:\\s\|\$\)\/\.test\(trimmed\)\) \{/);
  assert.match(SRC, /if \(\/\^cancel\(\?:\\s\|\$\)\/\.test\(trimmed\)\) \{/);
  assert.match(SRC, /async function cmdGllaResume\(ctx: ExtensionContext\): Promise<void>/);
  assert.match(SRC, /async function cmdGllaCancel\(ctx: ExtensionContext\): Promise<void>/);
  // paused-goal + held-loop ambiguity → decision picker (v0.28.23 pattern):
  assert.match(SRC, /ctx\.ui\.select\("Two things can resume — which one\?"/);
  // v0.34.119: a list objective routes through the whole-list cancellation
  // path, so the waiting queue cannot survive as a hidden continuation.
  const cancelIdx = SRC.indexOf("async function cmdGllaCancel");
  const cancel = SRC.slice(cancelIdx);
  assert.match(cancel, /const hasListObjective = listQueue\(\)\.length > 0 \|\| g\?\.policy === "list";/);
  assert.match(cancel, /if \(hasListObjective\) \{\s*\n\s*await cmdList\("cancel", ctx\);/);
  assert.match(cancel, /if \(g && \(g\.status === "active" \|\| g\.status === "paused" \|\| g\.status === "auditing"\)\)/);
  assert.match(cancel, /await cmdCancel\(ctx\);/);
  assert.match(cancel, /await cmdLoop\("stop", ctx\);/);
  // empty states guide to the typed verbs / power verbs:
  assert.match(SRC, /Nothing to resume — no paused goal\/list-item, no held loop\./);
  assert.match(SRC, /Nothing to cancel — no active\/paused goal\/list-item, no loop\./);
});
