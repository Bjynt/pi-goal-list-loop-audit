import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cancelHourlyProbe, createGoalRecovery, scheduleHourlyProbe } from "../extensions/goal-recovery.js";
import { replaceState, state } from "../extensions/goal-state.js";

const settingsPath = process.env.GLLA_GLOBAL_SETTINGS_PATH;
assert.ok(settingsPath, "the parent test supplies an isolated global-settings path");

function setHourlyProbeSetting(enabled) {
  fs.writeFileSync(settingsPath, JSON.stringify({ hourlyQuotaProbe: enabled }));
}

function parkedRecovery() {
  return {
    primary: "openai/backup",
    active: "anthropic/mock-model",
    attempted: ["anthropic/mock-model"],
    attempts: 1,
    reason: "main model quota: synthetic hourly probe failure",
    kind: "goal",
    firstFailureAt: new Date().toISOString(),
    autoRetryUntil: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    retryAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-hourly-runtime-"));
const ctx = {
  cwd,
  model: { provider: "anthropic", id: "mock-model" },
  modelRegistry: { find: () => ({ provider: "openai", id: "backup" }) },
  ui: { notify: () => {} },
};

let providerCalls = 0;
const scheduled = [];
const flags = {
  completionAuditRecoveryArmed: false,
  mainModelRecoveryTimer: null,
  mainModelSwitchInFlight: false,
  mainModelAbortForRecovery: false,
  lastMainModelFailure: null,
  hourlyProbeTimer: null,
  hourlyProbeFireAt: null,
  sessionGeneration: 1,
  extensionApi: {
    setModel: async () => {
      providerCalls += 1;
      throw new Error("synthetic hourly probe failure");
    },
  },
  extensionApiStale: false,
  continuationDispatchStoodDown: false,
  lastLongLivedFailureAt: 0,
  lastMainModelRecoveryResumeAt: 0,
};

const deps = {
  activeGoalSurfaceCommand: (command) => `/${command}`,
  clearDetachedAuditRuntime: () => {},
  updateGoal: () => {},
  clearContinuationTimer: () => {},
  freshCtxForGeneration: (generation) => generation === flags.sessionGeneration ? ctx : null,
  isSupervising: () => true,
  notifyExternal: () => {},
  persistState: () => {},
  recoverySurfaceCommand: (_kind, command) => `/${command}`,
  scheduleContinuation: () => {},
  scheduleSessionTimeout: (callback, delayMs) => {
    const timer = {
      delayMs,
      callback,
      native: setTimeout(() => {}, 60 * 60_000),
      fired: false,
    };
    scheduled.push(timer);
    return timer.native;
  },
};

createGoalRecovery(flags, deps);

function run(timer) {
  assert.equal(timer.fired, false, "a runtime timer fires once");
  timer.fired = true;
  timer.callback();
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function ledger() {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
}

setHourlyProbeSetting(true);
replaceState({ goal: null, mainModelRecovery: parkedRecovery() });
scheduleHourlyProbe(ctx);
assert.equal(scheduled.length, 1, "parked recovery arms one hourly timer");
const firstHourly = scheduled[0];
run(firstHourly);
await settle();
assert.equal(providerCalls, 1, "the first scheduled slot executes a provider probe");
assert.match(ledger(), /"main_model_probe_failed"/, "the injected provider failure reaches cleanup");
assert.notEqual(flags.hourlyProbeTimer, null, "cleanup leaves a new hourly timer");
const pending = scheduled.filter((timer) => !timer.fired);
assert.equal(pending.length, 2, "normal retry and later hourly slot are both pending");
const normalRetry = pending[0];
const secondHourly = pending[1];
assert.ok(secondHourly.delayMs > normalRetry.delayMs, "the later :00:30 slot is distinct from normal retry");
assert.notEqual(secondHourly.native, firstHourly.native, "cleanup did not retain the consumed timer");
assert.equal(flags.hourlyProbeTimer, secondHourly.native, "the re-armed timer is the hourly handle");

run(secondHourly);
await settle();
assert.equal(providerCalls, 2, "the later scheduled slot executes a second provider probe");
assert.equal((ledger().match(/"hourly_probe_fired"/g) ?? []).length, 2, "both hourly slots fired");

cancelHourlyProbe();
setHourlyProbeSetting(false);
replaceState({ goal: null, mainModelRecovery: parkedRecovery() });
const beforeOptOut = scheduled.length;
scheduleHourlyProbe(ctx);
assert.equal(scheduled.length, beforeOptOut, "opt-out prevents a new hourly timer");

setHourlyProbeSetting(true);
scheduleHourlyProbe(ctx);
const staleTimer = scheduled[scheduled.length - 1];
assert.equal(staleTimer.fired, false, "opt-in arms a timer again");
const beforeStale = scheduled.length;
flags.sessionGeneration += 1;
run(staleTimer);
await settle();
assert.equal(providerCalls, 2, "a stale generation never reaches the provider");
assert.equal(scheduled.length, beforeStale, "a stale timer does not re-arm itself");
assert.equal((ledger().match(/"hourly_probe_fired"/g) ?? []).length, 2, "stale execution emits no probe event");

cancelHourlyProbe();
for (const timer of scheduled) clearTimeout(timer.native);
console.log("hourly-runtime-ok");
