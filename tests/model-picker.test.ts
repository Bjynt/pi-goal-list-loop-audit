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

import { buildModelPickItems, ModelPickerComponent } from "../extensions/model-picker.ts";

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
  assert.match(SRC, /buildModelPickItems\(models, sessionLabel\)/);
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

test("v0.31.2/0.31.3: auditor thinking defaults to sticky high — never the session dial", () => {
  const SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  assert.equal(SRC.match(/thinkingLevel: settings\.auditorThinkingLevel \?\? "high",/g)!.length, 2, "both audit call sites floor at high");
  assert.ok(!SRC.includes("getSessionThinkingLevel"), "the session-dial follower is gone");
  const MENU = fs.readFileSync("extensions/settings-menu.ts", "utf-8");
  // v0.31.4: no standalone thinking ROW — thinking is chained into the
  // Auditor model drill-in ("we are setting the thinking when we select
  // the model"); terse valueTexts: "session model" / "none".
  assert.ok(!MENU.includes('id: "auditorThinkingLevel"'), "standalone thinking row removed");
  assert.match(MENU, /valueText: show\("auditorModel", "session model"\)/);
  // v0.31.5: unset fallback displays as what it semantically IS — the
  // cascade's last rung ("maybe have a def fallback to session").
  assert.match(MENU, /valueText: show\("auditorModelFallback", "session model \(last resort\)"\)/);
  const caseIdx2 = SRC.indexOf('case "auditorModel": {');
  assert.match(SRC.slice(caseIdx2, caseIdx2 + 1500), /Auditor thinking — ISOLATED auditor session ONLY/);
  assert.ok(!SRC.includes('case "auditorThinkingLevel"'), "dead menu case removed");
  const SETTINGS = fs.readFileSync("extensions/goal-settings.ts", "utf-8");
  assert.match(SETTINGS, /must NOT ride the session's coding-speed/);
});

test("v0.31.3: the auditor chain — pinned primary → pinned fallback → session LAST; same-as-session auto-swap", () => {
  const SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  // The cascade: two pins walked in order, session model after the loop:
  assert.match(SRC, /const pins = \[ref, fallbackRef\]/);
  assert.match(SRC, /via: i === 0 \? "setting" : "fallback-pin"/);
  assert.match(SRC, /All pinned auditor models are unavailable — falling back to the session model/);
  // Same-as-session swap (the user's move): swap only when a next pin exists;
  // last-pin == session stands with one loud nudge. v0.31.6: both gated on
  // the auditorSameSessionSwap toggle (default ON).
  assert.match(SRC, /if \(sameSessionSwap && isSession\(r\.model\) && i \+ 1 < pins\.length\) \{/);
  assert.match(SRC, /auditor_model_same_as_session/);
  assert.match(SRC, /pin a different \/glla → Auditor fallback model so the verifier can differ/);
  // Both audit call sites pass the fallback pin (v0.31.6: + the swap toggle):
  assert.match(SRC, /resolveAuditorModel\(liveCtx, settings\.auditorModel, settings\.auditorModelFallback, settings\.auditorSameSessionSwap !== false\)/);
  assert.match(SRC, /resolveAuditorModel\(ctx, settings\.auditorModel, settings\.auditorModelFallback, settings\.auditorSameSessionSwap !== false\)/);
  // The settings key + menu row + editor case:
  const SETTINGS = fs.readFileSync("extensions/goal-settings.ts", "utf-8");
  assert.match(SETTINGS, /auditorModelFallback\?: string;/);
  const MENU = fs.readFileSync("extensions/settings-menu.ts", "utf-8");
  assert.match(MENU, /id: "auditorModelFallback"/);
  assert.match(MENU, /section: "auditor",[\s\S]{0,200}?Auditor fallback model/);
  assert.match(SRC, /case "auditorModelFallback": \{/);
  // The v0.31.2 "diverse" machinery is gone (complexity cost > benefit):
  assert.ok(!SRC.includes("pickDiverseAuditorModel") && !SRC.includes('"diverse"'), "diverse strategy removed");
});

test("v0.31.6: same-model swap toggle — default ON, off = same-model audits stand", () => {
  const SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  assert.match(SRC, /sameSessionSwap = true\): \{ model: any; error\?: string; via\?: string \}/);
  assert.equal(SRC.match(/settings\.auditorSameSessionSwap !== false/g)!.length, 2, "both audit call sites pass the toggle (undefined = on)");
  assert.match(SRC, /if \(sameSessionSwap && isSession\(r\.model\) && !fallbackRef\?\.trim\(\)\) \{/);
  assert.match(SRC, /case "auditorSameSessionSwap": \{/);
  assert.match(SRC, /off — same-model audits stand \(you accept the executor's model as its own verifier/);
  const SETTINGS = fs.readFileSync("extensions/goal-settings.ts", "utf-8");
  assert.match(SETTINGS, /auditorSameSessionSwap\?: boolean;/);
  assert.match(SETTINGS, /Default ON \(undefined\)/);
  const MENU = fs.readFileSync("extensions/settings-menu.ts", "utf-8");
  assert.match(MENU, /id: "auditorSameSessionSwap"/);
  assert.match(MENU, /valueText: show\("auditorSameSessionSwap", "on"\)/);
});
