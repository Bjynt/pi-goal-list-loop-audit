// pi-goal-list-loop-audit — v0.34.57
// tests/loops/goal.test.ts
//
// The verification contract for the 150s continuation-start watchdog fix
// names `tests/loops/goal.test.ts` as the home for the watchdog regression
// tests. This file holds the v0.34.57 watchdog tests:
//
//   - "v0.34.57: a compaction inside the watchdog window pauses the watchdog
//     instead of firing the unacknowledged warning"
//   - "v0.34.57: a genuine stall (no compaction in the window) still fires
//     the unacknowledged warning"
//
// Behavior pinned by the companion code at extensions/loops/goal.ts:
//   - the 150s continuation-start watchdog re-arms when a compaction event
//     lands after the dispatch was accepted
//   - the re-arm is bounded by COMPACTION_REARM_CAP (3) so a stuck session
//     cannot loop forever
//   - the genuine-stall warning still fires when no compaction event is
//     observed in the watchdog window
//   - the new ledger event `continuation_start_paused_for_compaction`
//     records each re-arm for observability
//
// Field: 115855/115858/115901 screenshots — the 150s watchdog fired while
// the session was still mid-compact; the work was completed on disk but
// the session handle was lost, producing a false-positive unacknowledged
// warning. The fix in this file's companion code path eliminates that
// false positive.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { MockPi, makeMockCtx, tmpCwd, tick, type MockCtx } from "../harness/mock-pi.js";
import activate, { __testOnlyResetStaleFlag, __testOnlySetContinuationStartTimeout, __testOnlySetLastCompactionAt } from "../../extensions/loops/goal.js";

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager" };

function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}

async function freshSession(cwd: string, reason: string): Promise<MockCtx> {
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason }, ctx);
  return ctx;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for watchdog state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(() => {
  __testOnlySetContinuationStartTimeout(null);
  __testOnlySetLastCompactionAt(null);
});

test("v0.34.57: a compaction inside the watchdog window pauses the watchdog instead of firing the unacknowledged warning", async () => {
  // Field (115855/115858/115901): the 150s continuation-start watchdog fires
  // while the session is still mid-compact; the work was completed on disk
  // but the session handle was lost, so the user saw the false-positive
  // warning. The watchdog must re-arm when a compaction event lands after
  // the dispatch was accepted, then fire unacknowledged only after the
  // re-arm cap is reached.
  __testOnlyResetStaleFlag();
  __testOnlySetContinuationStartTimeout(300);
  try {
    const cwd = tmpCwd();
    const ctx = await freshSession(cwd, "startup");
    pi.sent.length = 0;
    await pi.command("goal", "compaction recovery target — done when pinned", ctx);
    await tick();
    // Simulate a compaction event that lands AFTER the dispatch was accepted.
    // The session_compact handler sets lastCompactionAt; here we set it
    // directly to avoid the handler's full settle-probe side effects.
    __testOnlySetLastCompactionAt(Date.now());
    await waitUntil(() => {
      try {
        return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").includes("continuation_start_paused_for_compaction");
      } catch {
        return false;
      }
    }, 2_000);
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.match(ledger, /continuation_start_paused_for_compaction/, "the watchdog paused on the in-window compaction");
    assert.doesNotMatch(ledger, /continuation_start_unacknowledged/, "the false-positive unacknowledged warning must NOT fire");
    await pi.command("goal", "pause", ctx);
  } finally {
    __testOnlySetContinuationStartTimeout(null);
    __testOnlySetLastCompactionAt(null);
  }
});

test("v0.34.57: a genuine stall (no compaction in the window) still fires the unacknowledged warning", async () => {
  __testOnlyResetStaleFlag();
  __testOnlySetContinuationStartTimeout(300);
  try {
    const cwd = tmpCwd();
    const ctx = await freshSession(cwd, "startup");
    pi.sent.length = 0;
    await pi.command("goal", "compaction recovery target — done when pinned", ctx);
    await tick();
    await waitUntil(() => {
      try {
        return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").includes("continuation_start_unacknowledged");
      } catch {
        return false;
      }
    }, 2_000);
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.match(ledger, /continuation_start_unacknowledged/, "the unacknowledged warning still fires for a genuine stall");
    assert.doesNotMatch(ledger, /continuation_start_paused_for_compaction/, "no pause is recorded when there was no compaction");
    await pi.command("goal", "pause", ctx);
  } finally {
    __testOnlySetContinuationStartTimeout(null);
    __testOnlySetLastCompactionAt(null);
  }
});
