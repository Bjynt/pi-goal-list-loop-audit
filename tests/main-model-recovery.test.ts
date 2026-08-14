// Main-session model failover/recovery is pure policy; runtime switching is
// exercised by the orchestrator, while these tests pin the safe decisions.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyMainModelFailure,
  isMainModelFallbackFailure,
  mainModelAutoRetryUntil,
  mainModelFailureDelayMs,
  mainModelRetryDelayMs,
  modelRef,
  nextUntriedModelRef,
  MAX_MAIN_MODEL_FALLBACKS,
  normalizeMainModelFallbackRefs,
  normalizeModelRefs,
  formatMainModelFallbacks,
  splitModelRef,
} from "../extensions/main-model-recovery.js";
import { createGoalRecovery, probeMainModelRecovery, tryMainModelFallback } from "../extensions/goal-recovery.js";
import { replaceState, state } from "../extensions/goal-state.js";
import { globalSettingsPath } from "../extensions/goal-settings.js";

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

test("main fallback settings dedupe case-insensitively and cap the chain at ten", () => {
  const input = [
    "provider/one", "PROVIDER/ONE", "provider/two", "provider/three", "provider/four",
    "provider/five", "provider/six", "provider/seven", "provider/eight", "provider/nine",
    "provider/ten", "provider/eleven", "provider/twelve",
  ];
  const refs = normalizeMainModelFallbackRefs(input);
  assert.equal(MAX_MAIN_MODEL_FALLBACKS, 10);
  assert.equal(refs.length, 10);
  assert.deepEqual(refs[0], "provider/one");
  assert.deepEqual(refs.at(-1), "provider/ten");
  assert.equal(refs.some((ref) => /eleven|twelve/i.test(ref)), false, "the 11th and later rungs are not persisted");
});

