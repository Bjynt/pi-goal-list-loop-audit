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

process.env.GLLA_GLOBAL_SETTINGS_PATH ??= path.join(
  os.tmpdir(),
  `glla-test-global-settings-${process.pid}.json`,
);

// v0.34.12: the eager continuation settles 2.5s past agent_end in production
// (pi's turn-teardown blackhole window); tests flush with tick() and must not
// wait real seconds — zero the settle for the whole suite.
process.env.GLLA_EAGER_SETTLE_MS ??= "0";
