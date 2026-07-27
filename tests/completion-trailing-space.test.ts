// pi-goal-list-loop-audit — v0.27.4
// tests/completion-trailing-space.test.ts
//
// Pi's applyCompletion does NOT add a trailing space for argument
// completions (it does for the top-level /goal itself). glla's subcommand
// items now include a trailing space in `value` (label stays clean) so the
// user can type the argument immediately — no more `/goal startasdahlasf`.
// Key=value items (ending in `=`) keep no space because the user types the
// value right after the `=`.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

const SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");

function buildFactory(): (items: Array<[string, string]>) => (prefix: string) => Array<{ value: string; label: string; description: string }> {
  const match = SRC.match(/const completions = \(items[^]*?return items[^]*?\n\s+\}\);/);
  if (!match) throw new Error("could not locate completions factory");
  // Strip the TS type annotation and evaluate as plain JS.
  const js = match[0].replace(/^const completions = /, "return ").replace(/: Array<\[string, string\]> =>/, " =>").replace(/\): Array<\{[^}]*\}>/, ")");
  // eslint-disable-next-line no-new-func
  return new Function(js)() as ReturnType<typeof buildFactory>;
}

test("subcommand items get a trailing space in value, label stays clean", () => {
  const factory = buildFactory();
  const f = factory([
    ["start", "skip drafting"],
    ["status", "show status"],
    ["tweak", "narrow the goal"],
    ["cancel", "abort"],
  ]);
  assert.deepEqual(f("s"), [
    { value: "start ", label: "start", description: "skip drafting" },
    { value: "status ", label: "status", description: "show status" },
  ]);
  assert.deepEqual(f(""), [
    { value: "start ", label: "start", description: "skip drafting" },
    { value: "status ", label: "status", description: "show status" },
    { value: "tweak ", label: "tweak", description: "narrow the goal" },
    { value: "cancel ", label: "cancel", description: "abort" },
  ]);
});

test("key=value items get NO trailing space (user types the value right after the =)", () => {
  const factory = buildFactory();
  const f = factory([
    ["model=", "auditor model override"],
    ["thinking=", "auditor thinking level"],
    ["notify=", "desktop push command"],
  ]);
  assert.deepEqual(f("m"), [{ value: "model=", label: "model=", description: "auditor model override" }]);
  assert.deepEqual(f(""), [
    { value: "model=", label: "model=", description: "auditor model override" },
    { value: "thinking=", label: "thinking=", description: "auditor thinking level" },
    { value: "notify=", label: "notify=", description: "desktop push command" },
  ]);
});

test("mixed list (bare commands + key=value) — the asymmetric rule", () => {
  const factory = buildFactory();
  const f = factory([
    ["stats", "ledger rollups"],
    ["audits", "audit-log browser"],
    ["autoaccept=", "on: drafts activate without Confirm"],
    ["model=", "auditor model override"],
  ]);
  assert.deepEqual(f(""), [
    { value: "stats ", label: "stats", description: "ledger rollups" },
    { value: "audits ", label: "audits", description: "audit-log browser" },
    { value: "autoaccept=", label: "autoaccept=", description: "on: drafts activate without Confirm" },
    { value: "model=", label: "model=", description: "auditor model override" },
  ]);
});

test("filter still case-sensitive and prefix-based (no other behavior change)", () => {
  const factory = buildFactory();
  const f = factory([["start", "a"], ["status", "b"], ["resume", "c"]]);
  assert.equal(f("st").length, 2);
  assert.equal(f("ST").length, 0, "case-sensitive filter (pre-existing behavior)");
  assert.equal(f("s").length, 3);
  assert.equal(f("xyz").length, 0);
});

test("registerCommand: /goal, /glla, /list, /loop all use the shared factory", () => {
  for (const cmd of ["goal", "glla", "list", "loop"]) {
    const m = SRC.match(new RegExp(`pi\\.registerCommand\\("${cmd}"[\\s\\S]+?getArgumentCompletions: completions\\(`));
    assert.ok(m, `${cmd} registers with the completions factory`);
  }
});
