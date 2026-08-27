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

import { readFile } from "node:fs/promises";
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

function parseArgs(argv) {
  const args = { file: undefined, doneNeedles: [], terminalNeedles: [], timeoutMs: 30_000, pollIntervalMs: 250 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--file") args.file = value;
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
  if (!args.file) throw new Error("--file is required");
  if (args.doneNeedles.length === 0) throw new Error("at least one --needle is required");
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
  const filePath = path.resolve(args.file);
  // A smoke run owns a fresh scratch root. Reading from the beginning makes a
  // marker that landed between the send and this process start observable.
  // Callers needing cross-attempt disambiguation should put an attempt id in
  // the durable needle rather than relying on wall-clock freshness.
  const waited = await waitForDurableEvent(
    () => readDurableFile(filePath, args),
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
