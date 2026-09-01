import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlyResetTerminalFlags,
  __testOnlyRunFanOutListAuditFindings,
} from "../extensions/loops/goal.js";
import { readState, setRuntimeSessionDir } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, tmpCwd } from "./harness/mock-pi.js";

const pi = new MockPi();
activate(pi.api);

function stateLine(goal: unknown): string {
  return JSON.stringify({
    type: "state",
    value: { goal, list: [], loop: null },
    at: new Date().toISOString(),
  }) + "\n";
}

test("list-audit fan-out reads findings from the configured sessionDir root", async () => {
  const cwd = tmpCwd();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-list-audit-session-"));
  const globalSettings = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
  const priorGlobal = fs.readFileSync(globalSettings, "utf8");
  let ctx: ReturnType<typeof makeMockCtx> | undefined;
  try {
    __testOnlyResetOwnerSession();
    __testOnlyResetStaleFlag();
    __testOnlyResetTerminalFlags();
    fs.writeFileSync(globalSettings, JSON.stringify({ stateRoot: "sessionDir" }));
    const stateDir = path.join(sessionDir, "pi-glla");
    const selectedFindings = path.join(stateDir, "audit-loop", "findings.md");
    fs.mkdirSync(path.dirname(selectedFindings), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "settings.json"), JSON.stringify({ autoAcceptDrafts: true }));
    fs.writeFileSync(path.join(stateDir, "active.jsonl"), stateLine(seedGoal({ status: "paused" })));
    fs.writeFileSync(selectedFindings, "- [ ] FIX: HIGH: selected-root finding (selected.ts:1)\n");

    // A cwd-local decoy proves the old direct `<cwd>/.pi-glla` read is not
    // accidentally still feeding the fan-out.
    const cwdDecoy = path.join(cwd, ".pi-glla", "audit-loop", "findings.md");
    fs.mkdirSync(path.dirname(cwdDecoy), { recursive: true });
    fs.writeFileSync(cwdDecoy, "- [ ] FIX: HIGH: cwd-decoy finding (wrong.ts:1)\n");

    ctx = makeMockCtx(cwd, {
      sessionManager: {
        name: "list-audit-session-manager",
        getSessionId: () => "list-audit-session",
        getSessionDir: () => sessionDir,
      },
    });
    await pi.fire("session_start", { reason: "startup" }, ctx);
    await __testOnlyRunFanOutListAuditFindings(cwd);

    const after = readState(cwd);
    assert.equal(after.list?.length, 1, "the selected-root finding is queued");
    assert.match(after.list?.[0]?.objective ?? "", /selected-root finding/);
    assert.doesNotMatch(after.list?.[0]?.objective ?? "", /cwd-decoy/);
    assert.ok(fs.existsSync(path.join(stateDir, "goals", `${after.list?.[0]?.id}.queue.json`)), "the queued sidecar stays in sessionDir");
  } finally {
    if (ctx) {
      try { await pi.fire("session_shutdown", { reason: "quit" }, ctx); } catch { /* test cleanup */ }
    }
    __testOnlyResetOwnerSession();
    __testOnlyResetStaleFlag();
    __testOnlyResetTerminalFlags();
    setRuntimeSessionDir(undefined);
    fs.writeFileSync(globalSettings, priorGlobal);
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
