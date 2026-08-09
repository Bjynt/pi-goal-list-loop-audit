// pi-goal-list-loop-audit — tests/revision-bound-audit.test.ts
//
// Revision-bound audit validity (steal #3 / item #8): the goal carries a
// `revision` counter bumped on every CONTRACT change (/goal tweak, or
// complete_goal with newObjective) — contract-scoped since v0.34.61, so
// audit settles and other non-contract writes do NOT move it. complete_goal
// is gated on the current revision matching the revision of the LAST audit
// in auditHistory — an approval from an older contract cannot be cited
// against a new one, while a settled audit never invalidates its own
// verdict (auditor round-2 findings 1-4: the +1 drift, the broken /goal
// verify escape, the every-persist bump, the false rejection text).
// The claim that itself carries the contract change (newObjective) skips
// the gate: its audit covers the new contract in the same call.
//
// Co-residency: this file drives complete_goal / goal tweak / goal verify
// like the behavioral driver but NEVER fires session_start. beforeEach
// resets the module-level terminal/owner flags; settings written to the
// suite's global settings path.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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

/** rememberCtx is typed against the production ExtensionContext; the
 * harness MockCtx is structurally close but not assignable. */
function rememberCtxFor(cwd: string): void {
  __testOnlyRememberCtx(ownerCtx(cwd) as unknown as ExtensionContext);
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
  fs.chmodSync(script, 0o700);
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
    rememberCtxFor(cwd);
    const res = await pi.runTool(
      "complete_goal",
      { completionSummary: "Claim", verificationSummary: "Evidence", newObjective: "shifted objective — different work now" },
      ownerCtx(cwd),
    );
    assert.match(res.content[0]!.text, /auditor queued|detached/i, "the claim proceeds (no gate rejection)");
    const st = readState(cwd);
    assert.equal(st.goal?.objective, "shifted objective — different work now", "newObjective replaced the objective");
    assert.equal(st.goal?.completionSummary, "Claim", "v0.34.91: the completion recap is captured on the goal at claim time (the terminal summary shows what happened)");
    assert.equal(st.goal?.revision, 2, "newObjective bumps the revision exactly once (seed 1 → 2); settle writes do not bump");
    await waitUntil(() => readState(cwd).goal === null);
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
  rememberCtxFor(cwd);
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
    rememberCtxFor(cwd);
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
    rememberCtxFor(cwd);
    const res = await pi.runTool("complete_goal", { completionSummary: "Claim", verificationSummary: "Evidence" }, ownerCtx(cwd));
    assert.match(res.content[0]!.text, /auditor queued|detached/i, "legacy entries do not block the claim");
    assert.equal(readLedger(cwd).filter((l) => l.type === "complete_goal_revision_rejected").length, 0);
    await waitUntil(() => readState(cwd).goal?.status === "active" && !readState(cwd).goal?.pendingCompletion);
  } finally {
    delete process.env.GLLA_PI_BINARY;
  }
});

