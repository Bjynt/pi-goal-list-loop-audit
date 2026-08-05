// pi-goal-list-loop-audit — v0.34.56
// tests/auditor-unmatched-telemetry.test.ts
//
// Contract item: "unmatched tool starts/ends are represented as explicitly
// unmatched facts, never falsely paired, and covered by a telemetry
// regression test."
//
// The auditor tool-execution telemetry must never (a) pair an end with a
// start it provably does not close, nor (b) silently drop events it cannot
// pair. This file is the regression test for the shared pairing matrix:
//
//   - applyToolExecutionEvent (goal-loop-auditor.ts) is the pure,
//     id-aware implementation used by the in-process harness.
//   - scripts/goal-auditor-worker.mjs mirrors the matrix with a
//     concurrency-capable Map (source-pinned here; it cannot be imported —
//     it is a spawnable worker script).
//   - The progress file, asProgress, the HUD mapping and the display all
//     carry the explicit unmatched facts (source-pinned).
//
// The failure shape this guards: a tool_execution_start whose end never
// arrives (stream cut, or the missing-toolCallId shape) previously left its
// name in the single currentTool slot, so the NEXT end — belonging to a
// DIFFERENT tool — was recorded as that orphaned tool's completion. An end
// that matched nothing was silently dropped. Both are telemetry lies.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyToolExecutionEvent,
  type AuditProgress,
  type AuditorToolExecutionEvent,
} from "../extensions/goal-loop-auditor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDITOR_SRC = fs.readFileSync(path.resolve(__dirname, "../extensions/goal-loop-auditor.ts"), "utf-8");
const PROCESS_SRC = fs.readFileSync(path.resolve(__dirname, "../extensions/goal-loop-auditor-process.ts"), "utf-8");
const DISPLAY_SRC = fs.readFileSync(path.resolve(__dirname, "../extensions/goal-loop-display.ts"), "utf-8");
const GOAL_SRC = fs.readFileSync(path.resolve(__dirname, "../extensions/loops/goal.ts"), "utf-8");
const WORKER_SRC = fs.readFileSync(path.resolve(__dirname, "../scripts/goal-auditor-worker.mjs"), "utf-8");

function fresh(): AuditProgress {
  return { recentOutput: [], phase: "running", elapsedMs: 0, toolCalls: [], unmatchedToolStarts: [], unmatchedToolEnds: [] };
}

function start(toolCallId: string | undefined, toolName: string, args?: unknown): AuditorToolExecutionEvent {
  return { type: "tool_execution_start", toolCallId, toolName, args };
}
function end(toolCallId: string | undefined, toolName?: string): AuditorToolExecutionEvent {
  return { type: "tool_execution_end", toolCallId, toolName };
}

// ── behavioral matrix on the pure function ─────────────────────────

test("v0.34.56: a serial id'd start+end pairs into toolCalls with zero unmatched facts", () => {
  const t = fresh();
  applyToolExecutionEvent(t, start("read-1", "read", { path: "/repo/README.md" }), 1000);
  assert.equal(t.currentTool, "read");
  assert.equal(t.currentToolId, "read-1");
  applyToolExecutionEvent(t, end("read-1", "read"), 2000);
  assert.deepEqual(t.toolCalls, [{ name: "read", argsPrefix: '{"path":"/repo/README.md"}', finishedAt: 2000 }]);
  assert.equal(t.currentTool, undefined, "slot cleared after the pair");
  assert.equal(t.currentToolId, undefined);
  assert.equal(t.unmatchedToolStarts.length, 0);
  assert.equal(t.unmatchedToolEnds.length, 0);
});

test("v0.34.56: an end with the WRONG id never pairs — it is an explicit unmatched fact and the open start stays open", () => {
  const t = fresh();
  applyToolExecutionEvent(t, start("read-1", "read"), 1000);
  applyToolExecutionEvent(t, end("grep-9", "grep"), 2000);
  // The killer case from the old single-slot bug: the orphaned "read" start
  // must NOT be recorded as a completed "read" call just because an end
  // arrived. The end belongs to a different tool whose start never arrived.
  assert.deepEqual(t.toolCalls, [], "no false pairing into toolCalls");
  assert.equal(t.currentTool, "read", "the open start has not ended — it stays open");
  assert.equal(t.currentToolId, "read-1");
  assert.deepEqual(t.unmatchedToolEnds, [{ toolCallId: "grep-9", toolName: "grep", at: 2000 }]);
  assert.equal(t.unmatchedToolStarts.length, 0);
});

