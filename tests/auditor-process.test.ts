import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  requestHash,
  runDetachedGoalCompletionAuditor,
  stableJson,
  type AuditorModel,
} from "../extensions/goal-loop-auditor-process.ts";

const workerPath = path.resolve(process.cwd(), "tests/fixtures/auditor-fake-worker.mjs");
const workerSource = `
import { readFile, writeFile } from "node:fs/promises";
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
const request = JSON.parse(await readFile(dir + "/request.json", "utf8"));
const progress = { protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash, phase: "running", elapsedMs: 1, recentOutput: [], toolCalls: [] };
await writeFile(dir + "/progress.json", JSON.stringify(progress));
await writeFile(dir + "/result.json", JSON.stringify({ protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash, ok: true, output: process.env.FAKE_AUDIT_OUTPUT || "<disapproved/>", model: request.model, thinkingLevel: request.thinkingLevel, toolCalls: process.env.FAKE_TOOL === "yes" ? [{ name: "read", argsPrefix: "{}", finishedAt: Date.now() }] : [] }));
`;

const goal = {
  id: "g-test",
  objective: "Create the audited artifact.",
  status: "active" as const,
  policy: "goal" as const,
  verificationContract: "Done when:\n- artifact exists\n- tests pass",
  autoContinue: false,
  usage: { tokensUsed: 0, tokensLimit: 0 },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

async function setup(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-process-"));
  await mkdir(path.dirname(workerPath), { recursive: true });
  await writeFile(workerPath, workerSource);
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await rm(workerPath, { force: true });
}

async function run(dir: string, env: NodeJS.ProcessEnv = {}) {
  return runDetachedGoalCompletionAuditor({
    cwd: dir,
    goal,
    model: "test/provider-model" satisfies AuditorModel,
    thinkingLevel: "high",
    runtime: { workerPath, env, attemptId: () => "attempt-test", pollIntervalMs: 10, wallTimeoutMs: 2_000 },
  });
}

test("detached parent accepts an identity-checked result and applies regression_shield", async () => {
  const dir = await setup();
  try {
    const result = await run(dir, {
      FAKE_AUDIT_OUTPUT: "<evidence>\nartifact exists; tests pass\n</evidence>\n<approved/>",
      FAKE_TOOL: "yes",
    });
    assert.equal(result.approved, true);
    assert.equal(result.disapproved, false);
    assert.equal(result.regressionShieldPassed, true);
    assert.equal(result.model, "test/provider-model");
  } finally {
    await cleanup(dir);
  }
});

test("approval without a read-only tool is a semantic disapproval", async () => {
  const dir = await setup();
  try {
    const result = await run(dir, { FAKE_AUDIT_OUTPUT: "<approved/>" });
    assert.equal(result.approved, false);
    assert.equal(result.disapproved, true);
    assert.match(result.error ?? "", /read-only tool/);
  } finally {
    await cleanup(dir);
  }
});

test("a mismatched result hash fails closed as infrastructure", async () => {
  const dir = await setup();
  try {
    const badWorker = path.join(dir, "bad-worker.mjs");
    await writeFile(badWorker, workerSource.replace("request.requestHash, ok", '"wrong-hash", ok'));
    const result = await runDetachedGoalCompletionAuditor({
      cwd: dir, goal, model: "test/provider-model",
      runtime: { workerPath: badWorker, attemptId: () => "attempt-bad", pollIntervalMs: 10, wallTimeoutMs: 2_000 },
    });
    assert.equal(result.approved, false);
    assert.equal(result.disapproved, false);
    assert.match(result.error ?? "", /hash mismatch/);
  } finally {
    await cleanup(dir);
  }
});

test("request hashing is stable and excludes no runtime secret or API key field", () => {
  const request = {
    protocolVersion: 1, attemptId: "a", cwd: "/tmp/project", prompt: "inspect", model: "p/m",
    thinkingLevel: "medium", createdAt: "2026-01-01T00:00:00.000Z", wallDeadlineAt: 123,
  };
  assert.equal(stableJson({ b: 2, a: 1 }), stableJson({ a: 1, b: 2 }));
  assert.equal(requestHash(request).length, 64);
  assert.equal("apiKey" in request, false);
});

test("detached worker treats silent provider time as infrastructure, not a verdict", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-stall-"));
  const fakePi = path.join(dir, "silent-pi.mjs");
  await writeFile(fakePi, "#!/usr/bin/env node\\nprocess.stdin.resume(); setInterval(() => {}, 1000);\\n");
  await chmod(fakePi, 0o700);
  try {
    const result = await runDetachedGoalCompletionAuditor({
      cwd: dir,
      goal,
      model: "test/provider-model",
      thinkingLevel: "high",
      runtime: {
        workerPath: path.resolve(process.cwd(), "scripts/goal-auditor-worker.mjs"),
        env: { GLLA_PI_BINARY: fakePi, GLLA_AUDITOR_STALL_MS: "60" },
        attemptId: () => "attempt-silent",
        pollIntervalMs: 10,
        wallTimeoutMs: 2_000,
      },
    });
    assert.equal(result.approved, false);
    assert.equal(result.disapproved, false);
    assert.match(result.error ?? "", /Auditor stalled/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker launches pi with the exact read-only RPC contract and one LF JSONL prompt", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-worker-"));
  const piLog = path.join(dir, "pi-log.json");
  const fakePi = path.join(dir, "fake-pi.mjs");
  const worker = path.resolve(process.cwd(), "scripts/goal-auditor-worker.mjs");
  const piSource = `
import { readFile, writeFile } from "node:fs/promises";
let input = "";
let handled = false;
process.stdin.on("data", async (chunk) => {
  input += chunk;
  if (handled || !input.includes("\\n")) return;
  handled = true;
  await writeFile(process.env.PI_LOG, JSON.stringify({ args: process.argv.slice(2), input }));
  const out = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "<evidence>\\nartifact exists\\ntests pass\\n</evidence>\\n" } });
  out({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "artifact" } });
  out({ type: "tool_execution_end", toolCallId: "1" });
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "<approved/>" } });
  out({ type: "agent_end" });
  out({ type: "agent_settled" });
});
// EOF is a shutdown request in pi RPC mode. If the client closes stdin before
// the asynchronous result, this fake exits without an agent_settled event.
process.stdin.on("end", () => { process.exitCode = 41; });
`;
  await writeFile(fakePi, `#!/usr/bin/env node\n${piSource}`);
  await chmod(fakePi, 0o700);
  const attemptId = "worker-test";
  const jobDir = path.join(dir, ".pi-glla", "audit-jobs", attemptId);
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(jobDir, "lock"), "lock\n");
  const withoutHash = {
    protocolVersion: 1, attemptId, cwd: dir, prompt: "Inspect artifact.", model: "test/provider-model",
    thinkingLevel: "medium", createdAt: new Date().toISOString(), wallDeadlineAt: Date.now() + 5_000,
  };
  const request = { ...withoutHash, requestHash: requestHash(withoutHash) };
  await writeFile(path.join(jobDir, "request.json"), JSON.stringify(request));
  try {
    const child = spawn(process.execPath, [worker, "--job-dir", jobDir], {
      env: { ...process.env, GLLA_PI_BINARY: fakePi, PI_LOG: piLog },
      stdio: "ignore",
    });
    const resultPath = path.join(jobDir, "result.json");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker test timed out")), 2_000);
      const poll = async () => {
        try { await readFile(resultPath); clearTimeout(timer); resolve(); }
        catch { setTimeout(poll, 10); }
      };
      void poll();
    });
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
      child.once("exit", () => resolve());
    });
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    const log = JSON.parse(await readFile(piLog, "utf8"));
    assert.equal(result.ok, true);
    assert.equal(result.toolCalls[0].name, "read");
    assert.deepEqual(log.args, [
      "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
      "--no-themes", "--no-context-files", "--approve", "--tools", "read,grep,find,ls,bash",
      "--model", "test/provider-model", "--thinking", "medium",
    ]);
    assert.equal(log.input.split("\n").length, 2);
    assert.equal(log.input.endsWith("\n"), true);
    assert.equal(JSON.parse(log.input).type, "prompt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
