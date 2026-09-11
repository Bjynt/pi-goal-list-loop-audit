import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  findActiveSameSubjectAudit,
  findResumableInspectionSession,
  requestHash,
  runDetachedGoalCompletionAuditor,
  type AuditorModel,
  type GoalAuditorResult,
} from "../extensions/goal-loop-auditor-process.ts";

// =================================================================
// Fixtures
// =================================================================

const SESSION_HEADER = `{"type":"session","id":"00000000-0000-0000-0000-000000000001","cwd":"/tmp/repo","time":{"created":1}}`;

async function makePriorJob(
  jobsRoot: string,
  name: string,
  opts: {
    subject?: string;
    goalId?: string;
    createdAt: string;
    withResult?: boolean;
    session?: "valid" | "empty" | "bad-header" | "missing";
  },
): Promise<string> {
  const dir = path.join(jobsRoot, name);
  await mkdir(dir, { recursive: true });
  const request: Record<string, unknown> = {
    protocolVersion: 1,
    attemptId: name,
    requestHash: "hash-" + name,
    cwd: "/tmp/repo",
    prompt: "prior audit prompt",
    model: "test/provider-model",
    thinkingLevel: "high",
    createdAt: opts.createdAt,
  };
  if (opts.subject !== undefined) request.auditSubject = opts.subject;
  if (opts.goalId !== undefined) request.goalRevision = { goalId: opts.goalId, revision: 0 };
  await writeFile(path.join(dir, "request.json"), JSON.stringify(request));
  if (opts.withResult !== false) {
    await writeFile(path.join(dir, "result.json"), JSON.stringify({ ok: true, output: "<approved/>" }));
  }
  const sessionMode = opts.session ?? "valid";
  if (sessionMode !== "missing") {
    if (sessionMode === "valid") {
      await writeFile(path.join(dir, "session.jsonl"), `${SESSION_HEADER}\n{"type":"message","text":"history turn"}\n`);
    } else if (sessionMode === "empty") {
      await writeFile(path.join(dir, "session.jsonl"), "");
    } else {
      await writeFile(path.join(dir, "session.jsonl"), "not-json-at-all\n");
    }
  }
  return dir;
}

async function setupJobsRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "glla-resume-"));
  return path.join(root, ".pi-glla", "audit-jobs");
}

async function cleanupRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

// =================================================================
// findResumableInspectionSession — unit
// =================================================================

test("resume resolver: returns undefined when the jobs root does not exist", async () => {
  const found = await findResumableInspectionSession("/nonexistent-glla-root-xyz/jobs", "goal:g1");
  assert.equal(found, undefined);
});

test("resume resolver: picks the newest valid same-subject job", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "glla-resume-pick-"));
  try {
    const jobsRoot = path.join(root, "jobs");
    await makePriorJob(jobsRoot, "audit-old", { subject: "goal:g1", createdAt: "2026-01-01T00:00:00.000Z" });
    await makePriorJob(jobsRoot, "audit-middle", { subject: "goal:g1", createdAt: "2026-01-02T00:00:00.000Z" });
    const newest = await makePriorJob(jobsRoot, "audit-newest", { subject: "goal:g1", createdAt: "2026-01-03T00:00:00.000Z" });
    const other = await makePriorJob(jobsRoot, "audit-other-subject", { subject: "loop:xyz", createdAt: "2026-01-09T00:00:00.000Z" });
    // Newest overall but crashed (no result.json) — must be skipped even
    // though its createdAt beats every valid candidate.
    await makePriorJob(jobsRoot, "audit-crashed", { subject: "goal:g1", createdAt: "2026-01-08T00:00:00.000Z", withResult: false });
    const found = await findResumableInspectionSession(jobsRoot, "goal:g1");
    assert.ok(found);
    assert.equal(found.jobDir, newest);
    assert.equal(found.sessionPath, path.join(newest, "session.jsonl"));
    void other;
  } finally {
    await cleanupRoot(root);
  }
});

