/**
 * pi-goal-list-loop-audit — v0.36.x
 * Proactive drafting pre-read — bounded evidence before first question
 */

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlyResetTerminalFlags,
} from "../extensions/loops/goal.js";
import { gatherProactivePreRead, PROACTIVE_MAX_FILES, PROACTIVE_MAX_CHARS_PER_FILE } from "../extensions/proactive-pre-read.js";
import { MockPi, makeMockCtx, seedState, tmpCwd } from "./harness/mock-pi.js";

const pi = new MockPi();
activate(pi.api);

afterEach(() => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnerSession();
});

test("gatherProactivePreRead surfaces bounded file evidence and seed excerpt before questioning", () => {
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, "audit"), { recursive: true });
  const content = "INDEX MARKER 42 " + "x".repeat(2000);
  fs.writeFileSync(path.join(cwd, "audit", "INDEX.md"), content);
  const seed = "Fix audit gap referencing audit/INDEX.md — claims provided";
  const block = gatherProactivePreRead(seed, cwd);
  assert.ok(block, "block produced");
  assert.match(block!, /PROACTIVE PRE-READ/, "header present");
  assert.match(block!, /audit\/INDEX\.md/, "candidate surfaced");
  assert.match(block!, /INDEX MARKER 42/, "snippet included, not dropped");
  assert.match(block!, /Seed excerpt/, "seed excerpt pinned even with file hit");
  // Bounded — first 800 chars only
  assert.ok(block!.length <= 2800, `total bounded ${block!.length}`);
  // The file's 2000 x tail should be truncated (header 800 chars)
  assert.doesNotMatch(block!, /x{1000}/ as RegExp, "truncated, not full 2000");
});

test("gatherProactivePreRead notes image references without assuming an external tool", () => {
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, "pics"), { recursive: true });
  // No actual image file needed — reference alone is enough.
  const seed = "Visual bug in /tmp/pics/Screenshot_20260829_223257.png — see picture";
  const block = gatherProactivePreRead(seed, cwd);
  assert.ok(block);
  assert.match(block!, /Image reference/, "image note");
  assert.match(block!, /native vision when supported/i, "native vision is preferred");
  assert.match(block!, /confirmed external provider/i, "external vision is opt-in");
  assert.doesNotMatch(block!, /mmx vision describe/, "MMX is not assumed by pre-read");
  assert.match(block!, /PROACTIVE PRE-READ/);
});

test("gatherProactivePreRead still emits a seed-excerpt block when no files match", () => {
  const cwd = tmpCwd();
  const seed = "Generic claim without a file path that still should be pre-read";
  const block = gatherProactivePreRead(seed, cwd);
  assert.ok(block);
  assert.match(block!, /PROACTIVE PRE-READ/);
  assert.match(block!, /Seed excerpt/);
  assert.match(block!, /Generic claim/);
});

test("drafting injects proactive pre-read before the first question", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: null, list: [] });
  fs.mkdirSync(path.join(cwd, "audit"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "audit", "INDEX.md"), "DRAFT EVIDENCE 99 — unique");
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "host", getSessionFile: () => path.join(cwd, "host.jsonl"), getSessionId: () => "host-1" } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  pi.userMessages.length = 0;
  // Seed contains a file path — drafting should pre-read it before asking.
  await pi.command("goal", "investigate audit/INDEX.md — see evidence", ctx);
  const delivered = pi.userMessages.map((m) => m.message).join("\n---\n");
  assert.match(delivered, /PROACTIVE PRE-READ/, "drafting prompt carries the pre-read block");
  assert.match(delivered, /DRAFT EVIDENCE 99/, "file snippet reached the agent before first question");
  assert.match(delivered, /Seed excerpt/, "seed excerpt also present");
  // No model switch was triggered — modelSelections stays independent of drafting
  // (the helper does not call setModel).
  await pi.fire("session_shutdown", { reason: "quit" }, ctx).catch(() => {});
});

test("constants retain bounded shape (max 3 files, 800 chars each)", () => {
  assert.equal(PROACTIVE_MAX_FILES, 3);
  assert.equal(PROACTIVE_MAX_CHARS_PER_FILE, 800);
});
