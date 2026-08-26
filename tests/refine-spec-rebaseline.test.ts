// pi-goal-list-loop-audit — v0.35.43
// tests/refine-spec-rebaseline.test.ts
//
// v0.35.43 audit-pass fix: refine's orchestrator-side spec write updated
// specText/specHash but NOT loop.specChecked — so the next tick saw
// checked > specChecked against the OLD file's count and ledged
// spec_item_progress attributed to the agent's iteration: unearned
// progress feeding the multi-signal stuck gate (the agent may have done
// nothing; the USER confirmed the respec).
//
// Fix under test: the refine handler re-baselines specChecked together
// with specHash after writing the new spec.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import activate, {
  __testOnlyRegisterAgentTools,
  __testOnlyRememberCtx,
  __testOnlyResetOwnerSession,
} from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { replaceState, state } from "../extensions/goal-state.js";
import { seedGoal, seedState, tmpCwd, makeMockCtx, MockPi } from "./harness/mock-pi.js";

function ownerCtx(cwd: string) {
  return makeMockCtx(cwd, { sessionManager: { name: "main-session-manager" } });
}

function rememberCtxFor(cwd: string): void {
  __testOnlyRememberCtx(ownerCtx(cwd) as unknown as ExtensionContext);
}

const SPEC_OLD = "# Spec\n\n- [x] done item one\n- [x] done item two\n- [ ] open item three\n";
const SPEC_NEW = `${SPEC_OLD}\n- [x] pre-checked by the respec itself\n- [x] also pre-checked\n`;

test("v0.35.43: a confirmed respec with newly checked boxes re-baselines specChecked — no unearned progress", async () => {
  const cwd = tmpCwd();
  const specFile = path.join(cwd, ".pi-glla", "spec.md");
  fs.mkdirSync(path.dirname(specFile), { recursive: true });
  fs.writeFileSync(specFile, SPEC_OLD);
  // Project settings: auto-accept drafts so the confirm dialog is skipped.
  fs.writeFileSync(path.join(cwd, ".pi-glla", "settings.json"), JSON.stringify({ autoAcceptDrafts: true }));
  const loopSeed = {
    target: "ship the widget", measureCmd: "echo 1", direction: "max" as const,
    active: true, iteration: 3, maxIterations: 0, plateauWindow: 5,
    specFile, specHash: "old-hash", specChecked: 2,
  };
  seedState(cwd, { goal: null, loop: loopSeed });
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyResetOwnerSession();
  // The foreign-tool guard compares sessionManager IDENTITY — bind and use
  // ONE ctx object for the whole test.
  const ownCtx = ownerCtx(cwd);
  await pi.fire("session_start", { reason: "startup" }, ownCtx);
  // The session-restore gate holds SEEDED loops inactive on load (v0.34.15);
  // /loop resume is what flips it back — do that to the in-memory state.
  assert.ok(state.loop, "the loop was loaded");
  replaceState({ ...state, loop: { ...state.loop!, active: true, stopReason: undefined } });
  __testOnlyRegisterAgentTools(pi.api);
  __testOnlyRememberCtx(ownCtx as unknown as ExtensionContext);

  // The respec REPLACES the spec with a file that has FOUR checked boxes:
  // two the agent checked before, two that arrive pre-checked via the
  // user-confirmed rewrite. Only the orchestrator wrote here.
  const res = await pi.runTool(
    "propose_loop_refine",
    { target: "ship the widget faster", specText: SPEC_NEW, rationale: "sharpened after review" },
    ownCtx,
  );
  console.log("REFINE RESULT:", res.content[0]!.text.slice(0, 300));
  assert.match(res.content[0]!.text, /applied|refin/i, `refine applied: ${res.content[0]!.text}`);
  assert.equal(fs.readFileSync(specFile, "utf8"), SPEC_NEW, "the orchestrator owns the spec write");

  const st = readState(cwd);
  assert.equal(st.loop!.specHash && st.loop!.specHash !== "old-hash", true, "specHash re-baselined (pre-existing behavior)");
  assert.equal(st.loop!.specChecked, 4, "v0.35.43: specChecked re-baselined with the hash — the next tick must not credit the agent with the respec's own checkboxes");
});

test("v0.35.x: recoverable bound-stopped loops accept a confirmed refinement without auto-starting", async () => {
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "settings.json"), JSON.stringify({ autoAcceptDrafts: true }));
  seedState(cwd, {
    goal: null,
    list: [],
    loop: {
      target: "ship the widget",
      measureCmd: "echo 1",
      direction: "max" as const,
      active: false,
      stopReason: "token budget exhausted (100 >= 100); best: 1",
      iteration: 3,
      maxIterations: 50,
      plateauWindow: 5,
      stallCount: 0,
      bestValue: 1,
      lastValue: 1,
      tokenBudget: 100,
      tokensUsed: 100,
      history: [],
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    },
  });
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyResetOwnerSession();
  const ownCtx = ownerCtx(cwd);
  await pi.fire("session_start", { reason: "startup" }, ownCtx);
  __testOnlyRegisterAgentTools(pi.api);
  __testOnlyRememberCtx(ownCtx as unknown as ExtensionContext);

  const res = await pi.runTool(
    "propose_loop_refine",
    { target: "ship the widget with verified interaction coverage", rationale: "the bound-stop evidence requires a narrower target" },
    ownCtx,
  );
  assert.match(res.content[0]!.text, /applied to the stopped loop/i);
  const after = readState(cwd).loop!;
  assert.equal(after.active, false, "refinement does not silently restart a stopped loop");
  assert.equal(after.stopReason, "token budget exhausted (100 >= 100); best: 1");
  assert.equal(after.target, "ship the widget with verified interaction coverage");
});
