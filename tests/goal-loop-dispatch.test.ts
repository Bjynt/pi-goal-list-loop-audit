// v0.34.24 — accepted trigger is not a started turn.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  clearDispatchRecord,
  createContinuationDispatch,
  dispatchMatchesOwner,
  dispatchPromptMatches,
  dispatchTimedOut,
  persistDispatchRecord,
  readDispatchRecord,
  transitionDispatch,
} from "../extensions/goal-loop-dispatch.ts";

function cwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "glla-dispatch-"));
}

function record() {
  return createContinuationDispatch({
    id: "attempt-1",
    generation: 7,
    ownerSessionId: "session-1",
    kind: "goal",
    goalId: "goal-1",
    marker: "[GOAL CHECKPOINT goalId=goal-1]",
    resync: true,
    sentAt: 1_000,
  });
}

test("dispatch starts prepared and only accepted records can time out", () => {
  const prepared = record();
  assert.equal(prepared.phase, "prepared");
  assert.equal(dispatchTimedOut(prepared, 200_000, 150_000), false);
  const accepted = transitionDispatch(prepared, "accepted");
  assert.equal(dispatchTimedOut(accepted, 151_000, 150_000), true);
  assert.equal(dispatchTimedOut(accepted, 150_999, 150_000), false);
});

test("start proof is generation/owner-bound and prompt matching is exact to the attempt marker", () => {
  const r = record();
  assert.equal(dispatchMatchesOwner(r, 7, "session-1"), true);
  assert.equal(dispatchMatchesOwner(r, 8, "session-1"), false);
  assert.equal(dispatchMatchesOwner(r, 7, "session-2"), false);
  assert.equal(dispatchPromptMatches(r, "prefix [GOAL CHECKPOINT goalId=goal-1] suffix"), true);
  assert.equal(dispatchPromptMatches(r, "[GOAL CHECKPOINT goalId=other]"), false);
});

test("dispatch sidecar is atomic and recoverable across a session boundary", () => {
  const root = cwd();
  const r = transitionDispatch(record(), "accepted");
  assert.equal(persistDispatchRecord(root, r), true);
  assert.deepEqual(readDispatchRecord(root), r);
  assert.equal(clearDispatchRecord(root), true);
  assert.equal(readDispatchRecord(root), null);
});

test("corrupt or unknown sidecar records are ignored", () => {
  const root = cwd();
  const file = path.join(root, ".pi-glla", "continuation-dispatch.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 999, phase: "accepted" }));
  assert.equal(readDispatchRecord(root), null);
});
