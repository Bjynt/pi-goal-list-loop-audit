import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { isFreshPastTimestamp } from "../extensions/goal-loop-core.js";
import { consumeRecoveryResume } from "../extensions/goal-recovery.js";
import { tmpCwd } from "./harness/mock-pi.js";

const WINDOW_MS = 300_000;

test("freshness markers reject future timestamps while accepting recent past timestamps", () => {
  const now = Date.parse("2026-09-01T18:00:00.000Z");
  assert.equal(isFreshPastTimestamp(now - 1_000, WINDOW_MS, now), true);
  assert.equal(isFreshPastTimestamp(now, WINDOW_MS, now), true);
  assert.equal(isFreshPastTimestamp(now + 1, WINDOW_MS, now), false);
  assert.equal(isFreshPastTimestamp(now + 365 * 24 * 60 * 60_000, WINDOW_MS, now), false);
  assert.equal(isFreshPastTimestamp(now - WINDOW_MS, WINDOW_MS, now), false);
});

test("recovery-resume consumes but refuses a future-dated sidecar", () => {
  const cwd = tmpCwd();
  const dir = path.join(cwd, ".pi-glla");
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, "recovery-resume.json");
  fs.writeFileSync(marker, JSON.stringify({ at: new Date(Date.now() + 60_000).toISOString() }));
  assert.equal(consumeRecoveryResume(cwd), false);
  assert.equal(fs.existsSync(marker), false, "invalid one-shot markers are consumed rather than replayed");
});

test("all restart sidecar validators use the non-negative-age freshness gate", () => {
  const recovery = fs.readFileSync(path.resolve("extensions/goal-recovery.ts"), "utf8");
  const session = fs.readFileSync(path.resolve("extensions/loops/goal-session.ts"), "utf8");
  assert.match(recovery, /return isFreshPastTimestamp\(at, RECOVERY_RESUME_FRESH_MS\);/);
  assert.equal((session.match(/isFreshPastTimestamp\(/g) ?? []).length, 3, "handoff and both pending-list checks share the gate");
  assert.doesNotMatch(session, /Date\.now\(\) - (?:at|priorAt) < (?:SESSION_HANDOFF|PENDING_LIST_OPERATION)_FRESH_MS/);
});
