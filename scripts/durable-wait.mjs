/**
 * Absolute-deadline polling for durable lifecycle events.
 *
 * A caller supplies a reader that observes durable state (a ledger, atomic
 * result, or restart-safe sidecar). The reader must return:
 *   { status: "pending" }
 *   { status: "done", value?: unknown }
 *   { status: "terminal", reason: "provider-failure"|"restart"|"aborted"|"error" }
 *
 * The helper never treats elapsed time as success. Every result reports the
 * elapsed duration, number of reads, and the reason it stopped.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TERMINAL_REASONS = new Set(["provider-failure", "restart", "aborted", "error"]);
const RESULT_REASONS = new Set(["done", "timeout", ...TERMINAL_REASONS]);

const defaultNow = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());
const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function finiteNumber(value, fallback, minimum, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum) {
    if (fallback !== undefined) return fallback;
    throw new TypeError(`${name} must be a finite number >= ${minimum}`);
  }
  return number;
}

function result(reason, startedAt, now, checks, value, detail) {
  const elapsedMs = Math.max(0, now() - startedAt);
  return {
    ok: reason === "done",
    elapsedMs,
    checks,
    terminalReason: reason,
    ...(value === undefined ? {} : { value }),
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * Poll a durable condition until it resolves or an absolute deadline expires.
 * `read` is called once immediately and after each bounded poll interval.
 */
export async function waitForDurableEvent(read, options = {}) {
  if (typeof read !== "function") throw new TypeError("read must be a function");
  const timeoutMs = finiteNumber(options.timeoutMs, undefined, 0, "timeoutMs");
  const pollIntervalMs = finiteNumber(options.pollIntervalMs ?? 250, 250, 1, "pollIntervalMs");
  const now = options.now ?? defaultNow;
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let checks = 0;

  for (;;) {
    if (signal?.aborted) return result("aborted", startedAt, now, checks);

    let observation;
    try {
      observation = await read();
    } catch (error) {
      return result("error", startedAt, now, checks, undefined, error instanceof Error ? error.message : String(error));
    }
    checks += 1;
    // A slow reader may resolve after the deadline. Treat that observation as
    // a timeout even if it contains a done marker; a bounded waiter must not
    // turn late visibility into success.
    if (now() > deadline) return result("timeout", startedAt, now, checks);

    if (!observation || typeof observation !== "object" || typeof observation.status !== "string") {
      return result("error", startedAt, now, checks, undefined, "reader returned an invalid observation");
    }
    if (observation.status === "done") {
      return result("done", startedAt, now, checks, observation.value);
    }
    if (observation.status === "terminal") {
      const reason = observation.reason;
      if (!TERMINAL_REASONS.has(reason)) {
        return result("error", startedAt, now, checks, undefined, "reader returned an invalid terminal reason");
      }
      return result(reason, startedAt, now, checks, observation.value, observation.detail);
    }
    if (observation.status !== "pending") {
      return result("error", startedAt, now, checks, undefined, "reader returned an invalid status");
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) return result("timeout", startedAt, now, checks);
    try {
      await sleep(Math.min(pollIntervalMs, remainingMs));
    } catch (error) {
      return result("error", startedAt, now, checks, undefined, error instanceof Error ? error.message : String(error));
    }
  }
}

/**
 * Turn a durable text file into a reader observation. This is intentionally a
 * simple substring adapter for smoke fixtures: each smoke run owns a fresh
 * scratch directory, so a marker cannot be inherited from another run.
 */
export async function readDurableFile(filePath, options = {}) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "pending" };
    throw error;
  }

  const terminalNeedles = options.terminalNeedles ?? [];
  for (const entry of terminalNeedles) {
    if (entry && text.includes(entry.needle)) {
      return { status: "terminal", reason: entry.reason, detail: entry.detail };
    }
  }
  const doneNeedles = options.doneNeedles ?? [];
  if (doneNeedles.length > 0 && doneNeedles.every((needle) => text.includes(needle))) {
    return { status: "done" };
  }
  return { status: "pending" };
}

/** Observe an archive directory as a durable count, for list smoke waits. */
export async function readDurableDirectoryCount(directoryPath, options = {}) {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "pending", value: { count: 0 } };
    throw error;
  }
  const suffix = options.suffix ?? ".md";
  const count = entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).length;
  const minimum = finiteNumber(options.minimum ?? 1, 1, 1, "minimum");
  return count >= minimum ? { status: "done", value: { count } } : { status: "pending", value: { count } };
}

