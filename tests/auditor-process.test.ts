import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  newDetachedAuditJobAttemptId,
  requestHash,
  runDetachedGoalCompletionAuditor,
  stableJson,
  type AuditorModel,
  type AuditorProgress,
} from "../extensions/goal-loop-auditor-process.ts";

const workerPath = path.resolve(process.cwd(), "tests/fixtures/auditor-fake-worker.mjs");
const workerSource = `
import { readFile, writeFile } from "node:fs/promises";
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
const request = JSON.parse(await readFile(dir + "/request.json", "utf8"));
const progress = {
  protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
  phase: "running", elapsedMs: 1,
  ...(process.env.FAKE_TELEMETRY === "yes" ? {
    lastActivityAt: Date.now(),
    recentOutput: ["inspected README.md"],
    currentTool: "read",
    currentToolArgs: JSON.stringify({ path: "/repo/README.md" }),
    currentToolStartedAt: Date.now() - 20,
    toolCalls: [{ name: "grep", argsPrefix: "{}", finishedAt: Date.now() - 30 }],
  } : { recentOutput: [], toolCalls: [] }),
};
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

async function runWithAttempt(dir: string, attemptId: string, env: NodeJS.ProcessEnv = {}) {
  return runDetachedGoalCompletionAuditor({
    cwd: dir,
    goal,
    model: "test/provider-model" satisfies AuditorModel,
    thinkingLevel: "high",
    runtime: { workerPath, env, attemptId: () => attemptId, pollIntervalMs: 10, wallTimeoutMs: 2_000 },
  });
}

async function run(dir: string, env: NodeJS.ProcessEnv = {}) {
  return runWithAttempt(dir, "attempt-test", env);
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

test("detached parent forwards live worker telemetry to its progress callback", async () => {
  const dir = await setup();
  const reports: AuditorProgress[] = [];
  try {
    await runDetachedGoalCompletionAuditor({
      cwd: dir,
      goal,
      model: "test/provider-model",
      thinkingLevel: "high",
      onProgress: (progress) => reports.push(progress),
      runtime: { workerPath, env: { FAKE_TELEMETRY: "yes" }, attemptId: () => "attempt-telemetry", pollIntervalMs: 10, wallTimeoutMs: 2_000 },
    });
    const live = reports.find((progress) => progress.currentTool === "read");
    assert.ok(live, "the detached progress file reaches the parent");
    assert.equal(live?.currentToolArgs, JSON.stringify({ path: "/repo/README.md" }));
    assert.deepEqual(live?.recentOutput, ["inspected README.md"]);
    assert.equal(live?.toolCalls[0]?.name, "grep");
    assert.ok(live?.lastActivityAt);
  } finally {
    await cleanup(dir);
  }
});

test("the real worker forwards ordered tool and report phases to the parent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-live-telemetry-"));
  const fakePi = path.join(dir, "phase-pi.mjs");
  const reports: AuditorProgress[] = [];
  const fakePiSource = `
