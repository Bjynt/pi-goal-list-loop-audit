// pi-goal-list-loop-audit — v0.25.0
// tests/commit-survival-e2e.test.ts
//
// Eager-continuation contract item 32 (Section H): end-to-end "the agent's
// commit survives the daemon". This is ENV-GATED because it intentionally
// creates an empty probe commit in a real daemon-managed repository. The
// caller must provide that repository explicitly; creating a fresh mkdtemp
// repository here would make the test vacuous because no daemon watches it.
//
// Run the live check explicitly, for example:
//   GLLA_E2E_DAEMON=1 GLLA_E2E_DAEMON_REPO="$PWD" \
//     bun test tests/commit-survival-e2e.test.ts
//
// What it does when enabled:
//   1. require the supplied repository to be listed by dracon-sync
//   2. create an empty probe commit using the repository's configured identity
//   3. wait through the daemon's debounce window
//   4. assert the probe remains reachable from HEAD and no rewrite reflog entry
//      was added after it

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const ENABLED = process.env.GLLA_E2E_DAEMON === "1";
const DAEMON_REPO = process.env.GLLA_E2E_DAEMON_REPO;
const SKIP_REASON = !ENABLED
  ? "set GLLA_E2E_DAEMON=1 and GLLA_E2E_DAEMON_REPO to run against a watched repo"
  : !DAEMON_REPO
    ? "GLLA_E2E_DAEMON_REPO is required; a fresh temporary repo is never a valid daemon target"
    : false;
const DAEMON_SETTLE_MS = 12_000;

function run(cwd: string, command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function git(cwd: string, args: string[]): string {
  return run(cwd, "git", args);
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    run(cwd, "git", ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

function daemonWatches(repo: string): boolean {
  let report: { rows?: Array<{ repo?: string }> };
  try {
    report = JSON.parse(run(repo, "dracon-sync", ["repos", "--json"])) as { rows?: Array<{ repo?: string }> };
  } catch (error) {
    throw new Error(
      `GLLA_E2E_DAEMON=1 requires dracon-sync repos --json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return (report.rows ?? []).some((row) => row.repo !== undefined && path.resolve(row.repo) === repo);
}

test(
  "commit survives the auto-committer daemon (item 32, env-gated watched repo)",
  { skip: SKIP_REASON },
  async () => {
    const dir = path.resolve(DAEMON_REPO!);
    assert.ok(fs.existsSync(dir), `daemon repository does not exist: ${dir}`);
    assert.equal(
      path.resolve(git(dir, ["rev-parse", "--show-toplevel"])),
      dir,
      "GLLA_E2E_DAEMON_REPO must name a git worktree root",
    );
    assert.ok(
      daemonWatches(dir),
      `dracon-sync does not list ${dir}; refusing to run a vacuous daemon test`,
    );

    const before = git(dir, ["rev-parse", "HEAD"]);
    // No temporary repository and no local identity override: this probe is
    // deliberately made in the repository the daemon actually watches.
    git(dir, ["commit", "--allow-empty", "-m", `glla daemon survival probe ${Date.now()}`]);
    const probe = git(dir, ["rev-parse", "HEAD"]);
    assert.notEqual(probe, before, "probe commit did not advance HEAD");

    const deadline = Date.now() + DAEMON_SETTLE_MS;
    while (Date.now() < deadline) {
      const head = git(dir, ["rev-parse", "HEAD"]);
      assert.ok(
        isAncestor(dir, probe, head),
        `daemon rewrote away probe commit ${probe}; current HEAD is ${head}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const head = git(dir, ["rev-parse", "HEAD"]);
    assert.ok(isAncestor(dir, probe, head), `probe ${probe} is not reachable from final HEAD ${head}`);

    const reflog = git(dir, ["reflog", "--date=iso", "--format=%H %gs"]);
    const lines = reflog.split("\n").filter(Boolean);
    const probeIndex = lines.findIndex((line) => line.startsWith(`${probe} `));
    assert.ok(probeIndex >= 0, `probe ${probe} is missing from the reflog`);
    const newerEntries = lines.slice(0, probeIndex).join("\n");
    assert.doesNotMatch(
      newerEntries,
      /filter-branch|filter-repo/i,
      "a history-rewrite command appeared after the probe commit",
    );
  },
);
