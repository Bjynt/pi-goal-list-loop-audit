// pi-goal-list-loop-audit — tests/revision-bound-audit.test.ts
//
// Revision-bound audit validity (steal #3 / item #8): the goal carries a
// `revision` counter bumped on every contract change (/goal tweak, or
// complete_goal with newObjective); complete_goal is gated on the current
// revision matching the revision of the LAST audit in auditHistory — an
// approval from an older contract cannot be cited against a new one. The
// claim that itself carries the contract change (newObjective) skips the
// gate: its audit covers the new contract in the same call.
//
// Co-residency: this file drives complete_goal / goal tweak like the
// behavioral driver but NEVER fires session_start. beforeEach resets the
// module-level terminal/owner flags; settings written to the suite's global
// settings path.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readState } from "../extensions/goal-loop-core.js";
import activate, {
  __testOnlyLoadState,
  __testOnlyRegisterAgentTools,
  __testOnlyRememberCtx,
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlyResetTerminalFlags,
} from "../extensions/loops/goal.js";
import { makeMockCtx, MockPi, seedGoal, seedState, tmpCwd } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const MAIN_SM = { name: "main-session-manager" };

function ownerCtx(cwd: string) {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}

/** All ledger entries for a cwd, in order. */
function readLedger(cwd: string): Array<{ type: string; value: any; at: string }> {
  return fs
    .readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeSettings(settings: Record<string, unknown>): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(settings));
}

/** A goal at `revision` carrying a prior audit at `auditedRevision`
 * (or a legacy entry with no revision when omitted). */
function seedRevisionedGoal(cwd: string, revision: number, auditedRevision: number | undefined, approved: boolean): void {
  const history = auditedRevision === undefined
    ? [{ at: "2026-08-06T10:00:00.000Z", approved, disapproved: !approved, model: "test-auditor" }]
    : [{ at: "2026-08-06T10:00:00.000Z", approved, disapproved: !approved, model: "test-auditor", revision: auditedRevision }];
  seedState(cwd, { goal: seedGoal({ revision, auditHistory: history, status: "active" }) });
  __testOnlyLoadState(cwd);
}

/** Fake auditor pi binary that settles with the given verdict. */
function writeFakeAuditor(cwd: string, verdict: "approved" | "disapproved"): string {
  const script = path.join(cwd, "fake-auditor-pi.mjs");
  fs.writeFileSync(script, `#!/usr/bin/env node
let input = "";
let handled = false;
process.stdin.on("data", async (chunk) => {
  input += chunk;
  if (handled || !input.includes("\\n")) return;
  handled = true;
  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  const report = ${JSON.stringify(verdict === "approved" ? "<evidence>\npinned\n</evidence>\n<approved/>" : "## Required fixes\n- fix the pinned gap\n<disapproved/>")};
  emit({ type: "tool_execution_start", toolCallId: "fake-read", toolName: "read", args: { path: "README.md" } });
  emit({ type: "tool_execution_end", toolCallId: "fake-read" });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: report } });
  emit({ type: "agent_settled" });
  process.exit(0);
});
`);
  return script;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for detached-auditor state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(() => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnerSession();
  writeSettings({});
});

afterEach(() => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnerSession();
  writeSettings({});
});

// ---- (a) revision bumps on contract changes ----

test("v0.34.60: /goal tweak bumps the goal revision (a contract change)", async () => {
  const cwd = tmpCwd();
  seedRevisionedGoal(cwd, 1, undefined, false);
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyRegisterAgentTools(pi.api);
  await pi.command("goal", 'tweak "replaced objective — done when pinned"', ownerCtx(cwd));

  const st = readState(cwd);
  assert.equal(st.goal?.objective, "replaced objective — done when pinned");
  assert.equal(st.goal?.revision, 2, "contract change bumps the revision 1 → 2");
  assert.equal(readLedger(cwd).filter((l) => l.type === "goal_tweaked").length, 1);
});

test("v0.34.60: complete_goal with newObjective bumps the revision and audits the new contract in the same call", async () => {
  const cwd = tmpCwd();
  seedRevisionedGoal(cwd, 1, undefined, false);
  const fakePi = writeFakeAuditor(cwd, "approved");
  process.env.GLLA_PI_BINARY = fakePi;
  try {
    const pi = new MockPi();
    activate(pi.api);
    __testOnlyRegisterAgentTools(pi.api);
    __testOnlyRememberCtx(ownerCtx(cwd));
    const res = await pi.runTool(
      "complete_goal",
      { completionSummary: "Claim", verificationSummary: "Evidence", newObjective: "shifted objective — different work now" },
      ownerCtx(cwd),
    );
    assert.match(res.content[0]!.text, /auditor queued|detached/i, "the claim proceeds (no gate rejection)");
    const st = readState(cwd);
    assert.equal(st.goal?.objective, "shifted objective — different work now", "newObjective replaced the objective");
    assert.ok((st.goal?.revision ?? 0) > 1, "newObjective bumps the revision in the same call");
    await waitUntil(() => readState(cwd).goal?.status === "complete");
  } finally {
    delete process.env.GLLA_PI_BINARY;
  }
});

