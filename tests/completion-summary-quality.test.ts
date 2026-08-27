import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readGoalRuntimeSource } from "./harness/goal-source.js";
import activate, {
  __testOnlyLoadState,
  __testOnlyRegisterAgentTools,
  __testOnlyRememberCtx,
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlyResetTerminalFlags,
} from "../extensions/loops/goal.js";
import { makeMockCtx, MockPi, seedGoal, seedState, tmpCwd } from "./harness/mock-pi.js";

const SRC = readGoalRuntimeSource();
const MAIN_SM = { name: "main-session-manager" };
function ownerCtx(cwd: string) { return makeMockCtx(cwd, { sessionManager: MAIN_SM }); }
function rememberCtxFor(cwd: string) { __testOnlyRememberCtx(ownerCtx(cwd) as any); }
function readLedger(cwd: string) {
  return fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("completion summary quality: validator requires six labels", () => {
  assert.match(SRC, /const requiredLabels = \[\"Outcome:\", \"Changed:\", \"Evidence:\", \"Tests:\", \"Unresolved:\", \"Next:\"\] as const;/);
  assert.match(SRC, /completion_summary_missing_labels/);
  assert.match(SRC, /completionSummary missing required labels/);
});

test("completion summary quality: generic prose and missing labels ledger and NOTE", async () => {
  __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags(); __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ status: "active" }) });
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyRegisterAgentTools(pi.api);
  rememberCtxFor(cwd);
  // Use hanging auditor so the goal stays auditing for inspection before settle
  const script = path.join(cwd, "hanging-auditor.mjs");
  fs.writeFileSync(script, "setTimeout(()=>process.exit(0),8000)");
  fs.chmodSync(script, 0o700);
  process.env.GLLA_PI_BINARY = script;
  try {
    const res = await pi.runTool("complete_goal", { completionSummary: "done", verificationSummary: "Evidence" }, ownerCtx(cwd));
    assert.match(res.content[0]!.text, /auditor queued|detached/i);
    const st = JSON.parse(fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf-8").split("\n").filter(Boolean).pop()!);
    // The stored summary should contain NOTE about missing labels
    const ledger = readLedger(cwd);
    const missing = ledger.find((e) => e.type === "completion_summary_missing_labels");
    assert.ok(missing, "missing labels ledgered");
    assert.match(String(missing.value.flags.join(" ")), /missing required labels/);
    // Pending completion should carry the NOTE
    const stateLine = ledger.filter((e) => e.type === "audit_started").length ? ledger : readLedger(cwd);
    // Check via active.jsonl goal state
    const { readState } = await import("../extensions/goal-loop-core.js");
    const state = readState(cwd);
    assert.ok(state.goal?.completionSummary?.includes("NOTE:"), "stored summary amended with NOTE");
    assert.ok(state.goal?.completionSummary?.includes("Outcome"), "NOTE mentions missing labels");
  } finally { delete process.env.GLLA_PI_BINARY; __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags(); __testOnlyResetOwnerSession(); }
});

test("completion summary quality: valid six-label recap passes without missing-label ledger", async () => {
  __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags(); __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ status: "active" }) });
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyRegisterAgentTools(pi.api);
  rememberCtxFor(cwd);
  const script = path.join(cwd, "hanging-auditor2.mjs");
  fs.writeFileSync(script, "setTimeout(()=>process.exit(0),8000)");
  fs.chmodSync(script, 0o700);
  process.env.GLLA_PI_BINARY = script;
  const valid = "Outcome: Shipped X. Changed: file.ts. Evidence: commit abc. Tests: bun test — 1 pass. Unresolved: none. Next: none.";
  try {
    const res = await pi.runTool("complete_goal", { completionSummary: valid, verificationSummary: "Evidence" }, ownerCtx(cwd));
    assert.match(res.content[0]!.text, /auditor queued|detached/i);
    const ledger = readLedger(cwd);
    assert.equal(ledger.filter((e) => e.type === "completion_summary_missing_labels").length, 0, "valid recap does not ledger missing labels");
    const { readState } = await import("../extensions/goal-loop-core.js");
    const state = readState(cwd);
    assert.equal(state.goal?.completionSummary, valid, "valid recap stored verbatim without NOTE");
  } finally { delete process.env.GLLA_PI_BINARY; __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags(); __testOnlyResetOwnerSession(); }
});

test("completion summary audit doc exists and inventories archives", () => {
  const p = path.resolve("audit/COMPLETION-SUMMARY-AUDIT-2026-08-27.md");
  assert.ok(fs.existsSync(p), "audit doc exists");
  const txt = fs.readFileSync(p, "utf-8");
  assert.match(txt, /Inventory/);
  assert.match(txt, /Usefulness assessment/);
  assert.match(txt, /six-label/);
});