test("resume resolver: skips empty and bad-header sessions, missing result, wrong subject", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "glla-resume-skip-"));
  try {
    const jobsRoot = path.join(root, "jobs");
    await makePriorJob(jobsRoot, "empty-session", { subject: "goal:g1", createdAt: "2026-01-01T00:00:00.000Z", session: "empty" });
    await makePriorJob(jobsRoot, "bad-header", { subject: "goal:g1", createdAt: "2026-01-02T00:00:00.000Z", session: "bad-header" });
    await makePriorJob(jobsRoot, "crashed", { subject: "goal:g1", createdAt: "2026-01-03T00:00:00.000Z", withResult: false });
    await makePriorJob(jobsRoot, "wrong-subject", { subject: "goal:other", createdAt: "2026-01-04T00:00:00.000Z" });
    const good = await makePriorJob(jobsRoot, "good", { subject: "goal:g1", createdAt: "2026-01-05T00:00:00.000Z" });
    const found = await findResumableInspectionSession(jobsRoot, "goal:g1");
    assert.ok(found);
    assert.equal(found.jobDir, good);
  } finally {
    await cleanupRoot(root);
  }
});

test("resume resolver: pre-feature jobs match via goalRevision.goalId", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "glla-resume-prefeature-"));
  try {
    const jobsRoot = path.join(root, "jobs");
    const legacy = await makePriorJob(jobsRoot, "legacy-goal", { goalId: "g1", createdAt: "2026-01-01T00:00:00.000Z" });
    const found = await findResumableInspectionSession(jobsRoot, "goal:g1");
    assert.ok(found);
    assert.equal(found.jobDir, legacy);
    // A loop subject never matches a goal job.
    const none = await findResumableInspectionSession(jobsRoot, "loop:anything");
    assert.equal(none, undefined);
  } finally {
    await cleanupRoot(root);
  }
});

test("resume resolver: explicit auditSubject wins over goalRevision", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "glla-resume-explicit-"));
  try {
    const jobsRoot = path.join(root, "jobs");
    // Subject says loop even though a goal token is present — the explicit
    // field is authoritative.
    const dir = await makePriorJob(jobsRoot, "explicit", {
      subject: "loop:run-1",
      goalId: "g1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const foundLoop = await findResumableInspectionSession(jobsRoot, "loop:run-1");
    assert.ok(foundLoop);
    assert.equal(foundLoop.jobDir, dir);
    const foundGoal = await findResumableInspectionSession(jobsRoot, "goal:g1");
    assert.equal(foundGoal, undefined);
  } finally {
    await cleanupRoot(root);
  }
});

test("resume resolver: excludes the current job dir", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "glla-resume-exclude-"));
  try {
    const jobsRoot = path.join(root, "jobs");
    await makePriorJob(jobsRoot, "prior", { subject: "goal:g1", createdAt: "2026-01-01T00:00:00.000Z" });
    const current = await makePriorJob(jobsRoot, "current", { subject: "goal:g1", createdAt: "2026-01-02T00:00:00.000Z" });
    const found = await findResumableInspectionSession(jobsRoot, "goal:g1", current);
    assert.ok(found);
    assert.notEqual(found.jobDir, current);
  } finally {
    await cleanupRoot(root);
  }
});

// =================================================================
// findActiveSameSubjectAudit — durable in-flight complement
// =================================================================

async function makeActiveJob(jobsRoot: string, name: string, opts: {
  subject: string;
  lock: Record<string, unknown> | null;
  withResult?: boolean;
}): Promise<string> {
  const dir = path.join(jobsRoot, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "request.json"), JSON.stringify({
    protocolVersion: 1, attemptId: name, requestHash: "h", cwd: "/tmp/repo",
    prompt: "p", model: "m", thinkingLevel: "low", createdAt: "2026-01-01T00:00:00.000Z",
    auditSubject: opts.subject,
  }));
  if (opts.lock !== null) await writeFile(path.join(dir, "lock"), JSON.stringify(opts.lock));
  if (opts.withResult) await writeFile(path.join(dir, "result.json"), JSON.stringify({ ok: true }));
  return dir;
}

