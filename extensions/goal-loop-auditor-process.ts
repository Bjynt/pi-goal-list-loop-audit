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

import { stripThinkBlocks, captureGoalRevision, type Goal, type GoalRevisionToken } from "./goal-loop-core.js";
import { buildGoalAuditorPrompt } from "./goal-loop-auditor.js";
import { checkRegressionShield, parseAuditorVerdict } from "./goal-loop-shield.js";

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
  /** v0.34.59: focus revision token echoed from request.json. The parent
   * compares this against the current state.goal.revision after the audit
   * finishes; mismatch → the verdict is treated as stale-refused, not a
   * silent overwrite. The caller decides what to do (typically: skip the
   * verdict, log stale_revision_refused, surface the refusal in the HUD). */
  goalRevision?: GoalRevisionToken;
}

export interface AuditorProgress {
  recentOutput: string[];
  phase: "starting" | "running" | "thinking" | "tool_executing" | "producing_report" | "complete";
  elapsedMs: number;
  /** v0.34.86: monotonic report-stream byte count (text_delta chars). */
  reportBytes?: number;
  /** Timestamp of the last real RPC/session event observed by the worker. */
  lastActivityAt?: number;
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  /** v0.34.56: the toolCallId of the open start (undefined when the start
   * event carried none — the missing-toolCallId shape). */
  currentToolId?: string;
  toolCalls: Array<{ name: string; argsPrefix: string; finishedAt: number }>;
  /** v0.34.56: explicitly unmatched tool starts/ends — see
   * applyToolExecutionEvent (goal-loop-auditor.ts) and the worker's mirror
   * in scripts/goal-auditor-worker.mjs. Never dropped, never falsely paired. */
  unmatchedToolStarts: Array<{ name: string; argsPrefix: string; startedAt: number; toolCallId?: string }>;
  unmatchedToolEnds: Array<{ toolCallId?: string; toolName?: string; at: number }>;
}

export type AuditorModel = string | { provider: string; id: string };

// Detached completion auditors must never receive a shell or project-trust
// override. Repository content is untrusted input, so the allowlist itself is
// the security boundary rather than a prompt request to "please don't mutate".
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const PROTOCOL_VERSION = 1;
const DEFAULT_WALL_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
/** v0.34.57 (steal-list #7 / bug #1.4): heartbeat-without-progress watchdog.
 * A worker heartbeat (`lastActivityAt`) fresher than this is "activity";
 * older than this is "silence" (the worker's own GLLA_AUDITOR_STALL_MS
 * brake owns that case — the parent watchdog must not double-fire it). */
const DEFAULT_HEARTBEAT_FRESH_MS = 60_000;
/** v0.34.57: if the heartbeat stays fresh but no NEW tool call or report
 * output arrives for this long, the worker is alive but wedged (auto-retry
 * loop, empty stream, hung tool). Demote to quiet, emit `auditor_stalled`,
 * and auto-cancel the detached job. Mirrors the worker's 10m default brake
 * on the complementary axis: silence→worker cancels, activity-without-
 * progress→parent cancels. Both are far inside the 30m wall bound and the
 * observed 1h50m stuck case. */
const DEFAULT_HEARTBEAT_NO_PROGRESS_MS = 10 * 60_000;
const ATTEMPT_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
const activeChildren = new Map<string, ChildProcess>();

/**
 * Give each detached filesystem/child attempt a fresh identity while keeping
 * the logical completion claim visible as its prefix. A retried worker must
 * not collide with a stale job directory, and the parent still uses the
 * logical claim ID for stale-result rejection.
 */
