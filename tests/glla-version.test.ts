import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "glla-version-audit-"));

import { compareVersions, formatGllaVersion, readGllaVersionInfo, updateCheckPath } from "../extensions/glla-version.js";

const PACKAGE = JSON.parse(fs.readFileSync("package.json", "utf8")) as { name: string; version: string };
const LOCK = JSON.parse(fs.readFileSync("package-lock.json", "utf8")) as {
  name: string;
  version: string;
  packages?: { "": { name: string; version: string } };
};
const ACTIVATION = fs.readFileSync("extensions/loops/goal-activation.ts", "utf8");
const COMMANDS = fs.readFileSync("extensions/goal-commands.ts", "utf8");

test("/glla version reads the installed package metadata and exposes a registry check", () => {
  const info = readGllaVersionInfo();
  assert.deepEqual(info, { name: PACKAGE.name, version: PACKAGE.version });
  assert.match(formatGllaVersion(undefined, info), new RegExp(`${PACKAGE.name} v${PACKAGE.version}`));
  assert.match(formatGllaVersion(undefined, info), /npm view pi-goal-list-loop-audit version/);
});

test("/glla version names staleness and the update path when the sidecar proves it", () => {
  const dir = fs.mkdtempSync("/tmp/glla-version-cmd-");
  fs.mkdirSync(`${dir}/.pi-glla`, { recursive: true });
  fs.writeFileSync(`${dir}/.pi-glla/update-check.json`, JSON.stringify({ latest: "99.0.0", checkedAt: Date.now() }));
  const out = formatGllaVersion(dir, { name: PACKAGE.name, version: "0.0.0" });
  assert.match(out, /Registry latest: v99\.0\.0\./);
  assert.match(out, /stale — update: pi install npm:pi-goal-list-loop-audit@latest then \/reload\./);
  const fresh = formatGllaVersion(dir, { name: PACKAGE.name, version: "99.0.0" });
  assert.match(fresh, /up to date/);
});

test("package and lock metadata stay synchronized for version reporting", () => {
  assert.equal(LOCK.name, PACKAGE.name);
  assert.equal(LOCK.version, PACKAGE.version);
  assert.equal(LOCK.packages?.[""].name, PACKAGE.name);
  assert.equal(LOCK.packages?.[""].version, PACKAGE.version);
});

test("/glla version is registered, autocompleted, and read-only routed", () => {
  assert.match(ACTIVATION, /\["version", "show the installed package version and registry check"\]/);
  assert.match(ACTIVATION, /`\/glla version` shows the installed package version/);
  assert.match(COMMANDS, /function cmdGllaVersion\(ctx: ExtensionContext\): void/);
  assert.match(COMMANDS, /if \(\/\^version\(\?:\\s\|\$\)\/.test\(trimmed\)\) \{\s*cmdGllaVersion\(ctx\);/);
  assert.match(COMMANDS, /ctx\.ui\.notify\(formatGllaVersion\(ctx\.cwd\), "info"\)/);
});

test("unknown running version makes no staleness claim either way", () => {
  const cwd = tmpRoot();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi-glla", "update-check.json"),
    JSON.stringify({ latest: "9.9.9", checkedAt: Date.now() }),
  );
  const out = formatGllaVersion(cwd, { name: "pi-goal-list-loop-audit", version: "unknown" });
  assert.ok(!/up to date/.test(out), "a damaged manifest never prints a false fresh verdict");
  assert.ok(!/stale/.test(out), "and never cries stale without a running version to compare");
});

test("compareVersions is strictly numeric: prereleases never equal releases", () => {
  assert.equal(compareVersions("1.2.3-beta", "1.2.3"), 0, "prerelease vs release is unknown, not equal");
  assert.equal(compareVersions("0.38.44", "0.38.44"), 0, "identical versions still equal");
  assert.equal(compareVersions("0.38.45", "0.38.44"), 1, "numeric ordering intact");
});

test("updateCheckPath defaults to the cwd state dir", () => {
  assert.equal(updateCheckPath("/tmp/some-cwd"), path.join("/tmp/some-cwd", ".pi-glla", "update-check.json"));
});