test("active-subject scan: live worker lock without result is found; finished/dead/mismatched are not", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "glla-active-"));
  try {
    const jobsRoot = path.join(root, "jobs");
    const live = await makeActiveJob(jobsRoot, "live-worker", {
      subject: "loop:r1",
      lock: { protocolVersion: 1, attemptId: "live-worker", pid: process.pid, role: "worker", workerPath: "/w" },
    });
    await makeActiveJob(jobsRoot, "finished", {
      subject: "loop:r1",
      lock: { protocolVersion: 1, attemptId: "finished", pid: process.pid, role: "worker", workerPath: "/w" },
      withResult: true,
    });
    await makeActiveJob(jobsRoot, "dead-worker", {
      subject: "loop:r1",
      lock: { protocolVersion: 1, attemptId: "dead-worker", pid: 999999999, role: "worker", workerPath: "/w" },
    });
    await makeActiveJob(jobsRoot, "other-subject", {
      subject: "loop:other",
      lock: { protocolVersion: 1, attemptId: "other-subject", pid: process.pid, role: "worker", workerPath: "/w" },
    });
    const found = await findActiveSameSubjectAudit(jobsRoot, "loop:r1");
    assert.ok(found);
    assert.equal(found.jobDir, live);
    assert.equal(found.pid, process.pid);

    // A live parent lock (worker not yet spawned) also counts as in-flight.
    const parented = await makeActiveJob(jobsRoot, "parent-held", { subject: "loop:r2", lock: { protocolVersion: 1, attemptId: "parent-held", pid: process.pid, role: "parent" } });
    const foundParent = await findActiveSameSubjectAudit(jobsRoot, "loop:r2");
    assert.ok(foundParent);
    assert.equal(foundParent.jobDir, parented);

    // No lock at all — crashed before ownership: not active.
    await makeActiveJob(jobsRoot, "no-lock", { subject: "loop:r3", lock: null });
    assert.equal(await findActiveSameSubjectAudit(jobsRoot, "loop:r3"), undefined);

    // Exclusion of the caller's own dir (post-mkdir pre-spawn window).
    const foundEx = await findActiveSameSubjectAudit(jobsRoot, "loop:r1", live);
    assert.equal(foundEx, undefined);
  } finally {
    await cleanupRoot(root);
  }
});

// =================================================================
// runDetachedGoalCompletionAuditor — seeding integration (fake worker)
// =================================================================

const workerSource = `
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
async function atomicJson(file, value) {
  const temp = file + "." + process.pid + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value));
  try { await rename(temp, file); }
  catch (e) { await rm(temp, { force: true }).catch(() => {}); throw e; }
}
const request = JSON.parse(await readFile(dir + "/request.json", "utf8"));
await atomicJson(dir + "/progress.json", { protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash, phase: "running", elapsedMs: 1, recentOutput: [], toolCalls: [] });
await atomicJson(dir + "/result.json", { protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash, ok: true, output: process.env.FAKE_AUDIT_OUTPUT || "<approved/>", model: request.model, thinkingLevel: request.thinkingLevel, toolCalls: [{ name: "read", argsPrefix: "{}", finishedAt: Date.now() }] });
`;

