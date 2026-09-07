// pi-goal-list-loop-audit — v0.38.23
// tests/lifesign.test.ts
//
// Head lifesign + semantic color ramp: evidence-gated breathing (frame
// derives from evidence counters, never wall-clock), freshest-evidence
// age readout, green→amber→red bands on head + rows, color never the sole
// channel (glyph shape + silence number survive unpainted), and no readout
// invented without tracked rows.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  BREATH_FRAMES,
  headLifesign,
  lifesignBandFor,
  type LifesignRow,
} from "../extensions/goal-loop-core.js";
import { buildWidgetLines, type DisplayTheme } from "../extensions/goal-loop-display.js";
import { renderAgentsWidgetLines } from "../extensions/goal-agents-panel.js";
import type { Goal } from "../extensions/goal-loop-core.js";

const NOW = Date.parse("2026-07-21T12:00:00Z");

// Marker theme: records the color ride without real ANSI.
const MARKER = { fg: (c: string, t: string) => `[${c}]${t}[/]` } as unknown as DisplayTheme;

function row(over: Partial<LifesignRow> = {}): LifesignRow {
  return { status: "running", silentMs: 8_000, toolUses: 10, outputTokens: 100, ...over };
}

function goalOf(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "20260721120000-abcdef",
    objective: "Ship v0.38.23",
    status: "active",
    policy: "goal",
    autoContinue: true,
    usage: { tokensUsed: 12_400, tokensLimit: 1_000_000 },
    createdAt: "2026-07-21T11:57:00Z",
    updatedAt: "2026-07-21T11:57:00Z",
    ...overrides,
  } as Goal;
}

test("bands: fresh <5m, aging to 30m, stale past it, hung on classification", () => {
  assert.equal(lifesignBandFor(row({ silentMs: 8_000 })), "fresh");
  assert.equal(lifesignBandFor(row({ silentMs: 12 * 60_000 })), "aging");
  assert.equal(lifesignBandFor(row({ silentMs: 31 * 60_000 })), "stale");
  assert.equal(lifesignBandFor(row({ status: "hung", silentMs: 31 * 60_000 })), "hung");
  assert.equal(lifesignBandFor(row({ action: "failed", silentMs: 1_000 })), "hung");
  assert.equal(lifesignBandFor(row({ action: "abort-requested", silentMs: 1_000 })), "aging");
  assert.equal(lifesignBandFor(row({ status: "queued", silentMs: 40 * 60_000 })), "aging", "waiting caps at amber — red is for stuck");
  assert.equal(lifesignBandFor(row({ status: "queued", silentMs: 1_000 })), "fresh");
});

test("head: empty/ended rows invent nothing", () => {
  assert.equal(headLifesign(undefined), undefined);
  assert.equal(headLifesign([]), undefined);
  assert.equal(headLifesign([row({ status: "ended" })]), undefined);
});

test("head: band follows the freshest row, breath rides evidence counters", () => {
  const a = headLifesign([row({ silentMs: 8_000, toolUses: 10, outputTokens: 100 })])!;
  assert.equal(a.band, "fresh");
  assert.equal(a.freshestMs, 8_000);
  assert.equal(a.breath, BREATH_FRAMES[(10 + 100) % 4]);
  // Same counters, later wall-clock: identical frame — no time animation.
  const b = headLifesign([row({ silentMs: 9_000, toolUses: 10, outputTokens: 100 })])!;
  assert.equal(b.breath, a.breath, "frame derives from counters, never from now");
  // One more evidence chunk advances the frame.
  const c = headLifesign([row({ silentMs: 8_000, toolUses: 10, outputTokens: 101 })])!;
  assert.equal(c.breath, BREATH_FRAMES[(10 + 101) % 4]);
  // Aging freezes the ring; stale hollows it; hung triangles it.
  assert.equal(headLifesign([row({ silentMs: 12 * 60_000 })])!.breath, "◉");
  assert.equal(headLifesign([row({ silentMs: 31 * 60_000 })])!.breath, "○");
  const hung = headLifesign([row({ silentMs: 8_000 }), row({ status: "hung", silentMs: 31 * 60_000 })])!;
  assert.equal(hung.band, "hung");
  assert.equal(hung.breath, "⚠");
  assert.equal(hung.freshestMs, 8_000, "readout stays on the freshest evidence even with a hung sibling");
});

