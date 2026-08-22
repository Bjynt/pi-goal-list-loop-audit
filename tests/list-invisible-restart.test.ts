// pi-goal-list-loop-audit — v0.35.21
// tests/list-invisible-restart.test.ts
//
// v0.35.21 list-invisible-until-restart regression (note.md Next #4).
//
// Field: a stopped/interrupted /list exec left the queue surface blank —
// active item only, no "N waiting · up next" line — until a full session
// restart. Root cause: the sidebar renders state.list from MEMORY, but the
// durable queue is the UNION of the persisted state ledger and the
// per-item .queue.json sidecars (v0.34.60 disk-first writes). Any window
// where RAM resets to defaults (plugin re-init, stale handle) desynced the
// two; only some later path re-ran the disk merge.
// Fix: session_start's restore converges memory to the union immediately
// (hydrateListQueueFromDisk), so the very next lifecycle boundary heals
// the surface without a restart.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate from "../extensions/loops/goal.js";
import { buildWidgetLines } from "../extensions/goal-loop-display.ts";
import { readState, writeQueueItemFile } from "../extensions/goal-loop-core.js";
import { state } from "../extensions/goal-state.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, tick } from "./harness/mock-pi.js";

const MAIN_SM = { name: "main-session-manager" };

function ownerCtx(cwd: string) {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}

test("v0.35.21: session_start converges a disk-sidecar queue the state ledger lost, and the widget renders it", async () => {
  const cwd = tmpCwd();
  const now = new Date().toISOString();
  const activeItem = {
    id: "20260821213000-active",
    objective: "active list item — done when pinned",
    status: "active",
    policy: "goal",
    autoContinue: true,
    createdAt: now,
    updatedAt: now,
  };
  // The desync: durable STATE says the waiting queue is empty…
  seedState(cwd, { goal: activeItem, list: [] });
  // …while the durable SIDECAR for a waiting item exists (disk-first write
  // survived; RAM/state replay lost it).
  const waitingItem = {
    id: "20260821213100-waiting",
    objective: "waiting list item that must stay visible",
    addedAt: now,
    queueOrder: 1,
  };
  const wrote = writeQueueItemFile(cwd, waitingItem as never);
  assert.equal(wrote.wrote, true);

  const pi = new MockPi();
  activate(pi.api);
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();

  // Memory converged to the union at the lifecycle boundary…
  assert.ok((state.list ?? []).some((i) => i.id === waitingItem.id), "the sidecar-only item was hydrated into memory");

  // …and the widget renders the queue truthfully instead of "queue empty"
  // (the restored-on-load card holds in its paused branch, which surfaces
  // the queue count + the waiting hint).
  const lines = buildWidgetLines(state)?.join("\n") ?? "";
  assert.match(lines, /1 queued/);
  assert.doesNotMatch(lines, /queue empty/);
  assert.match(lines, /\+1 waiting in the list/);

  // The convergence is announced honestly.
  const restoredNote = ctx.ui.matching("restored 1 queued list item");
  assert.equal(restoredNote.length, 1, "the hydration notifies with a truthful count");
});

test("v0.35.21: convergence is idempotent — an item present in BOTH state and sidecar is not duplicated", async () => {
  const cwd = tmpCwd();
  const now = new Date().toISOString();
  const goal = {
    id: "20260821214000-g",
    objective: "plain goal with a synced queue — done when pinned",
    status: "active",
    policy: "goal",
    autoContinue: true,
    createdAt: now,
    updatedAt: now,
  };
  const item = { id: "20260821214100-both", objective: "present in BOTH state and sidecar", addedAt: now, queueOrder: 1 };
  seedState(cwd, { goal, list: [item] });
  const wrote = writeQueueItemFile(cwd, item as never);
  assert.equal(wrote.wrote, true);

  const pi = new MockPi();
  activate(pi.api);
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();

  const list = readState(cwd).list ?? [];
  assert.equal(list.filter((i) => i.id === item.id).length, 1, "no twin after hydration");
});