test("v0.34.61: a settled audit never invalidates its own verdict — a second complete_goal on the same contract proceeds", async () => {
  // Auditor round-2 finding 1 (the +1 drift): v0.34.59 bumped on every
  // persist, so the settle write itself moved the goal one revision past
  // the verdict's recorded one and the next complete_goal was falsely
  // rejected with zero contract change. With the contract-scoped counter
  // the settle leaves lastAudited.revision === state.goal.revision.
  const cwd = tmpCwd();
  seedRevisionedGoal(cwd, 2, 2, false); // last audit at revision 2, goal at revision 2
  const fakePi = writeFakeAuditor(cwd, "disapproved");
  process.env.GLLA_PI_BINARY = fakePi;
  try {
    const pi = new MockPi();
    activate(pi.api);
    __testOnlyRegisterAgentTools(pi.api);
    rememberCtxFor(cwd);
    // Call 1: proceeds and settles disapproved → goal stays active.
    const res1 = await pi.runTool("complete_goal", { completionSummary: "Claim 1", verificationSummary: "Evidence" }, ownerCtx(cwd));
    assert.match(res1.content[0]!.text, /auditor queued|detached/i, "first claim proceeds");
    await waitUntil(() => {
      const st = readState(cwd);
      return st.goal?.status === "active" && !st.goal?.pendingCompletion && (st.goal?.auditHistory?.length ?? 0) >= 2;
    });
    const afterSettle = readState(cwd);
    const lastAudited = afterSettle.goal?.auditHistory?.at(-1);
    assert.equal(lastAudited?.revision, afterSettle.goal?.revision, "settle leaves the recorded revision equal to the goal's current revision");
    // Call 2: same contract, zero changes → must proceed (before the fix
    // this was REJECTED — the "pass when matching" state was unreachable).
    const res2 = await pi.runTool("complete_goal", { completionSummary: "Claim 2", verificationSummary: "Evidence" }, ownerCtx(cwd));
    assert.match(res2.content[0]!.text, /auditor queued|detached/i, "second claim on the same contract proceeds");
    const ledger = readLedger(cwd);
    assert.equal(ledger.filter((l) => l.type === "complete_goal_revision_rejected").length, 0, "no false rejection");
    assert.equal(ledger.filter((l) => l.type === "audit_started").length, 2, "both claims dispatched audits");
    // Drain call-2's settle so no in-flight audit bleeds into the next test
    // (the /goal verify route no-ops while completionAuditInFlight is set).
    await waitUntil(() => readState(cwd).goal?.status === "active" && !readState(cwd).goal?.pendingCompletion);
  } finally {
    delete process.env.GLLA_PI_BINARY;
  }
});

test("v0.34.61: the documented escape works — tweak, then /goal verify, then complete_goal proceeds", async () => {
  // Auditor round-2 finding 2: the rejection text promised "Run /goal
  // verify … then call complete_goal again", but the verify settle bumped
  // the revision too, dead-ending the escape. With the contract-scoped
  // counter the verify's settle records the CURRENT revision and the
  // follow-up claim proceeds.
  const cwd = tmpCwd();
  seedRevisionedGoal(cwd, 1, 1, true); // approved at revision 1
  const fakePi = writeFakeAuditor(cwd, "disapproved");
  process.env.GLLA_PI_BINARY = fakePi;
  try {
    const pi = new MockPi();
    activate(pi.api);
    __testOnlyRegisterAgentTools(pi.api);
    rememberCtxFor(cwd);
    // Contract change: /goal tweak → revision 2 → the old approval is stale.
    await pi.command("goal", 'tweak "new contract after tweak"', ownerCtx(cwd));
    assert.equal(readState(cwd).goal?.revision, 2, "tweak bumps 1 → 2");
    const resRejected = await pi.runTool("complete_goal", { completionSummary: "Claim", verificationSummary: "Evidence" }, ownerCtx(cwd));
    assert.match(resRejected.content[0]!.text, /REJECTED/i, "tweak since the last audit → rejected");
    // The escape: /goal verify audits the CURRENT contract (disapproved
    // settle → goal stays active) and records its revision.
    await pi.command("goal", "verify", ownerCtx(cwd));
    await waitUntil(() => {
      const st = readState(cwd);
      return st.goal?.status === "active" && !st.goal?.pendingCompletion && (st.goal?.auditHistory?.length ?? 0) >= 2;
    });
    const afterVerify = readState(cwd);
    assert.equal(afterVerify.goal?.auditHistory?.at(-1)?.revision, afterVerify.goal?.revision, "verify records the current revision");
    const res2 = await pi.runTool("complete_goal", { completionSummary: "Claim", verificationSummary: "Evidence" }, ownerCtx(cwd));
    assert.match(res2.content[0]!.text, /auditor queued|detached/i, "after /goal verify the claim proceeds (escape is real)");
    assert.equal(readLedger(cwd).filter((l) => l.type === "complete_goal_revision_rejected").length, 1, "exactly the pre-verify rejection");
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
    rememberCtxFor(cwd);
    const res = await pi.runTool(
      "complete_goal",
      { completionSummary: "Claim", verificationSummary: "Evidence", newObjective: "different contract now" },
      ownerCtx(cwd),
    );
    assert.match(res.content[0]!.text, /auditor queued|detached/i, "newObjective claims skip the stale-approval gate");
    assert.equal(readState(cwd).goal?.revision, 2, "revision bumped exactly once by the contract change in the call");
    assert.equal(readLedger(cwd).filter((l) => l.type === "complete_goal_revision_rejected").length, 0);
    await waitUntil(() => readState(cwd).goal?.status === "active" && !readState(cwd).goal?.pendingCompletion);
  } finally {
    delete process.env.GLLA_PI_BINARY;
  }
});