test("runtime fallback walk uses one supervised model at a time and preserves left-to-right order", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-main-fallback-runtime-"));
  const settingsFile = globalSettingsPath();
  const original = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : undefined;
  const calls: string[] = [];
  const ctx: any = {
    cwd,
    model: { provider: "provider", id: "primary" },
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      hasConfiguredAuth: () => true,
    },
    ui: { notify: () => {} },
    abort: () => {},
  };
  const flags: any = {
    completionAuditRecoveryArmed: false,
    mainModelRecoveryTimer: null,
    mainModelSwitchInFlight: false,
    mainModelAbortForRecovery: false,
    lastMainModelFailure: null,
    hourlyProbeTimer: null,
    hourlyProbeFireAt: null,
    sessionGeneration: 1,
    extensionApi: { setModel: async (model: any) => { calls.push(`${model.provider}/${model.id}`); return true; } },
    extensionApiStale: false,
    continuationDispatchStoodDown: false,
    lastLongLivedFailureAt: 0,
    lastMainModelRecoveryResumeAt: 0,
  };
  try {
    fs.writeFileSync(settingsFile, JSON.stringify({
      mainModelFallbacks: ["provider/blocked", "provider/first", "provider/second"],
      forbiddenModels: ["blocked"],
    }));
    replaceState({ goal: null } as any);
    createGoalRecovery(flags, {
      activeGoalSurfaceCommand: (command: string) => `/${command}`,
      clearDetachedAuditRuntime: () => {},
      updateGoal: () => {},
      clearContinuationTimer: () => {},
      freshCtxForGeneration: (generation: number) => generation === flags.sessionGeneration ? ctx : null,
      isSupervising: () => true,
      notifyExternal: () => {},
      persistState: () => {},
      recoverySurfaceCommand: (_kind: "goal" | "loop", command: string) => `/${command}`,
      scheduleContinuation: () => {},
      scheduleSessionTimeout: () => setTimeout(() => {}, 60_000),
    });
    const accountFailure = classifyMainModelFailure("usage limit reached; switch billing");
    assert.equal(await tryMainModelFallback(ctx, accountFailure), true);
    assert.deepEqual(calls, ["provider/first"], "the first failure selects only the first eligible backup");
    assert.deepEqual(state.mainModelRecovery?.attempted, ["provider/primary", "provider/blocked", "provider/first"]);
    assert.deepEqual(state.mainModelRecovery?.skipped, [{ ref: "provider/blocked", reason: "forbidden" }]);
    assert.equal(state.mainModelRecovery?.skipped?.some((entry) => entry.ref === "provider/first"), false, "the selected backup is not labelled skipped");

    ctx.model = { provider: "provider", id: "first" };
    assert.equal(await tryMainModelFallback(ctx, accountFailure), true);
    assert.deepEqual(calls, ["provider/first", "provider/second"], "the next failure advances to the next backup");
    assert.deepEqual(state.mainModelRecovery?.attempted, ["provider/primary", "provider/blocked", "provider/first", "provider/second"]);
    assert.equal(state.mainModelRecovery?.skipped?.some((entry) => entry.ref === "provider/first" || entry.ref === "provider/second"), false, "successful backups remain absent from skipped");

    // The delayed/scheduled probe has its own selector path. A successful
    // probe target must be attempted, not persisted as an unregistered skip.
    ctx.model = { provider: "provider", id: "primary" };
    state.mainModelRecovery = {
      primary: "provider/primary",
      active: "provider/primary",
      attempted: ["provider/primary"],
      attempts: 1,
      reason: "main model quota — provider account/usage wall",
      kind: "goal",
    };
    await probeMainModelRecovery(ctx);
    assert.equal(calls.at(-1), "provider/first", "the scheduled probe selects the first eligible backup");
    assert.deepEqual(state.mainModelRecovery?.skipped, [{ ref: "provider/blocked", reason: "forbidden" }]);
    assert.equal(state.mainModelRecovery?.skipped?.some((entry) => entry.ref === "provider/first"), false, "the scheduled probe target is not labelled skipped");

    // With request-rate fallback enabled by default, a 429 walks the next
    // configured backup instead of consuming another current-model retry.
    ctx.model = { provider: "provider", id: "first" };
    assert.equal(await tryMainModelFallback(ctx, classifyMainModelFailure("HTTP 429 too many requests")), true);
    assert.equal(calls.at(-1), "provider/second");
  } finally {
    replaceState({ goal: null } as any);
    if (original === undefined) {
      try { fs.unlinkSync(settingsFile); } catch { /* absent */ }
    } else {
      fs.writeFileSync(settingsFile, original);
    }
  }
});

