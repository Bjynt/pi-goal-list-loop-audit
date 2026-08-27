// pi-goal-list-loop-audit — v0.35.72
// tests/glla-bug-capture.test.ts
//
// /glla bug — lightweight failure capture that never touches durable goal state.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, tick } from "./harness/mock-pi.js";

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager" };
afterEach(() => {
  __testOnlyResetOwnerSession();
});

function readActive(cwd: string): string {
  try {
    return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  } catch {
    return "";
  }
}
function readGoalMd(cwd: string, goalId: string): string {
  try {
    return fs.readFileSync(path.join(cwd, ".pi-glla", "goals", `${goalId}.md`), "utf8");
  } catch {
    return "";
  }
}

test("/glla bug writes to dedicated bugs artifact and leaves durable goal state untouched", async () => {
  const cwd = tmpCwd();
  const goalId = "20260827b00001-abc123";
  seedState(cwd, {
    goal: {
      id: goalId,
      objective: "active goal for bug capture test",
      status: "active",
      policy: "list",
      autoContinue: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      verificationContract: "- do the thing",
    },
    list: [{ id: "queued-1", objective: "queued item", addedAt: new Date().toISOString() }],
  });
  const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();

  const beforeActive = readActive(cwd);
  const beforeMd = readGoalMd(cwd, goalId);
  const beforeBugs = (() => {
    try {
      return fs.readdirSync(path.join(cwd, ".pi-glla", "bugs"));
    } catch {
      return [];
    }
  })();

  await pi.command("glla", "bug the widget flickered on retry", ctx);
  await tick();

  const afterActive = readActive(cwd);
  const afterMd = readGoalMd(cwd, goalId);
  // durable state must be identical (no persistState/appendLedger for bug)
  assert.equal(afterActive, beforeActive, "active.jsonl untouched by /glla bug");
  assert.equal(afterMd, beforeMd, "goal md untouched by /glla bug");

  const bugsDir = path.join(cwd, ".pi-glla", "bugs");
  const files = fs.readdirSync(bugsDir);
  assert.equal(files.length, beforeBugs.length + 1, "one new bug file created");
  const latest = files.sort().at(-1)!;
  const content = fs.readFileSync(path.join(bugsDir, latest), "utf8");
  assert.match(content, /# Bug report/, "bug file has header");
  assert.match(content, /the widget flickered on retry/, "user message captured");
  assert.match(content, new RegExp(goalId), "goal id captured");
  assert.match(content, /active goal for bug capture test/, "objective captured");
  assert.match(content, /Durable goal state untouched/, "notes mention untouched guarantee");
  assert.match(content, /Recent active\.jsonl tail/, "snapshot included");
  // verify it's not polluting ledger with bug-specific type
  assert.ok(!afterActive.includes("bug_captured"), "no bug ledger event in active.jsonl");
});

test("/glla bug without message still captures and does not mutate state", async () => {
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: {
      id: "20260827b00002-def456",
      objective: "second goal",
      status: "paused",
      policy: "list",
      autoContinue: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    list: [],
  });
  const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  const beforeActive = readActive(cwd);
  await pi.command("glla", "bug", ctx);
  await tick();
  assert.equal(readActive(cwd), beforeActive, "active.jsonl still untouched");
  const bugsDir = path.join(cwd, ".pi-glla", "bugs");
  const files = fs.readdirSync(bugsDir);
  const latest = files.sort().at(-1)!;
  const content = fs.readFileSync(path.join(bugsDir, latest), "utf8");
  assert.match(content, /\(no message/, "empty message handled");
});

test("source: cmdGllaBug exists and writes to bugs/ without persistState", () => {
  const src = fs.readFileSync("extensions/goal-commands.ts", "utf8");
  assert.match(src, /function cmdGllaBug\(message: string, ctx: ExtensionContext\): string/, "function exists");
  assert.match(src, /resolveGllaStateDir\(ctx\.cwd\)/, "uses state-root resolver");
  assert.match(src, /path\.join\(.*bugs/, "writes under bugs");
  assert.match(src, /fs\.writeFileSync\(file/, "uses plain write");
  // must not call durable mutators — extract only the function body up to its return
  const start = src.indexOf("function cmdGllaBug");
  const end = src.indexOf("return file;", start) + 20;
  const fnBody = src.slice(start, end);
  assert.ok(!fnBody.includes("persistState("), "does not persist state");
  assert.ok(!fnBody.includes("appendLedger("), "does not append ledger");
  assert.ok(!fnBody.includes("writeGoalMd"), "does not write goal md");
});

test("source: /glla bug is registered in completions and handler", () => {
  const act = fs.readFileSync("extensions/loops/goal-activation.ts", "utf8");
  assert.match(act, /\["bug", "capture failure context/);
  const cmds = fs.readFileSync("extensions/goal-commands.ts", "utf8");
  assert.match(cmds, /if \(\/\^bug\(\?:\\s\|\$\)\/\.test\(trimmed\)\)/);
});