/**
 * Estimate a wait from recent observed durations (Antigravity-style:
 * check-if-done beats guessing, but a guess still bounds the deadline).
 * Reuses existing telemetry (e.g. computeListDepth avgDurationMs) when
 * available; falls back to caller-supplied default.
 */
export function estimateDurationFromHistory(durations, fallbackMs) {
  const fallback = finiteNumber(fallbackMs ?? 30_000, 30_000, 0, "fallbackMs");
  if (!Array.isArray(durations) || durations.length === 0) return fallback;
  const nums = durations.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n >= 0);
  if (nums.length === 0) return fallback;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  // Slight headroom over median, bounded below by fallback * 0.5 and above by fallback * 4.
  return Math.max(Math.round(fallback * 0.5), Math.min(Math.round(fallback * 4), Math.max(median, Math.round(median * 1.2))));
}

export function nextPollMs(attempt, baseMs = 250, capMs = 1000) {
  const base = finiteNumber(baseMs, 250, 1, "baseMs");
  const cap = finiteNumber(capMs, 1000, 1, "capMs");
  const exp = base * Math.pow(2, Math.max(0, attempt));
  return Math.min(cap, Math.max(base, Math.round(exp)));
}

function parseArgs(argv) {
  const args = { file: undefined, directory: undefined, minFiles: undefined, doneNeedles: [], terminalNeedles: [], timeoutMs: 30_000, pollIntervalMs: 250 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--file") args.file = value;
    else if (flag === "--directory") args.directory = value;
    else if (flag === "--min-files") args.minFiles = finiteNumber(value, undefined, 1, "minFiles");
    else if (flag === "--needle") args.doneNeedles.push(value);
    else if (flag === "--terminal") {
      const separator = value?.indexOf("=") ?? -1;
      if (separator <= 0) throw new Error("--terminal requires reason=needle");
      args.terminalNeedles.push({ reason: value.slice(0, separator), needle: value.slice(separator + 1) });
    } else if (flag === "--timeout-ms") args.timeoutMs = finiteNumber(value, undefined, 0, "timeoutMs");
    else if (flag === "--poll-ms") args.pollIntervalMs = finiteNumber(value, undefined, 1, "pollIntervalMs");
    else throw new Error(`unknown argument: ${flag}`);
    i += 1;
  }
  if ((args.file && args.directory) || (!args.file && !args.directory)) {
    throw new Error("exactly one of --file or --directory is required");
  }
  if (args.directory && args.doneNeedles.length > 0) throw new Error("--needle is only valid with --file");
  if (args.directory && args.minFiles === undefined) throw new Error("--min-files is required with --directory");
  if (args.file && args.doneNeedles.length === 0) throw new Error("at least one --needle is required");
  if (args.terminalNeedles.some((entry) => !TERMINAL_REASONS.has(entry.reason))) {
    throw new Error("--terminal reason must be provider-failure, restart, aborted, or error");
  }
  return args;
}

function exitCodeFor(reason) {
  if (reason === "done") return 0;
  if (reason === "timeout") return 2;
  if (reason === "provider-failure") return 3;
  if (reason === "restart") return 4;
  if (reason === "aborted") return 5;
  return 1;
}

async function main(argv) {
  const args = parseArgs(argv);
  const targetPath = path.resolve(args.file ?? args.directory);
  // A smoke run owns a fresh scratch root. Reading from the beginning makes a
  // marker that landed between the send and this process start observable.
  // Callers needing cross-attempt disambiguation should put an attempt id in
  // the durable needle rather than relying on wall-clock freshness.
  const reader = args.directory
    ? () => readDurableDirectoryCount(targetPath, { minimum: args.minFiles })
    : () => readDurableFile(targetPath, args);
  const waited = await waitForDurableEvent(
    reader,
    { timeoutMs: args.timeoutMs, pollIntervalMs: args.pollIntervalMs },
  );
  process.stdout.write(`${JSON.stringify(waited)}\n`);
  return exitCodeFor(waited.terminalReason);
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { RESULT_REASONS };