test("main model errors distinguish quota recovery from deterministic prompt walls", () => {
  assert.equal(classifyMainModelFailure("429 usage limit; retry in 2 hours").kind, "rate-limit");
  assert.equal(classifyMainModelFailure("Token Plan usage limit reached").kind, "quota");
  assert.equal(classifyMainModelFailure("Token Plan rate limit reached (2062)").kind, "rate-limit");
  assert.equal(classifyMainModelFailure("Token Plan rate limit reached (2062)").quotaSignal, "rate-limit");
  assert.equal(classifyMainModelFailure("429 Too Many Requests").kind, "rate-limit");
  assert.equal(classifyMainModelFailure("HTTP 429 request cancelled by upstream").kind, "rate-limit");
  assert.equal(classifyMainModelFailure("too-many-requests").kind, "rate-limit");
  assert.equal(classifyMainModelFailure("too_many_requests").kind, "rate-limit");
  assert.equal(classifyMainModelFailure("request rate exceeded").kind, "rate-limit");
  assert.equal(classifyMainModelFailure("request-rate exceeded").kind, "rate-limit");
  assert.equal(classifyMainModelFailure("429 Too Many Requests").quotaSignal, "rate-limit");
  assert.equal(classifyMainModelFailure("HTTP 429 — Token Plan output token limit reached").kind, "rate-limit");
  assert.equal(classifyMainModelFailure("HTTP 429 — Token Plan output token limit reached").quotaSignal, "rate-limit");
  assert.equal(classifyMainModelFailure("429 rate limit exceeded").kind, "rate-limit");
  assert.equal(classifyMainModelFailure("429 usage limit").kind, "rate-limit");
  assert.equal(classifyMainModelFailure("503 temporarily unavailable").kind, "transient");
  assert.equal(isMainModelFallbackFailure(classifyMainModelFailure("usage limit reached")), true);
  assert.equal(isMainModelFallbackFailure(classifyMainModelFailure("429 too many requests")), false);
  assert.equal(isMainModelFallbackFailure(classifyMainModelFailure("429 too many requests"), { allowRateLimit: true }), true);
  assert.equal(isMainModelFallbackFailure(classifyMainModelFailure("request rate exceeded")), false);
  assert.equal(isMainModelFallbackFailure(classifyMainModelFailure("503 temporarily unavailable")), false);
  assert.equal(classifyMainModelFailure("429 Token Plan rate limit reached").kind, "rate-limit");
  assert.equal(classifyMainModelFailure("429 Token Plan rate limit reached").quotaSignal, "rate-limit");
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
  const nowMs = Date.parse("2026-08-07T01:18:01.930Z");
  // A pure no-hint request-rate wall gets one bounded eager backoff; the
  // following attempt uses the configured base ladder.
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("429 Too Many Requests"), 1, 15, nowMs), 5_000);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("429 Too Many Requests"), 2, 15, nowMs), 30 * 60_000);
  // The upstream hint (a factual provider fact) still outranks the ladder.
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("429 rate limit; retry in 2 hours"), 1, 15, nowMs), 2 * 60 * 60_000);
  // Temporary-window prose remains a factual hint rather than waiting for
  // the optional hourly ticker.
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("429 Too Many Requests — try again in 30 seconds"), 1, 15, nowMs), 30_000);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("rate limit resets in 15 seconds"), 1, 15, nowMs), 15_000);
  // An over-budget hint falls back to the configured bounded ladder.
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("429 rate limit; retry in 1 week"), 1, 15, nowMs), 15 * 60_000);
  // Every non-rate-limit failure family uses the same configured base and
  // attempt ladder. An explicit 429/rate-limit marker gets the 5s first
  // retry, then joins that same ladder.
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("Token Plan rate limit reached (2062)"), 1, 15, nowMs), 5_000);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("Token Plan rate limit reached (2062)"), 2, 15, nowMs), 30 * 60_000);
  for (const raw of [
    "503 temporarily unavailable",
    "insufficient credits — buy credits",
    "401 invalid API key",
    "mysterious provider prose with no hint",
  ]) {
    assert.equal(mainModelFailureDelayMs(classifyMainModelFailure(raw), 1, 15, nowMs), 15 * 60_000, raw);
    assert.equal(mainModelFailureDelayMs(classifyMainModelFailure(raw), 2, 15, nowMs), 30 * 60_000, raw);
  }
  // The setting is effective for ordinary failures, not just a dead-end
  // branch: a 45-minute base means 45m, then 90m.
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("503 temporarily unavailable"), 1, 45, nowMs), 45 * 60_000);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("503 temporarily unavailable"), 2, 45, nowMs), 90 * 60_000);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("Token Plan rate limit reached (2062); retry after 3 hours"), 1, 15, nowMs), 3 * 60 * 60_000);
  assert.equal(mainModelAutoRetryUntil(Date.parse("2026-08-03T00:00:00Z")), "2026-08-04T00:00:00.000Z");
  assert.equal(modelRef({ provider: "openai", id: "gpt" }), "openai/gpt");
  assert.equal(modelRef({ provider: "openai" }), undefined);
  assert.equal(formatMainModelFallbacks(["a/one", "b/two"]), "1. a/one → 2. b/two");
  assert.equal(formatMainModelFallbacks([]), "none");
});

test("main recovery requirements keep rate limits current-model-only while parking them durably", () => {
  const rateLimit = classifyMainModelFailure("HTTP 429 too many requests");
  const account = classifyMainModelFailure("account usage limit reached");
  assert.equal(isMainModelFallbackFailure(rateLimit), false);
  assert.equal(isMainModelFallbackFailure(account), true);
});
