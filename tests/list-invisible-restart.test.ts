// v0.35.21 — list-invisible-until-restart regression (note.md Next #4).
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
import { test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const { MockPi, makeMockCtx, tmpCwd, seedState, tick } = await import("./harness/mock-pi.ts");
type MockCtx = Awaited<ReturnType<typeof makeMockCtx>>;
const { writeQueueItemFile } = await import("../extensions/goal-loop-core.ts");
const { buildWidgetLines } = await import("../extensions/goal-loop-display.ts");

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
    status: "active" as const,
    policy: "goal" as const,
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
  expect(wrote.wrote).toBe(true);

  const pi = new MockPi();
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();

  // Memory converged to the union at the lifecycle boundary…
  const restored = (await import("../extensions/goal-state.ts")).state;
  expect((restored.list ?? []).some((i: { id: string }) => i.id === waitingItem.id)).toBe(true);

  // …and the widget renders the waiting line instead of a blank queue.
  const lines = buildWidgetLines((await import("../extensions/goal-state.ts")).state).join("\n");
  expect(lines).toMatch(/1 waiting · up next: waiting list item that must stay visible/);
});

test("v0.35.21: convergence is idempotent — no duplicate restore when memory already matches disk", async () => {
  const cwd = tmpCwd();
  const now = new Date().toISOString();
  const goal = {
    id: "20260821214000-g",
    objective: "plain goal with a synced queue — done when pinned",
    status: "active" as const,
    policy: "goal" as const,
    autoContinue: true,
    createdAt: now,
    updatedAt: now,
  };
  const item = { id: "20260821214100-both", objective: "present in BOTH state and sidecar", addedAt: now, queueOrder: 1 };
  seedState(cwd, { goal, list: [item] });
  const wrote = writeQueueItemFile(cwd, item as never);
  expect(wrote.wrote).toBe(true); // idempotent writer skips existing? No — file absent, writes.

  const pi = new MockPi();
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();

  const { readState } = await import("../extensions/goal-loop-core.ts");
  const list = readState(cwd).list ?? [];
  expect(list.filter((i) => i.id === item.id)).toHaveLength(1); // no twin
});
