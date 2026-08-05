// Main-session model failover/recovery is pure policy; runtime switching is
// exercised by the orchestrator, while these tests pin the safe decisions.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  classifyMainModelFailure,
  mainModelAutoRetryUntil,
  mainModelFailureDelayMs,
  mainModelRetryDelayMs,
  modelRef,
  nextUntriedModelRef,
  normalizeModelRefs,
  splitModelRef,
} from "../extensions/main-model-recovery.js";

test("main model refs preserve order, dedupe, and support nested model ids", () => {
  assert.deepEqual(normalizeModelRefs("openai/a, openrouter/provider/model;openai/a"), [
    "openai/a",
    "openrouter/provider/model",
  ]);
  assert.deepEqual(normalizeModelRefs(["x/a", " x/a ", "unset", 42]), ["x/a"]);
  assert.deepEqual(splitModelRef("openrouter/provider/model"), { provider: "openrouter", id: "provider/model" });
  assert.equal(splitModelRef("bare-model"), undefined);
});

test("main model fallback candidates are ordered and never retried in a cycle", () => {
  const refs = ["a/one", "b/two", "c/three"];
  assert.equal(nextUntriedModelRef("a/one", refs, ["a/one"]), "b/two");
  assert.equal(nextUntriedModelRef("b/two", refs, ["a/one", "b/two"]), "c/three");
  assert.equal(nextUntriedModelRef("c/three", refs, refs), undefined);
});

test("main model errors distinguish quota recovery from deterministic prompt walls", () => {
  assert.equal(classifyMainModelFailure("429 usage limit; retry in 2 hours").kind, "quota");
  assert.equal(classifyMainModelFailure("Token Plan usage limit reached").kind, "quota");
  assert.equal(classifyMainModelFailure("Token Plan rate limit reached (2062)").quotaSignal, "plan-quota");
  assert.equal(classifyMainModelFailure("429 Too Many Requests").quotaSignal, "rate-limit");
  assert.equal(classifyMainModelFailure("503 temporarily unavailable").kind, "transient");
  assert.equal(classifyMainModelFailure("insufficient credits — buy credits").kind, "billing");
  assert.equal(classifyMainModelFailure("401 invalid API key").kind, "auth");
  assert.equal(classifyMainModelFailure("503 upstream overloaded").kind, "transient");
  assert.equal(classifyMainModelFailure("max_tokens exceeds context window").kind, "non-recoverable");
  assert.equal(classifyMainModelFailure("user aborted").kind, "non-recoverable");
});

test("main model recovery backs off without giving up", () => {
  assert.equal(mainModelRetryDelayMs(1, 15), 15 * 60_000);
  assert.equal(mainModelRetryDelayMs(2, 15), 30 * 60_000);
  assert.equal(mainModelRetryDelayMs(3, 15), 60 * 60_000);
  assert.equal(mainModelRetryDelayMs(4, 15), 2 * 60 * 60_000);
  assert.equal(mainModelRetryDelayMs(5, 15), 4 * 60 * 60_000);
  assert.equal(mainModelRetryDelayMs(6, 15), 5 * 60 * 60_000);
  assert.equal(mainModelRetryDelayMs(20, 15), 5 * 60 * 60_000);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("429 rate limit; retry in 2 hours"), 1), 2 * 60 * 60_000);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("429 rate limit; retry in 1 week"), 1), 15 * 60_000);
  // v0.34.51: ONE uniform envelope — error text does not pick the cadence.
  // A plan wall starts at the same 15m base as a 503 or an auth failure.
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("Token Plan rate limit reached (2062)"), 1), 15 * 60_000);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("Token Plan rate limit reached (2062)"), 2), 30 * 60_000);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("503 temporarily unavailable"), 1), 15 * 60_000);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("insufficient credits — buy credits"), 1), 15 * 60_000);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("401 invalid API key"), 1), 15 * 60_000);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("mysterious provider prose with no hint"), 1), 15 * 60_000);
  // ...and the upstream hint (a factual provider fact) still outranks it,
  // even on a plan wall:
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("Token Plan rate limit reached (2062); retry after 3 hours"), 1), 3 * 60 * 60_000);
  assert.equal(mainModelAutoRetryUntil(Date.parse("2026-08-03T00:00:00Z")), "2026-08-04T00:00:00.000Z");
  assert.equal(modelRef({ provider: "openai", id: "gpt" }), "openai/gpt");
  assert.equal(modelRef({ provider: "openai" }), undefined);
});
