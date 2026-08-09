// pi-goal-list-loop-audit — v0.34.54
// tests/lifecycle-recovery.test.ts
//
// Contract item: "Test list and settings recovery after session replacement —
// the behavioral harness proves /list show and settings work after a fresh
// session_start and fail honestly before rebind."
//
// The lifecycle story under test, in one file:
//   Phase 1 (stale handle — pi replaced the session and never delivered a
//     replacement): /list show must NOT silently pretend success — the
//     standard recovery warning accompanies the read (inspect, don't
//     mutate). Settings must NOT open or write — bare /glla is refused
//     wholesale (every table choice writes state), read-only /glla actions
//     stay usable with the warning.
//   Phase 2 (fresh session_start arrives): /list show renders cleanly with
//     NO stale residue, and settings both open (the table renders) and
//     WRITE (a real choice lands in the settings file).
// v0.34.51 pinned the refusal half of the /list story and the read-only
// exemption; v0.34.52 pinned the settings refusal + table-reopen. This file
// adds what those did not: the honest-warning assertion on the stale-phase
// /list show (silent success would be the lie), the clean post-rebind
// /list show (no warning, no probe trail), and a post-rebind settings WRITE
// that lands (not just the table opening).
//
// Shared-process hazard (note.md): this file activates the goal.js module
// singleton at module scope, so it copies loop-error-exemption.test.ts's
// afterEach cleanup and the __testOnlyResetOwnerSession() in freshSession.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetStaleFlag, __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { readState, LIST_MUTATING_SUBCOMMANDS, SETTINGS_MUTATING_ACTIONS } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, invalidateHostSession, tick, type MockCtx } from "./harness/mock-pi.js";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager" };
const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true } : {}));
}
afterEach(() => {
  setGlobalAutoResume(false);
  pi.execHandler = null;
  pi.sendMessageError = null;
  pi.sessionNameError = null;
  __testOnlyResetOwnerSession(); // release the claim so later files are unaffected
});

function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}
async function freshSession(cwd: string, reason: string): Promise<MockCtx> {
  __testOnlyResetOwnerSession(); // behavioral-orchestrator's owner claim precedes this file
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason }, ctx);
  return ctx;
}

function projectSettingsPath(cwd: string): string {
  return path.join(cwd, ".pi-glla", "settings.json");
}
function ledgerText(cwd: string): string {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
}
/** The lifecycle replacement arrives: a fresh factory run clears the stale
 * latch and session_start rebinds (same motion as v0.34.51's recovery test). */
async function rebindSession(cwd: string, reason: string): Promise<MockCtx> {
  __testOnlyResetStaleFlag();
  pi.sendMessageError = null;
  pi.sessionNameError = null;
  return await freshSession(cwd, reason);
}
const RECOVERY = "can't send continuations in this process";

function seedListState(cwd: string): void {
  seedState(cwd, {
    goal: {
      id: "list-item-1",
      objective: "active seeded list item — done when pinned",
      status: "active",
      policy: "list",
      autoContinue: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    list: [{ id: "queued-1", objective: "queued item one", addedAt: new Date().toISOString() }],
  });
}

// ────────────────────────────────────────────────────────────────────
// Phase 1: before rebind — honest results, no pretend success
// ────────────────────────────────────────────────────────────────────

test("v0.34.54: /list show before rebind — honest stale result: the recovery warning accompanies the read", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedListState(cwd);
  const ctx = await freshSession(cwd, "startup");
  await tick();
  const before = ledgerText(cwd);
  invalidateHostSession(pi, ctx);

  await pi.command("list", "show", ctx);
  await tick();

  const after = ledgerText(cwd);
  // The honest part: the command does NOT silently succeed — the standard
  // recovery warning is printed with the read.
  const honest = ctx.ui.matching(RECOVERY);
  assert.ok(honest.length >= 1, "the recovery warning accompanies the stale read");
  assert.ok(honest.some((n) => n.message.includes("State is safe in .pi-glla/")), "points at the durable state");
  // Still an inspection: the queue renders, nothing is refused, nothing mutates.
  assert.ok(ctx.ui.matching("List (1)").some((n) => n.message.includes("queued item one")), "the queue is still inspectable");
  assert.ok(!after.includes('"list_mutation_refused_stale"'), "read-only show is not a refused mutation");
  assert.ok(after.includes('"extension_api_stale"'), "the entry probe is ledgered");
  assert.equal(after.split("\n").length, before.split("\n").length + 1, "show itself writes nothing beyond the probe trail");
});

