// pi-goal-list-loop-audit — v0.34.57
// tests/model-switch.test.ts
//
// The verification contract for the model-switch ledger (bug #1.14 —
// unauthorized model switches must be observable and blockable):
//
//   (a) extensions/goal-loop-core.ts exports a modelSwitch(from, to, reason,
//       at) helper AND a turn-boundary hook (the pi model_select event +
//       the before_agent_start drift check in goal.ts) writes the entry
//   (b) the forbiddenModels setting blocks forbidden models and emits the
//       forbidden_model_switch violation event
//   (c) /glla switchlog renders the last N entries
//
// Pure helper pins + wiring pins on a MockPi that DRIVES the registered
// handlers, mirroring the behavioral-orchestrator harness pattern (own
// MockPi, own tmp cwd per test, session_start re-reads state from disk).

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { MockPi, makeMockCtx, tmpCwd, type MockCtx } from "./harness/mock-pi.js";
import activate, { __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { modelSwitch, isForbiddenModel, DEFAULT_FORBIDDEN_MODELS } from "../extensions/goal-loop-core.js";

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager" };
const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}

async function freshSession(cwd: string): Promise<MockCtx> {
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  return ctx;
}

/** All ledger entries for a cwd, in order. */
function readLedger(cwd: string): Array<{ type: string; value: any; at: string }> {
  const file = path.join(cwd, ".pi-glla", "active.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

afterEach(() => {
  __testOnlyResetStaleFlag();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({}));
});

// ── (a) helper + turn-boundary hook ────────────────────────────────────

test("v0.34.57: modelSwitch() builds the canonical ledger payload", () => {
  const at = Date.parse("2026-08-06T10:15:51.717Z");
  const rec = modelSwitch("anthropic/claude-sonnet-4-5", "openai/gpt-4.1", "manual", at);
  assert.deepEqual(rec, {
    from: "anthropic/claude-sonnet-4-5",
    to: "openai/gpt-4.1",
    reason: "manual",
    at: "2026-08-06T10:15:51.717Z",
  });
  // Unknown sides are omitted (a fresh session has no previous model).
  assert.deepEqual(modelSwitch(undefined, "openai/gpt-4.1", "turn-boundary", at), {
    to: "openai/gpt-4.1",
    reason: "turn-boundary",
    at: "2026-08-06T10:15:51.717Z",
  });
});

test("v0.34.57: isForbiddenModel matches gpt-5.5/sonnet/opus refs, case-insensitively, and ignores empty lists", () => {
  assert.equal(DEFAULT_FORBIDDEN_MODELS.join(","), "gpt-5.5,sonnet,opus", "default policy forbids gpt-5.5/sonnet/opus");
  assert.equal(isForbiddenModel("openai/gpt-5.5"), true);
  assert.equal(isForbiddenModel("openrouter/openai/gpt-5.5"), true, "substring match against the full provider/id ref");
  assert.equal(isForbiddenModel("anthropic/claude-sonnet-4-5"), true);
  assert.equal(isForbiddenModel("anthropic/claude-opus-4-1"), true);
  assert.equal(isForbiddenModel("ANTHROPIC/CLAUDE-OPUS-4-1"), true, "case-insensitive");
  assert.equal(isForbiddenModel("openai/gpt-4.1"), false);
  assert.equal(isForbiddenModel("minimax/MiniMax-M3"), false);
  assert.equal(isForbiddenModel(undefined), false);
  assert.equal(isForbiddenModel("openai/gpt-5.5", []), false, "an empty forbidden list forbids nothing");
  assert.equal(isForbiddenModel("openai/gpt-5.5", ["sonnet"]), false, "custom list replaces the default");
});

test("v0.34.57: the model_select hook ledgeres every provider/model change", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  await pi.fire(
    "model_select",
    { model: { provider: "openai", id: "gpt-4.1" }, previousModel: { provider: "anthropic", id: "claude-sonnet-4-5" }, source: "set" },
    ctx,
  );
  const switches = readLedger(cwd).filter((e) => e.type === "model_switch");
  assert.equal(switches.length, 1, "exactly one model_switch entry");
  assert.equal(switches[0]!.value.from, "anthropic/claude-sonnet-4-5");
  assert.equal(switches[0]!.value.to, "openai/gpt-4.1");
  assert.equal(switches[0]!.value.reason, "manual");
  assert.equal(switches[0]!.value.source, "set");
  assert.ok(typeof switches[0]!.value.at === "string" && !Number.isNaN(Date.parse(switches[0]!.value.at)), "ISO timestamp");
});

test("v0.34.57: the turn-boundary check ledgeres drift that arrives without a model_select event", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  // First observed turn just baselines — no ledger entry.
  await pi.fire("before_agent_start", { prompt: "first turn" }, ctx);
  assert.equal(readLedger(cwd).filter((e) => e.type === "model_switch").length, 0, "baseline turn records nothing");
  // The next turn runs on a different model (e.g. a fresh launch with a
  // changed default) — drift is ledgered as a turn-boundary switch.
  const drifted: MockCtx = { ...ctx, model: { provider: "openai", id: "gpt-4.1" } };
  await pi.fire("before_agent_start", { prompt: "second turn" }, drifted);
  const switches = readLedger(cwd).filter((e) => e.type === "model_switch");
  assert.equal(switches.length, 1, "drift is ledgered once");
  assert.equal(switches[0]!.value.from, "anthropic/mock-model");
  assert.equal(switches[0]!.value.to, "openai/gpt-4.1");
  assert.equal(switches[0]!.value.reason, "turn-boundary");
  // Same model again — no new entry.
  await pi.fire("before_agent_start", { prompt: "third turn" }, drifted);
  assert.equal(readLedger(cwd).filter((e) => e.type === "model_switch").length, 1, "no change, no entry");
});

