/**
 * pi-goal-list-loop-audit — v0.2.0
 * extensions/goal-loop-shield.ts
 *
 * regression_shield — pure, dependency-free enforcement logic.
 *
 * When a goal has a verification contract, an <approved/> verdict is only
 * accepted if the auditor's report carries an <evidence> section that
 * references every contract item. This kills the "auditor ran bash true and
 * approved" class of bamboozle that pi-goal-x's author explicitly documented
 * as a known hole.
 *
 * Kept free of pi imports so unit tests can exercise it under plain node.
 */

import { resolveCanonicalRunnerCommand } from "./goal-loop-backoff.js";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Split a verification contract into its individual checkable items. */
export function contractItems(contract: string): string[] {
  return contract
    .split("\n")
    .map((l) => l.trim())
    .map((l) => l.replace(/^(?:done when|verify|verified when|verification|done)\s*:\s*/i, ""))
    .map((l) => l.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, ""))
    .filter((l) => l.length > 0)
    // Boundary lines ("Out of scope: ...") constrain the auditor's judgment;
    // they are not deliverables and have no evidence to quote (v0.22.6).
    .filter((l) => !/^out of scope\b/i.test(l))
    // Preamble lines are not checkable items (v0.23.4, darklord field bug:
    // "Done when ALL of the following are true:" survived as an "item" —
    // the prefix strip only fires when a colon directly follows "done
    // when" — and the shield then blocked TWO genuine approvals forever,
    // because no evidence can reference a preamble). Two mechanical
    // predicates: a line still ending in a colon introduces a list, and a
    // "(done when) (all of) the following ..." line IS the introducer.
    .filter((l) => !l.endsWith(":"))
    .filter((l) => !/^(?:done when\s+)?(?:all of\s+)?the following\b/i.test(l));
}

export interface RegressionShieldResult {
  passed: boolean;
  missingItems: string[];
  hasEvidenceBlock: boolean;
}

/** Strip prose punctuation glued to a token ("file/element." → "file/element").
 * v0.34.77 (GitHub #5): Unicode-aware — \p{L}\p{N} with the /u flag keeps
 * CJK letters. The old ASCII-only class treated every Chinese character as
 * punctuation, so a pure-Chinese token like 调研报告文件 shrank to nothing. */
function stripEdgePunct(w: string): string {
  return w.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}/_.-]+$/u, "");
}

/**
 * Is a candidate token present in the report? Compound tokens joined by
 * "-" or "/" (left-cropped, file/element, Phaser/Svelte) count as present
 * when ALL their segments (len >= 3) appear — a good-faith report writes
 * "no cropped strip on the left", not the contract's literal compound.
 */
function tokenPresent(candidate: string, reportLower: string): boolean {
  const c = candidate.toLowerCase();
  if (reportLower.includes(c)) return true;
  // v0.34.77 (GitHub #5): Han (CJK) tokens match by exact substring only —
  // Chinese words have no compound-segment decomposition, so the ASCII
  // segment rule below would wrongly reject a quoted 章节 line.
  if (/\p{Script=Han}/u.test(c)) return reportLower.includes(c);
  const segments = c.split(/[-/]+/).filter((s) => s.length >= 3);
  return segments.length > 1 && segments.every((s) => reportLower.includes(s));
}

/** v0.34.77 (GitHub #5): punctuation-edge-normalized lowercase for the
 * no-candidate fallback — a verbatim quote that drops the item's trailing
 * full-width colon (章节： → 章节) still counts as a reference. */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "").replace(/\s+/g, " ");
}

/**
 * Check an approved auditor report against the verification contract.
 * Rules (deliberately simple + auditable):
 *   1. The report must contain an <evidence> ... </evidence> block.
 *   2. Every contract item must be referenced inside the report by ANY of
 *      its top-3 longest tokens (>= 5 chars, edge punctuation stripped;
 *      compounds match via their segments). v0.22.6: the previous
 *      single-longest-word rule false-rejected genuine approvals when the
 *      longest word was contract-only vocabulary ("left-cropped") or had
 *      prose punctuation glued on ("file/element.") — three real approved
 *      audits on hegemon were converted to disapprovals that way.
 */
