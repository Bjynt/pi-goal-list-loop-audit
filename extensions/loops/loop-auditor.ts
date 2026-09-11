/**
 * pi-goal-list-loop-audit — v0.38.43
 * extensions/loops/loop-auditor.ts
 *
 * The LOOP auditor: an opt-in periodic SEMANTIC audit of a running metric
 * loop. Every N iterations (`settings.auditLoop`) a DETACHED auditor — the
 * exact same infrastructure as goal completion audits (same worker spawn,
 * watchdogs, verdict parsing, model resolution, inspection sessions) — asks
 * one question: is the loop making REAL progress toward its target, or just
 * moving its metric?
 *
 * Verdict handling mirrors the goal auditor, adapted to a loop that keeps
 * running:
 *   approved          → streak resets, continue
 *   disapproved ×1    → the "## Required fixes" tail rides the NEXT
 *                       iteration's prompt as a corrective directive
 *   disapproved ×2    → stop REQUESTED; the running tick consumes it through
 *                       the standard stop machinery (never stopped here —
 *                       this handler is async and must not race a live
 *                       iteration's git work)
 *   impossible        → stop requested (the target can never be satisfied)
 *   infra failure     → ledger only; an infra failure is NOT evidence
 *                       about the work and never counts as a disapproval
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { state, persistStateLine } from "../goal-state.js";
import {
  appendAuditLog,
  appendLedger,
  auditFeedbackExcerpt,
  type AuditLogEntry,
  DEFAULT_AUDIT_FEEDBACK_CHARS,
} from "../goal-loop-core.js";
import { loadSettings, type Settings } from "../goal-settings.js";

import {
  runDetachedGoalCompletionAuditor,
  findActiveSameSubjectAudit,
  DEFAULT_AUDITOR_TOOL_TIMEOUT_MS,
  DEFAULT_AUDITOR_STALL_MS,
  type GoalAuditorResult,
} from "../goal-loop-auditor-process.js";
import { buildLoopAuditorPrompt, type LoopAuditFacts } from "../goal-loop-auditor.js";
import { resolveAuditorModel } from "./goal-settings-ui.js";
import type { LoopState } from "../goal-loop-forever.js";

const execFileAsync = promisify(execFile);

/** Two consecutive disapprovals stop the loop (same spirit as the goal
 * auditor's bounded no-progress escalation — one strike steers, two stop). */
export const LOOP_AUDIT_STOP_STREAK = 2;

/** Bounded spec excerpt size for the audit prompt (chars). */
const LOOP_AUDIT_SPEC_EXCERPT_CHARS = 4000;
/** Recent-iteration tail carried into the prompt (entries). */
const LOOP_AUDIT_HISTORY_TAIL = 10;

let loopAuditInFlight = false;

/** Test/inspection accessor for the in-flight guard. */
export function isLoopAuditInFlight(): boolean {
  return loopAuditInFlight;
}

/** Pure trigger predicate: fire when the interval is positive, the loop has
 * completed a multiple of it, and no audit is already in flight. */
export function shouldTriggerLoopAudit(
  iteration: number,
  interval: number | undefined,
  inFlight: boolean,
): boolean {
  if (!interval || interval <= 0) return false;
  if (inFlight) return false;
  return iteration > 0 && iteration % interval === 0;
}

async function gitHead(cwd: string): Promise<{ sha?: string; branch?: string }> {
  try {
    const [shaRes, branchRes] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd, timeout: 5000 }),
      execFileAsync("git", ["branch", "--show-current"], { cwd, timeout: 5000 }),
    ]);
    return {
      sha: shaRes.stdout.trim() || undefined,
      branch: branchRes.stdout.trim() || undefined,
    };
  } catch {
    return {}; // snapshot is best-effort; the audit still runs without it
  }
}

