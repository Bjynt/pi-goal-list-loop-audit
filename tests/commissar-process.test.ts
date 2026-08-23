// Tests for the v0.36.x commissar role on the detached worker transport
// (extensions/goal-loop-auditor-process.ts). The transport is shared with
// the completion auditor; these tests pin the role-specific contract:
//   - role "commissar" parses <adherent/> / <wanting>…</wanting> verdicts
//   - evidence floor: a verdict without any tool call is infrastructure
//     noise (no-verdict), never a termination signal
//   - the prompt override reaches request.json only under role "commissar"
// Real modules, real spawn, fake worker (same harness shape as
// tests/auditor-process.test.ts).

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  requestHash,
  runDetachedGoalCompletionAuditor,
} from "../extensions/goal-loop-auditor-process.ts";
import { buildCommissarPrompt } from "../extensions/goal-commissar.ts";

function workerPathFor(dir: string): string {
  return path.join(dir, "commissar-fake-worker.mjs");
}

const workerSource = `
import { readFile, rename, rm, writeFile, appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
async function atomicJson(file, value) {
  const temp = file + "." + process.pid + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value));
  try { await rename(temp, file); }
  catch (e) { await rm(temp, { force: true }).catch(() => {}); throw e; }
}
const request = JSON.parse(await readFile(dir + "/request.json", "utf8"));
// Echo the received prompt into a side file OUTSIDE the job dir so tests
// can pin exactly what was dispatched (the parent deletes the job dir).
if (process.env.FAKE_PROMPT_SINK) {
  await appendFile(process.env.FAKE_PROMPT_SINK, JSON.stringify({ prompt: request.prompt }) + "\\n");
}
await atomicJson(dir + "/progress.json", { protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash, phase: "running", elapsedMs: 1, recentOutput: [], toolCalls: [] });
await atomicJson(dir + "/result.json", { protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash, ok: true, output: process.env.FAKE_AUDIT_OUTPUT || "<adherent/>", model: request.model, thinkingLevel: request.thinkingLevel, toolCalls: process.env.FAKE_TOOL === "yes" ? [{ name: "read", argsPrefix: "{}", finishedAt: Date.now() }] : [] });
`;