test("v0.34.56: an end with an id can never close an ANONYMOUS start (missing-toolCallId shape)", () => {
  const t = fresh();
  applyToolExecutionEvent(t, start(undefined, "read"), 1000);
  applyToolExecutionEvent(t, end("read-1"), 2000);
  assert.deepEqual(t.toolCalls, []);
  assert.equal(t.currentTool, "read", "anonymous start stays open");
  assert.equal(t.unmatchedToolEnds.length, 1);
  assert.equal(t.unmatchedToolEnds[0]!.toolCallId, "read-1");
});

test("v0.34.56: an ANONYMOUS end can never close an id'd start (the id would be present on a true end)", () => {
  const t = fresh();
  applyToolExecutionEvent(t, start("read-1", "read"), 1000);
  applyToolExecutionEvent(t, end(undefined), 2000);
  assert.deepEqual(t.toolCalls, []);
  assert.equal(t.currentTool, "read");
  assert.equal(t.currentToolId, "read-1");
  assert.deepEqual(t.unmatchedToolEnds, [{ toolCallId: undefined, toolName: undefined, at: 2000 }]);
  assert.deepEqual(t.unmatchedToolStarts, [], "no orphaned start recorded");
});

test("v0.34.56: a serial ANONYMOUS stream (both sides missing toolCallId) still pairs truthfully", () => {
  const t = fresh();
  applyToolExecutionEvent(t, start(undefined, "read"), 1000);
  applyToolExecutionEvent(t, end(undefined), 2000);
  assert.deepEqual(t.toolCalls, [{ name: "read", argsPrefix: "", finishedAt: 2000 }]);
  assert.equal(t.currentTool, undefined);
  assert.equal(t.unmatchedToolStarts.length, 0);
  assert.equal(t.unmatchedToolEnds.length, 0);
});

test("v0.34.56: an anonymous end with TWO anonymous starts open is unmatched — pairing would be a guess", () => {
  const t = fresh();
  applyToolExecutionEvent(t, start(undefined, "read"), 1000);
  applyToolExecutionEvent(t, start(undefined, "grep"), 1100);
  applyToolExecutionEvent(t, end(undefined), 2000);
  assert.deepEqual(t.toolCalls, [], "cannot know which anonymous start the end closes");
  assert.equal(t.currentTool, "grep", "the last start remains open");
  assert.equal(t.unmatchedToolEnds.length, 1);
  assert.equal(t.unmatchedToolStarts.length, 1, "the replaced 'read' start is an explicit unmatched start");
  assert.equal(t.unmatchedToolStarts[0]!.name, "read");
});

test("v0.34.56: a new start replacing an open start records the ORPHANED start explicitly (name, args, id preserved)", () => {
  const t = fresh();
  applyToolExecutionEvent(t, start("read-1", "read", { path: "/a" }), 1000);
  applyToolExecutionEvent(t, start("grep-2", "grep", { pattern: "x" }), 1100);
  assert.deepEqual(t.toolCalls, []);
  assert.equal(t.currentTool, "grep", "the new start is adopted");
  assert.equal(t.currentToolId, "grep-2");
  assert.deepEqual(t.unmatchedToolStarts, [
    { name: "read", argsPrefix: '{"path":"/a"}', startedAt: 1000, toolCallId: "read-1" },
  ]);
  // The orphaned start must never resurface as a completed call: an end for
  // the NEW tool pairs with the NEW tool only.
  applyToolExecutionEvent(t, end("grep-2"), 2000);
  assert.deepEqual(t.toolCalls, [{ name: "grep", argsPrefix: '{"pattern":"x"}', finishedAt: 2000 }]);
  assert.equal(t.unmatchedToolStarts.length, 1, "the orphan stays a fact, not a phantom completion");
});

test("v0.34.56: same-id restart updates the slot without an unmatched fact; an end with no open start is an unmatched end", () => {
  const t = fresh();
  applyToolExecutionEvent(t, start("read-1", "read"), 1000);
  applyToolExecutionEvent(t, start("read-1", "read", { path: "/b" }), 1100);
  assert.equal(t.unmatchedToolStarts.length, 0, "same id = same logical call, slot refreshed");
  assert.equal(t.currentToolArgs, '{"path":"/b"}');
  const t2 = fresh();
  applyToolExecutionEvent(t2, end("stray-7", "bash"), 500);
  assert.deepEqual(t2.unmatchedToolEnds, [{ toolCallId: "stray-7", toolName: "bash", at: 500 }]);
  assert.deepEqual(t2.toolCalls, []);
});

