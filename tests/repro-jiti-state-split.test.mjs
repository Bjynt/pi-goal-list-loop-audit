/**
 * REGRESSION TEST — jiti `export let state` binding split (incident 2026-08-09/10)
 *
 * pi's extension loader (jiti 2.7.0, moduleCache:false) compiles
 * `export let state` with a captured-value export binding: after
 * `replaceState(next)` (which did `state = next`), every importer of the
 * `state` binding kept the ORIGINAL object, so persistStateLine serialized
 * a frozen first-read state. Ledger showed `list_queue_disk_first` +
 * `list_imported` but the persisted `state` line never gained the item and
 * NO goal ever activated. bun (the harness) and node keep live bindings, so
 * the 1209-test suite could not catch it — this test MUST run under NODE
 * with the real jiti loader:
 *
 *   node tests/repro-jiti-state-split.test.mjs
 *
 * (GLLA_EXT_PATH may point at a different extension root, e.g. a scratch
 * copy, to prove the test fails on the pre-fix code.)
 *
 * Fix: goal-state.ts now exports `const state` and replaceState() mutates
 * the object IN PLACE — every imported binding stays current under any
 * loader by construction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const EXT = process.env.GLLA_EXT_PATH ?? new URL("..", import.meta.url).pathname;
const ROOT = new URL("..", import.meta.url).pathname;
const NODE_MODULES = path.join(ROOT, "node_modules");

process.env.GLLA_GLOBAL_SETTINGS_PATH ??= path.join(
  os.tmpdir(),
  `glla-jiti-split-${process.pid}.json`,
);
fs.writeFileSync(process.env.GLLA_GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true }));

const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-tui": `${NODE_MODULES}/@earendil-works/pi-tui`,
    "@earendil-works/pi-coding-agent": `${NODE_MODULES}/@earendil-works/pi-coding-agent`,
  },
});

test("jiti: /list audit enqueues, persists the item, and ACTIVATES (state binding not split)", async (t) => {
  const { MockPi, makeMockCtx, tmpCwd } = await jiti.import(
    `${ROOT}/tests/harness/mock-pi.ts`,
  );
  const pi = new MockPi();
  const activate = await jiti.import(`${EXT}/extensions/loops/goal.ts`, {
    default: true,
  });
  activate(pi.api);

  const cwd = tmpCwd();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "main-session-manager" } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await pi.fire("session_shutdown", { reason: "resume" }, ctx);
  await pi.fire("session_start", { reason: "resume" }, ctx);

  await pi.command("list", "audit", ctx);

  const ledger = fs
    .readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const states = ledger.filter((e) => e.type === "state").map((e) => e.value);
  assert.ok(states.length > 0, "expected at least one persisted state line");

  // The enqueue's persist must carry the new item (listlen 1), NOT a frozen
  // empty list — this was the exact live failure signature.
  const enqueueState = states.find((s) => (s.list?.length ?? 0) > 0);
  assert.ok(enqueueState, `enqueue state line must contain the item, got: ${JSON.stringify(states)}`);
  assert.ok(
    enqueueState.list[0].objective.startsWith("[LIST-AUDIT-COLLECT]"),
    `unexpected queued objective: ${enqueueState.list[0].objective.slice(0, 60)}`,
  );

  // Activation must fire: goal_created + goal md file on disk.
  assert.ok(ledger.some((e) => e.type === "goal_created"), "goal_created expected after enqueue");
  const created = ledger.find((e) => e.type === "goal_created").value.goalId;
  assert.ok(fs.existsSync(path.join(cwd, ".pi-glla", "goals", `${created}.md`)), "goal md file must exist");

  // Post-activation state must show the goal, not a frozen null.
  const last = states[states.length - 1];
  assert.ok(last.goal, `final state must carry the active goal, got: ${JSON.stringify(last)}`);
});
