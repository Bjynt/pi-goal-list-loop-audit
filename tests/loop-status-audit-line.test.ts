// pi-goal-list-loop-audit — v0.38.46
// tests/loop-status-audit-line.test.ts
//
// /loop status loop-audit rendering contract (feat branch): the status
// renderer must surface the consumed verdict + disapproval streak, and the
// state stamp must happen at CONSUMPTION only — a dispatched-but-verdict-less
// audit must not present as "the last audit". cmdLoop is inline (no pi
// harness), so this pins the renderer/stamp contract by source text,
// matching the loop-finish.test.ts convention.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const loopSrc = fs.readFileSync(path.resolve("extensions", "goal-loop.ts"), "utf-8");
const auditorSrc = fs.readFileSync(path.resolve("extensions", "loops", "loop-auditor.ts"), "utf-8");

test("/loop status renders the loop-audit line gated on consumption state", () => {
  assert.match(
    loopSrc,
    /if \(loop\.lastLoopAuditIteration !== undefined\) \{/,
    "audit line is conditional: no audits yet means no line",
  );
  assert.match(loopSrc, /Loop audit: iter \$\{loop\.lastLoopAuditIteration\} → \$\{loop\.lastLoopAuditVerdict/);
  // Streak renders only while a disapproval is live, with the stop threshold.
  assert.match(loopSrc, /disapproval streak \$\{streak\}\/\$\{LOOP_AUDIT_STOP_STREAK\}/);
  assert.match(loopSrc, /import \{ maybeTriggerLoopAudit, LOOP_AUDIT_STOP_STREAK \} from "\.\/loops\/loop-auditor\.js";/);
});

test("the iteration+verdict stamp is consumed-side only — trigger no longer stamps", () => {
  // Exactly one assignment site each, both next to each other post-apply.
  const iterStamps = auditorSrc.match(/loop\.lastLoopAuditIteration = /g) ?? [];
  const verdictStamps = auditorSrc.match(/loop\.lastLoopAuditVerdict = /g) ?? [];
  assert.equal(iterStamps.length, 1, "single stamp site (was trigger-time too — the lie under stall/no-verdict)");
  assert.equal(verdictStamps.length, 1);
  // The trigger function must be free of state stamping.
  const trigger = auditorSrc.slice(
    auditorSrc.indexOf("export function maybeTriggerLoopAudit"),
    auditorSrc.indexOf("export function maybeTriggerLoopAudit") + 1400,
  );
  assert.ok(!trigger.includes("lastLoopAuditIteration"), "maybeTriggerLoopAudit must not stamp");
  // infra classes surface verbatim for the operator.
  assert.match(auditorSrc, /outcome === "infra" \? `infra:\$\{infrastructureClass \?\? "unknown"\}` : outcome/);
});

test("LoopState carries lastLoopAuditVerdict with consumption semantics", () => {
  const foreverSrc = fs.readFileSync(path.resolve("extensions", "goal-loop-forever.ts"), "utf-8");
  assert.match(foreverSrc, /lastLoopAuditVerdict\?: string;/);
  assert.match(foreverSrc, /stamped at consumption/);
});
