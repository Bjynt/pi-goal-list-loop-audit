import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { GOAL_RUNTIME_GLOBAL_NAMES } from "../extensions/loops/goal-runtime-globals.ts";

const BRIDGE = fs.readFileSync("extensions/loops/goal-runtime-globals.ts", "utf8");
const LOOP_DIR = "extensions/loops";

function namesFrom(pattern: RegExp, source: string): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]!).filter(Boolean);
}

test("runtime global bridge has one typed declaration for every registration", () => {
  const declared = namesFrom(/\bvar\s+([A-Za-z_$][A-Za-z0-9_$]*):\s+GoalRuntimeGlobals\["([^"]+)"\]/g, BRIDGE)
    .map((_, index, all) => all[index]!);
  // The declaration name and indexed type key are intentionally checked
  // separately because a typo in either side would otherwise look covered.
  const declarationPairs = [...BRIDGE.matchAll(/\bvar\s+([A-Za-z_$][A-Za-z0-9_$]*):\s+GoalRuntimeGlobals\["([^"]+)"\]/g)]
    .map((match) => [match[1]!, match[2]!] as const);
  assert.equal(declared.length, declarationPairs.length);
  assert.ok(declarationPairs.every(([name, key]) => name === key), "ambient name and registry key must match");

  const registrations = fs.readdirSync(LOOP_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => fs.readFileSync(path.join(LOOP_DIR, name), "utf8"))
    .flatMap((source) => namesFrom(/defineGoalRuntimeGlobal\("([^"]+)"/g, source));

  assert.equal(new Set(GOAL_RUNTIME_GLOBAL_NAMES).size, GOAL_RUNTIME_GLOBAL_NAMES.length, "registry has no duplicate names");
  assert.equal(new Set(declarationPairs.map(([, key]) => key)).size, declarationPairs.length, "ambient declarations have no duplicates");
  assert.deepEqual([...new Set(declarationPairs.map(([, key]) => key))].sort(), [...GOAL_RUNTIME_GLOBAL_NAMES].sort());
  assert.deepEqual([...new Set(registrations)].sort(), [...GOAL_RUNTIME_GLOBAL_NAMES].sort());
  assert.doesNotMatch(BRIDGE, /\bvar\s+[A-Za-z_$][A-Za-z0-9_$]*\s*:\s*any\b/, "ambient slots use the typed registry");
  assert.match(BRIDGE, /type GoalRuntimeFunction =/);
  assert.match(BRIDGE, /type RuntimeDataCoverage =/);
});