import { setTimeout as sleep } from "node:timers/promises";
let handled = false;
process.stdin.on("data", async (chunk) => {
  if (handled || !String(chunk).includes("\\n")) return;
  handled = true;
  const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  out({ type: "agent_start" });
  await sleep(30);
  out({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "/repo/README.md" } });
  await sleep(30);
  out({ type: "tool_execution_start", toolCallId: "grep-2", toolName: "grep", args: { pattern: "artifact", path: "/repo/src" } });
  await sleep(30);
  out({ type: "tool_execution_end", toolCallId: "read-1" });
  await sleep(30);
  out({ type: "tool_execution_end", toolCallId: "grep-2" });
  await sleep(30);
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "<evidence>\\nartifact exists; tests pass\\n</evidence>\\n<approved/>" } });
  await sleep(50);
  out({ type: "agent_settled" });
});
`;
  await writeFile(fakePi, `#!/usr/bin/env node\n${fakePiSource}`);
  await chmod(fakePi, 0o700);
  try {
    const result = await runDetachedGoalCompletionAuditor({
      cwd: dir,
      goal,
      model: "test/provider-model",
      thinkingLevel: "high",
      onProgress: (progress) => reports.push(progress),
      runtime: {
        workerPath: path.resolve(process.cwd(), "scripts/goal-auditor-worker.mjs"),
        env: { GLLA_PI_BINARY: fakePi },
        attemptId: () => "attempt-real-telemetry",
        pollIntervalMs: 5,
        wallTimeoutMs: 2_000,
      },
    });
    assert.equal(result.approved, true);
    const phases = reports.map((progress) => progress.phase);
    assert.ok(phases.includes("starting"));
    assert.ok(phases.includes("thinking"));
    assert.ok(phases.includes("tool_executing"));
    assert.ok(phases.includes("producing_report"), `observed phases: ${phases.join(", ")}`);
    assert.ok(phases.indexOf("tool_executing") < phases.indexOf("producing_report"));
    const tool = reports.find((progress) => progress.currentTool === "read");
    assert.ok(tool, "parent observed the real worker's active tool");
    assert.equal(tool?.currentToolArgs, JSON.stringify({ path: "/repo/README.md" }));
    assert.ok(
      reports.some((progress) => progress.phase === "tool_executing" && progress.currentTool === "grep" && progress.toolCalls.some((call) => call.name === "read")),
      "ending one overlapping tool does not erase the other active tool",
    );
    assert.ok(reports.some((progress) => progress.phase === "complete"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker assembles streamed report fragments into cumulative display lines without changing the exact result", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-fragment-telemetry-"));
  const fakePi = path.join(dir, "fragment-pi.mjs");
  const reports: AuditorProgress[] = [];
  const fakePiSource = `
import { setTimeout as sleep } from "node:timers/promises";
let handled = false;
process.stdin.on("data", async (chunk) => {
  if (handled || !String(chunk).includes("\\n")) return;
  handled = true;
  const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  // ne and ys are deliberately standalone provider chunks inside two
  // logical lines. They must join the buffered current line, never become
  // independent latest entries in the progress HUD.
  for (const delta of ["Audit summary: checked\\nNext li", "ne", ": anal", "ys", "is", "\\n<disapproved/>"]) {
    out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
    await sleep(25);
  }
  out({ type: "agent_settled" });
});
`;
  await writeFile(fakePi, `#!/usr/bin/env node\n${fakePiSource}`);
  await chmod(fakePi, 0o700);
  try {
    const result = await runDetachedGoalCompletionAuditor({
      cwd: dir,
      goal,
      model: "test/provider-model",
      thinkingLevel: "high",
      onProgress: (progress) => reports.push(progress),
      runtime: {
        workerPath: path.resolve(process.cwd(), "scripts/goal-auditor-worker.mjs"),
        env: { GLLA_PI_BINARY: fakePi },
        attemptId: () => "attempt-fragment-telemetry",
        pollIntervalMs: 5,
        wallTimeoutMs: 2_000,
      },
    });
    assert.equal(result.disapproved, true);
    assert.equal(result.output, "Audit summary: checked\nNext line: analysis\n<disapproved/>");
    assert.ok(
      reports.some((progress) => progress.recentOutput.includes("Audit summary: checked")),
      "the parent receives the cumulative current report line",
    );
    assert.ok(
      reports.some((progress) => progress.recentOutput.includes("Next line: analysis")),
      "the parent receives a later logical line as one item",
    );
    assert.ok(
      reports.every((progress) => !progress.recentOutput.some((line) => ["ne", "ys"].includes(line))),
      "word fragments are never presented as separate report lines",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
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

test("a verdict marker inside a think block is not accepted", async () => {
  const dir = await setup();
  try {
    const result = await run(dir, {
      FAKE_AUDIT_OUTPUT: "<think><approved/></think>",
      FAKE_TOOL: "yes",
    });
    assert.equal(result.approved, false);
    assert.equal(result.disapproved, false);
    assert.match(result.error ?? "", /no output/);
  } finally {
    await cleanup(dir);
  }
});

test("detached retry identities create unique job directories with the logical claim as prefix", async () => {
  const dir = await setup();
  const logicalAttemptId = "audit-logical-claim";
  const firstAttemptId = newDetachedAuditJobAttemptId(logicalAttemptId);
  const secondAttemptId = newDetachedAuditJobAttemptId(logicalAttemptId);
  try {
    assert.notEqual(firstAttemptId, secondAttemptId, "each retry gets a unique filesystem identity");
    assert.ok(firstAttemptId.startsWith(`${logicalAttemptId}-`));
    assert.ok(secondAttemptId.startsWith(`${logicalAttemptId}-`));
    await runWithAttempt(dir, firstAttemptId, { FAKE_AUDIT_OUTPUT: "<disapproved/>" });
    await runWithAttempt(dir, secondAttemptId, { FAKE_AUDIT_OUTPUT: "<disapproved/>" });
    const jobs = (await readdir(path.join(dir, ".pi-glla", "audit-jobs"))).sort();
    assert.deepEqual(jobs, [firstAttemptId, secondAttemptId].sort(), "retries do not collide on the old job directory");
    const firstRequest = JSON.parse(await readFile(path.join(dir, ".pi-glla", "audit-jobs", firstAttemptId, "request.json"), "utf8")) as { attemptId: string };
    const secondRequest = JSON.parse(await readFile(path.join(dir, ".pi-glla", "audit-jobs", secondAttemptId, "request.json"), "utf8")) as { attemptId: string };
    assert.equal(firstRequest.attemptId, firstAttemptId);
    assert.equal(secondRequest.attemptId, secondAttemptId);
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

test("an early RPC child exit still publishes an atomic infrastructure result", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-early-rpc-exit-"));
  const fakePi = path.join(dir, "early-exit-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node
process.stdin.destroy();
setTimeout(() => process.exit(17), 25);
`);
  await chmod(fakePi, 0o700);
  try {
    const result = await runDetachedGoalCompletionAuditor({
      cwd: dir,
      goal,
      model: "test/provider-model",
      thinkingLevel: "high",
      runtime: {
        workerPath: path.resolve(process.cwd(), "scripts/goal-auditor-worker.mjs"),
        env: { GLLA_PI_BINARY: fakePi },
        attemptId: () => "attempt-early-rpc-exit",
        pollIntervalMs: 10,
        wallTimeoutMs: 2_000,
      },
    });
    assert.equal(result.approved, false);
    assert.equal(result.disapproved, false);
    assert.match(result.error ?? "", /RPC stdin stream failed|pi exited before audit completion|pi exited without an agent_settled|RPC stream ended/);
    assert.doesNotMatch(result.error ?? "", /worker exited without an atomic result/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
    assert.match(result.error ?? "", /for 1s/);
    assert.doesNotMatch(result.error ?? "", /for 10m/);
    const progress = JSON.parse(await readFile(path.join(dir, ".pi-glla", "audit-jobs", "attempt-silent", "progress.json"), "utf8")) as Record<string, unknown>;
    assert.equal("lastActivityAt" in progress, false, "startup silence is not rendered as worker activity");
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
  // Verdict markers may be split across arbitrary stream fragments.
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "<approved" } });
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "/>" } });
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
    assert.match(result.output, /<approved\/>$/);
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
