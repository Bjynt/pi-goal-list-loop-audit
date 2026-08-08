/**
 * goal-recovery.ts — Recovery machinery: compat sidecar + main-model
 * recovery + completion-audit recovery.
 *
 * Decomposition step 3 (v0.34.111): extracted from extensions/loops/goal.ts.
 * - ZERO behavior change: moved bodies are byte-identical except module-level
 *   flag references rewritten to `flags.<name>` accessors.
 * - One-way imports: this module never imports from goal.ts or goal-commands.ts.
 *   It DOES import from goal-loop.ts (clearContinuationTimer / clearLoopTimer
 *   are loop-owned) and from goal-state.ts (state.mainModelRecovery lives
 *   there per step 1).
 * - Module-level mutable state owned here: mainModelRecoveryTimer,
 *   mainModelSwitchInFlight, mainModelAbortForRecovery, lastMainModelFailure,
 *   completionAuditRecoveryArmed. goal.ts observes them through the
 *   RecoveryFlags accessor object.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { state } from "./goal-state.js";
import { appendLedger, nowIso, piGlaDir, type Goal, type PendingCompletion } from "./goal-loop-core.js";
import { cancelDetachedGoalCompletionAuditor } from "./goal-loop-auditor-process.js";

/* ------------------------------------------------------------------ */
/* Cluster A — compat sidecar marker (single-use, freshness-bounded)   */
/* ------------------------------------------------------------------ */

const RECOVERY_RESUME_MARKER = "recovery-resume.json";
const RECOVERY_RESUME_FRESH_MS = 300_000;

/** v0.34.13: consume the sidecar marker on session restore. Single-use,
 * freshness-bounded — a stale marker from an abandoned recovery must not
 * surprise-resume a later session. */
export function consumeRecoveryResume(cwd: string): boolean {
  try {
    const p = path.join(piGlaDir(cwd), RECOVERY_RESUME_MARKER);
    if (!fs.existsSync(p)) return false;
    const raw = fs.readFileSync(p, "utf-8");
    fs.unlinkSync(p);
    const at = Date.parse((JSON.parse(raw) as { at?: string }).at ?? "");
    return !Number.isNaN(at) && Date.now() - at < RECOVERY_RESUME_FRESH_MS;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Cluster C — completion-audit recovery (durable claim rehydration)  */
/* ------------------------------------------------------------------ */

/* The `completionAuditRecoveryArmed` flag stays owned by goal.ts and is
 * read/written by goal.ts watchdog / lifecycle code; the moved functions
 * below don't touch it directly, so no RecoveryFlags entry is needed yet.
 * (Cluster B's mainModelRecovery will add the first RecoveryFlags
 * accessors when the big block moves.) */
export interface RecoveryFlags {
  // intentionally empty for cluster A + C; cluster B will add:
  //   get/set mainModelRecoveryTimer
  //   get/set mainModelSwitchInFlight
  //   get/set mainModelAbortForRecovery
  //   get/set lastMainModelFailure
  //   get/set completionAuditRecoveryArmed (if it ends up here)
}

export interface RecoveryDeps {
  activeGoalSurfaceCommand: (command: string) => string;
  cancelDetachedGoalCompletionAuditor: (cwd: string, attemptId: string) => boolean;
  clearDetachedAuditRuntime: () => void;
  nowIso: () => string;
  updateGoal: (patch: Partial<Goal>, ctx: ExtensionContext) => void;
}

let activeGoalSurfaceCommand: RecoveryDeps["activeGoalSurfaceCommand"];
let clearDetachedAuditRuntime: RecoveryDeps["clearDetachedAuditRuntime"];
// appendLedger + nowIso + cancelDetachedGoalCompletionAuditor imported directly from goal-loop-core / goal-loop-auditor-process above.
let updateGoal: RecoveryDeps["updateGoal"];

export function createGoalRecovery(_flags: RecoveryFlags, d: RecoveryDeps): void {
  activeGoalSurfaceCommand = d.activeGoalSurfaceCommand;
  clearDetachedAuditRuntime = d.clearDetachedAuditRuntime;
  updateGoal = d.updateGoal;
}

export function markCompletionAuditRecoveryPending(ctx: ExtensionContext, reason: string): boolean {
  const goal = state.goal;
  const claim = goal?.pendingCompletion;
  if (!goal || goal.status !== "auditing" || !claim) {
    // A legacy/corrupt in-memory audit can still hold the process latch even
    // when its durable claim is absent. Fail closed for the MAIN as well.
    if (goal?.status === "auditing") clearDetachedAuditRuntime();
    return false;
  }
  const pending: PendingCompletion = {
    ...claim,
    phase: "recovery-pending",
    recoveryAt: nowIso(),
    recoveryReason: reason,
  };
  // Kill any child still owned by this process before releasing the durable
  // claim. Its late result is rejected by the attempt/generation checks, and
  // it must not keep the user-facing state looking like an active audit.
  if (claim.attemptId) cancelDetachedGoalCompletionAuditor(ctx.cwd, claim.attemptId);
  clearDetachedAuditRuntime();
  updateGoal({
    status: "paused",
    pendingCompletion: pending,
    pauseKind: "blocked",
    pauseResumeAt: undefined,
    pauseReason: `completion audit blocked — no verdict: ${reason}`,
    pauseSuggestedAction: `The completion claim is stored and was not judged. Fix the auditor/session issue, then ${activeGoalSurfaceCommand("resume")} to start exactly one fresh audit.`,
    pauseOptions: undefined,
    pauseRecommended: undefined,
  }, ctx);
  appendLedger(ctx.cwd, "audit_recovery_pending", {
    goalId: goal.id,
    attemptId: claim.attemptId,
    reason,
    mainReleased: true,
    verdict: "none",
  });
  return true;
}

export function isCompletionAuditRecoveryPending(goal: Goal | null | undefined): boolean {
  return !!goal?.pendingCompletion && goal.pendingCompletion.phase !== "running";
}
