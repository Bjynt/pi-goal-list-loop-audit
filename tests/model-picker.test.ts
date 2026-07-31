// tests/model-picker.test.ts
//
// v0.29.17: /model-style fuzzy picker for model-valued settings + the
// loud session-model fallback for unavailable auditorModel values.
//
// Field: the auditor ran on openrouter/anthropic/claude-sonnet-4.5 until
// the OpenRouter key hit its TOTAL limit — every audit fleet-wide 403'd
// into quota parks. Fixing the setting meant hand-typing provider/model
// into a bare ctx.ui.input; the user asked for the /model interaction
// shape instead (search + filtered list), plus "fall back to the session
// model if unavailable".

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { buildModelPickItems, ModelPickerComponent, pickDiverseAuditorModel, DIVERSE_AUDITOR_PREFERENCE } from "../extensions/model-picker.ts";

const THEME = {
  fg: (_c: string, t: string) => t,
  bold: (t: string) => t,
};
const KB = {
  matches: (data: string, key: string) =>
    (key === "tui.select.confirm" && data === "\r") ||
    (key === "tui.select.cancel" && data === "\x1b") ||
    (key === "tui.select.up" && data === "\x1b[A") ||
    (key === "tui.select.down" && data === "\x1b[B"),
};

const MODELS = [
  { provider: "minimax", id: "MiniMax-M3", name: "MiniMax-M3" },
  { provider: "minimax", id: "MiniMax-M2.7", name: "MiniMax-M2.7" },
  { provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
  { provider: "openrouter", id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
];

function makePicker(items: ReturnType<typeof buildModelPickItems>) {
  let rendered = 0;
  let result: unknown = "unset";
  const comp = new ModelPickerComponent(
    { title: "Auditor model override", items },
    () => { rendered++; },
    THEME,
    KB,
    (item) => { result = item; },
  );
  return {
    comp,
    get result() { return result as any; },
    get renders() { return rendered; },
  };
}

test("model-picker items: session row first, manual row last, models sorted by provider/id", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  assert.equal(items[0]!.kind, "session");
  assert.ok(items[0]!.label.includes("minimax/MiniMax-M3"), "session row names the current session model");
  assert.equal(items[items.length - 1]!.kind, "manual");
  const refs = items.filter((i) => i.kind === "model").map((i) => i.ref);
  assert.deepEqual(refs, [
    "anthropic/claude-opus-4-7",
    "minimax/MiniMax-M2.7",
    "minimax/MiniMax-M3",
    "openrouter/anthropic/claude-sonnet-4.5",
  ]);
});

test("model-picker: typing fuzzy-filters the list; enter returns the highlighted model", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items);
  for (const ch of "minimax-m3") p.comp.handleInput(ch);
  assert.equal(p.comp.getQuery(), "minimax-m3");
  const filtered = p.comp.filteredItems();
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.ref, "minimax/MiniMax-M3");
  p.comp.handleInput("\r");
  assert.equal(p.result.kind, "model");
  assert.equal(p.result.ref, "minimax/MiniMax-M3");
  assert.ok(p.renders > 0, "re-rendered on each keystroke");
});

test("model-picker: slash-token fuzzy match (provider/model style), nav wraps, backspace edits", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items);
  for (const ch of "openrouter sonnet") p.comp.handleInput(ch);
  const filtered = p.comp.filteredItems();
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.ref, "openrouter/anthropic/claude-sonnet-4.5");
  p.comp.handleInput("\x7f"); // backspace one char — filter widens
  assert.equal(p.comp.getQuery(), "openrouter sonne");
  assert.ok(p.comp.filteredItems().length >= 1);
});

test("model-picker: up/down moves the selection; esc cancels with undefined", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items);
  p.comp.handleInput("\x1b[B");
  assert.equal(p.comp.getSelectedIdx(), 1);
  p.comp.handleInput("\x1b[A");
  assert.equal(p.comp.getSelectedIdx(), 0);
  p.comp.handleInput("\x1b");
  assert.equal(p.result, undefined);
});

test("model-picker: selecting the session row clears the override; manual row is the typed escape hatch", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items);
  p.comp.handleInput("\r"); // first row = session
  assert.equal(p.result.kind, "session");
  const manual = items[items.length - 1]!;
  assert.equal(manual.kind, "manual");
  assert.ok(!manual.ref, "manual carries no ref — the host opens the typed input");
});

test("model-picker: render stays within width and shows the filter hint", () => {
  const items = buildModelPickItems(MODELS, "minimax/MiniMax-M3");
  const p = makePicker(items);
  const lines = p.comp.render(60);
  const text = lines.join("\n");
  assert.ok(text.includes("Auditor model override"));
  assert.ok(text.includes("type to filter"));
  assert.ok(text.includes("minimax/MiniMax-M3"));
});

