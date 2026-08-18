import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf-8")) as { version: string };

function dryRunFiles(): Set<string> {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf-8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const report = JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>;
  return new Set((report[0]?.files ?? []).map((file) => file.path));
}

test("v0.35.4: published documentation links are covered by the npm tarball", () => {
  const files = dryRunFiles();
  for (const required of ["README.md", "INSTALL.md", "CHANGELOG.md", "docs/INDEX.md", "examples/example-objective.md"]) {
    assert.ok(files.has(required), `${required} must be shipped`);
  }
  const index = fs.readFileSync("docs/INDEX.md", "utf-8");
  for (const omitted of ["../PLAN.md", "../LIST-PHILOSOPHY.md", "../audit/INDEX.md"]) {
    assert.doesNotMatch(index, new RegExp(omitted.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")), `${omitted} must not be a broken package link`);
  }
});

test("v0.35.4: README version matches package metadata", () => {
  const readme = fs.readFileSync("README.md", "utf-8");
  assert.match(readme, new RegExp(`Current package version:\\*\\*.*v${packageJson.version.replaceAll(".", "\\.")}`));
});
