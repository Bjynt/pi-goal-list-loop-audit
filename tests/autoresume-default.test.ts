// pi-goal-list-loop-audit — v0.26.8
// tests/autoresume-default.test.ts
//
// "Auto on — we just keep pushing forward unless we are super stuck."
// The restore gate's default flipped from hold-fresh-sessions (v0.21.0)
// to auto-resume-everything. Explicit /glla autoresume=off preserves the
// old gate — so the off choice must PERSIST (undefined now means ON).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

const SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");

test("/glla autoresume=off persists explicit false (undefined = default ON)", () => {
  assert.match(SRC, /patch\.autoResume = false; \/\/ v0\.26\.8: explicit off must persist/);
  assert.doesNotMatch(SRC, /patch\.autoResume = undefined;/);
});

test("status display shows the new default honestly", () => {
  assert.match(SRC, /autoResume=\$\{effective\.autoResume === false \? "off" : "on \(default\)"\}/);
});

test("hold-on-restore text names the opt-out as the cause", () => {
  assert.match(SRC, /held because \/glla autoresume=off/);
  assert.doesNotMatch(SRC, /restored in a fresh session — no work started/);
});
