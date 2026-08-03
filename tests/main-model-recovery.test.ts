// Main-session model failover/recovery is pure policy; runtime switching is
// exercised by the orchestrator, while these tests pin the safe decisions.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  classifyMainModelFailure,
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
  assert.equal(classifyMainModelFailure("401 invalid API key").kind, "auth");
  assert.equal(classifyMainModelFailure("503 upstream overloaded").kind, "transient");
  assert.equal(classifyMainModelFailure("max_tokens exceeds context window").kind, "non-recoverable");
  assert.equal(classifyMainModelFailure("user aborted").kind, "non-recoverable");
});

test("main model recovery backs off without giving up", () => {
  assert.equal(mainModelRetryDelayMs(1, 15), 15 * 60_000);
  assert.equal(mainModelRetryDelayMs(2, 15), 30 * 60_000);
  assert.equal(mainModelRetryDelayMs(3, 15), 60 * 60_000);
  assert.equal(mainModelRetryDelayMs(20, 15), 60 * 60_000);
  assert.equal(modelRef({ provider: "openai", id: "gpt" }), "openai/gpt");
  assert.equal(modelRef({ provider: "openai" }), undefined);
});
