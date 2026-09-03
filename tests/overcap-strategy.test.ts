// v0.38.9 (over-cap strategy): the three rungs fire in order — trim is
// always-on, rotation walks the chain after a failed compact, the ladder
// names the viable rung (never a stale /compact retry).
import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { buildStarvationLadderMessage } from "../extensions/loops/goal-ui.js";
import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { clearContinuationTimer, resetContinuationDispatchState } from "../extensions/goal-continuation.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd } from "./harness/mock-pi.js";

const G = globalThis as any;
const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH;
function setGlobalSettings(value: Record<string, unknown>): void {
  if (GLOBAL_SETTINGS_PATH) fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(value));
}
afterEach(() => {
  setGlobalSettings({ aggressiveMode: false });
  if (typeof G.onCompactionLanded === "function") G.onCompactionLanded();
});

test("ladder skips the stale retry after a recent compact", () => {
  const fresh = buildStarvationLadderMessage({ percent: 95, recentCompact: false }).split("\n");
  assert.match(fresh[2] ?? "", /^\(1\) run \/compact again/);
  const stale = buildStarvationLadderMessage({ percent: 124.5, streak: 3, recentCompact: true }).split("\n");
  assert.equal(stale.length, 6, "same shape, honest first rung");
  assert.match(stale[2] ?? "", /^\(1\) skip the \/compact retry/);
  assert.match(stale[2] ?? "", /straight to \(2\)\/\(3\)/);
  assert.match(stale[3] ?? "", /^\(2\) switch to a larger-context model/);
  assert.match(stale[4] ?? "", /^\(3\) \/new, then \/goal resume/);
});

async function starvedSession(opts: { fallbacks: string[]; recentCompact: boolean }) {
  const cwd = tmpCwd();
  setGlobalSettings({ mainModelFallbacks: opts.fallbacks, aggressiveMode: false, autoResume: true });
  // lastCompactionAt is durable state — the rotation/ladder branch reads it
  // from the restored state, not from any test global.
  seedState(cwd, { goal: seedGoal({ objective: "over-cap chain item — done when the rung order is proven" }), list: [], lastCompactionAt: opts.recentCompact ? Date.now() : null });
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `chain-${Date.now()}-${Math.random()}` } });
  (ctx as any).modelRegistry = { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true };
  (ctx as any).getContextUsage = () => ({ tokens: 190_000, contextWindow: 200_000, percent: 95 });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(60);
  resetContinuationDispatchState(cwd);
  clearContinuationTimer();
  G.__testOnlySetLastCompactionAt(opts.recentCompact ? Date.now() : null);
  await pi.fire("agent_end", {
    messages: [{ role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "length", usage: { output: 1 } }],
  }, ctx);
  await tick(120);
  return { cwd, pi, ctx };
}

test("failed compact + configured chain rotates, no ladder", async () => {
  const { pi, ctx } = await starvedSession({ fallbacks: ["provider/backup"], recentCompact: true });
  try {
    assert.ok(ctx.ui.matching("rotated to a larger-context backup model").length >= 1, "rotation named");
    assert.ok(pi.modelSelections.length > 0, "setModel crossed the host boundary");
    assert.equal(ctx.ui.matching("recovered from disk").length, 0, "no recovery banner on an active goal");
    assert.equal(ctx.ui.matching("skip the /compact retry").length, 0, "success needs no ladder");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("failed compact + empty chain names rung 3, never claims a walk", async () => {
  const { pi, ctx } = await starvedSession({ fallbacks: [], recentCompact: true });
  try {
    assert.equal(pi.modelSelections.length, 0, "no chain means no rotation attempt");
    assert.equal(ctx.ui.matching("walking the fallback chain").length, 0, "the walk is never claimed");
    const ladder = ctx.ui.matching("skip the /compact retry");
    assert.equal(ladder.length, 1, "exactly one ladder names the viable rungs");
    assert.match(ladder[0]?.message ?? "", /\/new, then \/goal resume/);
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});