test("v0.34.54: settings before rebind — bare /glla refused, read-only /glla status usable, both honest", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {});
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  const settingsFile = projectSettingsPath(cwd);
  const original = JSON.stringify({ autoAcceptDrafts: true });
  fs.writeFileSync(settingsFile, original);
  const ctx = await freshSession(cwd, "startup");
  await tick();
  let uiOpened = 0;
  ctx.ui.customImpl = async () => {
    uiOpened++;
    return undefined;
  };
  invalidateHostSession(pi, ctx);

  await pi.command("glla", "", ctx); // bare /glla = the settings entry
  await tick();
  await pi.command("glla", "status", ctx);
  await tick();

  assert.equal(uiOpened, 0, "the settings table never opened before rebind");
  assert.equal(fs.readFileSync(settingsFile, "utf-8"), original, "settings file untouched before rebind");
  const ledger = ledgerText(cwd);
  assert.ok(ledger.includes('"settings_mutation_refused_stale"'), "the settings entry refusal is ledgered");
  assert.ok(!ledger.includes('"settings_saved"'), "no settings write event before rebind");
  assert.ok(ledger.split("\n").filter((l) => l.includes('"extension_api_stale"')).length >= 2, "both entries probed");
  // Read-only stays usable with the warning: the status surface renders and
  // every notify carries the honest staleness context.
  const honest = ctx.ui.matching(RECOVERY);
  assert.ok(honest.length >= 2, "both commands print the recovery warning");
  const statuses = ctx.ui.matching("status");
  assert.ok(statuses.length >= 1, "the status read still renders");
});

// ────────────────────────────────────────────────────────────────────
// Phase 2: after a fresh session_start — fully working, no stale residue
// ────────────────────────────────────────────────────────────────────

test("v0.34.54: /list show after a fresh session_start — renders clean, zero stale residue", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedListState(cwd);
  const ctx = await freshSession(cwd, "startup");
  await tick();
  invalidateHostSession(pi, ctx);
  await pi.command("list", "show", ctx); // phase 1: honest
  await tick();

  const fresh = await rebindSession(cwd, "startup");
  await tick();
  const before = ledgerText(cwd);
  await pi.command("list", "show", fresh);
  await tick();

  const after = ledgerText(cwd);
  assert.ok(fresh.ui.matching("List (1)").some((n) => n.message.includes("queued item one")), "the queue renders after rebind");
  assert.equal(fresh.ui.matching(RECOVERY).length, 0, "no stale warning — the handle is alive again");
  assert.equal(after.split("\n").length, before.split("\n").length, "no probe trail — warnIfStaleAtEntry never fired");
  const staleLines = (t: string) => t.split("\n").filter((l) => l.includes('"extension_api_stale"')).length;
  assert.equal(staleLines(after), staleLines(before), "no NEW staleness ledgered after rebind (phase-1 history stays untouched)");
});