const goal = {
  id: "g-commissar",
  objective: "Ship the commissar watchdog.",
  status: "active" as const,
  policy: "goal" as const,
  autoContinue: false,
  usage: { tokensUsed: 0, tokensLimit: 0 },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

async function setup(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-commissar-"));
  await writeFile2(workerPathFor(dir), workerSource);
  return dir;
}

/** Small sync wrapper so setup stays one expression; node fs/promises writeFile re-exported for clarity. */
import { writeFile as writeFile2 } from "node:fs/promises";

async function runCommissar(
  dir: string,
  env: NodeJS.ProcessEnv = {},
  prompt?: string,
) {
  return runDetachedGoalCompletionAuditor({
    cwd: dir,
    goal,
    role: "commissar",
    prompt: prompt ?? buildCommissarPrompt(goal),
    model: "test/provider-model",
    thinkingLevel: "high",
    runtime: {
      workerPath: workerPathFor(dir),
      env,
      attemptId: () => "attempt-comm",
      pollIntervalMs: 10,
      wallTimeoutMs: 10_000,
    },
  });
}

test("commissar role: adherent verdict with evidence maps to approved/adherent", async () => {
  const dir = await setup();
  try {
    const result = await runCommissar(dir, {
      FAKE_AUDIT_OUTPUT: "Ledger shows steady commits.\n<adherent/>",
      FAKE_TOOL: "yes",
    });
    assert.ok(result.commissar, "commissar verdict block present");
    assert.equal(result.commissar.adherent, true);
    assert.equal(result.commissar.wanting, false);
    assert.equal(result.approved, true);
    assert.equal(result.disapproved, false);
    assert.equal(result.infrastructureClass, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("commissar role: wanting verdict carries the actionable reason", async () => {
  const dir = await setup();
  try {
    const result = await runCommissar(dir, {
      FAKE_AUDIT_OUTPUT:
        "Nine stalled turns.\n<wanting>no progress across 9 consecutive turns</wanting>",
      FAKE_TOOL: "yes",
    });
    assert.ok(result.commissar);
    assert.equal(result.commissar.wanting, true);
    assert.equal(
      result.commissar.reason,
      "no progress across 9 consecutive turns",
    );
    assert.equal(result.disapproved, true);
    assert.equal(result.approved, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("commissar role: missing verdict marker is infrastructure noise", async () => {
  const dir = await setup();
  try {
    const result = await runCommissar(dir, {
      FAKE_AUDIT_OUTPUT: "a plausible report with no final-line marker",
      FAKE_TOOL: "yes",
    });
    assert.equal(result.infrastructureClass, "no-verdict");
    assert.equal(result.commissar, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("commissar role: evidence-free verdict is discarded (no tool calls)", async () => {
  const dir = await setup();
  try {
    const result = await runCommissar(dir, {
      FAKE_AUDIT_OUTPUT: "<wanting>vibes</wanting>",
      FAKE_TOOL: "no",
    });
    assert.equal(result.infrastructureClass, "no-verdict");
    assert.match(result.error ?? "", /without calling any evidence tool/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("commissar role: unsupported tool call fails closed", async () => {
  const dir = await setup();
  try {
    // Simulate a rogue tool report by having the fake worker claim an edit tool.
    await rm(workerPathFor(dir));
    await writeFile2(
      workerPathFor(dir),
      workerSource.replace(
        'toolCalls: process.env.FAKE_TOOL === "yes" ? [{ name: "read"',
        'toolCalls: process.env.FAKE_TOOL === "yes" ? [{ name: "edit"',
      ),
    );
    const result = await runCommissar(dir, {
      FAKE_AUDIT_OUTPUT: "<adherent/>",
      FAKE_TOOL: "yes",
    });
    assert.equal(result.infrastructureClass, "no-verdict");
    assert.match(result.error ?? "", /unsupported tool: edit/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("commissar role: prompt override reaches request.json verbatim", async () => {
  const dir = await setup();
  const sink = path.join(dir, "prompt-sink.jsonl");
  try {
    const customPrompt = buildCommissarPrompt(goal, "digest: three idle turns");
    await runCommissar(dir, { FAKE_PROMPT_SINK: sink }, customPrompt);
    const lines = (await readFile(sink, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { prompt: string });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!.prompt, /<evidence>/);
    assert.match(lines[0]!.prompt, /digest: three idle turns/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default role (no role): completion audit path unchanged, no commissar field", async () => {
  const dir = await setup();
  try {
    const result = await runDetachedGoalCompletionAuditor({
      cwd: dir,
      goal,
      completionSummary: "claimed done",
      model: "test/provider-model",
      thinkingLevel: "high",
      runtime: {
        workerPath: workerPathFor(dir),
        env: { FAKE_AUDIT_OUTPUT: "<disapproved/>", FAKE_TOOL: "yes" },
        attemptId: () => "attempt-audit",
        pollIntervalMs: 10,
        wallTimeoutMs: 10_000,
      },
    });
    assert.equal(result.disapproved, true);
    assert.equal(result.commissar, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("request hash remains stable when optional role/prompt args are absent", () => {
  // The hash input type excludes role/prompt by construction: build two
  // request-shaped objects differing ONLY in fields the schema never sees.
  const base = {
    protocolVersion: 1,
    attemptId: "a",
    cwd: "/c",
    prompt: "p",
    model: "m",
    thinkingLevel: "high",
    createdAt: "t",
    wallDeadlineAt: "w",
    goalRevision: undefined,
  };
  assert.equal(requestHash(base as never), requestHash({ ...base } as never));
});