export function newDetachedAuditJobAttemptId(logicalAttemptId: string): string {
  return `${logicalAttemptId}-${Date.now().toString(36)}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function childKey(cwd: string, attemptId: string): string {
  return `${path.resolve(cwd)}\u0000${attemptId}`;
}

/** Best-effort cancellation used after the owning goal is archived/cancelled. */
export function cancelDetachedGoalCompletionAuditor(cwd: string, attemptId: string): boolean {
  const root = path.resolve(cwd);
  const exact = childKey(root, attemptId);
  const retryPrefix = `${exact}-`;
  let killed = false;
  // Completion state keeps the logical claim attempt ID, while each detached
  // retry owns a unique filesystem/child identity (`<logical>-<nonce>`). Kill
  // both the exact legacy identity and every live retry for this claim.
  for (const [key, child] of activeChildren) {
    if (key !== exact && !key.startsWith(retryPrefix)) continue;
    if (!childAlive(child)) continue;
    try {
      killed = child.kill("SIGTERM") || killed;
    } catch {
      /* best effort — the worker's wall bound remains the final brake */
    }
  }
  return killed;
}

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
  /** v0.34.59: focus revision token captured at dispatch. Echoed in
   * result.json; the parent re-validates against current disk state
   * before applying the verdict. Mismatch → stale-refusal, not a silent
   * overwrite. */
  goalRevision?: GoalRevisionToken;
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
  /** v0.34.59: focus revision token echoed from request.json. The parent
   * compares this against the current state.goal.revision; mismatch → the
   * verdict is treated as stale-refused, not a silent overwrite. */
  goalRevision?: GoalRevisionToken;
}

interface AuditorProgressFile {
  protocolVersion: number;
  attemptId: string;
  requestHash: string;
  phase: AuditorProgress["phase"];
  elapsedMs: number;
  /** v0.34.86: monotonic report-stream byte count (text_delta chars). The
   * silent-mode byte counter — the "worker IS making progress" evidence
   * that never reveals prose. */
  reportBytes?: number;
  /** Worker-side activity, not merely a parent poll or UI refresh. */
  lastActivityAt?: number;
  recentOutput: string[];
  toolCalls: AuditorToolCall[];
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  /** v0.34.56: explicitly unmatched tool telemetry facts (see
   * applyToolExecutionEvent in goal-loop-auditor.ts). */
  unmatchedToolStarts?: AuditorProgress["unmatchedToolStarts"];
  unmatchedToolEnds?: AuditorProgress["unmatchedToolEnds"];
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
  /** v0.34.57: watchdog window — cancel the detached job when the worker's
   * heartbeat stays fresh but no new tool call or report output arrives for
   * this long (default 10m). Tests shrink this. */
  heartbeatNoProgressMs?: number;
  /** v0.34.57: freshness horizon for `lastActivityAt` — only heartbeats
   * younger than this count as "activity" for the watchdog (default 60s). */
  heartbeatFreshMs?: number;
  /** v0.34.130: independent ceiling for one allowed read-only tool call.
   * This remains armed while the tool is open, unlike the inactivity brake. */
  toolTimeoutMs?: number;
  /** Environment is inherited by default; useful for a fake pi binary in tests. */
  env?: NodeJS.ProcessEnv;
}

export type AuditorProgressCallback = (progress: AuditorProgress) => void;

/** v0.34.57: payload for the heartbeat-without-progress watchdog. The parent
 * persists this as the `auditor_stalled` ledger event. */
export interface AuditorStalledInfo {
  /** When the watchdog fired. */
  at: number;
  /** Which independent watchdog fired. */
  reason: "heartbeat-no-progress" | "tool-timeout";
  /** Age of the last worker heartbeat at detection (`now - lastActivityAt`).
   * For heartbeat-no-progress this is fresh (≤ heartbeatFreshMs); a
   * tool-timeout may deliberately have a stale heartbeat. */
  heartbeatAgeMs: number;
  /** How long the no-progress/tool-open streak had been running. */
  noProgressMs: number;
  /** The worker phase in the last progress snapshot. */
  phase: AuditorProgress["phase"];
  /** Present when the tool-timeout watchdog fired. */
  toolName?: string;
  toolAgeMs?: number;
}

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
  return buildGoalAuditorPrompt(goal, completionSummary, verificationSummary);
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
    ...(file.reportBytes !== undefined ? { reportBytes: file.reportBytes } : {}),
    ...(file.lastActivityAt !== undefined ? { lastActivityAt: file.lastActivityAt } : {}),
    recentOutput: file.recentOutput,
    toolCalls: file.toolCalls,
    unmatchedToolStarts: file.unmatchedToolStarts ?? [],
    unmatchedToolEnds: file.unmatchedToolEnds ?? [],
    ...(file.currentTool ? { currentTool: file.currentTool } : {}),
    ...(file.currentToolArgs ? { currentToolArgs: file.currentToolArgs } : {}),
    ...(file.currentToolStartedAt ? { currentToolStartedAt: file.currentToolStartedAt } : {}),
    ...(file.unmatchedToolStarts ? { unmatchedToolStarts: file.unmatchedToolStarts } : {}),
    ...(file.unmatchedToolEnds ? { unmatchedToolEnds: file.unmatchedToolEnds } : {}),
  };
}

/** v0.34.57: the progress-bearing subset of a worker snapshot. Heartbeat
 * events refresh `lastActivityAt` and may oscillate `phase` (running ↔
 * thinking on message_start/agent_start) without delivering progress — this
 * signature deliberately excludes both, so only a NEW finished tool call,
 * new report output, or a NEW tool start counts as progress. */
function progressSignature(file: AuditorProgressFile): string {
  const calls = file.toolCalls;
  const lastToolFinishedAt = calls.length > 0 ? (calls[calls.length - 1]?.finishedAt ?? 0) : 0;
  return `${calls.length}|${lastToolFinishedAt}|${file.recentOutput.join("\u0000")}|${file.currentTool ?? ""}|${file.currentToolStartedAt ?? 0}`;
}

function infra(model: string, thinkingLevel: string, error: string, output = "", capturedToken?: GoalRevisionToken): GoalAuditorResult {
  return { approved: false, disapproved: false, output, model, thinkingLevel, error, ...(capturedToken ? { goalRevision: capturedToken } : {}) };
}

/** v0.34.59: stamp the captured focus revision onto a successful verdict
 * result so the parent can re-validate before applying. Mismatched tokens
 * cause the verdict to be refused (logged as stale_revision_refused in the
 * parent) rather than silently overwriting a goal that moved on. */
function stampToken<T extends GoalAuditorResult>(result: T, capturedToken: GoalRevisionToken | undefined): T {
  if (!capturedToken) return result;
  return { ...result, goalRevision: capturedToken };
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
  /** v0.34.57: fired once when the heartbeat-without-progress watchdog
   * detects a wedged worker and auto-cancels the detached job. The parent
   * persists this as the `auditor_stalled` ledger event. */
  onStalled?: (info: AuditorStalledInfo) => void;
  runtime?: AuditorProcessRuntime;
}): Promise<GoalAuditorResult> {
  const runtime = args.runtime ?? {};
  const model = modelLabel(args.model);
  const thinkingLevel = args.thinkingLevel ?? "medium";
  if (!args.model || !model.trim() || model === "(unset)") return infra(model, thinkingLevel, "no auditor model");

  const now = runtime.now ?? Date.now;
  const wallTimeoutMs = runtime.wallTimeoutMs ?? DEFAULT_WALL_TIMEOUT_MS;
  const pollIntervalMs = Math.max(10, runtime.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const heartbeatFreshMs = Math.max(10, runtime.heartbeatFreshMs ?? DEFAULT_HEARTBEAT_FRESH_MS);
  const heartbeatNoProgressMs = Math.max(50, runtime.heartbeatNoProgressMs ?? DEFAULT_HEARTBEAT_NO_PROGRESS_MS);
  const configuredToolTimeoutMs = runtime.toolTimeoutMs;
  const toolTimeoutMs = configuredToolTimeoutMs === undefined || !Number.isFinite(configuredToolTimeoutMs)
    ? DEFAULT_TOOL_TIMEOUT_MS
    : Math.max(50, configuredToolTimeoutMs);
  const attemptId = runtime.attemptId?.() ?? `${Date.now().toString(36)}-${randomUUID()}`;
  // v0.34.59: capture the focus revision token at dispatch. Every result
  // shape returned to the parent carries this token so the parent can
  // re-validate before applying a verdict. Pre-revision goals pass through
  // unchanged (captured is null).
  const capturedRevisionToken: GoalRevisionToken | undefined = captureGoalRevision(args.goal) ?? undefined;
  try {
    assertAttemptId(attemptId);
  } catch (error) {
    return infra(model, thinkingLevel, error instanceof Error ? error.message : String(error), "", capturedRevisionToken);
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
  // v0.34.57: heartbeat-without-progress watchdog state. `lastProgressAt` is
  // reset whenever the progress signature changes; the watchdog fires when
  // the worker heartbeat stays fresh but the signature has not changed for
  // `heartbeatNoProgressMs` — the worker is alive but wedged.
  let lastProgressAt = startedAt;
  let lastProgressSignature = "";
  let lastProgress: AuditorProgressFile | undefined;

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
      // v0.34.59: capture the focus revision token at dispatch. The
      // worker echoes it in result.json; the parent re-validates before
      // applying the verdict. A stale-handle ghost can no longer silently
      // overwrite a goal that moved on.
      goalRevision: capturedRevisionToken,
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
    activeChildren.set(childKey(args.cwd, attemptId), child);
    child.unref();

    const abort = () => { if (child && childAlive(child)) child.kill("SIGTERM"); };
    args.signal?.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        if (args.signal?.aborted) return infra(model, thinkingLevel, "Auditor aborted.", "", capturedRevisionToken);
        if (now() >= wallDeadlineAt) {
          if (childAlive(child)) child.kill("SIGTERM");
          return infra(model, thinkingLevel, `Auditor exceeded its ${Math.round(wallTimeoutMs / 60_000)}m wall-clock bound and was aborted.`, "", capturedRevisionToken);
        }
        try {
          const progress = await readJson<AuditorProgressFile>(progressPath);
          if (progress.protocolVersion !== PROTOCOL_VERSION || progress.attemptId !== attemptId || progress.requestHash !== request.requestHash) {
            return infra(model, thinkingLevel, "auditor progress identity/request-hash mismatch", "", capturedRevisionToken);
          }
          lastProgress = progress;
          const serialized = stableJson(progress);
          if (serialized !== lastProgressSerialized) {
            lastProgressSerialized = serialized;
            args.onProgress?.(asProgress(progress, startedAt));
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return infra(model, thinkingLevel, `invalid auditor progress: ${error instanceof Error ? error.message : String(error)}`, "", capturedRevisionToken);
        }
        try {
          const result = await readJson<AuditorResultFile>(resultPath);
          if (result.protocolVersion !== PROTOCOL_VERSION || result.attemptId !== attemptId || result.requestHash !== request.requestHash) {
            return infra(model, thinkingLevel, "auditor result identity/request-hash mismatch", "", capturedRevisionToken);
          }
          const output = stripThinkBlocks(result.output);
          if (!result.ok) return infra(model, thinkingLevel, result.error || "detached auditor failed", output, capturedRevisionToken);
          if (!output.trim()) return infra(model, thinkingLevel, "auditor produced no output", output, capturedRevisionToken);
          const parsed = parseAuditorVerdict(output);
          if (!parsed.approved && !parsed.disapproved && !parsed.impossible) return infra(model, thinkingLevel, "auditor produced no verdict marker", output, capturedRevisionToken);
          const usedReadTool = result.toolCalls.some((call) => (READ_ONLY_TOOLS as readonly string[]).includes(call.name));
          if (parsed.approved && !usedReadTool) {
            return stampToken({ approved: false, disapproved: true, output, model, thinkingLevel, error: "Auditor approved without calling any read-only tool; treated as disapproved." }, capturedRevisionToken);
          }
          if (parsed.approved && args.goal.verificationContract?.trim()) {
            const shield = checkRegressionShield(output, args.goal.verificationContract);
            if (!shield.passed) {
              // The auditor's semantic verdict was approval; the separate
              // regression shield blocked acceptance because the report did
              // not cite every contract item. Keep that outcome distinct from
              // both a work disapproval and infrastructure failure.
              return stampToken({
                approved: true, disapproved: false, output, model, thinkingLevel,
                regressionShieldPassed: false, regressionShieldMissing: shield.missingItems,
              }, capturedRevisionToken);
            }
            args.onProgress?.({ phase: "complete", elapsedMs: now() - startedAt, recentOutput: output.split("\n").filter(Boolean).slice(-8), toolCalls: result.toolCalls, unmatchedToolStarts: [], unmatchedToolEnds: [] });
            return stampToken({ approved: true, disapproved: false, output, model, thinkingLevel, regressionShieldPassed: true }, capturedRevisionToken);
          }
          args.onProgress?.({ phase: "complete", elapsedMs: now() - startedAt, recentOutput: output.split("\n").filter(Boolean).slice(-8), toolCalls: result.toolCalls, unmatchedToolStarts: [], unmatchedToolEnds: [] });
          return stampToken({ approved: parsed.approved, disapproved: parsed.disapproved, impossible: parsed.impossible, impossibleReason: parsed.impossibleReason, output, model, thinkingLevel }, capturedRevisionToken);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return infra(model, thinkingLevel, `invalid auditor result: ${error instanceof Error ? error.message : String(error)}`, "", capturedRevisionToken);
        }
        // v0.34.130: a tool-open timeout is independent of both heartbeat
        // freshness and the worker's inactivity brake. A stuck read/grep/find/
        // ls call emits no further RPC event, so neither heartbeat axis can
        // safely own its termination. Keep the detached job bounded well
        // inside the 30m wall.
        if (lastProgress?.currentToolStartedAt !== undefined) {
          const toolAgeMs = Math.max(0, now() - lastProgress.currentToolStartedAt);
          if (toolAgeMs >= toolTimeoutMs) {
            args.onProgress?.({
              phase: "running",
              elapsedMs: now() - startedAt,
              recentOutput: lastProgress.recentOutput,
              toolCalls: lastProgress.toolCalls,
              unmatchedToolStarts: lastProgress.unmatchedToolStarts ?? [],
              unmatchedToolEnds: lastProgress.unmatchedToolEnds ?? [],
            });
            const toolLabel = toolTimeoutMs >= 60_000
              ? `${Math.max(1, Math.round(toolTimeoutMs / 60_000))}m`
              : `${Math.max(1, Math.round(toolTimeoutMs / 1_000))}s`;
            args.onStalled?.({
              at: now(),
              reason: "tool-timeout",
              heartbeatAgeMs: lastProgress.lastActivityAt === undefined ? toolAgeMs : Math.max(0, now() - lastProgress.lastActivityAt),
              noProgressMs: toolAgeMs,
              phase: lastProgress.phase,
              toolName: lastProgress.currentTool,
              toolAgeMs,
            });
            if (child && childAlive(child)) child.kill("SIGTERM");
            return infra(model, thinkingLevel, `Auditor stalled — read-only tool ${lastProgress.currentTool ?? "unknown"} exceeded its ${toolLabel} timeout; the detached job was auto-cancelled.`, "", capturedRevisionToken);
          }
        }
        // v0.34.57: heartbeat-without-progress watchdog (steal-list #7 /
        // bug #1.4). The worker's own stall brake only fires on TOTAL silence
        // (and skips it while a read-only tool is running); a worker that
        // keeps emitting RPC events — auto-retry loops, empty message
        // updates, a hung tool — refreshes `lastActivityAt` forever without
        // delivering any new tool call or report output. That is the 1h50m
        // "alive but wedged" class: fail fast instead.
        if (lastProgress && lastProgress.lastActivityAt !== undefined && now() - lastProgress.lastActivityAt <= heartbeatFreshMs) {
          const signature = progressSignature(lastProgress);
          if (signature !== lastProgressSignature) {
            lastProgressSignature = signature;
            lastProgressAt = now();
          }
          const noProgressMs = now() - lastProgressAt;
          if (noProgressMs >= heartbeatNoProgressMs) {
            // Demote to quiet first: a final progress snapshot WITHOUT the
            // live heartbeat, so the HUD cannot render LIVE + "worker activity
            // 0s ago" for the wedged worker.
            args.onProgress?.({
              phase: "running",
              elapsedMs: now() - startedAt,
              recentOutput: lastProgress.recentOutput,
              toolCalls: lastProgress.toolCalls,
              unmatchedToolStarts: lastProgress.unmatchedToolStarts ?? [],
              unmatchedToolEnds: lastProgress.unmatchedToolEnds ?? [],
            });
            const stallLabel = heartbeatNoProgressMs >= 60_000
              ? `${Math.max(1, Math.round(heartbeatNoProgressMs / 60_000))}m`
              : `${Math.max(1, Math.round(heartbeatNoProgressMs / 1_000))}s`;
            args.onStalled?.({
              at: now(),
              reason: "heartbeat-no-progress",
              heartbeatAgeMs: now() - lastProgress.lastActivityAt,
              noProgressMs,
              phase: lastProgress.phase,
            });
            if (child && childAlive(child)) child.kill("SIGTERM");
            return infra(model, thinkingLevel, `Auditor stalled — heartbeats without progress for ${stallLabel} (no new tool call or output); the detached job was auto-cancelled.`, "", capturedRevisionToken);
          }
        }
        if (child && !childAlive(child)) return infra(model, thinkingLevel, "auditor worker exited without an atomic result", "", capturedRevisionToken);
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    } finally {
      args.signal?.removeEventListener("abort", abort);
    }
  } catch (error) {
    return infra(model, thinkingLevel, error instanceof Error ? error.message : String(error), "", capturedRevisionToken);
  } finally {
    activeChildren.delete(childKey(args.cwd, attemptId));
    if (lockHeld) await fs.unlink(lockPath).catch(() => {});
  }
}

export { buildPrompt as buildGoalAuditorPrompt };