async function buildLoopAuditFacts(loop: LoopState, cwd: string): Promise<LoopAuditFacts> {
  const history = loop.history.slice(-LOOP_AUDIT_HISTORY_TAIL).map((h) => ({ iteration: h.iteration, value: h.value }));
  let specExcerpt: string | undefined;
  if (loop.specFile) {
    try {
      specExcerpt = (await fs.readFile(path.resolve(cwd, loop.specFile), "utf8")).slice(0, LOOP_AUDIT_SPEC_EXCERPT_CHARS);
    } catch {
      /* spec file vanished — audit without it */
    }
  }
  const head = await gitHead(cwd);
  return {
    target: loop.target,
    ...(loop.measureCmd ? { measureCmd: loop.measureCmd } : {}),
    direction: loop.direction,
    iteration: loop.iteration,
    maxIterations: loop.maxIterations,
    bestValue: loop.bestValue,
    lastValue: loop.lastValue,
    history,
    ...(specExcerpt ? { specExcerpt } : {}),
    ...(head.sha ? { headRef: head.sha } : {}),
    ...(head.branch ? { branch: head.branch } : {}),
    // A prior disapproval of THIS run rides along so the next audit checks
    // whether the flagged gaps were actually closed.
    ...(loop.loopAuditNote
      ? { priorDisapproval: loop.loopAuditNote, consecutiveDisapprovals: loop.consecutiveLoopAuditDisapprovals }
      : {}),
  };
}

/** v0.38.46: the `/glla audits` record for one consumed loop audit — the
 * same stream goal audits write, so an operator's usual surface shows loop
 * verdicts too, with the inspectable session path and resume provenance.
 * PURE: every clock/file input arrives through `extra`. */
export function buildLoopAuditLogEntry(
  loop: LoopState,
  result: GoalAuditorResult,
  outcome: "approved" | "disapproved-corrective" | "disapproved-stop" | "impossible" | "infra",
  extra: { at: string; durationMs?: number; sessionPath?: string; resumedFrom?: string },
): AuditLogEntry {
  const verdict =
    outcome === "approved" ? "approved"
      : outcome === "impossible" ? "impossible"
      : outcome === "infra" ? "error" as const
      : "disapproved";
  return {
    at: extra.at,
    goalId: loopAuditSubject(loop),
    objective: loop.target,
    verdict,
    ...(result.infrastructureClass ? { infrastructureClass: result.infrastructureClass } : {}),
    ...(extra.sessionPath ? { sessionPath: extra.sessionPath } : {}),
    ...(extra.resumedFrom ? { resumedFrom: extra.resumedFrom } : {}),
    model: result.model,
    thinkingLevel: result.thinkingLevel ?? "",
    report: result.output ?? "",
    ...(result.impossibleReason ? { impossibleReason: result.impossibleReason } : {}),
    ...(result.error ? { error: result.error.slice(0, 300) } : {}),
    ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
  };
}

/**
 * PURE verdict application — mutates ONLY the loop object (no I/O), so it is
 * fully unit-testable. The caller ledger-records the returned outcome.
 */
export function applyLoopAuditVerdict(
  loop: LoopState,
  result: GoalAuditorResult,
  correctiveText?: string,
): "approved" | "disapproved-corrective" | "disapproved-stop" | "impossible" | "infra" {
  if (result.approved) {
    loop.consecutiveLoopAuditDisapprovals = 0;
    // The flagged gaps landed — a stale corrective note must not outlive it.
    loop.loopAuditNote = undefined;
    return "approved";
  }
  if (result.disapproved) {
    const streak = (loop.consecutiveLoopAuditDisapprovals ?? 0) + 1;
    loop.consecutiveLoopAuditDisapprovals = streak;
    if (streak >= LOOP_AUDIT_STOP_STREAK) {
      loop.loopAuditStopRequested = true;
      loop.loopAuditStopReason = `loop audit — ${streak} consecutive disapprovals`;
      loop.loopAuditNote = undefined; // the stop carries the verdict; the note is never consumed
      return "disapproved-stop";
    }
    loop.loopAuditNote = correctiveText?.trim()
      ? correctiveText.trim()
      : "The independent loop auditor disapproved this iteration's progress (report unavailable — re-derive the required fixes from the target yourself).";
    return "disapproved-corrective";
  }
  if (result.impossible) {
    loop.loopAuditStopRequested = true;
    loop.loopAuditStopReason = `loop audit — auditor: the target can never be satisfied (${result.impossibleReason ?? "no reason given"})`;
    loop.loopAuditNote = undefined;
    return "impossible";
  }
  // Infra failure: NOT evidence about the work — the streak is untouched.
  return "infra";
}

function notifyBestEffort(ctx: ExtensionContext, text: string, kind: "info" | "warning"): void {
  try {
    ctx.ui.notify(text, kind);
  } catch {
    /* stale handle — the ledger + next-iteration note carry the signal */
  }
}

