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
  assert.equal(classifyMainModelFailure("Token Plan rate limit reached (2062)").kind, "quota");
  assert.equal(classifyMainModelFailure("Token Plan rate limit reached (2062)").quotaSignal, "plan-quota");
  assert.equal(classifyMainModelFailure("429 Too Many Requests").kind, "rate-limit");
  assert.equal(classifyMainModelFailure("429 Too Many Requests").quotaSignal, "rate-limit");
  assert.equal(classifyMainModelFailure("429 rate limit exceeded").kind, "rate-limit");
  assert.equal(classifyMainModelFailure("429 usage limit").kind, "quota");
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
  // v0.34.63: the failure-driven envelope is hour-aligned — the next :00 of
  // the LOCAL clock hour (quota windows reset on the hour). Expected value
  // computed with the same local-time math so the pin is timezone-safe.
  const hourAligned = (nowMs: number) => {
    const next = new Date(nowMs);
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    return Math.max(1_000, next.getTime() - nowMs);
  };
  const nowMs = Date.parse("2026-08-07T01:18:01.930Z");
  const first = hourAligned(nowMs);
  assert.ok(first > 40 * 60_000 && first <= 60 * 60_000, `aligned first delay: ${first}`);
  // A pure no-hint request-rate wall gets one bounded eager backoff, then
  // joins the hourly reset slot instead of being called an account quota wall.
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("429 Too Many Requests"), 1, 15, nowMs), 5_000);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("429 Too Many Requests"), 2, 15, nowMs), first);
  // The upstream hint (a factual provider fact) still outranks the alignment:
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("429 rate limit; retry in 2 hours"), 1, 15, nowMs), 2 * 60 * 60_000);
  // v0.34.125: temporary-window prose is the same factual hint — a
  // "try again in 30 seconds" message must NOT park until the next hour
  // (note.md 2026-08-10 "we gave up and waited for a bigger reset").
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("429 Too Many Requests — try again in 30 seconds"), 1, 15, nowMs), 30_000);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("rate limit resets in 15 seconds"), 1, 15, nowMs), 15_000);
  // ...but an over-budget hint falls back to the bounded alignment:
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("429 rate limit; retry in 1 week"), 1, 15, nowMs), first);
  // v0.34.51: ONE uniform envelope — error text does not pick the cadence.
  // A plan wall waits the same hour boundary as a 503 or an auth failure;
  // the attempt number no longer shapes the delay either.
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("Token Plan rate limit reached (2062)"), 1, 15, nowMs), first);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("Token Plan rate limit reached (2062)"), 2, 15, nowMs), first);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("503 temporarily unavailable"), 1, 15, nowMs), first);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("insufficient credits — buy credits"), 1, 15, nowMs), first);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("401 invalid API key"), 1, 15, nowMs), first);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("mysterious provider prose with no hint"), 1, 15, nowMs), first);
  // ...and the upstream hint (a factual provider fact) still outranks it,
  // even on a plan wall:
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("Token Plan rate limit reached (2062); retry after 3 hours"), 1, 15, nowMs), 3 * 60 * 60_000);
  // Exact boundary math: a wall at 01:59:59 probes within ~2s of 02:00;
  // a wall just after 02:00 waits almost the full hour to 03:00.
  const justBefore = Date.parse("2026-08-07T01:59:59.900Z");
  assert.ok(mainModelFailureDelayMs(classifyMainModelFailure("weird prose"), 1, 15, justBefore) <= 2_000, "wall at :59:59 probes at the top of the hour");
  const justAfter = Date.parse("2026-08-07T02:00:00.100Z");
  const after = mainModelFailureDelayMs(classifyMainModelFailure("weird prose"), 1, 15, justAfter);
  assert.ok(after > 59 * 60_000 && after <= 60 * 60_000, `wall just after :00 waits to the next hour: ${after}`);
  assert.equal(mainModelAutoRetryUntil(Date.parse("2026-08-03T00:00:00Z")), "2026-08-04T00:00:00.000Z");
  assert.equal(modelRef({ provider: "openai", id: "gpt" }), "openai/gpt");
  assert.equal(modelRef({ provider: "openai" }), undefined);
});