// v0.34.96: complete-vs-aborted distinction when the work was already
// shipped in a prior version. Field evidence: Screenshot 080536 — a
// v0.34.74 recap ended `✓ complete` while saying "v0.34.74 already…",
// the two states contradicted each other. The fix: detect
// "already shipped" / "verified vX.Y.Z covers this" / "no new work
// shipped" in the completionSummary and route to status=aborted with
// stopReason already_shipped:vX.Y.Z. The auditor never runs (there's
// nothing for it to verify); the user sees an honest terminal state.
test("v0.34.96: complete_goal routes to aborted when completionSummary says 'already shipped'", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ status: "active" }) });
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyRegisterAgentTools(pi.api);
  rememberCtxFor(cwd);
  const res = await pi.runTool(
    "complete_goal",
    {
      completionSummary: "Verified v0.34.74 already covers this — no new work shipped in this turn.",
      verificationSummary: "Evidence points to v0.34.74 commit history.",
    },
    ownerCtx(cwd),
  );
  assert.match(res.content[0]!.text, /routed to status=aborted/i);
  assert.match(res.content[0]!.text, /v0\.34\.74/, "the matched version is named in the response");
  const st = readState(cwd);
  assert.equal(st.goal?.status, "aborted", "the goal is archived as aborted, not complete");
  assert.match(st.goal?.stopReason ?? "", /already_shipped:v0\.34\.74/, "stopReason names the version");
  const ledger = readLedger(cwd);
  assert.equal(ledger.filter((l) => l.type === "complete_goal_already_shipped").length, 1);
  assert.equal(ledger.filter((l) => l.type === "audit_started").length, 0, "no auditor was started");
});

test("v0.34.96: complete_goal routes to aborted when completionSummary says 'no new work shipped'", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ status: "active" }) });
  __testOnlyLoadState(cwd);
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyRegisterAgentTools(pi.api);
  rememberCtxFor(cwd);
  const res = await pi.runTool(
    "complete_goal",
    { completionSummary: "All checklist items were no new work shipped — the audit shows prior versions." },
    ownerCtx(cwd),
  );
  assert.match(res.content[0]!.text, /routed to status=aborted/i);
  assert.match(res.content[0]!.text, /no version/i, "no version is named when summary has no vX.Y.Z");
  const st = readState(cwd);
  assert.equal(st.goal?.status, "aborted");
  assert.match(st.goal?.stopReason ?? "", /already_shipped:no new work shipped/, "stopReason names the matched phrase");
});

test("v0.34.96: a NORMAL completionSummary still runs the auditor (no false-positive abort)", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ status: "active" }) });
  __testOnlyLoadState(cwd);
  const fakePi = writeFakeAuditor(cwd, "disapproved");
  process.env.GLLA_PI_BINARY = fakePi;
  try {
    const pi = new MockPi();
    activate(pi.api);
    __testOnlyRegisterAgentTools(pi.api);
    rememberCtxFor(cwd);
    const res = await pi.runTool(
      "complete_goal",
      { completionSummary: "Shipped v0.34.95 work: quota-prompt removal + hourly probe ticker." },
      ownerCtx(cwd),
    );
    assert.match(res.content[0]!.text, /auditor queued|detached/i, "normal claims still run the auditor");
    assert.equal(readLedger(cwd).filter((l) => l.type === "complete_goal_already_shipped").length, 0);
    await waitUntil(() => readState(cwd).goal?.status === "active" && !readState(cwd).goal?.pendingCompletion);
  } finally {
    delete process.env.GLLA_PI_BINARY;
  }
});