/** Durable subject identity for one loop run — stable across iterations,
 * unique per run, shared by the trigger and the orphan guard. */
export function loopAuditSubject(loop: LoopState): string {
  return `loop:${loop.startedAt}`;
}

async function runLoopAuditAndApply(cwd: string, ctx: ExtensionContext, loop: LoopState, settings: Settings): Promise<void> {
  loopAuditInFlight = true;
  const iteration = loop.iteration;
  let outcome: ReturnType<typeof applyLoopAuditVerdict> = "infra";
  let errorText: string | undefined;
  let infrastructureClass: string | undefined;
  let dispatchStartedAt: number | undefined;
  let auditedJobDir: string | undefined;
  let auditedResult: GoalAuditorResult | undefined;
  try {
    // Host replacement resets the module-level guard; an orphan worker of
    // this same run may still be alive (observed live). Skip this slot
    // rather than run a second concurrent audit of one subject — and never
    // reap it: its session/verdict are still valuable.
    const jobsRoot = path.join(cwd, ".pi-glla", "audit-jobs");
    let active: Awaited<ReturnType<typeof findActiveSameSubjectAudit>>;
    try {
      active = await findActiveSameSubjectAudit(jobsRoot, loopAuditSubject(loop));
    } catch {
      active = undefined; // guard failure never blocks the dispatch
    }
    if (active) {
      appendLedger(cwd, "loop_audit_skipped_active_prior", { iteration, activeJob: path.basename(active.jobDir), pid: active.pid });
      notifyBestEffort(ctx, `Loop audit (iteration ${iteration}): a prior audit of this run is still running (${path.basename(active.jobDir)}) — slot skipped, nothing reaped.`, "info");
      return;
    }
    const { model, error } = resolveAuditorModel(
      ctx,
      settings.auditorModel,
      settings.auditorModelFallbacks,
      settings.auditorSameSessionSwap !== false,
    );
    if (error || !model) {
      appendLedger(cwd, "loop_audit_model_issue", { iteration, error: error ?? "no auditor model" });
      notifyBestEffort(ctx, `Loop audit (iteration ${iteration}): no usable auditor model${error ? ` — ${error}` : ""}; skipped.`, "warning");
      return;
    }
    const facts = await buildLoopAuditFacts(loop, cwd);
    const toolTimeoutMs = settings.auditorToolTimeoutMs ?? DEFAULT_AUDITOR_TOOL_TIMEOUT_MS;
    const stallMs = settings.auditorStallMs ?? DEFAULT_AUDITOR_STALL_MS;
    // Named attempt: the audits-log record needs the job dir to point at
    // the inspectable session file (and its resume provenance).
    const auditAttemptId = `loop-audit-${iteration}-${Date.now().toString(36)}`;
    dispatchStartedAt = Date.now();
    auditedJobDir = path.join(jobsRoot, auditAttemptId);
    const result = await runDetachedGoalCompletionAuditor({
      cwd,
      prompt: buildLoopAuditorPrompt(facts),
      model,
      // Unset follows the parent session dial, matching the Auditor
      // settings row; max is the safe detached default when a headless
      // context does not expose a thinking level.
      thinkingLevel: (settings.auditorThinkingLevel ?? ctx.thinkingLevel ?? "max") as any,
      allowedExtensions: settings.auditorAllowedExtensions,
      inspection: settings.auditorInspection === true,
      // Subject identity: stable across iterations of ONE loop run, unique
      // per run — so resumable inspection sessions keep the SAME auditor
      // conversation across this loop's audits (and never bleed into goal
      // audits or other loops).
      auditSubject: loopAuditSubject(loop),
      runtime: {
        toolTimeoutMs,
        heartbeatNoProgressMs: stallMs,
        firstEventTimeoutMs: stallMs,
        attemptId: () => auditAttemptId,
        env: {
          GLLA_AUDITOR_TOOL_TIMEOUT_MS: String(toolTimeoutMs),
          GLLA_AUDITOR_STALL_MS: String(stallMs),
        },
      },
    });
    auditedResult = result;
    errorText = result.error;
    infrastructureClass = result.infrastructureClass;
    // The same feedback cap as goal-auditor disapprovals: tail-preserving,
    // so the "## Required fixes" section survives truncation.
    const correctiveText = auditFeedbackExcerpt(result.output, settings.auditFeedbackChars ?? DEFAULT_AUDIT_FEEDBACK_CHARS);
    outcome = applyLoopAuditVerdict(loop, result, correctiveText);
  } finally {
    loopAuditInFlight = false;
  }
  // Durable evidence + user-visible signal AFTER the in-flight guard is
  // released: the next tick (or a /loop stop) sees state either way.
  appendLedger(cwd, "loop_audit", {
    iteration,
    verdict: outcome,
    ...(errorText ? { error: errorText.slice(0, 300) } : {}),
    ...(infrastructureClass ? { infrastructureClass } : {}),
    consecutiveDisapprovals: loop.consecutiveLoopAuditDisapprovals ?? 0,
    target: loop.target.slice(0, 200),
  });
  // Operator-facing record: the same audits.jsonl stream `/glla audits`
  // renders for goal audits, so loop verdicts are visible and each entry
  // points at the inspectable session file + its resume provenance.
  if (auditedResult) {
    let sessionPath: string | undefined;
    let resumedFrom: string | undefined;
    if (auditedJobDir) {
      try { resumedFrom = JSON.parse(await fs.readFile(path.join(auditedJobDir, "request.json"), "utf8")).inspectionResumedFrom ?? undefined; } catch { /* fresh or missing */ }
      try {
        await fs.stat(path.join(auditedJobDir, "session.jsonl"));
        sessionPath = path.join(auditedJobDir, "session.jsonl");
      } catch { /* inspection off */ }
    }
    appendAuditLog(cwd, buildLoopAuditLogEntry(loop, auditedResult, outcome, {
      at: new Date().toISOString(),
      ...(dispatchStartedAt !== undefined ? { durationMs: Date.now() - dispatchStartedAt } : {}),
      ...(sessionPath ? { sessionPath } : {}),
      ...(resumedFrom ? { resumedFrom } : {}),
    }));
  }
  try {
    persistStateLine(cwd, state);
  } catch {
    /* best effort — the verdict is already applied to the live object */
  }
  switch (outcome) {
    case "approved":
      notifyBestEffort(ctx, `Loop audit (iteration ${iteration}): approved — real progress toward the target verified.`, "info");
      break;
    case "disapproved-corrective":
      notifyBestEffort(ctx, `Loop audit (iteration ${iteration}) flagged gaps — corrective directive queued for the next iteration.`, "warning");
      break;
    case "disapproved-stop":
      notifyBestEffort(ctx, `Loop audit (iteration ${iteration}): ${LOOP_AUDIT_STOP_STREAK} consecutive disapprovals — the loop stops at the next tick.`, "warning");
      break;
    case "impossible":
      notifyBestEffort(ctx, `Loop audit (iteration ${iteration}): the auditor says the target can never be satisfied — the loop stops at the next tick.`, "warning");
      break;
    case "infra":
      notifyBestEffort(ctx, `Loop audit (iteration ${iteration}) produced no verdict (${errorText ?? "infrastructure failure"}) — no verdict applied.`, "warning");
      break;
  }
}

/**
 * Fire-and-forget entry point, called from runLoopTick on the CONTINUE path
 * only (every stop route returns before it). Never throws, never blocks the
 * tick: the detached audit runs alongside the loop and applies its verdict
 * asynchronously.
 */
export function maybeTriggerLoopAudit(ctx: ExtensionContext, loop: LoopState): void {
  const settings = loadSettings(ctx.cwd);
  const interval = typeof settings.auditLoop === "number" ? settings.auditLoop : 0;
  if (!shouldTriggerLoopAudit(loop.iteration, interval, loopAuditInFlight)) {
    // Ledger the skip ONLY on a would-have-fired slot while an audit is in
    // flight — an off setting must stay silent.
    if (interval > 0 && loop.iteration > 0 && loop.iteration % interval === 0 && loopAuditInFlight) {
      appendLedger(ctx.cwd, "loop_audit_skipped_in_flight", { iteration: loop.iteration });
    }
    return;
  }
  loop.lastLoopAuditIteration = loop.iteration;
  try {
    persistStateLine(ctx.cwd, state);
  } catch {
    /* best effort */
  }
  void runLoopAuditAndApply(ctx.cwd, ctx, loop, settings);
}