const testGoal = {
  id: "g-test",
  objective: "Create the audited artifact.",
  status: "active" as const,
  policy: "goal" as const,
  autoContinue: false,
  usage: { tokensUsed: 0, tokensLimit: 0 },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

interface DispatchExtra {
  goal?: typeof testGoal;
  prompt?: string;
  inspection?: boolean;
  auditSubject?: string;
}

async function runDispatch(
  cwd: string,
  workerPath: string,
  attemptId: string,
  extra: DispatchExtra = {},
): Promise<GoalAuditorResult> {
  return runDetachedGoalCompletionAuditor({
    cwd,
    ...(extra.prompt === undefined ? { goal: testGoal } : {}),
    ...extra,
    model: "test/provider-model" satisfies AuditorModel,
    thinkingLevel: "high",
    runtime: { workerPath, pollIntervalMs: 10, attemptId: () => attemptId },
  });
}

async function readRequest(cwd: string, attemptId: string): Promise<Record<string, unknown>> {
  const text = await readFile(path.join(cwd, ".pi-glla", "audit-jobs", attemptId, "request.json"), "utf8");
  return JSON.parse(text);
}

test("inspection dispatch seeds session.jsonl from the newest prior same-subject audit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "glla-resume-int-"));
  const workerPath = path.join(root, "fake-worker.mjs");
  await writeFile(workerPath, workerSource);
  const cwd = path.join(root, "repo");
  await mkdir(cwd, { recursive: true });
  const jobsRoot = path.join(cwd, ".pi-glla", "audit-jobs");
  try {
    // Two prior completed inspection audits of the same goal; the NEWER one
    // is the seed source.
    const older = await makePriorJob(jobsRoot, "prior-older", {
      subject: "goal:g-test",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const newer = await makePriorJob(jobsRoot, "prior-newer", {
      subject: "goal:g-test",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    const historyContent = await readFile(path.join(newer, "session.jsonl"), "utf8");

    const result = await runDispatch(cwd, workerPath, "attempt-resume", { inspection: true });
    assert.equal(result.approved, true);

    const request = await readRequest(cwd, "attempt-resume");
    assert.equal(request.auditSubject, "goal:g-test");
    assert.equal(request.inspectionResumedFrom, "prior-newer");

    const seeded = await readFile(path.join(cwd, ".pi-glla", "audit-jobs", "attempt-resume", "session.jsonl"), "utf8");
    assert.equal(seeded, historyContent);
    void older;
  } finally {
    await cleanupRoot(root);
  }
});

test("inspection dispatch without a prior audit starts fresh (no resume provenance)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "glla-resume-fresh-"));
  const workerPath = path.join(root, "fake-worker.mjs");
  await writeFile(workerPath, workerSource);
  const cwd = path.join(root, "repo");
  await mkdir(cwd, { recursive: true });
  try {
    const result = await runDispatch(cwd, workerPath, "attempt-fresh", { inspection: true });
    assert.equal(result.approved, true);
    const request = await readRequest(cwd, "attempt-fresh");
    assert.equal(request.auditSubject, "goal:g-test");
    assert.equal(request.inspectionResumedFrom, undefined);
  } finally {
    await cleanupRoot(root);
  }
});

test("prompt-only dispatch (loop audits) works and carries its auditSubject", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "glla-resume-loop-"));
  const workerPath = path.join(root, "fake-worker.mjs");
  await writeFile(workerPath, workerSource);
  const cwd = path.join(root, "repo");
  await mkdir(cwd, { recursive: true });
  try {
    const result = await runDispatch(cwd, workerPath, "attempt-loop", {
      prompt: "AUDIT THE LOOP",
      inspection: true,
      auditSubject: "loop:run-1",
    });
    assert.equal(result.approved, true);
    const request = await readRequest(cwd, "attempt-loop");
    assert.equal(request.auditSubject, "loop:run-1");
    assert.equal(request.prompt, "AUDIT THE LOOP");
  } finally {
    await cleanupRoot(root);
  }
});

test("on-disk request.json self-verifies for goal AND prompt-only dispatches (worker identity/hash)", async () => {
  // Regression: a request field that is present-undefined in memory
  // (stableJson hashes it via Object.keys) but dropped by JSON.stringify
  // on disk makes the stored hash unverifiable — the worker then dies
  // with "auditor request hash mismatch" before any pi spawn.
  const root = await mkdtemp(path.join(tmpdir(), "glla-selfverify-"));
  const workerPath = path.join(root, "fake-worker.mjs");
  await writeFile(workerPath, workerSource);
  const cwd = path.join(root, "repo");
  await mkdir(cwd, { recursive: true });
  try {
    for (const [attemptId, extra] of [
      ["attempt-goal-shape", {}],
      ["attempt-prompt-shape", { prompt: "LOOP AUDIT PREAMBLE", inspection: true, auditSubject: "loop:selftest" }],
    ] as const) {
      await runDispatch(cwd, workerPath, attemptId, extra as any);
      const raw = await readFile(
        path.join(cwd, ".pi-glla", "audit-jobs", attemptId, "request.json"),
        "utf8",
      );
      const parsed = JSON.parse(raw) as Record<string, unknown> & { requestHash: string };
      const { requestHash: stored, ...rest } = parsed;
      assert.equal(stored, requestHash(rest as Parameters<typeof requestHash>[0]), `${attemptId}: stored hash must verify against the on-disk bytes`);
    }
  } finally {
    await cleanupRoot(root);
  }
});

test("neither goal nor prompt is an infrastructure failure, not a crash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "glla-resume-none-"));
  const workerPath = path.join(root, "fake-worker.mjs");
  await writeFile(workerPath, workerSource);
  const cwd = path.join(root, "repo");
  await mkdir(cwd, { recursive: true });
  try {
    const result = await runDetachedGoalCompletionAuditor({
      cwd,
      model: "test/provider-model" satisfies AuditorModel,
      thinkingLevel: "high",
      runtime: { workerPath, pollIntervalMs: 10, attemptId: () => "attempt-none" },
    });
    assert.equal(result.approved, false);
    assert.equal(result.disapproved, false);
    assert.ok(/neither a goal nor a prompt/.test(result.error ?? ""));
  } finally {
    await cleanupRoot(root);
  }
});