// ---- (b) the complete_goal revision gate ----

test("v0.34.60: complete_goal REJECTS when the contract revision moved past the last audited revision", async () => {
  const cwd = tmpCwd();
  seedRevisionedGoal(cwd, 2, 1, true); // approved at revision 1, contract changed to revision 2
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyRegisterAgentTools(pi.api);
  __testOnlyRememberCtx(ownerCtx(cwd));
  const res = await pi.runTool("complete_goal", { completionSummary: "Claim", verificationSummary: "Evidence" }, ownerCtx(cwd));

  assert.match(res.content[0]!.text, /REJECTED/i, "the tool refuses the claim");
  assert.match(res.content[0]!.text, /revision/i, "the refusal names the revision mismatch");
  const st = readState(cwd);
  assert.equal(st.goal?.status, "active", "the goal is untouched");
  assert.equal(st.goal?.pendingCompletion, undefined, "no claim was stored");
  assert.equal(st.goal?.revision, 2, "the rejection does not mutate the goal");
  const ledger = readLedger(cwd);
  assert.equal(ledger.filter((l) => l.type === "complete_goal_revision_rejected").length, 1, "clear ledger entry for the rejection");
  assert.equal(ledger.filter((l) => l.type === "audit_started").length, 0, "no audit was started");
});

test("v0.34.60: complete_goal passes when the last audit matches the current revision", async () => {
  const cwd = tmpCwd();
  seedRevisionedGoal(cwd, 2, 2, false); // last audit at revision 2, goal at revision 2
  const fakePi = writeFakeAuditor(cwd, "disapproved");
  process.env.GLLA_PI_BINARY = fakePi;
  try {
    const pi = new MockPi();
    activate(pi.api);
    __testOnlyRegisterAgentTools(pi.api);
    __testOnlyRememberCtx(ownerCtx(cwd));
    const res = await pi.runTool("complete_goal", { completionSummary: "Claim", verificationSummary: "Evidence" }, ownerCtx(cwd));
    assert.match(res.content[0]!.text, /auditor queued|detached/i, "the claim proceeds");
    assert.equal(readLedger(cwd).filter((l) => l.type === "audit_started").length, 1);
    await waitUntil(() => readState(cwd).goal?.status === "active" && !readState(cwd).goal?.pendingCompletion);
    assert.equal(readState(cwd).goal?.auditHistory?.length, 2, "the fresh audit appended a second verdict");
  } finally {
    delete process.env.GLLA_PI_BINARY;
  }
});

test("v0.34.60: legacy audit entries without a revision never trip the gate", async () => {
  const cwd = tmpCwd();
  seedRevisionedGoal(cwd, 2, undefined, true); // pre-revision audit record — no revision field
  const fakePi = writeFakeAuditor(cwd, "disapproved");
  process.env.GLLA_PI_BINARY = fakePi;
  try {
    const pi = new MockPi();
    activate(pi.api);
    __testOnlyRegisterAgentTools(pi.api);
    __testOnlyRememberCtx(ownerCtx(cwd));
    const res = await pi.runTool("complete_goal", { completionSummary: "Claim", verificationSummary: "Evidence" }, ownerCtx(cwd));
    assert.match(res.content[0]!.text, /auditor queued|detached/i, "legacy entries do not block the claim");
    assert.equal(readLedger(cwd).filter((l) => l.type === "complete_goal_revision_rejected").length, 0);
    await waitUntil(() => readState(cwd).goal?.status === "active" && !readState(cwd).goal?.pendingCompletion);
  } finally {
    delete process.env.GLLA_PI_BINARY;
  }
});

test("v0.34.60: the gate skips when the call itself carries newObjective (its audit covers the new contract)", async () => {
  const cwd = tmpCwd();
  seedRevisionedGoal(cwd, 1, 1, true); // old approval at revision 1 — but the call CHANGES the contract
  const fakePi = writeFakeAuditor(cwd, "disapproved");
  process.env.GLLA_PI_BINARY = fakePi;
  try {
    const pi = new MockPi();
    activate(pi.api);
    __testOnlyRegisterAgentTools(pi.api);
    __testOnlyRememberCtx(ownerCtx(cwd));
    const res = await pi.runTool(
      "complete_goal",
      { completionSummary: "Claim", verificationSummary: "Evidence", newObjective: "different contract now" },
      ownerCtx(cwd),
    );
    assert.match(res.content[0]!.text, /auditor queued|detached/i, "newObjective claims skip the stale-approval gate");
    assert.ok((readState(cwd).goal?.revision ?? 0) > 1, "revision bumped by the contract change in the call");
    assert.equal(readLedger(cwd).filter((l) => l.type === "complete_goal_revision_rejected").length, 0);
    await waitUntil(() => readState(cwd).goal?.status === "active" && !readState(cwd).goal?.pendingCompletion);
  } finally {
    delete process.env.GLLA_PI_BINARY;
  }
});
