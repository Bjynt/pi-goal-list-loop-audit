#!/usr/bin/env node
// pi-goal-list-loop-audit — scripts/verify-auditor-extensions-offline.mjs
//
// Bounded live check for the auditor extension allowlist resolution
// (2026-08-22 audit finding): an allow-listed npm package extension must
// register its model providers in a `pi --no-extensions -e <resolved-path>`
// session with PI_OFFLINE=1, and must NOT trigger a temporary npm install
// into ~/.pi/agent/tmp/extensions (the failure mode of passing the raw
// `npm:<pkg>` spec verbatim).
//
// Exit 0 = verified; nonzero with a reason = failure. Bounded: every pi
// spawn is wrapped in `timeout`.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PI = process.env.PI_BIN ?? "pi";
const PKG = process.env.GLLA_LIVE_EXT_PKG ?? "pi-cursor-sdk";
const PROVIDER = process.env.GLLA_LIVE_EXT_PROVIDER ?? "cursor";

const resolved = path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", PKG);
if (!fs.existsSync(resolved)) {
  console.error(`SKIP: ${resolved} is not installed (install ${PKG} first)`);
  process.exit(0);
}

function listModels(extArg) {
  return execFileSync(
    "timeout",
    ["60", PI, "--no-extensions", "-e", extArg, "--list-models"],
    { env: { ...process.env, PI_OFFLINE: "1" }, encoding: "utf8" },
  );
}

const tmpExtensionsDir = path.join(os.homedir(), ".pi", "agent", "tmp", "extensions");
const tmpBefore = fs.existsSync(tmpExtensionsDir);

// 1. Resolved install path registers the extension's model providers offline.
const out = listModels(resolved);
const providerModels = out
  .split("\n")
  .filter((line) => line.startsWith(PROVIDER) && /\s/.test(line)).length;
if (providerModels === 0) {
  console.error(`FAIL: -e ${resolved} registered 0 ${PROVIDER} models offline`);
  process.exit(1);
}
console.log(`OK: -e <resolved-path> registered ${providerModels} ${PROVIDER} models offline (PI_OFFLINE=1)`);

// 2. No temporary extension install directory was created by the spawn.
const tmpAfter = fs.existsSync(tmpExtensionsDir);
if (!tmpBefore && tmpAfter) {
  console.error("FAIL: a temporary extension install directory was created during the spawn");
  process.exit(1);
}
console.log("OK: no temporary extension install directory created");

console.log(`VERIFIED offline auditor extension loading via resolved path: ${resolved}`);