export function checkRegressionShield(report: string, contract: string): RegressionShieldResult {
  const evidenceMatch = /<evidence>[\t\n\r ]*([\s\S]*?)<\/evidence>/i.exec(report);
  const hasEvidenceBlock = evidenceMatch !== null;
  const items = contractItems(contract);
  const missingItems: string[] = [];
  // Contract references must live inside the evidence block. Searching the
  // whole report let an auditor satisfy the shield by repeating the contract
  // in prose while leaving the evidence block empty or unrelated.
  const evidenceLower = (evidenceMatch?.[1] ?? "").toLowerCase();
  for (const item of items) {
    // v0.34.77 (GitHub #5): Unicode-aware token split — \p{L}\p{N} treats
    // CJK characters as letters, so a pure-Chinese contract line is ONE
    // candidate token instead of a pile of delimiters.
    const candidates = item
      .split(/[^\p{L}\p{N}_.\-/]+/u)
      .map(stripEdgePunct)
      .filter((w) => w.length >= 5)
      .sort((a, b) => b.length - a.length)
      .slice(0, 3);
    const addressed = candidates.length > 0
      ? candidates.some((c) => tokenPresent(c, evidenceLower))
      : evidenceLower.includes(normalizeForMatch(item));
    if (!addressed) missingItems.push(item);
  }
  return {
    passed: hasEvidenceBlock && missingItems.length === 0,
    missingItems,
    hasEvidenceBlock,
  };
}

/**
 * v0.24.2: pure auditor-verdict parser (approved / disapproved / impossible).
 * Lives here (not goal-loop-auditor.ts) so tests can import it without
 * dragging in the auditor's relative .js imports. The final nonblank line
 * is the only authoritative verdict location; prose tags are not verdicts.
 */
export function parseAuditorVerdict(output: string): { approved: boolean; disapproved: boolean; impossible: boolean; impossibleReason?: string } {
  // A few RPC/test transports serialize newlines as literal `\\n` text;
  // normalize that wire representation without relaxing the final-line gate.
  const normalizedOutput = output.replaceAll("\\n", "\n").replaceAll("\\r", "\r");
  const finalLine = normalizedOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  const impossibleMatch = /^<impossible>([\s\S]*?)<\/impossible>$/i.exec(finalLine);
  // The final line is the only authoritative verdict location.
  return {
    approved: /^<approved\/>$/i.test(finalLine),
    disapproved: /^<disapproved\/>$/i.test(finalLine),
    impossible: impossibleMatch !== null,
    impossibleReason: impossibleMatch?.[1]?.trim().slice(0, 300) || undefined,
  };
}

/**
 * v0.35.7: Extract mechanical shell command gates from a verification contract.
 * Captures explicit commands (e.g. `npm test`, `tsc --noEmit`, `cargo test`)
 * for deterministic fast-fail pre-auditing before spawning the heavy LLM worker.
 */
