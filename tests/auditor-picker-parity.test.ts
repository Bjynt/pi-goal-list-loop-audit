// pi-goal-list-loop-audit — v0.35.24
// tests/auditor-picker-parity.test.ts
//
// note.md Next #1: auditor selection UX parity with the main agent selector.
//
// The auditor model picker (promptModelRef, driven by the /glla → Auditor
// model row) already persisted to exactly the key resolveAuditorModel reads
// (global `auditorModel`) — but unlike the main-agent flows it did NOT
// apply forbidden-models filtering: the list showed policy-blocked models
// and the typed escape hatch accepted them, producing pins the resolver
// silently skips at audit time. These tests pin BOTH contract halves:
//   1. the picker persists its selection where resolveAuditorModel reads it;
//   2. forbidden-models filtering applies — list-level (buildModelPickItems)
//      and typed-entry level (the editor refuses a policy match).

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { handleSettingChoice, resolveAuditorModel } from "../extensions/loops/goal-settings-ui.js";
import { buildModelPickItems } from "../extensions/model-picker.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

// The suite shares ONE global settings file across co-resident test files
// (module-level process env). Tests here write policy entries — restore a
// clean slate after each so sibling suites never see our fixtures.
const GLOBAL_SNAPSHOT_PATH = GLOBAL_SETTINGS_PATH + ".auditor-parity-backup";
beforeEachSnapshot();
function beforeEachSnapshot(): void {
  try { fs.copyFileSync(GLOBAL_SETTINGS_PATH, GLOBAL_SNAPSHOT_PATH); } catch { /* absent */ }
}
afterEach(() => {
  try { fs.copyFileSync(GLOBAL_SNAPSHOT_PATH, GLOBAL_SETTINGS_PATH); } catch { fs.rmSync(GLOBAL_SETTINGS_PATH, { force: true }); }
  fs.rmSync(GLOBAL_SNAPSHOT_PATH, { force: true });
});

function readGlobal(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(GLOBAL_SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** Minimal registry double: two configured models; resolveAuditorModel's
 * tryRef path needs find/hasConfiguredAuth/getAvailable. */
function fakeRegistry() {
  const models = [
    { provider: "openai", id: "gpt-5-mini", name: "gpt-5-mini" },
    { provider: "anthropic", id: "claude-sonnet", name: "claude-sonnet" },
    { provider: "minimax", id: "MiniMax-M3", name: "MiniMax-M3" },
  ];
  const find = (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id) ?? undefined;
  return {
    find,
    getAvailable: () => models,
    hasConfiguredAuth: () => true,
  };
}

function editorCtx(cwd: string): ExtensionContext {
  const ctx = {
    cwd,
    model: { provider: "minimax", id: "MiniMax-M3" },
    modelRegistry: fakeRegistry(),
    ui: {
      // Headless path: no custom shard → promptModelRef uses typed input.
      input: async (_title: string, _placeholder: string) => {
        throw new Error("input not stubbed");
      },
      notify: (_msg: string, _level?: string) => {},
      select: async () => "high",
    },
  };
  return ctx as unknown as ExtensionContext;
}

test("v0.35.24: the auditor picker persists its selection where resolveAuditorModel reads it", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({}));
  const cwd = "/tmp/glla-auditor-parity-" + Date.now();
  fs.mkdirSync(cwd + "/.pi-glla", { recursive: true });
  const ctx: any = editorCtx(cwd);
  ctx.ui.input = async () => "openai/gpt-5-mini";

  await handleSettingChoice("auditorModel", ctx);

  // The pin lands in the GLOBAL file under the exact key the resolver's
  // callers pass (settings.auditorModel → resolveAuditorModel first arg).
  assert.equal(readGlobal().auditorModel, "openai/gpt-5-mini");

  // Parity end-to-end: the resolver resolves THE pinned model, via=setting.
  const resolved = resolveAuditorModel(ctx, readGlobal().auditorModel as string);
  assert.equal(resolved.error, undefined);
  assert.equal(resolved.via, "setting");
  assert.deepEqual({ provider: resolved.model.provider, id: resolved.model.id }, { provider: "openai", id: "gpt-5-mini" });
});

test("v0.35.24: a typed forbidden ref is REFUSED by the auditor picker, never persisted", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ forbiddenModels: ["sonnet"] }));
  const cwd = "/tmp/glla-auditor-parity-fb-" + Date.now();
  fs.mkdirSync(cwd + "/.pi-glla", { recursive: true });
  const ctx: any = editorCtx(cwd);
  const warnings: string[] = [];
  ctx.ui.notify = (msg: string, level?: string) => { if (level === "warning") warnings.push(msg); };
  ctx.ui.input = async () => "anthropic/claude-sonnet";

  await handleSettingChoice("auditorModel", ctx);

  assert.equal(readGlobal().auditorModel, undefined, "a policy-matching pin is never saved");
  assert.ok(warnings.some((w) => w.includes("forbidden-models")), "the refusal names the policy");
  assert.ok(warnings.some((w) => w.includes("claude-sonnet")), "the refusal names the refused ref");
});

test("v0.35.24: the fallback-agent picker applies the same filtering", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ forbiddenModels: ["minimax"], auditorModelFallback: "keep/me" }));
  const cwd = "/tmp/glla-auditor-parity-fb2-" + Date.now();
  fs.mkdirSync(cwd + "/.pi-glla", { recursive: true });
  const ctx: any = editorCtx(cwd);
  ctx.ui.input = async () => "minimax/MiniMax-M3";

  await handleSettingChoice("auditorModelFallback", ctx);

  assert.equal(readGlobal().auditorModelFallback, "keep/me", "the forbidden ref did not overwrite the existing fallback pin");
});

test("v0.35.24: buildModelPickItems excludes forbidden refs for the auditor slot (list-level filter)", () => {
  const models = [
    { provider: "openai", id: "gpt-5-mini" },
    { provider: "anthropic", id: "claude-sonnet" },
    { provider: "minimax", id: "MiniMax-M3" },
  ];
  const items = buildModelPickItems(models as any, "pi session model", { excludeRefs: ["sonnet"] });
  const refs = items.map((i) => i.ref ?? "").join(" ");
  assert.ok(!refs.toLowerCase().includes("sonnet"), "policy-blocked models are absent from the picker list");
  assert.ok(refs.includes("gpt-5-mini"), "allowed models stay listed");

  // Without opts (legacy callers) nothing is filtered — the boundary lives
  // in the caller's explicit opt-in.
  const unfiltered = buildModelPickItems(models as any, "pi session model");
  assert.ok(unfiltered.map((i) => i.ref ?? "").join(" ").toLowerCase().includes("sonnet"));
});
