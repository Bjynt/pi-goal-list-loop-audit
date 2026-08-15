// pi-goal-list-loop-audit — v0.34.64
// tests/blocked-pause-autoclear.test.ts
//
// Field: dracon-platform/web 2026-08-07 — a goal paused on kind="blocked"
// with a quota-flavored pauseReason ("Quota recovered, but the two
// contract blockers…") was NOT auto-cleared when mainModelRecovery went
// from set → null, even though the underlying quota condition had
// resolved. The user came back from sleep to a parked goal they could
// not unstick without manual intervention ("manual resume is the exact
// wrong idea — we want to keep going"). The v0.34.64 fix extends the
// recovery-cleared path in mainModelRecoverySucceeded to also accept
// pauseKind === "blocked" when the pauseReason matches a quota-style
// indicator. autoResume:true honors "keep going" — when the wall has
// resolved, we un-park and re-engage, instead of waiting for a manual
// `/list resume`.
//
// Contract under test:
//   1. blocked pause + quota-style reason + recovery success → status:active
//   2. blocked pause + NON-quota reason → STAYS blocked (we never override
//      a pause the agent authored for a non-quota reason)
//   3. wait pause + quota-style reason → still auto-clears (regression guard
//      for the original v0.34.51 behavior, now broadened)
//
// Sequence: seed a paused goal + an active mainModelRecovery, fire
// session_start (restore path schedules the recovery probe timer), wait for
// main_model_probe (the probe retries the current model via continuation),
// then fire agent_end with a real message + stopReason end_turn — the model
// "succeeded" — which routes handleMainModelAgentEnd →
// mainModelRecoverySucceeded → the recoveryPause un-park decision.
//
// Co-residency: this file fires session_start and agent_end like
// lifecycle-recovery.test.ts; afterEach resets the module-level
// owner/stale flags, the pi knobs, and the global autoResume setting.

import { test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyLoadState,
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlyResetTerminalFlags,
  __testOnlySetLastMainModelRecoveryResumeAt,
} from "../extensions/loops/goal.js";
import { seedGoal, seedState, MockPi, makeMockCtx, tmpCwd, tick, type MockCtx } from "./harness/mock-pi.js";

const pi = new MockPi();
activate(pi.api);

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}

const HOST_SM = {
  name: "main-session-manager",
  getSessionId: () => "sess-blocked-autoclear",
  // Non-blank: include a user message so isBlankInitialStartup returns false
  // and the restore path (which schedules the recovery probe) runs. A blank
  // manager would trip the load barrier and the recovery probe would never
  // fire — the field's incident would reproduce as a parked goal forever.
  buildSessionContext: () => ({ messages: [{ role: "user", content: "hi" }] }),
};

function readLedger(cwd: string): string {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
}

function seedPausedGoal(cwd: string, pauseReason: string, pauseKind: "wait" | "blocked"): void {
  const isWait = pauseKind === "wait";
  seedState(cwd, {
    goal: seedGoal({
      status: "paused",
      pauseKind,
      pauseResumeAt: isWait ? new Date(Date.now() + 15 * 60_000).toISOString() : undefined,
      pauseReason,
      ...(pauseKind === "blocked"
        ? { pauseSuggestedAction: "Run /list remove 1, then /goal resume — I'll re-add 3 items with proper Done when: markers." }
        : {}),
    }),
    mainModelRecovery: {
      primary: "anthropic/mock-model",
      active: "anthropic/mock-model",
      attempted: ["anthropic/mock-model"],
      attempts: 1,
      reason: "main model quota: 429 rate limit: pi held the provider retry with no stream activity",
      kind: "goal",
      firstFailureAt: new Date().toISOString(),
      autoRetryUntil: new Date(Date.now() + 24 * 3600_000).toISOString(),
      retryAt: new Date(Date.now() + 150).toISOString(),
    },
  } as unknown as Parameters<typeof seedState>[1]);
  __testOnlyLoadState(cwd);
}

function resetModuleState(): void {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlySetLastMainModelRecoveryResumeAt(null); // v0.34.124: the recovery-resume stamp is module-level; leaked into sibling files in bun's shared-process node:test runner it re-arms their continuation watchdogs
}

