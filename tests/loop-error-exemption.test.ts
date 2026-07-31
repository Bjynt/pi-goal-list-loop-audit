// v0.29.19 — provider-error/user-abort turns must not feed loop stall/
// stuck/plateau accounting; audit plateau gate (open findings = the well
// isn't dry); resumable stop classes.
//
// Field case (2026-07-31, MiniMax token-plan 429 storm overnight): every
// fleet loop died on DEAD turns, not on the work — hegemon plateau-stopped
// at best 74 with 13 open findings, polis at best 46 with 3+, hellhunter
// stuck-stopped at iter 93. The v0.28.13/v0.29.4 exemptions only covered
// the goal nudge counter; the loop's own accounting counted 429 corpses.

import { test, assert } from "./harness/setup.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { readState } from "../extensions/goal-loop-core.js";
import activate, { __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { auditMeasureCmd, AUDIT_FINDINGS_REL } from "../extensions/goal-loop-forever.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedLoop, freshSession, tick, type MockCtx } from "./harness/mock-pi.js";

declare const pi: MockPi;

function errTurn() {
  return { messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "429: rate_limit_error" }] };
}
function abortTurn() {
  return { messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "aborted" }] };
}
function workTurn() {
  return { messages: [{ role: "assistant", content: [{ type: "text", text: "did some work on the loop target this turn" }], stopReason: "end_turn" }] };
}
function ledger(cwd: string): string {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
}
type LoopSnap = {
  active: boolean; iteration: number; stallCount: number; bestValue: number | null;
  stopReason?: string; consecutiveErrors?: number; consecutiveStuck?: number;
  auditPlateauReprieves?: number; auditReprieveNote?: string; kind?: string;
};
function loop(cwd: string): LoopSnap {
  return readState(cwd).loop as LoopSnap;
}

test("v0.29.19: provider-error turns are NOT iterations — no measure, no stall, no stuck; loop stays active", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({ measureCmd: "echo 74", direction: "max", bestValue: 74, lastValue: 74, stallCount: 2 }) });
  const ctx = await freshSession(cwd, "startup");
  for (let i = 0; i < 3; i++) {
    await pi.fire("agent_end", errTurn(), ctx);
    await tick();
  }
  const l = loop(cwd);
  assert.equal(l.active, true, "loop survives error turns");
  assert.equal(l.iteration, 1, "error turns are not iterations");
  assert.equal(l.stallCount, 2, "stall count untouched by dead turns");
  assert.equal(l.consecutiveErrors, 3, "dead-turn streak tracked");
  const lg = ledger(cwd);
  assert.ok(lg.includes('"loop_turn_exempt_error"'), "exemption ledgered");
  assert.ok(!lg.includes('"loop_measured"'), "no measurement on dead turns");
  assert.ok(!lg.includes('"loop_stuck"'), "no stuck accounting on dead turns (hellhunter class)");
});

test("v0.29.19: a real turn after errors clears the streak and measures normally", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({ measureCmd: "echo 74", direction: "max", bestValue: 74, lastValue: 74 }) });
  const ctx = await freshSession(cwd, "startup");
  await pi.fire("agent_end", errTurn(), ctx); await tick();
  await pi.fire("agent_end", errTurn(), ctx); await tick();
  assert.equal(loop(cwd).consecutiveErrors, 2);
  await pi.fire("agent_end", workTurn(), ctx); await tick();
  const l = loop(cwd);
  assert.equal(l.iteration, 2, "real turn measured as iteration 2");
  assert.equal(l.consecutiveErrors ?? 0, 0, "streak cleared by a real turn");
  assert.equal(l.stallCount, 1, "non-improving real turn counts the stall");
});

test("v0.29.19: 6 consecutive error turns stop the loop honestly — provider errors, resumable", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({ measureCmd: "echo 74", direction: "max", bestValue: 74, iteration: 41 }) });
  const ctx = await freshSession(cwd, "startup");
  for (let i = 0; i < 6; i++) {
    await pi.fire("agent_end", errTurn(), ctx);
    await tick();
  }
  const l = loop(cwd);
  assert.equal(l.active, false, "bounded: a real outage stops the loop");
  assert.match(l.stopReason ?? "", /^provider errors — 6 consecutive error turns/, "honest reason");
  assert.ok(l.stopReason!.includes("iteration 41 preserved"), "iteration preserved in the reason");
  // /loop resume works on the provider-error class and re-arms the counters:
  await pi.command("loop", "resume", ctx);
  await tick();
  const r = loop(cwd);
  assert.equal(r.active, true, "resumed");
  assert.equal(r.iteration, 41, "iteration preserved across resume");
  assert.equal(r.consecutiveErrors ?? 0, 0, "error streak re-armed");
});

