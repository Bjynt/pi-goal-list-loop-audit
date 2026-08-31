// v0.35.65 — real-host child-stop integration
//
// This deliberately uses the pinned, unmodified pi-subagents AgentManager and
// its production RPC handler. The faux provider keeps the child deterministic:
// its first model response never resolves, so the record remains running until
// the root-session stop RPC aborts it. No upstream package source is patched.
// This is .mjs so the repository typecheck does not typecheck upstream package
// source merely because the integration reaches its internal test seam.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  ModelRegistry,
  ModelRuntime,
  createEventBus,
} from "@earendil-works/pi-coding-agent";
import { MockPi } from "./harness/mock-pi.js";

// The legacy RPC fixture is retained for installations that still provide the
// old @tintinweb fork. The package dependency now targets pi-subagents, whose
// public API has no equivalent AgentManager import; do not reach into or patch
// that external package just to keep this compatibility check runnable.
const legacyAgentManagerPath = path.resolve("node_modules/@tintinweb/pi-subagents/src/agent-manager.js");
const legacyRpcPath = path.resolve("node_modules/@tintinweb/pi-subagents/src/cross-extension-rpc.js");
const legacyRpcFixtureAvailable = fs.existsSync(legacyAgentManagerPath) && fs.existsSync(legacyRpcPath);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the real child session");
    await delay(10);
  }
}

test("real AgentManager child is stopped through the root subagents RPC", { skip: !legacyRpcFixtureAvailable ? "legacy @tintinweb RPC fixture is not installed" : false }, async () => {
  const { AgentManager } = await import(pathToFileURL(legacyAgentManagerPath).href);
  const { registerRpcHandlers } = await import(pathToFileURL(legacyRpcPath).href);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-real-subagent-stop-"));
  const faux = fauxProvider({
    api: "glla-faux-api",
    provider: "glla-faux-provider",
    models: [{
      id: "glla-frozen-model",
      name: "GLLA frozen integration model",
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 1_024,
    }],
  });
  // A real provider stream is created by the AgentSession, but the response
  // factory is intentionally pending. AgentManager.abort() must still settle
  // the child record immediately through its AbortController.
  faux.setResponses([() => new Promise(() => {})]);

  const runtime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  const modelRegistry = new ModelRegistry(runtime);
  const model = runtime.getModel(faux.provider.id, "glla-frozen-model");
  assert.ok(model, "the deterministic faux model is registered");

  const parentPi = new MockPi();
  let parentAborts = 0;
  const parentContext = {
    cwd,
    hasUI: false,
    model,
    modelRegistry,
    getSystemPrompt: () => "integration parent prompt",
    abort: () => { parentAborts++; },
  };
  const events = createEventBus();
  const manager = new AgentManager();
  const rpc = registerRpcHandlers({
    events,
    pi: parentPi.api,
    getCtx: () => parentContext,
    manager,
  });

  try {
    const id = manager.spawn(
      parentPi.api,
      parentContext,
      "general-purpose",
      "Remain pending until the root host stops this child.",
      {
        description: "real RPC stop fixture",
        model,
        isolated: true,
        maxTurns: 1,
        isBackground: true,
      },
    );

    const record = manager.getRecord(id);
    assert.ok(record, "the real manager publishes the child record synchronously");
    assert.equal(record.status, "running");
    await waitFor(() => manager.getRecord(id)?.session !== undefined);
    assert.equal(manager.getRecord(id)?.status, "running");
    assert.equal(manager.getRecord(id)?.toolUses, 0, "the faux response produced no tool progress");

    const reply = new Promise((resolve) => {
      events.on("subagents:rpc:stop:reply:integration-stop", resolve);
    });
    events.emit("subagents:rpc:stop", {
      requestId: "integration-stop",
      agentId: id,
    });

    assert.deepEqual(await reply, { success: true });
    assert.equal(manager.getRecord(id)?.status, "stopped", "the actual manager marks the child stopped");
    assert.ok(manager.getRecord(id)?.completedAt, "the actual manager records the stop time");
    assert.equal(parentAborts, 0, "stopping the child never calls the parent context abort");
  } finally {
    rpc.unsubStop();
    rpc.unsubSpawn();
    rpc.unsubPing();
    manager.abortAll();
    manager.dispose();
  }
});