beforeEach(() => {
  resetModuleState();
  setGlobalAutoResume(true);
});

afterEach(() => {
  setGlobalAutoResume(false);
  pi.execHandler = null;
  pi.sendMessageError = null;
  pi.sessionNameError = null;
  resetModuleState();
});

async function waitFor(fn: () => boolean, ms = 2500): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await tick(50);
  }
}

/** Fire the restore, let the probe run, then let the model "succeed". */
async function restoreAndRecover(cwd: string): Promise<MockCtx> {
  const ctx = makeMockCtx(cwd, { sessionManager: HOST_SM });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await waitFor(() => readLedger(cwd).includes("main_model_probe"), 4000);
  // The probe retries the current model (primary === current), so the
  // continuation send lands in pi.sent. Simulate the model's success:
  await pi.fire(
    "agent_end",
    { messages: [{ role: "assistant", content: [{ type: "text", text: "probe ok" }] }], stopReason: "end_turn" },
    ctx,
  );
  await waitFor(() => readLedger(cwd).includes("main_model_recovered"), 4000);
  return ctx;
}

test("v0.34.64 — blocked pause with a quota-style reason auto-clears when the recovery probe succeeds", async () => {
  const cwd = tmpCwd();
  // The field's exact shape: agent wrote "Quota recovered, but ..." in
  // pauseReason — the leading "Quota" prefix matches isQuotaPauseReason.
  seedPausedGoal(
    cwd,
    "Quota recovered, but the two contract blockers from my previous pause are unchanged (run /list remove 1-4 to unblock)",
    "blocked",
  );

  await restoreAndRecover(cwd);

  // After recovery-cleared: blocked pause with quota reason → un-park to
  // active. The ledger section after main_model_recovered carries the new
  // state (persistState runs on the un-park).
  const l = readLedger(cwd);
  const after = l.slice(l.indexOf("main_model_recovered"));
  assert.match(after, /"status"\s*:\s*"active"/, "blocked+quota un-parks to active after recovery cleared");
  assert.doesNotMatch(after, /"pauseKind"\s*:\s*"blocked"/, "blocked pauseKind was cleared");
  assert.doesNotMatch(after, /"pauseReason"/, "pause reason was cleared on un-park");
});

test("v0.34.64 — blocked pause with a NON-quota reason stays blocked (we never override agent intent)", async () => {
  const cwd = tmpCwd();
  // An agent blocks for a non-quota reason ("contract review required").
  // autoResume must NOT override that.
  seedPausedGoal(
    cwd,
    "contract review required before continuing — the verification contract for this goal needs your sign-off",
    "blocked",
  );

  await restoreAndRecover(cwd);

  const l = readLedger(cwd);
  const after = l.slice(l.indexOf("main_model_recovered"));
  assert.match(after, /"pauseKind"\s*:\s*"blocked"/, "non-quota blocked pause stays blocked");
  assert.doesNotMatch(after, /"status"\s*:\s*"active"/, "no un-park to active for a non-quota reason");
});

test("v0.34.64 — wait pause with a quota-style reason still auto-clears (regression: original v0.34.51 path)", async () => {
  const cwd = tmpCwd();
  seedPausedGoal(
    cwd,
    "main model recovery — retrying in 15m (main model quota: 429 Token Plan usage limit)",
    "wait",
  );

  await restoreAndRecover(cwd);

  const l = readLedger(cwd);
  const after = l.slice(l.indexOf("main_model_recovered"));
  assert.match(after, /"status"\s*:\s*"active"/, "wait+quota un-parks to active (v0.34.51 path preserved)");
});

test("v0.34.64 — source guard: isQuotaPauseReason broadens the recoveryPause check", () => {
  const SRC = fs.readFileSync("extensions/goal-recovery.ts", "utf-8"); // decomposition step 3 (v0.34.111): mainModelRecoverySucceeded moved here
  // The function exists and accepts a blocked pauseKind now:
  assert.match(SRC, /pauseKind === "wait" \|\| state\.goal\.pauseKind === "blocked"/);
  // ...with the broader reason predicate:
  assert.match(SRC, /isQuotaPauseReason\(state\.goal\.pauseReason\)/);
});