// ── the in-process harness delegates to the pure function ──────────

test("v0.34.56: the session handler delegates pairing to applyToolExecutionEvent (no inline slot mutation)", () => {
  const subscribeSection = AUDITOR_SRC.slice(AUDITOR_SRC.indexOf("session.subscribe"), AUDITOR_SRC.indexOf("const unsub ="));
  assert.ok(subscribeSection.includes("applyToolExecutionEvent(progress,"), "handler calls the pure pairing function");
  assert.ok(subscribeSection.includes('type: "tool_execution_start"'), "start branch present");
  assert.ok(subscribeSection.includes('type: "tool_execution_end"'), "end branch present");
  assert.ok(!subscribeSection.includes("progress.currentTool = event.toolName"), "no inline single-slot assignment");
  assert.ok(!subscribeSection.includes("toolCalls.push({"), "no inline pairing outside the pure function");
});

// ── the detached worker mirrors the matrix ─────────────────────────

test("v0.34.56: worker — anonymous ends pair only with the SOLE anonymous start; everything else is an explicit unmatched fact", () => {
  assert.ok(WORKER_SRC.includes("anonymousStartKeys.size === 1"), "anonymous end pairs only when exactly one anonymous start is open");
  assert.ok(WORKER_SRC.includes("unmatchedToolEnds.push({ toolCallId: id, toolName: event.toolName, at: Date.now() })"), "unpair-able ends are recorded, never dropped");
  const endBranch = WORKER_SRC.slice(WORKER_SRC.indexOf("if (event.type === \"tool_execution_end\")"));
  assert.ok(!/toolCalls\.push\([^)]*\);\s*}\s*void progress/.test(endBranch), "no silent drop branch remains");
});

test("v0.34.56: worker — in-flight starts at session end become explicit unmatched starts (finish sweep)", () => {
  assert.ok(WORKER_SRC.includes("for (const active of activeTools.values())"), "finish sweeps every in-flight start");
  assert.ok(WORKER_SRC.includes("unmatchedToolStarts.push({ name: active.name"), "swept starts are recorded with name");
  assert.ok(WORKER_SRC.includes("toolCallId: active.toolCallId"), "swept starts preserve their (possibly missing) id");
  const progressSection = WORKER_SRC.slice(WORKER_SRC.indexOf("const progress = (phase"), WORKER_SRC.indexOf("const finish"));
  assert.ok(progressSection.includes("unmatchedToolStarts: unmatchedToolStarts.slice(-MAX_UNMATCHED_EVENTS)"), "progress file carries unmatched starts");
  assert.ok(progressSection.includes("unmatchedToolEnds: unmatchedToolEnds.slice(-MAX_UNMATCHED_EVENTS)"), "progress file carries unmatched ends");
});

// ── the plumbing carries the facts end to end ──────────────────────

test("v0.34.56: progress file + asProgress + HUD mapping + display all carry the unmatched facts", () => {
  // AuditorProgressFile has the fields (detached worker protocol).
  assert.ok(PROCESS_SRC.includes("unmatchedToolStarts?: AuditorProgress[\"unmatchedToolStarts\"]"), "file type carries unmatched starts");
  assert.ok(PROCESS_SRC.includes("unmatchedToolEnds?: AuditorProgress[\"unmatchedToolEnds\"]"), "file type carries unmatched ends");
  assert.ok(PROCESS_SRC.includes("unmatchedToolStarts: file.unmatchedToolStarts ?? []"), "asProgress defaults to empty, never undefined");
  // The HUD mapping exposes counts from the progress object.
  assert.ok(GOAL_SRC.includes("unmatchedToolStarts: progress.unmatchedToolStarts?.length ?? 0"), "HUD mapping exposes start count");
  assert.ok(GOAL_SRC.includes("unmatchedToolEnds: progress.unmatchedToolEnds?.length ?? 0"), "HUD mapping exposes end count");
  // The display renders the counts honestly.
  assert.ok(DISPLAY_SRC.includes("unmatched tool events: ${unmatchedStarts} start / ${unmatchedEnds} end — explicitly unpaired, never falsely matched"), "display surfaces unmatched counts");
  assert.ok(DISPLAY_SRC.includes("unmatchedToolStarts?: number"), "display type has the start count");
  assert.ok(DISPLAY_SRC.includes("unmatchedToolEnds?: number"), "display type has the end count");
});
