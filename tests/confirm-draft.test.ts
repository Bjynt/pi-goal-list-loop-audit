// pi-goal-list-loop-audit — v0.2.0
// tests/confirm-draft.test.ts
//
// v0.34.78 (GitHub #4): the draft-class confirm dialog renders as Markdown
// through ctx.ui.custom (ConfirmDraftComponent) instead of the plain-text
// select. Pins: the pure markdown builder, the component's rendered lines
// and SelectList wiring, and the goal.ts behavior on BOTH paths — custom
// first (yes/no/ALWAYS/stale) and the select fallback when the runtime has
// no custom shard.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";

import activate, { __testOnlyLastConfirmDialog, __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, seedState, seedGoal, tick, staleError } from "./harness/mock-pi.js";
import { readState } from "../extensions/goal-loop-core.ts";
import { buildConfirmDraftMarkdown, ConfirmDraftComponent } from "../extensions/confirm-draft.ts";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true }));

const pi = new MockPi();
activate(pi.api);

const FAKE_THEME = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;
const FAKE_KB = { matches: () => false };

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "glla-confirm-draft-"));
}

// ── pure builder ────────────────────────────────────────────────────────

test("buildConfirmDraftMarkdown: title is the H1, body follows", () => {
  const md = buildConfirmDraftMarkdown("Confirm goal", "objective — done when pinned");
  assert.equal(md, "# Confirm goal\n\nobjective — done when pinned");
});

// ── component ───────────────────────────────────────────────────────────

test("ConfirmDraftComponent renders the title, body, and all three choices", () => {
  const lines = new ConfirmDraftComponent(
    { title: "Confirm goal", body: "swap survival — done when absorbed", options: ["Yes", "No", "Yes — and always auto-accept drafts (sets autoAcceptDrafts for this project)"] },
    () => {},
    FAKE_THEME,
    FAKE_KB,
    () => {},
  ).render(120);
  const text = lines.join("\n");
  assert.ok(text.includes("Confirm goal"), "H1 title renders");
  assert.ok(text.includes("swap survival — done when absorbed"), "body renders");
  assert.ok(text.includes("Yes"), "Yes choice renders");
  assert.ok(text.includes("No"), "No choice renders");
  assert.ok(text.includes("auto-accept"), "ALWAYS choice renders (long option)");
});

test("ConfirmDraftComponent: first choice selected, no-throw on input/invalidate", () => {
  const comp = new ConfirmDraftComponent(
    { title: "Confirm goal", body: "b", options: ["Yes", "No"] },
    () => {},
    FAKE_THEME,
    FAKE_KB,
    () => {},
  );
  assert.equal(comp.getSelectedItem(), "Yes", "the first option is pre-selected");
  assert.doesNotThrow(() => comp.handleInput("j")); // navigate-down key data
  assert.doesNotThrow(() => comp.invalidate());
  assert.ok(comp.render(80).length > 0);
});

// ── goal.ts behavior: custom path (mock drives it via customImpl) ───────

function setup(cwd: string) {
  seedState(cwd, {});
  const ctx = makeMockCtx(cwd);
  return ctx;
}

test("custom path: Yes accepts the draft and the dialog is captured", async () => {
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  const ctx = setup(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  ctx.ui.customImpl = async () => "Yes";
  const res = await pi.runTool("propose_goal_draft", { objective: "confirm custom yes — done when pinned", verificationContract: "pinned" }, ctx);
  ctx.ui.customImpl = undefined;
  const dlg = __testOnlyLastConfirmDialog();
  assert.ok(dlg, "custom path captured the dialog");
  assert.equal(dlg!.title, "Confirm goal");
  assert.ok(dlg!.body.includes("confirm custom yes"));
  assert.match(res.content[0]!.text, /activated|Begin work/i);
  assert.equal((readState(cwd).goal as { objective: string }).objective, "confirm custom yes — done when pinned");
});

test("custom path: No rejects the draft", async () => {
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  const ctx = setup(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  ctx.ui.customImpl = async () => "No";
  const res = await pi.runTool("propose_goal_draft", { objective: "confirm custom no — done when pinned", verificationContract: "pinned" }, ctx);
  ctx.ui.customImpl = undefined;
  assert.match(res.content[0]!.text, /declined|not activated|not started|rejected/i);
  assert.equal(readState(cwd).goal, null, "nothing created on No");
});

test("custom path: a stale error returns stale (NOT-a-rejection)", async () => {
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  const ctx = setup(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  ctx.ui.customImpl = async () => { throw staleError(); };
  const res = await pi.runTool("propose_goal_draft", { objective: "confirm stale — done when pinned", verificationContract: "pinned" }, ctx);
  ctx.ui.customImpl = undefined;
  assert.match(res.content[0]!.text, /NOT a rejection/);
  assert.equal(readState(cwd).goal, null);
});

// ── goal.ts behavior: select fallback when custom is unavailable ────────

test("fallback: no custom shard → plain select path still accepts (Yes)", async () => {
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  const ctx = setup(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  (ctx.ui as { custom?: unknown }).custom = undefined; // emulate headless/RPC
  let selectTitle = "";
  ctx.ui.selectImpl = async (title: string) => {
    selectTitle = title;
    return "Yes";
  };
  const res = await pi.runTool("propose_goal_draft", { objective: "fallback select — done when pinned", verificationContract: "pinned" }, ctx);
  ctx.ui.selectImpl = undefined;
  assert.match(selectTitle, /Confirm goal/, "the select fallback rendered the same title");
  assert.match(res.content[0]!.text, /activated|Begin work/i);
  assert.equal((readState(cwd).goal as { objective: string }).objective, "fallback select — done when pinned");
});

test("fallback: a stale select error still returns stale", async () => {
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  const ctx = setup(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  (ctx.ui as { custom?: unknown }).custom = undefined;
  ctx.ui.selectImpl = async () => { throw staleError(); };
  ctx.ui.confirmImpl = async () => { throw staleError(); };
  const res = await pi.runTool("propose_goal_draft", { objective: "fallback stale — done when pinned", verificationContract: "pinned" }, ctx);
  ctx.ui.selectImpl = undefined;
  ctx.ui.confirmImpl = undefined;
  assert.match(res.content[0]!.text, /NOT a rejection/);
  assert.equal(readState(cwd).goal, null);
});
