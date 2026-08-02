#!/usr/bin/env node
/**
 * Detached auditor worker. This file intentionally has no project imports:
 * the parent gives it one validated job directory and it launches a clean pi
 * RPC process with read-only tools only.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const PROTOCOL_VERSION = 1;
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "bash"]);

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function hashRequest(request) {
  const { requestHash: ignored, ...withoutHash } = request;
  return createHash("sha256").update(stableJson(withoutHash), "utf8").digest("hex");
}

async function regular(file) {
  const stat = await lstat(file);
  if (!stat.isFile()) throw new Error(`not a regular protocol file: ${file}`);
}

async function readJson(file) {
  await regular(file);
  return JSON.parse(await readFile(file, "utf8"));
}

async function atomicJson(file, value) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function jobDirArg() {
  const index = process.argv.indexOf("--job-dir");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || !path.isAbsolute(value)) throw new Error("worker requires an absolute --job-dir");
  return path.resolve(value);
}

function identity(request, attemptId) {
  if (request.protocolVersion !== PROTOCOL_VERSION) throw new Error("unsupported auditor protocol version");
  if (request.attemptId !== attemptId) throw new Error("auditor request attempt identity mismatch");
  if (typeof request.requestHash !== "string" || request.requestHash !== hashRequest(request)) throw new Error("auditor request hash mismatch");
  if (typeof request.cwd !== "string" || !path.isAbsolute(request.cwd)) throw new Error("auditor request cwd is not absolute");
  if (typeof request.prompt !== "string" || !request.prompt) throw new Error("auditor request prompt is empty");
  if (typeof request.model !== "string" || !request.model) throw new Error("auditor request model is empty");
  if (typeof request.thinkingLevel !== "string" || !request.thinkingLevel) throw new Error("auditor request thinking level is empty");
  if (!Number.isFinite(request.wallDeadlineAt)) throw new Error("auditor request deadline is invalid");
}

function toolArgsPrefix(args) {
  try { return JSON.stringify(args ?? {}).slice(0, 120); } catch { return ""; }
}

async function main() {
  const jobDir = jobDirArg();
  const requestPath = path.join(jobDir, "request.json");
  const resultPath = path.join(jobDir, "result.json");
  const progressPath = path.join(jobDir, "progress.json");
  const lockPath = path.join(jobDir, "lock");
  const attemptId = path.basename(jobDir);
  await regular(lockPath);
  const request = await readJson(requestPath);
  identity(request, attemptId);

  const startedAt = Date.now();
  const toolCalls = [];
  const recentOutput = [];
  const outputParts = [];
  const activeTools = new Map();
  let currentTool;
  let currentToolArgs;
  let currentToolStartedAt;
  let finalized = false;
  let pi;
  let deadlineTimer;

  const progress = async (phase = "running") => {
    const file = {
      protocolVersion: PROTOCOL_VERSION,
      attemptId,
      requestHash: request.requestHash,
      phase,
      elapsedMs: Date.now() - startedAt,
      recentOutput: recentOutput.slice(-8),
      toolCalls: toolCalls.slice(),
      ...(currentTool ? { currentTool } : {}),
      ...(currentToolArgs ? { currentToolArgs } : {}),
      ...(currentToolStartedAt ? { currentToolStartedAt } : {}),
    };
    await atomicJson(progressPath, file);
  };

  const finish = async (ok, error = "") => {
    if (finalized) return;
    finalized = true;
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (pi && pi.exitCode === null) pi.kill("SIGTERM");
    const result = {
      protocolVersion: PROTOCOL_VERSION,
      attemptId,
      requestHash: request.requestHash,
      ok,
      output: outputParts.join("\n"),
      model: request.model,
      thinkingLevel: request.thinkingLevel,
      toolCalls,
      ...(error ? { error: error.slice(0, 500) } : {}),
    };
    await atomicJson(resultPath, result);
    await progress("complete").catch(() => {});
  };

  try {
    if (Date.now() >= request.wallDeadlineAt) {
      await finish(false, "auditor deadline expired before launch");
      return;
    }
    await progress("starting");

    const piBinary = process.env.GLLA_PI_BINARY || "pi";
    const piArgs = [
      "--mode", "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--approve",
      "--tools", "read,grep,find,ls,bash",
      "--model", request.model,
      "--thinking", request.thinkingLevel,
    ];
    pi = spawn(piBinary, piArgs, {
      cwd: request.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const remaining = Math.max(1, request.wallDeadlineAt - Date.now());
    deadlineTimer = setTimeout(() => {
      void finish(false, "auditor wall-clock deadline exceeded");
    }, remaining);
    deadlineTimer.unref?.();

    // RPC is a strict LF-delimited JSON stream. Do not use readline here:
    // its CRLF normalization accepts transport corruption that the worker
    // protocol deliberately rejects, and it can obscure an unterminated final
    // record. Buffer arbitrary chunks, reject raw CR, and process only complete
    // LF-terminated records. agent_end is intentionally not terminal: Pi may
    // retry/compact/follow up after it. agent_settled is the completion event.
    let stdoutBuffer = "";
    let settledSeen = false;
    const handleRpcLine = (line) => {
      if (finalized || !line) return;
      if (line.includes("\r")) {
        void finish(false, "RPC stream contained a raw CR; expected strict LF-only JSONL").catch(() => {});
        return;
      }
      let event;
      try { event = JSON.parse(line); } catch {
        void finish(false, "RPC stream contained invalid JSON").catch(() => {});
        return;
      }
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update?.type === "text_delta" && typeof update.delta === "string") {
          outputParts.push(update.delta);
          recentOutput.push(...update.delta.split("\n").filter(Boolean));
          void progress("producing_report").catch(() => {});
        }
        return;
      }
      if (event.type === "tool_execution_start" && READ_ONLY_TOOLS.has(event.toolName)) {
        const key = String(event.toolCallId ?? `${event.toolName}:${toolCalls.length}:${Date.now()}`);
        activeTools.set(key, { name: event.toolName, argsPrefix: toolArgsPrefix(event.args) });
        currentTool = event.toolName;
        currentToolArgs = toolArgsPrefix(event.args);
        currentToolStartedAt = Date.now();
        void progress("tool_executing").catch(() => {});
        return;
      }
      if (event.type === "tool_execution_end") {
        const key = String(event.toolCallId ?? "");
        const active = activeTools.get(key);
        if (active) {
          toolCalls.push({ ...active, finishedAt: Date.now() });
          activeTools.delete(key);
          currentTool = undefined;
          currentToolArgs = undefined;
          currentToolStartedAt = undefined;
          void progress("running").catch(() => {});
        }
        return;
      }
      if (event.type === "agent_settled") {
        settledSeen = true;
        void finish(true).catch(() => {});
      }
      // agent_end is progress only; never finalize on it.
    };
    pi.stdout.on("data", (chunk) => {
      if (finalized) return;
      stdoutBuffer += String(chunk);
      if (stdoutBuffer.includes("\r")) {
        void finish(false, "RPC stream contained a raw CR; expected strict LF-only JSONL").catch(() => {});
        return;
      }
      let newline;
      while (!finalized && (newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleRpcLine(line);
      }
    });
    pi.stdout.on("end", () => {
      if (finalized) return;
      if (stdoutBuffer.length > 0) {
        void finish(false, "RPC stream ended with an unterminated LF record").catch(() => {});
      } else if (!settledSeen) {
        void finish(false, "pi exited without an agent_settled RPC event").catch(() => {});
      }
    });

    pi.on("error", (error) => { void finish(false, `pi launch failed: ${error.message}`).catch(() => {}); });
    pi.on("exit", (code, signal) => {
      if (!finalized) void finish(false, `pi exited before audit completion (code=${code ?? "?"}, signal=${signal ?? "?"})`).catch(() => {});
    });

    // Exactly one LF-terminated JSONL prompt. JSON.stringify escapes embedded
    // newlines and carriage returns, so this remains one strict LF-only line.
    const promptLine = JSON.stringify({ type: "prompt", message: request.prompt });
    if (promptLine.includes("\r") || promptLine.includes("\n")) throw new Error("prompt JSONL encoding is not strict LF-only");
    pi.stdin.write(`${promptLine}\n`, "utf8");
    pi.stdin.end();
    await progress("running");
  } catch (error) {
    await finish(false, error instanceof Error ? error.message : String(error));
  }
}

main().catch(async (error) => {
  // A malformed request cannot safely be associated with a result identity.
  // There is deliberately no fallback or in-process execution here.
  process.stderr.write(`goal-auditor-worker: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