export function extractMechanicalCheckCommands(contract: string): string[] {
  if (!contract) return [];
  const items = contractItems(contract);
  const commands: string[] = [];
  for (const item of items) {
    const backtickMatches = [...item.matchAll(/`([^`]+)`/g)];
    if (backtickMatches.length > 0) {
      for (const m of backtickMatches) {
        const inner = m[1]!.trim();
        const parts = inner.split(/\s*&&\s*|\s*;\s*/);
        for (let part of parts) {
          part = part.trim();
          if (!part) continue;
          if (/^(?:npm\s+(?:test|run\s+[\w:-]+)|bun\s+(?:test|run\s+[\w:-]+)|pnpm\s+(?:test|run\s+[\w:-]+)|yarn\s+(?:test|[\w:-]+)|tsc\b|cargo\s+(?:test|check|build)|pytest\b|python3?\s+-m\s+unittest|python3?\s+[^\s]+|go\s+test|vitest\b|jest\b|make\s+test|git\s+diff|test\s+-[a-z])/i.test(part)) {
            commands.push(part);
          }
        }
      }
      continue;
    }
    let candidate = item.trim();
    candidate = candidate.replace(/\s+(?:passes(?:\s+cleanly|\s+with\s+zero\s+errors)?|exits\s+0|returns\s+0|cleanly|completes(?:\s+successfully)?|succeeds(?:\s+cleanly)?|successfully).*$/i, "").trim();
    if (/^(?:npm\s+(?:test|run\s+[\w:-]+)|bun\s+(?:test|run\s+[\w:-]+)|pnpm\s+(?:test|run\s+[\w:-]+)|yarn\s+(?:test|[\w:-]+)|tsc\b|cargo\s+(?:test|check|build)|pytest\b|python3?\s+-m\s+unittest|python3?\s+[^\s]+|go\s+test|vitest\b|jest\b|make\s+test|git\s+diff|test\s+-[a-z])/i.test(candidate)) {
      if (!isPlausibleBareMechanicalCandidate(candidate)) continue;
      const parts = candidate.split(/\s*&&\s*|\s*;\s*/);
      for (let part of parts) {
        part = part.trim();
        if (!part) continue;
        if (/^(?:npm\s+(?:test|run\s+[\w:-]+)|bun\s+(?:test|run\s+[\w:-]+)|pnpm\s+(?:test|run\s+[\w:-]+)|yarn\s+(?:test|[\w:-]+)|tsc\b|cargo\s+(?:test|check|build)|pytest\b|python3?\s+-m\s+unittest|python3?\s+[^\s]+|go\s+test|vitest\b|jest\b|make\s+test|git\s+diff|test\s+-[a-z])/i.test(part)) {
          commands.push(part);
        }
      }
    }
  }
  return commands;
}

function isPlausibleBareMechanicalCandidate(candidate: string): boolean {
  const tokens = candidate.trim().split(/\s+/);
  let baseLen = 1;
  if (/^npm\s+run\s+[\w:-]+/i.test(candidate)) baseLen = 3;
  else if (/^bun\s+run\s+[\w:-]+/i.test(candidate)) baseLen = 3;
  else if (/^pnpm\s+run\s+[\w:-]+/i.test(candidate)) baseLen = 3;
  else if (/^yarn\s+run\s+[\w:-]+/i.test(candidate)) baseLen = 3;
  else if (/^cargo\s+(?:test|check|build)/i.test(candidate)) baseLen = 2;
  else if (/^go\s+test/i.test(candidate)) baseLen = 2;
  else if (/^(?:npm|bun|pnpm|yarn)\s+(?:test|vitest|jest)/i.test(candidate)) baseLen = 2;
  else if (/^tsc\b/i.test(candidate)) baseLen = 1;
  else if (/^pytest\b/i.test(candidate)) baseLen = 1;
  else baseLen = 2;
  const args = tokens.slice(baseLen);
  if (args.length === 0) return true;
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    if (arg.includes("/") || arg.includes(".") || arg.includes(":")) continue;
    if (/^[A-Za-z]+(-[A-Za-z]+)*$/.test(arg)) return false;
  }
  return true;
}

export interface MechanicalCheckResult {
  passed: boolean;
  failedCommand?: string;
  output?: string;
  exitCode?: number;
  /** v0.35.20: set when the first attempt failed transiently and the single
   * bounded retry passed — honest evidence of the wobble, not a silent mask. */
  recoveredRetryNote?: string;
}

/**
 * Mechanical checks are intentionally a small, shell-free command language.
 * Contract text is not trusted input: accepting `npm test; ...` and passing it
 * to a shell would turn the verification gate into arbitrary code execution.
 */
const SAFE_MECHANICAL_COMMAND = /^[A-Za-z0-9_./:@=+,-]+(?:[ \t]+[A-Za-z0-9_./:@=+,-]+)*$/;

export function isSafeMechanicalCommand(command: string): boolean {
  return SAFE_MECHANICAL_COMMAND.test(command.trim());
}

/**
 * Accept one deliberately narrow assertion form used by verification
 * contracts that need both a file existence/size check and a literal marker
 * check. It is expanded into two shell-free invocations; arbitrary `&&`, `||`,
 * pipes, substitutions, redirects, and additional programs remain rejected.
 */
function safeFileMarkerCompound(command: string): string[] | null {
  const match = /^test\s+-([sf])\s+([A-Za-z0-9_./:@=+,-]+)\s+&&\s+grep\s+-q\s+(['"]?)([A-Za-z0-9_./:@=+,-]+)\3\s+([A-Za-z0-9_./:@=+,-]+)$/i.exec(command.trim());
  if (!match) return null;
  const [, flag, testPath, , marker, grepPath] = match;
  if (!testPath || !marker || !grepPath) return null;
  // Do not let a literal become a second grep option or a test flag. The
  // allowlisted assertion is for file paths and marker text, not option
  // forwarding.
  if ([testPath, marker, grepPath].some((value) => value.startsWith("-"))) return null;
  return [`test -${flag} ${testPath}`, `grep -q ${marker} ${grepPath}`];
}

const DEFAULT_MECHANICAL_CHECK_TIMEOUT_MS = 600_000;
const MECHANICAL_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MECHANICAL_OUTPUT_TAIL_CHARS = 64 * 1024;
const MECHANICAL_CHILD_SHUTDOWN_GRACE_MS = 1_000;
const MECHANICAL_FORCE_KILL_SETTLE_MS = 250;

interface MechanicalCommandRun {
  output: string;
  exitCode: number;
  signal?: NodeJS.Signals;
  timedOut: boolean;
  aborted: boolean;
  outputLimit: boolean;
}

function childIsRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function destroyChildStreams(child: ChildProcess): void {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try { stream?.destroy(); } catch { /* best effort */ }
  }
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!childIsRunning(child)) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const done = () => {
      if (timer) clearTimeout(timer);
      child.removeListener("exit", done);
      child.removeListener("close", done);
      child.removeListener("error", done);
      resolve();
    };
    child.once("exit", done);
    child.once("close", done);
    child.once("error", done);
    timer = setTimeout(done, timeoutMs);
    timer.unref?.();
  });
}

function signalMechanicalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (process.platform === "win32" || !child.pid) return false;
  try {
    // Mechanical commands are spawned detached below, making the PID the
    // POSIX process-group leader. A negative PID reaches recursive shells,
    // interpreters, and grandchildren instead of leaving a fork chain behind.
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

function signalMechanicalProcess(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (signalMechanicalProcessGroup(child, signal)) return true;
  try { return child.kill(signal); } catch { return false; }
}

async function terminateMechanicalProcessTree(child: ChildProcess): Promise<void> {
  if (process.platform === "win32") {
    if (child.pid && childIsRunning(child)) {
      let killer: ChildProcess | undefined;
      try {
        killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
        await waitForChildExit(killer, MECHANICAL_CHILD_SHUTDOWN_GRACE_MS);
      } catch {
        /* direct fallback below */
      }
    }
    if (childIsRunning(child)) {
      try { child.kill(); } catch { /* best effort */ }
      await waitForChildExit(child, MECHANICAL_FORCE_KILL_SETTLE_MS);
    }
    destroyChildStreams(child);
    return;
  }

  if (childIsRunning(child)) {
    signalMechanicalProcess(child, "SIGTERM");
    await waitForChildExit(child, MECHANICAL_CHILD_SHUTDOWN_GRACE_MS);
  }
  // Even when the direct command obeys TERM, its descendants may not. The
  // group kill after the direct exit closes the orphan-descendant hole.
  if (child.pid) signalMechanicalProcessGroup(child, "SIGKILL");
  if (childIsRunning(child)) signalMechanicalProcess(child, "SIGKILL");
  await waitForChildExit(child, MECHANICAL_FORCE_KILL_SETTLE_MS);
  destroyChildStreams(child);
}

function appendMechanicalOutputTail(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= MECHANICAL_OUTPUT_TAIL_CHARS
    ? combined
    : combined.slice(-MECHANICAL_OUTPUT_TAIL_CHARS);
}

function runMechanicalCommand(
  cwd: string,
  program: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<MechanicalCommandRun> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(program, args, {
        cwd,
        // A mechanical command is untrusted project code. Give it its own
        // process group so timeout/abort cleanup reaches every descendant.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        output: error instanceof Error ? error.message : String(error),
        exitCode: 1,
        timedOut: false,
        aborted: false,
        outputLimit: false,
      });
      return;
    }

    let stdoutTail = "";
    let stderrTail = "";
    let outputBytes = 0;
    let timedOut = false;
    let aborted = false;
    let outputLimit = false;
    let launchError: string | undefined;
    let termination: Promise<void> | undefined;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let settleFallbackTimer: NodeJS.Timeout | undefined;
    let closeSeen = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;

    const settle = (code: number | null, childSignal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (settleFallbackTimer) clearTimeout(settleFallbackTimer);
      signal?.removeEventListener("abort", onAbort);
      const output = [stdoutTail, stderrTail, launchError].filter(Boolean).join("\n");
      destroyChildStreams(child);
      resolve({
        output,
        exitCode: code ?? (childSignal || timedOut || aborted || outputLimit || launchError ? 1 : 0),
        ...(childSignal ? { signal: childSignal } : {}),
        timedOut,
        aborted,
        outputLimit,
      });
    };

    const settleAfterTermination = (code: number | null, childSignal: NodeJS.Signals | null): void => {
      if (!termination) {
        settle(code, childSignal);
        return;
      }
      void termination.then(() => {
        if (closeSeen) {
          settle(code, childSignal);
          return;
        }
        // A descendant that escaped the process group can keep a pipe open;
        // do not let that defeat the bounded runner, but give normal stdio a
        // short window to drain before returning the diagnostic tail.
        settleFallbackTimer ??= setTimeout(() => settle(exitCode, exitSignal), MECHANICAL_FORCE_KILL_SETTLE_MS);
        settleFallbackTimer.unref?.();
      });
    };

    const requestTermination = (reason: "timeout" | "abort" | "output-limit"): void => {
      if (settled) return;
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      if (reason === "output-limit") outputLimit = true;
      termination ??= terminateMechanicalProcessTree(child).catch(() => {});
      // A descendant that keeps a stdio pipe open must not hold this promise
      // forever after its process group has been terminated.
      settleAfterTermination(exitCode, exitSignal);
    };

    const onAbort = (): void => requestTermination("abort");
    const onOutput = (target: "stdout" | "stderr") => (chunk: Buffer | string): void => {
      if (settled) return;
      const text = String(chunk);
      outputBytes += Buffer.byteLength(text, "utf8");
      if (target === "stdout") stdoutTail = appendMechanicalOutputTail(stdoutTail, text);
      else stderrTail = appendMechanicalOutputTail(stderrTail, text);
      if (outputBytes > MECHANICAL_MAX_OUTPUT_BYTES) requestTermination("output-limit");
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onOutput("stdout"));
    child.stderr?.on("data", onOutput("stderr"));
    child.once("error", (error) => {
      launchError = error instanceof Error ? error.message : String(error);
      if (termination) settleAfterTermination(exitCode, exitSignal);
      else settle(1, null);
    });
    // A command can exit while a grandchild keeps an inherited stdio pipe
    // open, or can daemonize a child with stdio ignored. Clean up the owned
    // detached group on every direct exit, not only on timeout, so a green or
    // red check cannot strand a background process tree behind it.
    child.once("exit", (code, childSignal) => {
      exitCode = code;
      exitSignal = childSignal;
      termination ??= terminateMechanicalProcessTree(child).catch(() => {});
      settleAfterTermination(code, childSignal);
    });
    child.once("close", (code, childSignal) => {
      closeSeen = true;
      exitCode = code;
      exitSignal = childSignal;
      if (termination) settleAfterTermination(code, childSignal);
      else settle(code, childSignal);
    });
    timer = setTimeout(() => requestTermination("timeout"), timeoutMs);
    timer.unref?.();
    if (signal?.aborted) requestTermination("abort");
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function formatMechanicalFailure(run: MechanicalCommandRun, timeoutMs: number): { output: string; exitCode: number } {
  const body = run.output.trim() || (run.signal ? `Process terminated by ${run.signal}` : "Command failed");
  const banner = run.timedOut
    ? `[mechanical check killed after ${Math.round(timeoutMs / 1000)}s — process tree terminated; output tail below]`
    : run.aborted
      ? "[mechanical check aborted — process tree terminated; output tail below]"
      : run.outputLimit
        ? "[mechanical check exceeded its 64MB output limit — process tree terminated; output tail below]"
        : "";
  const evidence = body.length > 4000 ? "…[truncated head]\n" + body.slice(-4000) : body;
  return { output: (banner ? banner + "\n" : "") + evidence, exitCode: run.exitCode };
}

/** v0.35.7: Execute mechanical pre-audit checks deterministically.
 *
 * v0.35.16: default timeout 60s → 10min. The old 60s ceiling killed
 * LEGITIMATE long gates mid-run: this repo's own contract command,
 * `npm run release:check`, needs ~3 minutes (full suite + tsc + Jiti smoke
 * + pack), so every deterministic pre-audit fast-failed with a truncated
 * head-of-output report that showed startup logs instead of any failure —
 * twice in the field (2026-08-21 14:17 and 16:01 disapprovals), burning two
 * auditor rounds on a gate that could never pass inside its own bound. The
 * timeout still bounds genuinely hung commands; it no longer bounds honest
 * slow ones. Failed output now keeps the TAIL, not the head — the end of a
 * killed/failed run shows what was actually happening at death.
 */
export async function runMechanicalPreAuditChecks(
  cwd: string,
  commands: string[],
  timeoutMs = DEFAULT_MECHANICAL_CHECK_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<MechanicalCheckResult> {
  if (!commands || commands.length === 0) return { passed: true };
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_MECHANICAL_CHECK_TIMEOUT_MS;
  const recoveredRetries: string[] = [];
  for (const rawCommand of commands) {
    const cmd = rawCommand.trim();
    const compound = safeFileMarkerCompound(cmd);
    if (compound) {
      // Run each allowlisted assertion independently so no shell ever parses
      // the conjunction. Keep the original compound text in a failure result
      // so the auditor sees which contract item failed.
      for (const step of compound) {
        const stepResult = await runMechanicalPreAuditChecks(cwd, [step], effectiveTimeoutMs, signal);
        if (!stepResult.passed) return { ...stepResult, failedCommand: rawCommand };
      }
      continue;
    }
    if (!isSafeMechanicalCommand(cmd)) {
      return {
        passed: false,
        failedCommand: rawCommand,
        output: "Rejected unsafe mechanical command syntax; only a single executable followed by literal arguments is allowed.",
        exitCode: 126,
      };
    }
    const [rawProgram] = cmd.split(/[ \t]+/);
    // v0.35.18: a contract that names a raw runner ("bun test") must run the
    // project's CANONICAL invocation of it — package.json scripts encode the
    // flags the suite requires (serialization/isolation/timeouts). Running
    // the bare runner ignores that configuration and fails spuriously while
    // the real gate is green (field: fourth audit round, 2026-08-21).
    let scripts: Record<string, string> = {};
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
      if (pkg && typeof pkg.scripts === "object" && pkg.scripts) scripts = pkg.scripts;
    } catch { /* no package.json — nothing to resolve */ }
    const { program, args } = resolveCanonicalRunnerCommand(cmd, scripts);
    if (!program) {
      return { passed: false, failedCommand: rawCommand, output: "Empty mechanical command.", exitCode: 126 };
    }
    // v0.35.20: ONE bounded automatic retry per failed mechanical command.
    // Field (sixth audit round, 2026-08-21): the gate died MID-RUN under
    // machine load ~30 (output ends inside a passing file, no runner
    // summary, exit 1) while the identical tree passed green twice in
    // isolation — resource contention, not a red suite. A deterministic
    // contract command that genuinely fails stays red on both attempts;
    // only transient deaths get a second chance. The retry is bannered in
    // the returned evidence so the auditor sees it happened.
    let firstFailure: { output: string; exitCode: number } | null = null;
    let passed = false;
    for (let attempt = 1; attempt <= 2 && !passed; attempt++) {
      const run = await runMechanicalCommand(cwd, program, args, effectiveTimeoutMs, signal);
      if (!run.timedOut && !run.aborted && !run.outputLimit && run.exitCode === 0) {
        passed = true;
        continue;
      }
      const failure = formatMechanicalFailure(run, effectiveTimeoutMs);
      // A timeout, caller abort, or output-limit breach is a containment
      // event, not a transient test wobble. Retrying would immediately start
      // another untrusted process tree and can recreate the incident.
      if (run.timedOut || run.aborted || run.outputLimit) {
        return {
          passed: false,
          failedCommand: rawCommand,
          output: failure.output,
          exitCode: failure.exitCode,
        };
      }
      if (attempt === 1) {
        firstFailure = failure;
      } else {
        return {
          passed: false,
          failedCommand: rawCommand,
          output: firstFailure
            ? `[mechanical check retried once after a failed first attempt (exit ${firstFailure.exitCode}); second attempt also failed — output tail below]\n` + failure.output
            : failure.output,
          exitCode: failure.exitCode,
        };
      }
    }
    if (passed && firstFailure) {
      // First attempt failed, second PASSED — recoverable transience; keep
      // checking later contract commands instead of treating this one as the
      // whole contract.
      recoveredRetries.push(`[mechanical check ${rawProgram}: first attempt failed (exit ${firstFailure.exitCode}); automatic retry passed]`);
    }
  }
  return { passed: true, ...(recoveredRetries.length ? { recoveredRetryNote: recoveredRetries.join(" ") } : {}) };
}