test("v0.29.19: 3 consecutive user aborts stop the loop — user aborts mean STOP", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({ measureCmd: "echo 74", direction: "max", bestValue: 74 }) });
  const ctx = await freshSession(cwd, "startup");
  await pi.fire("agent_end", abortTurn(), ctx); await tick();
  await pi.fire("agent_end", abortTurn(), ctx); await tick();
  assert.equal(loop(cwd).active, true, "2 aborts: loop continues (unchanged from before)");
  await pi.fire("agent_end", abortTurn(), ctx); await tick();
  const l = loop(cwd);
  assert.equal(l.active, false, "third abort stops the loop");
  assert.match(l.stopReason ?? "", /^stopped by user — 3 consecutive aborts/, "honest abort reason");
});

test("v0.29.19: audit plateau with OPEN findings stands down (reprieve), then stops honestly when reprieves run out", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, path.dirname(AUDIT_FINDINGS_REL)), { recursive: true });
  fs.writeFileSync(path.join(cwd, AUDIT_FINDINGS_REL), [
    "- [x] MED: closed thing — fixed in abc1234",
    "- [ ] HIGH: still open one",
    "- [ ] MED: still open two",
    "",
  ].join("\n"));
  seedState(cwd, { loop: seedLoop({
    kind: "audit",
    measureCmd: auditMeasureCmd(),
    direction: "max",
    bestValue: 1,
    lastValue: 1,
    stallCount: 4,
    target: "audit target",
  }) });
  const ctx = await freshSession(cwd, "startup");
  // findings.md has 1 closed box → measure reads 1 = best → stall 5 → plateau
  // — but 2 boxes are OPEN: the well isn't dry, the stop must stand down.
  await pi.fire("agent_end", workTurn(), ctx);
  await tick();
  let l = loop(cwd);
  assert.equal(l.active, true, "plateau stands down while findings are open");
  assert.equal(l.stallCount, 0, "stall reset by the reprieve");
  assert.equal(l.auditPlateauReprieves, 1, "reprieve counted");
  assert.ok((l.auditReprieveNote ?? "").includes("2 finding(s) still OPEN"), "one-shot shove armed");
  assert.ok(ledger(cwd).includes('"audit_plateau_reprieve"'), "reprieve ledgered");
  // burn the second reprieve + the final plateau (5 turns each):
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 5; i++) {
      await pi.fire("agent_end", workTurn(), ctx);
      await tick();
    }
  }
  l = loop(cwd);
  assert.equal(l.active, false, "third plateau stops the loop");
  assert.match(l.stopReason ?? "", /no closure in 5×3 iterations despite 2 open findings/, "honest blocked-named stop");
  // and the honest stop is resumable:
  await pi.command("loop", "resume", ctx);
  await tick();
  const r = loop(cwd);
  assert.equal(r.active, true, "resumed after the blocked-named stop");
  assert.equal(r.auditPlateauReprieves ?? 0, 0, "explicit resume re-arms reprieves");
  assert.equal(r.stallCount, 0, "explicit resume re-arms the stall window");
});

test("v0.29.19: audit plateau with ZERO open findings stops normally — the well is dry", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, path.dirname(AUDIT_FINDINGS_REL)), { recursive: true });
  fs.writeFileSync(path.join(cwd, AUDIT_FINDINGS_REL), "- [x] MED: closed thing — fixed in abc1234\n");
  seedState(cwd, { loop: seedLoop({
    kind: "audit",
    measureCmd: auditMeasureCmd(),
    direction: "max",
    bestValue: 1,
    lastValue: 1,
    stallCount: 4,
    target: "audit target",
  }) });
  const ctx = await freshSession(cwd, "startup");
  await pi.fire("agent_end", workTurn(), ctx);
  await tick();
  const l = loop(cwd);
  assert.equal(l.active, false, "dry well: plateau stop stands");
  assert.match(l.stopReason ?? "", /^plateau — no improvement in 5 consecutive iterations/, "standard plateau reason");
  assert.equal(l.auditPlateauReprieves ?? 0, 0, "no reprieve spent");
});