// ── (b) forbiddenModels gate ───────────────────────────────────────────

test("v0.34.57: the forbidden gate blocks a forbidden selection, emits forbidden_model_switch, and reverts", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  pi.modelSelections.length = 0;
  const previous = { provider: "anthropic", id: "claude-sonnet-4-5" };
  await pi.fire("model_select", { model: { provider: "openai", id: "gpt-5.5" }, previousModel: previous, source: "set" }, ctx);
  const ledger = readLedger(cwd);
  const violations = ledger.filter((e) => e.type === "forbidden_model_switch");
  assert.equal(violations.length, 1, "the violation event is emitted");
  assert.equal(violations[0]!.value.from, "anthropic/claude-sonnet-4-5");
  assert.equal(violations[0]!.value.to, "openai/gpt-5.5");
  assert.equal(violations[0]!.value.reason, "manual");
  assert.equal(violations[0]!.value.source, "set");
  assert.equal(violations[0]!.value.blocked, true, "blocked by default");
  assert.equal(ledger.filter((e) => e.type === "model_switch").length, 0, "a blocked switch never becomes a model_switch entry");
  assert.equal(pi.modelSelections.length, 1, "the call was reverted to the previous model");
  assert.deepEqual(pi.modelSelections[0], previous);
  assert.ok(ctx.ui.matching("blocked by the glla policy gate").length >= 1, "the user is told about the revert");
});

test("v0.34.57: blockForbiddenModelSwitches off allows the switch but records the violation", async () => {
  __testOnlyResetStaleFlag();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ blockForbiddenModelSwitches: false }));
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  pi.modelSelections.length = 0;
  await pi.fire(
    "model_select",
    { model: { provider: "openai", id: "gpt-5.5" }, previousModel: { provider: "anthropic", id: "claude-sonnet-4-5" }, source: "set" },
    ctx,
  );
  const ledger = readLedger(cwd);
  const violations = ledger.filter((e) => e.type === "forbidden_model_switch");
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.value.blocked, false, "violation recorded, switch not blocked");
  assert.equal(pi.modelSelections.length, 0, "no revert attempted");
});

test("v0.34.57: turn-boundary drift into a forbidden model records the violation without blocking", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  pi.modelSelections.length = 0;
  await pi.fire("before_agent_start", { prompt: "baseline" }, ctx);
  const drifted: MockCtx = { ...ctx, model: { provider: "openai", id: "gpt-5.5" } };
  await pi.fire("before_agent_start", { prompt: "drifted turn" }, drifted);
  const ledger = readLedger(cwd);
  const violations = ledger.filter((e) => e.type === "forbidden_model_switch");
  assert.equal(violations.length, 1, "the violation is recorded");
  assert.equal(violations[0]!.value.to, "openai/gpt-5.5");
  assert.equal(violations[0]!.value.reason, "turn-boundary");
  assert.equal(violations[0]!.value.blocked, false, "a turn that already started is never reverted mid-turn");
  assert.equal(pi.modelSelections.length, 0, "no revert attempted");
  assert.equal(ledger.filter((e) => e.type === "model_switch").length, 0, "a forbidden drift never becomes a model_switch entry");
});

// ── (c) /glla switchlog ────────────────────────────────────────────────

test("v0.34.57: /glla switchlog renders the last N entries of the model-switch trail", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  // Two plain switches, then a blocked forbidden one.
  await pi.fire(
    "model_select",
    { model: { provider: "openai", id: "gpt-4.1" }, previousModel: { provider: "anthropic", id: "claude-sonnet-4-5" }, source: "set" },
    ctx,
  );
  await pi.fire(
    "model_select",
    { model: { provider: "openai", id: "gpt-5.5" }, previousModel: { provider: "openai", id: "gpt-4.1" }, source: "cycle" },
    ctx,
  );
  await pi.command("glla", "switchlog", ctx);
  const notify = ctx.ui.matching("Model-switch trail");
  assert.ok(notify.length >= 1, "switchlog rendered");
  const text = notify[0]!.message;
  assert.match(text, /switch  anthropic\/claude-sonnet-4-5 → openai\/gpt-4\.1 \[manual\]/);
  assert.match(text, /FORBIDDEN  openai\/gpt-4\.1 → openai\/gpt-5\.5 \(BLOCKED\) \[cycle\]/);
  // /glla switchlog 1 caps the window.
  await pi.command("glla", "switchlog 1", ctx);
  const capped = ctx.ui.matching("Model-switch trail");
  assert.equal(capped.length, 2);
  assert.match(capped[1]!.message, /last 1/);
  assert.doesNotMatch(capped[1]!.message, /claude-sonnet-4-5 → openai\/gpt-4\.1/);
});
