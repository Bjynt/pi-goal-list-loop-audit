/**
 * Detached completion-auditor transport.
 *
 * The parent never creates an agent session. It owns a small, durable job in
 * `<cwd>/.pi-glla/audit-jobs/<attemptId>/`, starts the extension-less worker,
 * and accepts only an identity-checked result from that worker.
 */

import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { Goal } from "./goal-loop-core.ts";
import { renderGoalMarkdown } from "./goal-loop-core.ts";
import { checkRegressionShield, parseAuditorVerdict } from "./goal-loop-shield.ts";

export interface GoalAuditorResult {
  approved: boolean;
  disapproved: boolean;
  impossible?: boolean;
  impossibleReason?: string;
  output: string;
  model: string;
  thinkingLevel?: string;
  error?: string;
  regressionShieldPassed?: boolean;
  regressionShieldMissing?: string[];
}

export interface AuditorProgress {
  recentOutput: string[];
  phase: "starting" | "running" | "thinking" | "tool_executing" | "producing_report" | "complete";
  elapsedMs: number;
  label?: string;
  percentage?: number;
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  toolCalls: Array<{ name: string; argsPrefix: string; finishedAt: number }>;
}

export type AuditorModel = string | { provider: string; id: string };

export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;
const PROTOCOL_VERSION = 1;
const DEFAULT_WALL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const ATTEMPT_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;

interface AuditorRequest {
  protocolVersion: number;
  attemptId: string;
  requestHash: string;
  cwd: string;
  prompt: string;
  model: string;
  thinkingLevel: string;
  createdAt: string;
  wallDeadlineAt: number;
}

interface AuditorToolCall {
  name: string;
  argsPrefix: string;
  finishedAt: number;
}

interface AuditorResultFile {
  protocolVersion: number;
  attemptId: string;
  requestHash: string;
  ok: boolean;
  output: string;
  model: string;
  thinkingLevel: string;
  toolCalls: AuditorToolCall[];
  error?: string;
}

interface AuditorProgressFile {
  protocolVersion: number;
  attemptId: string;
  requestHash: string;
  phase: AuditorProgress["phase"];
  elapsedMs: number;
  recentOutput: string[];
  toolCalls: AuditorToolCall[];
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
}

export interface AuditorProcessRuntime {
  /** Override the worker launcher command (normally process.execPath). */
  command?: string;
  /** Override the worker module (normally scripts/goal-auditor-worker.mjs). */
  workerPath?: string;
  /** Override the pi binary without putting it in the request or argv. */
  piBinary?: string;
  /** Override process spawning in bounded tests. */
  spawn?: typeof nodeSpawn;
  pollIntervalMs?: number;
  wallTimeoutMs?: number;
  now?: () => number;
  attemptId?: () => string;
  /** Environment is inherited by default; useful for a fake pi binary in tests. */
  env?: NodeJS.ProcessEnv;
}

export type AuditorProgressCallback = (progress: AuditorProgress) => void;

/** Return a stable JSON representation for request-hash validation. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function requestHash(requestWithoutHash: Omit<AuditorRequest, "requestHash">): string {
  return createHash("sha256").update(stableJson(requestWithoutHash), "utf8").digest("hex");
}

function modelLabel(model: AuditorModel | undefined): string {
  if (typeof model === "string") return model;
  if (model && typeof model === "object") return `${model.provider}/${model.id}`;
  return "(unset)";
}

function buildPrompt(goal: Goal, completionSummary?: string | null, verificationSummary?: string | null): string {
  const shieldGaps = [...(goal.auditHistory ?? [])].reverse().find((v) => v.regressionShieldPassed === false)?.regressionShieldMissing;
  return [
    "You are the independent completion auditor for pi-goal-list-loop-audit.",
    "The executor claims the goal is complete. Decide whether the user's objective is actually satisfied.",
    "Be skeptical and semantic. Inspect real artifacts with read/grep/find/ls/bash. Never modify files.",
    "Do not approve a scaffold, shallow draft, paperwork-only claim, or weakly verified requirement.",
    "Return a concise report. The final line MUST be exactly one of:",
    "<approved/>",
    "<disapproved/>",
    "<impossible>one-line reason</impossible>",
    "Use <impossible> only when the objective can never be satisfied as stated.",
    "When disapproving, end with ## Required fixes and one actionable line per blocking gap.",
    ...(goal.verificationContract?.trim() ? [
      "Because this goal has a verification contract, an approval MUST include an <evidence> block.",
      "For every contract item, name the item and paste raw output from a read-only tool (not a paraphrase).",
    ] : []),
    ...(shieldGaps?.length ? ["A previous approval lacked evidence for:", ...shieldGaps.map((item) => `- ${item}`)] : []),
    "",
    "<goal>", renderGoalMarkdown(goal), "</goal>",
    "<completion_summary>", completionSummary?.trim() || "(none provided)", "</completion_summary>",
    ...(verificationSummary?.trim() ? ["<verification_summary>", verificationSummary.trim(), "</verification_summary>"] : []),
    ...(goal.verificationContract?.trim() ? ["<verification_contract>", goal.verificationContract.trim(), "</verification_contract>"] : []),
  ].join("\n");
}

function assertAttemptId(attemptId: string): void {
  if (!ATTEMPT_ID_RE.test(attemptId)) throw new Error("invalid auditor attempt id");
}

async function ensureRegularFile(file: string): Promise<void> {
  const stat = await fs.lstat(file);
  if (!stat.isFile()) throw new Error(`auditor protocol path is not a regular file: ${file}`);
}

async function readJson<T>(file: string): Promise<T> {
  await ensureRegularFile(file);
  const text = await fs.readFile(file, "utf8");
  return JSON.parse(text) as T;
}

/** Write JSON so readers see either the old file or the complete new file. */
export async function writeAtomicJson(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function acquireLock(lockPath: string, attemptId: string): Promise<void> {
  const handle = await fs.open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, attemptId, pid: process.pid })}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

function defaultWorkerPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/goal-auditor-worker.mjs");
}

function childAlive(child: ChildProcess): boolean {
  return child.exitCode === null && !child.killed;
}

function asProgress(file: AuditorProgressFile, startedAt: number): AuditorProgress {
  return {
    phase: file.phase,
    elapsedMs: Math.max(file.elapsedMs, Date.now() - startedAt),
    recentOutput: file.recentOutput,
    toolCalls: file.toolCalls,
    ...(file.currentTool ? { currentTool: file.currentTool } : {}),
    ...(file.currentToolArgs ? { currentToolArgs: file.currentToolArgs } : {}),
    ...(file.currentToolStartedAt ? { currentToolStartedAt: file.currentToolStartedAt } : {}),
  };
}

function infra(model: string, thinkingLevel: string, error: string, output = ""): GoalAuditorResult {
  return { approved: false, disapproved: false, output, model, thinkingLevel, error };
}

/**
 * Run one completion audit in a detached, extension-less child process.
 * Infrastructure failures never become semantic disapprovals and never fall
 * back to an in-process session.
 */
export async function runDetachedGoalCompletionAuditor(args: {
  cwd: string;
  goal: Goal;
  completionSummary?: string | null;
  verificationSummary?: string | null;
  model?: AuditorModel;
  thinkingLevel?: string;
  signal?: AbortSignal;
  onProgress?: AuditorProgressCallback;
  runtime?: AuditorProcessRuntime;
}): Promise<GoalAuditorResult> {
  const runtime = args.runtime ?? {};
  const model = modelLabel(args.model);
  const thinkingLevel = args.thinkingLevel ?? "medium";
  if (!args.model || !model.trim() || model === "(unset)") return infra(model, thinkingLevel, "no auditor model");

  const now = runtime.now ?? Date.now;
  const wallTimeoutMs = runtime.wallTimeoutMs ?? DEFAULT_WALL_TIMEOUT_MS;
  const pollIntervalMs = Math.max(10, runtime.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const attemptId = runtime.attemptId?.() ?? `${Date.now().toString(36)}-${randomUUID()}`;
  try {
    assertAttemptId(attemptId);
  } catch (error) {
    return infra(model, thinkingLevel, error instanceof Error ? error.message : String(error));
  }

  const jobDir = path.resolve(args.cwd, ".pi-glla", "audit-jobs", attemptId);
  const jobsRoot = path.dirname(jobDir);
  const requestPath = path.join(jobDir, "request.json");
  const resultPath = path.join(jobDir, "result.json");
  const progressPath = path.join(jobDir, "progress.json");
  const lockPath = path.join(jobDir, "lock");
  const startedAt = now();
  const wallDeadlineAt = startedAt + wallTimeoutMs;
  let lockHeld = false;
  let child: ChildProcess | undefined;
  let lastProgressSerialized = "";

  try {
    await fs.mkdir(jobsRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(jobDir, { mode: 0o700 });
    await acquireLock(lockPath, attemptId);
    lockHeld = true;

    const requestWithoutHash: Omit<AuditorRequest, "requestHash"> = {
      protocolVersion: PROTOCOL_VERSION,
      attemptId,
      cwd: args.cwd,
      prompt: buildPrompt(args.goal, args.completionSummary, args.verificationSummary),
      model,
      thinkingLevel,
      createdAt: new Date(startedAt).toISOString(),
      wallDeadlineAt,
    };
    const request: AuditorRequest = { ...requestWithoutHash, requestHash: requestHash(requestWithoutHash) };
    await writeAtomicJson(requestPath, request);
    const initialProgress: AuditorProgressFile = {
      protocolVersion: PROTOCOL_VERSION, attemptId, requestHash: request.requestHash,
      phase: "starting", elapsedMs: 0, recentOutput: [], toolCalls: [],
    };
    await writeAtomicJson(progressPath, initialProgress);
    args.onProgress?.(asProgress(initialProgress, startedAt));

    const workerPath = runtime.workerPath ?? defaultWorkerPath();
    const command = runtime.command ?? process.execPath;
    const spawn = runtime.spawn ?? nodeSpawn;
    const env = { ...process.env, ...(runtime.env ?? {}) };
    if (runtime.piBinary) env.GLLA_PI_BINARY = runtime.piBinary;
    child = spawn(command, [workerPath, "--job-dir", jobDir], {
      cwd: args.cwd,
      detached: true,
      stdio: "ignore",
      env,
    } satisfies SpawnOptions);
    child.unref();

    const abort = () => { if (child && childAlive(child)) child.kill("SIGTERM"); };
    args.signal?.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        if (args.signal?.aborted) return infra(model, thinkingLevel, "Auditor aborted.");
        if (now() >= wallDeadlineAt) {
          if (childAlive(child)) child.kill("SIGTERM");
          return infra(model, thinkingLevel, `Auditor exceeded its ${Math.round(wallTimeoutMs / 60_000)}m wall-clock bound and was aborted.`);
        }
        try {
          const progress = await readJson<AuditorProgressFile>(progressPath);
          if (progress.protocolVersion !== PROTOCOL_VERSION || progress.attemptId !== attemptId || progress.requestHash !== request.requestHash) {
            return infra(model, thinkingLevel, "auditor progress identity/request-hash mismatch");
          }
          const serialized = stableJson(progress);
          if (serialized !== lastProgressSerialized) {
            lastProgressSerialized = serialized;
            args.onProgress?.(asProgress(progress, startedAt));
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return infra(model, thinkingLevel, `invalid auditor progress: ${error instanceof Error ? error.message : String(error)}`);
        }
        try {
          const result = await readJson<AuditorResultFile>(resultPath);
          if (result.protocolVersion !== PROTOCOL_VERSION || result.attemptId !== attemptId || result.requestHash !== request.requestHash) {
            return infra(model, thinkingLevel, "auditor result identity/request-hash mismatch");
          }
          if (!result.ok) return infra(model, thinkingLevel, result.error || "detached auditor failed", result.output);
          const output = result.output;
          if (!output.trim()) return infra(model, thinkingLevel, "auditor produced no output");
          const parsed = parseAuditorVerdict(output);
          if (!parsed.approved && !parsed.disapproved && !parsed.impossible) return infra(model, thinkingLevel, "auditor produced no verdict marker");
          const usedReadTool = result.toolCalls.some((call) => (READ_ONLY_TOOLS as readonly string[]).includes(call.name));
          if (parsed.approved && !usedReadTool) {
            return { approved: false, disapproved: true, output, model, thinkingLevel, error: "Auditor approved without calling any read-only tool; treated as disapproved." };
          }
          if (parsed.approved && args.goal.verificationContract?.trim()) {
            const shield = checkRegressionShield(output, args.goal.verificationContract);
            if (!shield.passed) {
              const why = !shield.hasEvidenceBlock ? "report has no <evidence> block" : `report's evidence does not address: ${shield.missingItems.join("; ")}`;
              return {
                approved: false, disapproved: true, output, model, thinkingLevel,
                error: `regression_shield: approved but ${why}`,
                regressionShieldPassed: false, regressionShieldMissing: shield.missingItems,
              };
            }
            args.onProgress?.({ phase: "complete", elapsedMs: now() - startedAt, recentOutput: output.split("\n").filter(Boolean).slice(-8), toolCalls: result.toolCalls });
            return { approved: true, disapproved: false, output, model, thinkingLevel, regressionShieldPassed: true };
          }
          args.onProgress?.({ phase: "complete", elapsedMs: now() - startedAt, recentOutput: output.split("\n").filter(Boolean).slice(-8), toolCalls: result.toolCalls });
          return { approved: parsed.approved, disapproved: parsed.disapproved, impossible: parsed.impossible, impossibleReason: parsed.impossibleReason, output, model, thinkingLevel };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return infra(model, thinkingLevel, `invalid auditor result: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (child && !childAlive(child)) return infra(model, thinkingLevel, "auditor worker exited without an atomic result");
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    } finally {
      args.signal?.removeEventListener("abort", abort);
    }
  } catch (error) {
    return infra(model, thinkingLevel, error instanceof Error ? error.message : String(error));
  } finally {
    if (lockHeld) await fs.unlink(lockPath).catch(() => {});
  }
}

export { buildPrompt as buildGoalAuditorPrompt };
