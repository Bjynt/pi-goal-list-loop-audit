// pi-goal-list-loop-audit — v0.28.18
// tests/harness/setup.ts
//
// bun test preload (bunfig.toml [test].preload) — runs BEFORE any test file's
// imports in every test process. Points the GLOBAL settings path at a
// per-process tmp file so the suite is hermetic from the developer's real
// ~/.pi/agent/pi-goal-list-loop-audit.settings.json. (Exposed 2026-07-29:
// setting autoAcceptDrafts globally on the dev rig made the draft-Confirm
// behavioral tests auto-accept and fail.)

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

process.env.GLLA_GLOBAL_SETTINGS_PATH ??= path.join(
  os.tmpdir(),
  `glla-test-global-settings-${process.pid}.json`,
);

// v0.34.139: bun test runs every file through the SAME worker process under
// --max-concurrency=1, so the pid-scoped settings path above is shared by
// all files in one run (verified: one glla-test-global-settings-*.json for
// the whole suite). A test that writes autoResume:true (e.g.
// repro-list-audit-activation) therefore poisons every LATER file unless
// discovery order happens to run it last — CI's readdir order differs from
// a dev machine, which surfaced as hegemon-queue-unblock-evidence creating
// a repair goal after the poisoned session_start auto-activation. This
// preload runs before EACH test file (verified), so resetting the shared
// file here makes the suite hermetic regardless of file order. Tests that
// need a setting write it at module scope, after this reset.
fs.writeFileSync(process.env.GLLA_GLOBAL_SETTINGS_PATH, "{}");

// v0.34.12: the eager continuation settles 2.5s past agent_end in production
// (pi's turn-teardown blackhole window); tests flush with tick() and must not
// wait real seconds — zero the settle for the whole suite.
process.env.GLLA_EAGER_SETTLE_MS ??= "0";