test("card head: active goal with workers breathes + reads out evidence age", () => {
  const lines = buildWidgetLines(
    { goal: goalOf(), list: [] } as never,
    null, NOW, undefined, 120,
    { agentRows: [row({ silentMs: 8_000, toolUses: 10, outputTokens: 100 })] },
  )!;
  assert.match(lines[0]!, /stream 5s/, "readout is the last head segment (8s buckets to 5s)");
  assert.match(lines[0]!, new RegExp(`^${BREATH_FRAMES[(10 + 100) % 4]} Ship v0\\.38\\.23`), "breathing glyph leads, objective follows");
});

test("card head: hung row triangles the head; paused keeps its own glyph; no rows means no readout", () => {
  const hung = buildWidgetLines(
    { goal: goalOf(), list: [] } as never,
    null, NOW, undefined, 120,
    { agentRows: [row({ status: "hung", silentMs: 31 * 60_000 })] },
  )!;
  assert.match(hung[0]!, /^⚠ Ship/, "hung head, objective intact");
  assert.match(hung[0]!, /stream 31m/, "age readout follows the worst band");

  const paused = buildWidgetLines(
    { goal: goalOf({ status: "paused", pauseReason: "quota" }), list: [] } as never,
    null, NOW, undefined, 120,
    { agentRows: [row({ silentMs: 8_000 })] },
  )!;
  assert.match(paused[0]!, /⏸/, "paused keeps its glyph language");
  assert.ok(!paused[0]!.includes("stream"), "lifesign never fights a non-active status");

  const bare = buildWidgetLines({ goal: goalOf(), list: [] } as never, null, NOW, undefined, 120)!;
  assert.match(bare[0]!, /^● Ship/, "no rows: plain status glyph");
  assert.ok(!bare[0]!.includes("stream"), "no readout invented without evidence");
});

test("rows: band colors ride the glyph; unpainted rows keep shape + number", () => {
  const rows = [
    { ...row(), agentType: "scout", summary: "ui fixes", recordId: "a", phase: "active", spawnedAt: 0, lastProgressAt: 0, toolUses: 1, outputTokens: 1, evidence: "live", silentMs: 8_000 },
    { ...row(), agentType: "worker", summary: "art batch", recordId: "b", phase: "hung", spawnedAt: 0, lastProgressAt: 0, toolUses: 1, outputTokens: 1, evidence: "live", status: "hung", silentMs: 31 * 60_000 },
  ] as never;
  const painted = renderAgentsWidgetLines(rows, NOW, 8, MARKER);
  assert.match(painted[1]!, /\[success\]▶\[\/\]/, "fresh glyph rides success");
  assert.match(painted[0]!, /\[error\]⚠\[\/\]/, "hung glyph rides error");
  const plain = renderAgentsWidgetLines(rows, NOW, 8, undefined);
  assert.ok(plain.every((l) => !l.includes("[")), "no theme: no paint markers");
  assert.ok(plain.some((l) => l.startsWith("⚠") && l.includes("31m")), "shape + number survive unpainted");
});

test("lifesign card fits 80 columns and is key-stable within a bucket", () => {
  const state = { goal: goalOf(), list: [] } as never;
  const extras = { agentRows: [row({ silentMs: 8_000, toolUses: 10, outputTokens: 100 })] };
  const a = buildWidgetLines(state, null, NOW, undefined, 80, extras)!;
  for (const line of a) {
    assert.ok(visibleWidth(line) <= 80, `fits 80 cols (${visibleWidth(line)}): ${line.slice(0, 60)}…`);
  }
  const b = buildWidgetLines(state, null, NOW + 3_000, undefined, 80, extras)!;
  // The pre-existing `total …` elapsed segment ticks with wall-clock (not
  // lifesign's doing); the lifesign projection itself must not move.
  const norm = (ls: string[]) => ls.map((l) => l.replace(/total \S+ \S+/, "total T"));
  assert.deepEqual(norm(b), norm(a), "same bucket, same counters: lifesign projection byte-identical");
});