test("v0.29.17 wiring: model-valued settings use the fuzzy picker; unavailable auditor models fall back LOUDLY to the session model", () => {
  const SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  // The picker hosts via ctx.ui.custom over buildModelPickItems:
  // v0.31.2: the picker accepts strategy top-items (the auditor's "diverse").
  assert.match(SRC, /buildModelPickItems\(models, sessionLabel, extraTop\)/);
  assert.match(SRC, /new ModelPickerComponent\(\{ title, items \}/);
  // Configured-auth filter — a pick from the list can never be a dead provider:
  assert.match(SRC, /hasConfiguredAuth\(m\)/);
  // The old bare-input auditorModel editor is gone from the case body:
  const caseIdx = SRC.indexOf('case "auditorModel": {');
  const caseBody = SRC.slice(caseIdx, caseIdx + 1600);
  assert.match(caseBody, /promptModelRef\(ctx, "Auditor model override"/);
  assert.ok(!caseBody.includes("ctx.ui.input(\"Auditor model override\""), "typed input replaced by the picker");
  // Subagent model pins use the picker too:
  const pinIdx = SRC.indexOf('case "subagentModelOverrides.general-purpose": {');
  const pinBody = SRC.slice(pinIdx, pinIdx + 900);
  assert.match(pinBody, /promptModelRef\(ctx, `Model pin for \$\{agentType\} subagents`/);
  // Fallback: unavailable configured model → session model, notified + ledgered:
  assert.match(SRC, /auditor_model_fallback/);
  assert.match(SRC, /via: "session-fallback"/);
  assert.match(SRC, /falling back to the session model\. Fix via \/glla → Auditor model/);
  assert.match(SRC, /no configured auth for \$\{provider\}/, "unkeyed provider counts as unavailable");
});

test("v0.31.2: pickDiverseAuditorModel — reciprocal cross-vendor selection", () => {
  const models = [
    { provider: "minimax", id: "MiniMax-M3" },
    { provider: "openrouter", id: "ai21/jamba-large-1.7" },
    { provider: "openrouter", id: "deepseek/deepseek-chat-v3-0324" },
    { provider: "kimi", id: "k2" },
  ];
  // session on minimax → deepseek via openrouter first:
  assert.equal(pickDiverseAuditorModel(models, "minimax")!.id, "deepseek/deepseek-chat-v3-0324");
  // session on openrouter → MiniMax-M3 (openrouter excluded entirely):
  assert.equal(pickDiverseAuditorModel(models, "openrouter")!.id, "MiniMax-M3");
  // no deepseek → minimax next when session is on openrouter; session on
  // BOTH preference heads → first non-session provider:
  assert.equal(pickDiverseAuditorModel(models, "kimi")!.id, "deepseek/deepseek-chat-v3-0324");
  // nothing outside the session provider → undefined (caller falls back LOUDLY):
  assert.equal(pickDiverseAuditorModel([{ provider: "minimax", id: "MiniMax-M3" }], "minimax"), undefined);
  assert.equal(pickDiverseAuditorModel([], "minimax"), undefined);
  // preference table sanity: deepseek head, minimax second:
  assert.deepEqual(
    DIVERSE_AUDITOR_PREFERENCE.slice(0, 4).map((p) => `${p.provider}:${p.match ?? "*"}`),
    ["openrouter:deepseek/deepseek-chat", "openrouter:deepseek", "minimax:MiniMax-M3", "minimax:*"],
  );
});

test("v0.31.2: wiring — diverse branch in resolveAuditorModel + menu entry + loud fallback", () => {
  const SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  assert.match(SRC, /if \(trimmed\.toLowerCase\(\) === "diverse"\) \{/);
  assert.match(SRC, /pickDiverseAuditorModel\(available, sessionModel\?\.provider\)/);
  assert.match(SRC, /via: "diverse"/);
  assert.match(SRC, /configured: "diverse", reason: "no configured-auth model outside the session's provider"/);
  assert.match(SRC, /ref: "diverse",[\s\S]{0,300}?cross-vendor auditor: a different provider than the session/);
});

test("v0.31.2: auditor thinking defaults to sticky high — never the session dial", () => {
  const SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  assert.equal(SRC.match(/thinkingLevel: settings\.auditorThinkingLevel \?\? "high",/g)!.length, 2, "both audit call sites floor at high");
  assert.ok(!SRC.includes("getSessionThinkingLevel"), "the session-dial follower is gone");
  const MENU = fs.readFileSync("extensions/settings-menu.ts", "utf-8");
  assert.match(MENU, /high \(fixed — never the session coding dial\)/);
  const SETTINGS = fs.readFileSync("extensions/goal-settings.ts", "utf-8");
  assert.match(SETTINGS, /must NOT ride the session's coding-speed/);
});