test("v0.34.54: settings after a fresh session_start — the table opens AND a real write lands", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {});
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(projectSettingsPath(cwd), JSON.stringify({ autoAcceptDrafts: true }));
  const ctx = await freshSession(cwd, "startup");
  await tick();
  invalidateHostSession(pi, ctx);
  await pi.command("glla", "", ctx); // phase 1: refused
  await tick();

  const fresh = await rebindSession(cwd, "startup");
  await tick();
  // (a) the settings table opens again:
  let uiOpened = 0;
  fresh.ui.customImpl = async () => {
    uiOpened++;
    return undefined; // cancel on first render
  };
  const beforeLedger = ledgerText(cwd);
  await pi.command("glla", "", fresh);
  await tick();
  assert.equal(uiOpened, 1, "the settings table opens after rebind");
  const afterLedger = ledgerText(cwd);
  const refusals = (t: string) => t.split("\n").filter((l) => l.includes('"settings_mutation_refused_stale"')).length;
  assert.equal(refusals(afterLedger), refusals(beforeLedger), "no NEW refusal after rebind (phase-1 refusal stays in history)");

  // (b) a REAL settings write lands through the menu: pick the
  // autoAcceptDrafts row, answer "on" — the global settings file must
  // change. (After the write the loop re-renders once; the second custom
  // call cancels.)
  let pickCount = 0;
  fresh.ui.customImpl = async () => (++pickCount === 1 ? "autoAcceptDrafts" : undefined); // one pick, then cancel — the loop exits
  fresh.ui.selectImpl = async (title: string) => (title.startsWith("Auto-accept") ? "on" : undefined);
  const globalBefore = fs.readFileSync(GLOBAL_SETTINGS_PATH, "utf-8");
  await pi.command("glla", "", fresh);
  await tick();
  const globalAfter = JSON.parse(fs.readFileSync(GLOBAL_SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
  assert.equal(globalAfter.autoAcceptDrafts, true, "the post-rebind settings write landed");
  assert.ok(globalBefore !== JSON.stringify(globalAfter), "the global settings file actually changed");
  // saveSettings is a pure file write (no ledger event) — the file IS the
  // evidence; the project-scope settings file must be untouched by the write:
  assert.equal(fs.readFileSync(projectSettingsPath(cwd), "utf-8"), JSON.stringify({ autoAcceptDrafts: true }), "project settings untouched — the write went to the global scope");
});

// ────────────────────────────────────────────────────────────────────
// Source pins — the honest taxonomy survives refactors
// ────────────────────────────────────────────────────────────────────

test("v0.34.54: source — read-only surfaces are never in the mutating sets; the gates are the honest refusal, not silence", () => {
  const SRC = readGoalRuntimeSource();
  const CMDS = fs.readFileSync("extensions/goal-commands.ts", "utf-8"); // decomposition step 2
  assert.ok(!LIST_MUTATING_SUBCOMMANDS.has("show") && !LIST_MUTATING_SUBCOMMANDS.has("depth"), "show/depth stay read-only for /list");
  assert.ok(!SETTINGS_MUTATING_ACTIONS.has("status") && !SETTINGS_MUTATING_ACTIONS.has("log") && !SETTINGS_MUTATING_ACTIONS.has("stats") && !SETTINGS_MUTATING_ACTIONS.has("audits"), "read-only /glla verbs stay ungated");
  // The /list show branch must NOT be gated by the entry probe (inspect,
  // don't mutate) — it only prints the honest warning via the probe:
  assert.match(CMDS, /const staleEntry = warnIfStaleAtEntry\(ctx, "\/list"\);[\s\S]{0,12000}?if \(!sub \|\| sub === "show"\)/, "the probe is captured before the show branch");
  const showBlock = CMDS.slice(CMDS.indexOf('if (!sub || sub === "show")'), CMDS.indexOf('if (!sub || sub === "show")') + 400);
  assert.ok(!showBlock.includes("LIST_MUTATING_SUBCOMMANDS"), "the show branch itself is ungated");
  // The settings gate refuses the bare entry on stale and names the recovery:
  assert.match(CMDS, /staleEntry && \(verb === "ui" \|\| SETTINGS_MUTATING_ACTIONS\.has\(verb\)\)/, "the settings gate refuses the entry + mutating verbs on stale");
  assert.match(SRC, /State is safe in \.pi-glla\/\. A fresh session_start will resume it/, "the honest recovery message is the standard one");
});
