/**
 * pi-goal-list-loop-audit — v0.1.0
 * extensions/loops/goal.ts
 *
 * The goal loop. The agent continues working, and on complete_goal,
 * an isolated auditor verifies the work.
 *
 * Design: see docs/DESIGN.md.
 *
 * Command surface (v0.8.0 — four top-level commands):
 *   /goal "<objective>" | /goal (draft) | /goal status|pause|resume|cancel|tweak <text>|archive
 *   /list add|show|tweak|next|remove|clear
 *   /loop (draft) | /loop start|status|stop
 *   /glla (settings UI) | /glla <action>
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// v0.34.109 (decomposition step 1): the state singleton and the persistence
// core moved to goal-state.ts — the SINGLE owner of the mutable state object
// (positioning doc invariant #2). Property reads on the imported binding are
// fine; wholesale replacement goes through replaceState().
import { state, replaceState, persistStateLine } from "../goal-state.js";

import {
  type Goal,
  type Policy,
  type State,
  type MainModelRecovery,
  type Status,
  type ModeCommand,
  modeCommand,
  workCommand,
  workCommandRoot,
  appendLedger,
  archiveDir,
  archivedGoalPath,
  buildTaskList,
  buildTaskSummary,
  auditFeedbackExcerpt,
  auditVerdictLabel,
  DEFAULT_AUDIT_FEEDBACK_CHARS,
  DEFAULT_QUOTA_RETRY_MINUTES,
  DEFAULT_STALL_ESCALATION_REFIRES,
  DEFAULT_TOKEN_LIMIT,
  classifyImpossibleReason,
  extractPendingTasks,
  isFullAuditObjective,
  resolveEffectiveAggressiveSettings,
  appendAuditLog,
  computeListDepth,
  formatAuditLog,
  formatGoalAuditHistory,
  runWithInfraRetry,
  isRetriableInfraError,
  readAuditLog,
  bumpGoalRevision,
  stripThinkBlocks,
  type AuditLogEntry,
  ledgerPath,
  crossRecommendMode,
  formatListDepth,
  parseListItemDeclaration,
  shouldEscalateStall,
  isStaleApiError,
  parseListImport,

  routeGoalArgs,
  routeListText,
  listMutationBlocked,
  LIST_DRAFTING_BLOCK_MESSAGE,
  LIST_MUTATING_SUBCOMMANDS,
  SETTINGS_MUTATING_ACTIONS,
  sumNewAssistantTokens,
  takeAt,
  countTrailingDisapprovals,
  goalArgsNeedDrafting,
  buildSeedGrillMessage,
  askUserQuestionAnswered,
  draftProposalBlock,
  type TaskProposal,
  validateTaskProposal,
  ensureDirs,
  findNextPendingTask,
  goalMdPath,
  newGoalId,
  nowIso,
  compactDisplayText,
  sanitizeDisplayText,
  piGlaDir,
  normalizeDraftContract,
  draftContractItemCount,
  extractVerificationContract,
  classifySessionCtx,
  readState,
  healCorruptedGoalPolicy,
  renderGoalMarkdown,
  shouldAutoResumeOnSessionStart,
  statusLabel,
  writeGoalMd,
  writeQueueItemFile,
  readQueueFromDisk,
  deleteQueueItemFile,
  missingGllaTools,
  runPersistStep,
  isPersistenceDegraded,
  lastPersistenceFailure,
  modelSwitch,
  isForbiddenModel,
isGoalRevisionCurrent,
  nextHourlyPromptMs,
  nextHourlyProbeMs,
  type ModelSwitchRecord,
  type ListItem,
} from "../goal-loop-core.js";
import {
  createContinuationDispatch,
  dispatchMatchesOwner,
  dispatchPromptMatches,
  dispatchTimedOut,
  dispatchRecordPath,
  clearDispatchRecord,
  persistDispatchRecord,
  readDispatchRecord,
  transitionDispatch,
  type ContinuationDispatch,
} from "../goal-loop-dispatch.js";
import {
  createGoalContinuation,
  scheduleContinuation,
  sendContinuation,
  sendStallEscalation,
  sendLengthContinue,
  dispatchStartAcknowledged,
  dispatchAccepted,
  dispatchFailed,
  dispatchPrepare,
  releaseContinuationDispatchStandDown,
  clearContinuationTimer,
  clearContinuationStartWatchdog,
  clearQueueStuckProbe,
  accountSendRearm,
  sendRearmDelayMs,
  armQueueStuckProbe,
  buildPostCompactResync,
  continuationTimerPending,
  continuationTimerRef,
  continuationStartTimerRef,
  pendingContinuationDispatchRef,
  setPendingContinuationDispatchRef,
  continuationDispatchStoodDownRef,
  setContinuationDispatchStoodDownRef,
  lastContinuationSentAtRef,
  setLastContinuationSentAtRef,
  lastContinuationSentPayloadRef,
  setLastContinuationSentPayloadRef,
  setContinuationRearmStreak,
  setContinuationRearmSince,
  type ContinuationFlags,
  type ContinuationDeps,
} from "../goal-continuation.js";
export { __testOnlySetContinuationStartTimeout, __testOnlySetContinuationRetryBackoff } from "../goal-continuation.js";
import {
  LENGTH_CONTINUE_MAX,
  LENGTH_CONTINUE_TEXT,
  isContextStarvedLengthStop,
  resetLengthContinue,
  tickLengthContinue,
} from "../length-continue.js";
import {
  capQuotaRetrySeconds,
  isSubagentQuotaResult,
  parseQuotaError,
  quotaRetryDelaySeconds,
  scheduleQuotaRetry,
  cancelQuotaRetry,
} from "../quota-retry.js";
import {
  classifyMainModelFailure,
  isLongLivedFailureKind,
  mainModelAutoRetryUntil,
  mainModelFailureDelayMs,
  mainModelRetryDelayMs,
  MAIN_MODEL_AUTO_RETRY_HORIZON_MS,
  modelRef,
  nextUntriedModelRef,
  normalizeModelRefs,
  sendStormEscalateMs,
  splitModelRef,
  type MainModelFailure,
} from "../main-model-recovery.js";
import {
  globalSettingsPath,
  loadGlobalSettings,
  loadSettings,
  projectSettingsPath,
  saveSettings,
  settingsProvenance,
  type Settings,
} from "../goal-settings.js";
import {
  curateAuditReviewSources,
  normalizeObjective,
  resolveReviewerConfig,
  reviewerMenuOptions,
  runReviewer,
  type ReviewerConfig,
} from "../reviewer.js";
import {
  discoverGllaProjects,
  parseLedgerEntries,
  filterPremature,
  formatRollupJson,
  formatRollupTable,
  rollupProject,
  type ProjectRollup,
} from "../goal-loop-stats.js";
import {
  cancelDetachedGoalCompletionAuditor,
  newDetachedAuditJobAttemptId,
  runDetachedGoalCompletionAuditor,
  type AuditorProgress,
} from "../goal-loop-auditor-process.js";
import {
  REPETITION,
  isActuallyStuck,
  loopInterventionDirective,
  continueVariant,
  textFingerprint,
  pushCapped as pushRepetitionCapped,
} from "../goal-loop-repetition.js";
import { buildStatusText, buildWidgetLines, type AuditDisplayProgress } from "../goal-loop-display.js";
import {
  defaultAgentDir,
  resolveEffectiveSubagentModel,
  syncSubagentModelOverrides,
  type SubagentModelStrategy,
} from "../goal-loop-subagents.js";
import {
  buildSettingsRows,
  SettingsMenuComponent,
  type SettingsRow,
  type SettingsSectionId,
} from "../settings-menu.js";
import {
  VISION_ASSIST_GUIDANCE,
  routeVisionCheck,
  visionAssistLedger,
} from "../vision-assist.js";
import {
  buildModelPickItems,
  ModelPickerComponent,
  type ModelPickItem,
} from "../model-picker.js";
import { consumeRecoveryResume } from "../goal-recovery.js"; // decomposition step 3 (v0.34.111)
import {
  createGoalHeartbeat,
  endSubagentHangProbe,
  markSubagentHangProgress,
  startHeartbeat,
  upsertSubagentHangProbe,
  type HeartbeatDeps,
  type HeartbeatFlags,
} from "../goal-heartbeat.js"; // decomposition step 4 (v0.34.112)
import {
  clearMainModelRecoveryTimer,
  createGoalRecovery,
  isCompletionAuditRecoveryPending,
  mainModelRecoveryActive,
  mainModelRecoveryKind,
  mainModelRecoveryReason,
  mainModelRecoverySucceeded,
  mainModelFallbackRefs,
  manuallyResumeMainModelRecovery,
  markCompletionAuditRecoveryPending,
  parkMainModelAfterFailure,
  probeMainModelRecovery,
  recoverMainModelFromSendStorm,
  resolveMainModel,
  scheduleHourlyProbe,
  scheduleMainModelRecoveryTimer,
  setMainModelRecoveryPause,
  tryMainModelFallback,
  withMainModelRecoveryWindow,
  type RecoveryDeps,
  type RecoveryFlags,
} from "../goal-recovery.js"; // decomposition step 3 (v0.34.111) — clusters B (main-model recovery) + C (completion-audit recovery)
import {
  ConfirmDraftComponent,
} from "../confirm-draft.js";
import {
  applyMeasurement,
  applyMetriclessTick,
  applyRefinement,
  loopBranchName,
  parseLoopStartArgs,
  loopFinishStopReason,
  isLoopWriteTool,
  parseMetric,
  LOOP_DEFAULTS,
  resolveSpecFiles,
  respecTarget,
  topOpenAuditFinding,
  specFileHash,
  countCheckedSpecItems,
  auditMeasureCmd,
  auditTarget,
  AUDIT_PLATEAU_MAX_REPRIEVES,
  countOpenAuditFindings,
  AUDIT_FINDINGS_REL,
  projectAuditTarget,
  LIST_AUDIT_COLLECT_MARKER,
  GOAL_AUDIT_ONESHOT_MARKER,
  LOOP_AUDIT_MARKER,
  listAuditCollectTarget,
  parseAuditFindingsForFanout,
  listAuditFanoutItemText,
  type LoopTickOutcome,
  HELD_ON_RESTORE,
  type LoopState,
} from "../goal-loop-forever.js";
import {
  accountTurnForNudgesRich,
  BACKOFF_IDLE_RETRY_MS,
  DEFAULT_STALL_SIM_THRESHOLD,
  DEFAULT_STALL_SHORT_WORDS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_NUDGES,
  HEARTBEAT_STALL_MS,
  shouldHeartbeatRefire,
  MEASURE_TIMEOUT_MS,
  WEDGE_ALERT_DEFAULT_MINUTES,
  shouldWedgeAlert,
  PENDING_LATCH_STUCK_MS,
  shouldFirePendingLatchWatchdog,
  msUntilNextHourBoundary,
  AUDITOR_WALL_TIMEOUT_MS,
} from "../goal-loop-backoff.js";

import {
  addSingleItem,
  autoNotifyCmd,
  cmdGoal,
  cmdList,
  cmdReview,
  cmdReviewerSettings,
  cmdSettings,
  createGoalCommands,
  enqueueItems,
  maybeDecisionPopup,
  probeAutoNotify,
  recentlyCompletedObjectives,
  warnIfAuditorProviderRisky,
  warnOnCommandCollision,
  type CommandDeps,
  type CommandFlags,
} from "../goal-commands.js";
import {
  STALE_TOOL_CONTEXT_MESSAGE,
  clearLoopTimer,
  cmdLoop,
  createGoalLoop,
  isLoopActive,
  loopTimerPending,
  runLoopTick,
  scheduleLoopTick,
  startLoopFromConfig,
  type LoopDeps,
  type LoopFlags,
} from "../goal-loop.js";
import { defineGoalRuntimeGlobal } from "./goal-runtime-globals.js";

function escalateStallNow(ctx: ExtensionContext, threshold: number): boolean {
  if (!shouldEscalateStall(consecutiveStalls, threshold)) return false;
  consecutiveStalls = 0;
  appendLedger(ctx.cwd, "stall_escalated", { threshold, kind: isLoopActive() ? "loop" : "goal" });
  if (isLoopActive()) {
    clearLoopTimer();
    state.loop = { ...state.loop!, active: false, stopReason: `stalled: ${threshold} continuation refires landed no turn — the session is not continuing (wedged message queue or stale API). Press Escape to cancel any stuck run, then /loop resume — the loop holds on restore. A fresh session_start rebinds the loop or goal; restart pi normally only if no replacement arrives.` };
    persistState(ctx);
    ctx.ui.notify(`Loop stopped: ${threshold} refires produced no turn — the continuation is not landing. Escape cancels a stuck run, then /loop resume (the loop holds on restore). A fresh session_start rebinds it; restart pi normally only if no replacement arrives.`, "warning");
    notifyExternal(ctx, "Loop stopped: stalled (continuation not landing).");
    return true;
  }
  if (state.goal && state.goal.status === "active") {
    updateGoal({
      status: "paused",
      pauseKind: "error",
      pauseReason: `stalled: ${threshold} continuation refires landed no turn`,
      pauseSuggestedAction: `The continuation chain is broken in this process (wedged message queue or stale API). Press Escape to cancel any stuck run, then ${activeGoalSurfaceCommand("resume")}. A fresh session_start rebinds the goal; restart pi normally only if no replacement arrives.`,
    }, ctx);
    ctx.ui.notify(`${goalNoun()} paused: ${threshold} refires produced no turn. Escape cancels a stuck run, then ${activeGoalSurfaceCommand("resume")}. A fresh session_start rebinds it; restart pi normally only if no replacement arrives.`, "warning");
    notifyExternal(ctx, `${goalNoun()} paused: stalled (continuation not landing).`);
    return true;
  }
  return true;
}

let heartbeatStaleStreak = 0;

let iterationCounter = 0;
let toolCallsThisTurn = 0;
let consecutiveErrorIterations = 0;
// v0.28.5 (E8): user aborts are NOT provider errors — separate counter,
// separate brake message, and no auto-resume (aborting is user intent).
let consecutiveAbortIterations = 0;
// v0.29.5: set when a user abort stands the chain down (0.29.4) — the
// heartbeat refire + post-compaction refire must NOT resurrect it; only
// an explicit schedule (resume/activate/next turn) clears it.
let abortedStandDown = false;

function scheduleSessionTimeout(callback: () => void, delayMs: number): NodeJS.Timeout {
  const generation = sessionGeneration;
  let timer: NodeJS.Timeout;
  timer = setTimeout(() => {
    sessionTimeouts.delete(timer);
    // clearTimeout is not enough when the callback is already queued. Do not
    // let an old session's callback re-arm work after stale/shutdown/reload.
    if (
      generation !== sessionGeneration ||
      sessionHandoffPending ||
      extensionApiStale ||
      staleTerminalDone ||
      zombieStoodDown
    ) return;
    callback();
  }, delayMs);
  sessionTimeouts.add(timer);
  timer.unref?.();
  return timer;
}

function clearSessionOwnedTimers(): void {
  sessionHandoffPending = true;
  sessionGeneration++;
  initialSessionLoadPending = false;
  clearContinuationTimer();
  clearContinuationStartWatchdog();
  clearLoopTimer();
  clearQueueStuckProbe();
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (uiTicker) { clearInterval(uiTicker); uiTicker = null; }
  clearMainModelRecoveryTimer();
  mainModelAbortForRecovery = false;
  lastMainModelFailure = null;
  for (const timer of sessionTimeouts) clearTimeout(timer);
  sessionTimeouts.clear();
  cancelQuotaRetry();
  if (ownerSession) {
    deadOwnerSession = ownerSession; // v0.34.25: keep the dead identity for successor absorption
    deadOwnerCwd = ownerCwd ?? lastCtx?.cwd ?? null;
  }
  lastCtx = null;
  ownerSession = null;
  ownerCwd = null;
}

function isActionableGoal(): boolean {
  return !!state.goal && state.goal.status === "active" && state.goal.autoContinue;
}

function freshCtx(): ExtensionContext | null {
  if (sessionHandoffPending || initialSessionLoadPending) return null;
  // A captured ctx throws "stale" after session replacement. Probe cheaply;
  // on stale, drop it and wait for the next event to hand us a fresh one.
  if (!lastCtx) return null;
  try {
    lastCtx.isIdle();
    return lastCtx;
  } catch {
    lastCtx = null;
    return null;
  }
}

/**
 * v0.34.20: a timer can already be queued when clearSessionOwnedTimers()
 * runs, and an async audit can finish after a replacement without a queued
 * timer at all. Delayed work must prove both facts before touching pi:
 * generation identity is unchanged and the context probe succeeds. A null
 * result is a normal fail-closed handoff, not a reason to use the caller's
 * captured context as a fallback.
 */
function freshCtxForGeneration(generation: number): ExtensionContext | null {
  if (
    generation !== sessionGeneration ||
    sessionHandoffPending ||
    initialSessionLoadPending ||
    extensionApiStale ||
    staleTerminalDone ||
    zombieStoodDown
  ) return null;
  return freshCtx();
}

/**
 * v0.34.20: the generic quota helper owns only the wall-clock timer and the
 * immediate notification. This adapter owns the session boundary: callbacks
 * receive a context proven fresh at fire time and may not close over the
 * scheduling event's ctx.
 */
function scheduleQuotaRetryForSession(
  ctx: ExtensionContext,
  retryAfterSec: number,
  reason: string,
  fire: (ctx: ExtensionContext) => void | Promise<void>,
  label?: string,
): void {
  const generation = sessionGeneration;
  scheduleQuotaRetry(ctx, retryAfterSec, reason, () => {
    const current = freshCtxForGeneration(generation);
    if (!current) return;
    try {
      void Promise.resolve(fire(current)).catch((err) => {
        if (isStaleApiError(err)) extensionApiStale = true;
      });
    } catch (err) {
      if (isStaleApiError(err)) extensionApiStale = true;
    }
  }, label);
}

// clearMainModelRecoveryTimer / mainModelRecoveryActive / mainModelRecoveryKind /
// mainModelRecoveryReason / withMainModelRecoveryWindow moved to goal-recovery.ts
// (decomposition step 3, v0.34.111) and imported above.

// ============================================================================
// Main-model recovery machinery (holdMainModelRecovery, tryMainModelFallback,
// probeMainModelRecovery, scheduleMainModelRecoveryTimer, scheduleHourlyProbe,
// manuallyResumeMainModelRecovery, recoverMainModelFromSendStorm,
// mainModelRecoverySucceeded, parkMainModelAfterFailure, mainModelFallbackRefs,
// resolveMainModel, setMainModelRecoveryPause, fireHourlyProbe, cancelHourlyProbe,
// and the hourly lets) moved to goal-recovery.ts (decomposition step 3,
// v0.34.111) and imported at the top of this file. The RecoveryFlags/RecoveryDeps
// wiring lives at createGoalRecovery(...) below.
// ============================================================================

/** Handle a provider error before loop/goal bookkeeping can mistake it for
 * an unproductive turn. Returns true when recovery owns this agent_end. */
async function handleMainModelAgentEnd(ctx: ExtensionContext, rawLastA: any, lastA: any): Promise<boolean> {
  if (lastA?.stopReason === "aborted" && mainModelAbortForRecovery) {
    mainModelAbortForRecovery = false;
    appendLedger(ctx.cwd, "main_model_recovery_abort_settled", { model: modelRef(ctx.model) });
    return true;
  }
  if (lastA?.stopReason === "error") {
    const rawError = [rawLastA?.errorMessage, lastA.text].filter((v): v is string => typeof v === "string" && v.trim().length > 0).join(" — ");
    const failure = classifyMainModelFailure(rawError);
    lastMainModelFailure = failure;
    if (isLongLivedFailureKind(failure.kind)) lastLongLivedFailureAt = Date.now();
    if (failure.kind !== "non-recoverable") {
      const switched = await tryMainModelFallback(ctx, failure);
      if (switched) return true; // pi's core retry now uses the selected backup
      const backupRefs = mainModelFallbackRefs(ctx);
      // v0.34.51: no quota/billing/auth gate — ANY failure parks into the
      // durable recovery envelope. The one exemption is transient
      // (5xx/timeout/network: positive evidence of a short-lived hiccup),
      // which keeps the fast error ladder instead of a 15m probe — nothing
      // ever STOPS on classification, only the pacing differs.
      if ((state.goal?.status === "active" && failure.kind !== "transient") || backupRefs.length > 0) {
        parkMainModelAfterFailure(ctx, failure);
        if (mainModelRecoveryActive() || state.mainModelRecovery) return true;
      }
    }
  } else if (lastA) {
    if (state.mainModelRecovery) mainModelRecoverySucceeded(ctx);
    else lastMainModelFailure = null;
  }
  return false;
}



// =================================================================
// Goal lifecycle
// =================================================================

function createGoal(objective: string, ctx: ExtensionContext, policy: "goal" | "list" = "goal"): Goal {
  ensureDirs(ctx.cwd);
  // Extract verification contract if present in objective.
  const { objective: cleanObj, verificationContract } = extractVerificationContract(objective);
  const id = newGoalId();
  const goal: Goal = {
    id,
    objective: cleanObj,
    status: "active",
    policy,
    autoContinue: true,
    verificationContract: verificationContract || "",
    usage: { tokensUsed: 0, tokensLimit: loadSettings(ctx.cwd).tokenLimit ?? DEFAULT_TOKEN_LIMIT },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  return goal;
}

function persistState(ctx: ExtensionContext): void {
  // v0.34.61 (steal #3, auditor round 2): the revision counter is
  // CONTRACT-scoped. v0.34.59 bumped on EVERY commit — audit settles
  // bumped too, so a settled verdict always left the goal one revision
  // past the recorded one and every later complete_goal was falsely
  // rejected ("pass when matching" was unreachable; /goal verify's
  // escape dead-ended too). Bumps now happen ONLY at the two contract
  // change sites (cmdTweak, complete_goal newObjective) — a settled
  // audit leaves lastAudited.revision === state.goal.revision.
  // The durable write itself lives in goal-state.ts (persistStateLine);
  // this wrapper adds the UI side effects on top.
  persistStateLine(ctx.cwd, state);
  notifyPersistenceState(ctx); // v0.28.6 (E1): loud on the first failure, all-clear on recovery
  refreshUI(ctx); // every state transition flows through here → the TUI is always current
}

// v0.28.6 (E1): persistence-degradation notify — once per failure streak,
// once per recovery. The TUI flag (buildWidgetLines) carries the standing
// state; these notifies are the LOUD part.
let persistenceDegradedNotified = false;

/** v0.28.11 (U9): objective-first notifies — truncate long objectives.
 * v0.34.24: this is a display projection; persisted objective text stays raw.
 */
const shortObj = (s: string): string => {
  const safe = compactDisplayText(s);
  return safe.length > 90 ? `${safe.slice(0, 87)}…` : safe;
};
const displaySlice = (s: string, max: number): string => compactDisplayText(s).slice(0, max);
/** v0.28.30: terminology — a list item is not a goal (user note: "we seem
 * to call everything goal"). User-facing pause/abort notifies name the policy. */
const goalNoun = (): string => (state.goal?.policy === "list" ? "List item" : "Goal");
const activeGoalCommand = (command: ModeCommand): string => modeCommand(state.goal?.policy, command);
const activeGoalRoot = (): "/goal" | "/list" => workCommandRoot(state.goal?.policy) as "/goal" | "/list";
const activeGoalSurfaceCommand = (command: string): string => workCommand(state.goal?.policy, command);
const activeGoalStatusCommand = (): string => state.goal?.policy === "list" ? `${activeGoalRoot()} show` : `${activeGoalRoot()} status`;
// v0.34.108: the main-model recovery paths park a METRIC LOOP too — a
// loop resumed through "/goal resume" would be wrong. activeGoalSurfaceCommand
// keys off the goal policy only; this helper adds the loop surface.
const recoverySurfaceCommand = (kind: "goal" | "loop", command: string): string =>
  workCommand(kind === "loop" ? "loop" : state.goal?.policy, command);
function notifyPersistenceState(ctx: ExtensionContext): void {
  if (isPersistenceDegraded() && !persistenceDegradedNotified) {
    persistenceDegradedNotified = true;
    const err = lastPersistenceFailure();
    ctx.ui.notify(
      `⚠ Persistence degraded: ${err?.what ?? "disk write"} failed (${(err?.error ?? "unknown").slice(0, 80)}). State lives in RAM and re-syncs on the next successful write — .pi-glla may be missing recent entries. Fix the disk (space/permissions) and it self-heals.`,
      "warning",
    );
    notifyExternal(ctx, "pi-goal-list-loop-audit: persistence degraded — .pi-glla writes failing.");
  } else if (!isPersistenceDegraded() && persistenceDegradedNotified) {
    persistenceDegradedNotified = false;
    ctx.ui.notify("Persistence recovered — .pi-glla writes are landing again.", "info");
  }
}

function setGoal(goal: Goal, ctx: ExtensionContext, via = "user"): boolean {
  // v0.33.1: per-goal module state resets at activation — a new goal must
  // not inherit the previous goal's compact debt/resync, quota streak,
  // token-message dedupe set, or widget action feed.
  postCompactResumeOwed = false;
  postCompactResyncPending = false;
  clearMainModelRecoveryTimer();
  state.mainModelRecovery = undefined;
  mainModelAbortForRecovery = false;
  lastMainModelFailure = null;
  releaseContinuationDispatchStandDown();
  countedTokenMessages.clear();
  recentActions.length = 0;
  // v0.28.14: never silently orphan a live goal — a paused/active goal
  // being replaced is archived honestly first (the old behavior left it in
  // goals/ but untracked: "older goals lying around leading to confusion").
  // v0.34.103 (GitHub #6, Defect A): a REPLACED WAIT goal's scheduled
  // auto-resume (pauseResumeAt) was silently dropped with it — the user's
  // reasonable "it will come back" expectation broke with no notice. If the
  // superseded goal had a pending scheduled resume, say so explicitly and
  // ledger the cancellation so forensics can trace the dropped intent.
  if (state.goal && state.goal.id !== goal.id && ["active", "paused", "auditing"].includes(state.goal.status)) {
    const replaced = state.goal;
    const hadScheduledResume = !!replaced.pauseResumeAt;
    if (!archiveCurrentGoal(ctx, "aborted", `replaced by goal ${goal.id}`)) {
      ctx.ui.notify(`New objective not started — the current ${replaced.policy === "list" ? "list item" : "goal"} could not be archived safely.`, "warning");
      return false;
    }
    if (hadScheduledResume) {
      appendLedger(ctx.cwd, "replaced_resume_cancelled", {
        goalId: replaced.id,
        policy: replaced.policy,
        scheduledAt: replaced.pauseResumeAt,
        replacedBy: goal.id,
      });
      const verb = replaced.policy === "list" ? "/list add" : "/goal";
      ctx.ui.notify(
        `Goal [${replaced.id}]: ${displaySlice(replaced.objective, 60)} was superseded and archived — its scheduled auto-resume (${new Date(Date.parse(replaced.pauseResumeAt!)).toLocaleTimeString()}) was cancelled. ${verb} <objective> to recreate it.`,
        "warning",
      );
      notifyExternal(ctx, `pi-goal-list-loop-audit: a paused goal with a scheduled auto-resume was replaced; the resume was cancelled.`);
    }
  }
  goal.createdVia = via; // v0.28.28: provenance — answerable from the ledger + /glla log
  // v0.34.60: disk-first write order. The active-goal .md lands BEFORE
  // the in-memory state commit, so a stale extension handle (post
  // /reload, torn jsonl, process restart) can recover from disk. The
  // active goal .md path is also where any state.goal.id lookup in a
  // fresh process lands, so writing it first closes the
  // "in-memory knows about a goal the disk does not" gap.
  const file = writeGoalMd(ctx.cwd, goal);
  replaceState({ ...state, goal }); // preserve list AND loop (v0.28.14: the bare reconstruction used to nuke a held/active loop whenever a goal was set)
  state.goal!.activePath = path.relative(ctx.cwd, file) || file;
  persistState(ctx);
  appendLedger(ctx.cwd, "goal_created", { goalId: goal.id, objective: goal.objective, policy: goal.policy, via });
  return true;
}

function updateGoal(patch: Partial<Goal>, ctx: ExtensionContext): void {
  if (!state.goal) return;
  // v0.34.60: write the active-goal .md BEFORE the in-memory commit and
  // BEFORE persistState (which appends to active.jsonl). If the
  // orchestrator turn dies between the in-memory commit and the disk
  // write, the file is already on disk; if it dies between the disk
  // write and active.jsonl, the file is still there. The only failure
  // mode that loses the write is the disk write itself — exactly the
  // path runPersistStep already guards.
  const next: Goal = { ...state.goal, ...patch, updatedAt: nowIso() };
  const file = writeGoalMd(ctx.cwd, next);
  state.goal = next;
  state.goal.activePath = path.relative(ctx.cwd, file) || file;
  persistState(ctx);
}

// v0.29.6: stacked-state auto-arbitration (user directive: "auto archive /
// wipe extra goals/loops/lists … make sure that we only have one"). Dirty
// pre-guard states can persist a live loop AND a live goal; the 0.28.21
// decision picker asked the user to arbitrate artifacts they didn't
// remember at every pi start. Now deterministic: MOST RECENT ACTIVITY
// keeps the slot; the loser is ARCHIVED (recoverable), never wiped. The
// queued list is a backlog, not a live artifact — untouched.
function autoArbitrateStackedState(ctx: ExtensionContext): void {
  const loop = state.loop?.active ? state.loop : undefined;
  const goal = state.goal && state.goal.status !== "complete" && state.goal.status !== "aborted" ? state.goal : undefined;
  if (!loop || !goal) return; // at most one live artifact — the invariant holds
  const lastMeasure = loop.history.length > 0 ? loop.history[loop.history.length - 1] : undefined;
  const loopMs = Date.parse(lastMeasure?.at ?? loop.startedAt ?? "") || 0;
  const goalMs = Date.parse(goal.updatedAt ?? goal.createdAt ?? "") || 0;
  const keepGoal = goalMs > loopMs; // tie → the loop keeps the slot (0.28.21 default)
  appendLedger(ctx.cwd, "stacked_state_auto_arbitrated", {
    kept: keepGoal ? "goal" : "loop",
    goalId: goal.id,
    goalMs,
    loopMs,
    loopIteration: loop.iteration,
    loopTarget: loop.target.slice(0, 120),
  });
  if (keepGoal) {
    // Same shape as /loop stop: the loop record stays in state (inactive)
    // with an honest reason — /loop status still shows it.
    replaceState({ ...state, loop: { ...loop, active: false, stopReason: "auto-arbitrated on session load: the goal was more recent (one active thing)" } });
    persistState(ctx);
  } else {
    archiveCurrentGoal(ctx, "aborted", "auto-arbitrated on session load: the loop was more recent (one active thing)");
  }
  ctx.ui.notify(
    `Stacked state auto-arbitrated (one active thing): kept the ${keepGoal ? "goal" : "loop"} — more recent activity — and archived the ${keepGoal ? `loop (iter ${loop.iteration}, best ${loop.bestValue ?? "n/a"})` : `goal (${goal.id})`}. Recoverable: /loop status · .pi-glla/archive/ · /glla wipe for a clean slate.`,
    "info",
  );
}

/** v0.31.0: /list audit completion fan-out — read the audit findings file,
 * queue every OPEN finding as its own list item (severity-sorted, deduped
 * against the live queue), present DECIDE findings without queueing them.
 * Confirm-gated like every bulk import (v0.23.7: the user reads what lands
 * in the queue) unless autoAcceptDrafts is enabled; a decline leaves the
 * findings open for a later re-run.
 * v0.34.20: this detached operation retains only cwd + generation. Every
 * context use after the confirmation await must come from the fresh session.
 */
async function fanOutListAuditFindings(cwd: string, generation: number): Promise<void> {
  let md = "";
  try {
    md = fs.readFileSync(path.join(cwd, AUDIT_FINDINGS_REL), "utf-8");
  } catch {
    /* no findings file — the audit was clean or never wrote */
  }
  const { open, decisions } = parseAuditFindingsForFanout(md);
  // Dedupe against the live queue (a re-run must not double-queue a finding
  // that's already waiting) — match on the finding text's first 60 chars.
  const queuedText = listQueue().map((i: any) => i.objective).join("\n");
  // v0.32.0: cap one fan-out — a runaway findings file must not enqueue
  // hundreds of items on a single Confirm.
  const fresh = open.filter((f) => !queuedText.includes(f.text.slice(0, 60))).slice(0, 50);
  const alreadyQueued = open.length - fresh.length;
  const current = freshCtxForGeneration(generation);
  if (!current) return;
  // v0.33.3: DECIDE findings are RAISED TO THE USER as real questions
  // (hegemon 2026-07-31: a truncated notify left the user typing "decide
  // what" into the void). The orchestrator can't call ask_user_question —
  // the agent can — so the full untruncated findings go to the agent as a
  // steer with the raise + record protocol. Fires BEFORE the queueing
  // early-returns below: decisions need answers even when nothing new
  // queued or the fan-out was declined.
  if (decisions.length > 0) {
    const decList = decisions.slice(0, 8).map((d, i) => `${i + 1}. ${d.slice(0, 500)}`).join("\n");
    if (safeSteerUser(current,
      `[DECIDE FINDINGS — user decisions needed] The audit surfaced ${decisions.length} DECIDE finding(s) — direction calls only the user can make (a decision is not a task, so they were NOT queued):\n${decList}\nRaise them to the user NOW with ask_user_question — one question per finding, options from the finding's own two sides plus "Defer" (prose numbered list if ask_user_question is unavailable; Esc = Defer). Then record every answer in ${AUDIT_FINDINGS_REL}: replace the "- [?]" line with "- [x] DECIDED: <what was chosen> (<date>)" (or "- [x] DEFERRED") so it stops re-surfacing, and queue any chosen work with list_add — do NOT start the work inline.`))
      appendLedger(cwd, "list_audit_decisions_raised", { decisions: decisions.length });
  }
  const decideNote =
    decisions.length > 0
      ? ` ${decisions.length} DECIDE finding(s) need YOU — raising them as questions now (not queued — a decision is not a task).`
      : "";
  if (fresh.length === 0) {
    const afterDecision = freshCtxForGeneration(generation);
    if (!afterDecision) return;
    afterDecision.ui.notify(
      open.length > 0
        ? `Audit collected ${open.length} open finding(s) — all already queued.${decideNote}`
        : `Audit complete — no open findings; the project is clean, nothing to queue.${decideNote}`,
      "info",
    );
    appendLedger(cwd, "list_audit_fanout_empty", { open: open.length, decisions: decisions.length });
    return;
  }
  const preview = fresh.map((f, i) => `  ${i + 1}. ${f.text.slice(0, 110)}`).join("\n");
  const beforeConfirm = freshCtxForGeneration(generation);
  if (!beforeConfirm) return;
  // v0.34.29: autoAcceptDrafts is explicit pre-consent for generated list
  // batches too. Keep the normal confirmation for users who have not opted
  // in; the project override wins through loadSettings(cwd).
  const autoAccepted = beforeConfirm.hasUI && loadSettings(cwd).autoAcceptDrafts === true;
  let confirmed = true;
  if (beforeConfirm.hasUI && !autoAccepted) {
    try {
      confirmed = await beforeConfirm.ui.confirm(`Queue ${fresh.length} audit finding(s) as list items?`, preview);
    } catch {
      confirmed = false;
    }
  }
  // A confirm result from an old session is not consent for the replacement.
  const afterConfirm = freshCtxForGeneration(generation);
  if (!afterConfirm) return;
  if (!confirmed) {
    appendLedger(cwd, "list_audit_fanout_declined", { findings: fresh.length });
    afterConfirm.ui.notify(`Fan-out declined — the findings stay open in ${AUDIT_FINDINGS_REL}; /list audit re-queues them any time.`, "info");
    return;
  }
  const n = enqueueItems(afterConfirm, fresh.map((f) => listAuditFanoutItemText(f.text)), "list audit fan-out");
  appendLedger(cwd, "list_audit_fanout", {
    queued: n,
    alreadyQueued,
    decisions: decisions.length,
    autoAccepted,
  });
  afterConfirm.ui.notify(
    `Queued ${n} finding(s) — the list drains them fix by fix, each with its own audited commit.${alreadyQueued > 0 ? ` (${alreadyQueued} already queued.)` : ""}${autoAccepted ? " Auto-accepted by autoAcceptDrafts." : ""}${decideNote}`,
    "info",
  );
}

function archiveCurrentGoal(ctx: ExtensionContext, status: Status, stopReason?: string): boolean {
  releaseContinuationDispatchStandDown();
  clearDispatchRecord(ctx.cwd);
  postCompactResumeOwed = false; // v0.33.1: the dead goal's compact debt/resync dies with it
  postCompactResyncPending = false;
  if (!state.goal) return false;
  const goal = state.goal;
  const pendingAttemptId = goal.pendingCompletion?.attemptId;
  ensureDirs(ctx.cwd);
  const target = archivedGoalPath(ctx.cwd, goal.id);
  const md = renderGoalMarkdown({ ...goal, status, stopReason, pendingCompletion: undefined });
  // v0.28.6 (E1): guarded — and the active md is only removed when the
  // archive actually LANDED (degraded mode must not destroy the only copy).
  const archived = runPersistStep("archiveCurrentGoal", () => {
    ensureDirs(ctx.cwd);
    fs.writeFileSync(target, md);
    return true;
  }) === true;
  if (!archived) {
    ctx.ui.notify(`Could not archive ${goal.policy === "list" ? "the list item" : "the goal"} — the live objective was kept open and no terminal state was recorded. Fix the project disk and retry.`, "warning");
    return false;
  }
  try { fs.unlinkSync(goalMdPath(ctx.cwd, goal.id)); } catch {}
  replaceState({
    ...state,
    goal: {
      ...goal,
      status,
      archivedPath: path.relative(ctx.cwd, target) || target,
      stopReason,
      // A cancelled/archived goal cannot accept a late detached worker result.
      pendingCompletion: undefined,
    },
  });
  if (pendingAttemptId) {
    // Drop the ephemeral widget projection immediately; the detached worker
    // may still emit a final callback while its SIGTERM is settling.
    latestAuditProgress = null;
    if (ownsDetachedAudit(sessionGeneration, goal.id, pendingAttemptId)) {
      completionAuditInFlight = false;
      completionAuditGeneration = null;
    }
    cancelDetachedGoalCompletionAuditor(ctx.cwd, pendingAttemptId);
  }
  if (state.mainModelRecovery?.kind === "goal") {
    clearMainModelRecoveryTimer();
    state.mainModelRecovery = undefined;
    mainModelAbortForRecovery = false;
  }
  appendLedger(ctx.cwd, "goal_archived", { goalId: goal.id, status, stopReason, objective: goal.objective.slice(0, 300) });
  persistState(ctx);
  // v0.34.120: archive is the durable history; a terminal goal must not
  // remain in the live slot and make the user cancel a finished card. Keep
  // the archive markdown (including completionSummary) as the final record,
  // and clear the slot only after any list cascade/reviewer work below has
  // had a chance to choose a successor.
  const closeArchivedSlot = () => {
    if (state.goal?.id !== goal.id) return;
    replaceState({ ...state, goal: null });
    persistState(ctx);
  };
  // Loop 2: a list-sourced goal COMPLETED → auto-activate the next item.
  // Aborts are user actions (/list next, /goal cancel, list_activate) which
  // pick their own next step — auto-advancing on abort double-activates
  // (v0.2.0 bug: bare /list next silently consumed TWO items, found by the
  // pick-any-item verification in v0.10.0).
  if (goal.policy === "list" && status === "complete") {
    // v0.34.81 (LIGHT parent/child): if the completed child was the last
    // open subtask of a parent group, CASCADE CLOSE the parent. Runs BEFORE
    // the advance so the scan-skip in activateNextListItem sees the updated
    // queue (otherwise a parent whose last child just closed could be
    // re-scanned as a group with children still queued — it would not, but
    // the ordering is the right discipline: every list-complete consequence
    // of THIS goal settles before the next goal is chosen). The parent is
    // a queue item (never a Goal), so closing it means removing it from
    // the queue + deleting its disk sidecar + ledger entry. The reviewer
    // fires on the CHILD's completion (its archive md is the audit unit);
    // no synthetic goal archive is written for the group — the ledger
    // record is the durable trace.
    if (goal.parentId) {
      const pid = goal.parentId;
      if (groupOpenChildren(pid) === 0) {
        const queue = listQueue();
        const parent = queue.find((c: any) => c.id === pid);
        if (parent) {
          appendLedger(ctx.cwd, "list_group_closed", {
            parentId: pid,
            parentObjective: parent.objective,
            closedVia: goal.objective,
          });
          replaceState({ ...state, list: queue.filter((c: any) => c.id !== pid) });
          deleteQueueItemFile(ctx.cwd, pid);
          ctx.ui.notify(`Group closed: "${displaySlice(parent.objective, 80)}" — all subtasks complete.`, "info");
        }
      }
    }
    // v0.31.0: a /list audit collection item completed → fan the open
    // findings out into the queue (async — Confirm-gated). When the queue
    // was empty, enqueueItems activates the first fix itself, so the
    // list-complete / reviewer noise below must NOT fire for this item.
    const isListAuditCollect = goal.objective.includes(LIST_AUDIT_COLLECT_MARKER);
    // v0.34.7: the float gets a catch — ANY rejection here used to become
    // an uncaughtException and kill pi (darklord 2026-08-01).
    if (isListAuditCollect) {
      const fanoutCwd = ctx.cwd;
      const fanoutGeneration = sessionGeneration;
      void fanOutListAuditFindings(fanoutCwd, fanoutGeneration).catch((err) => {
        appendLedger(fanoutCwd, "list_audit_fanout_error", { error: String(err).slice(0, 200) });
      });
    }
    const advanced = activateNextListItem(ctx);
    // v0.34.104 ([Image-#1]): delay the first continuation dispatched
    // from the cascade so pi has time to settle the completion
    // acknowledgement; any agent activity during the window clears the
    // settle so a wake-up doesn't double-dispatch.
    if (advanced) {
      postCompletionSettleUntil = Date.now() + LIST_COMPLETION_SETTLE_MS;
      appendLedger(ctx.cwd, "list_completion_settle_armed", { goalId: goal.id, settleMs: LIST_COMPLETION_SETTLE_MS, nextObjective: goal.objective.slice(0, 120) });
    }
    // v0.26.0: the queue just EMPTIED on a completion → list-complete.
    if (!advanced && !isListAuditCollect) {
      fireReviewer(ctx, { kind: "list", goalId: goal.id, objective: goal.objective, terminal: "goal-complete" });
      // v0.29.0: the well ran dry — point at the project-audit loop. A
      // suggestion, not an action: consent, never auto-start (v0.28.28).
      ctx.ui.notify("List complete. /loop audit to sweep the project for the next batch of work.", "info");
    }
    closeArchivedSlot();
    return true;
  }
  // v0.26.0: a /goal (non-list) reached a terminal state → maybe fire.
  if (goal.policy !== "list") {
    fireReviewer(ctx, { kind: "goal", goalId: goal.id, objective: goal.objective, terminal: status === "complete" ? "goal-complete" : status === "aborted" ? "goal-aborted" : "goal-paused" });
  }
  closeArchivedSlot();
  return true;
}

/** v0.34.21: durable completion-audit lifecycle helpers. A claim without
 * an explicit phase is legacy state and is treated as recovery-pending after
 * a fresh lifecycle event; it is never silently presented as an active run. */


/* Runtime globals: preserve the old monolith lexical links across extracted modules. */
defineGoalRuntimeGlobal("escalateStallNow", { get: () => escalateStallNow });
defineGoalRuntimeGlobal("heartbeatStaleStreak", { get: () => heartbeatStaleStreak, set: (v) => { heartbeatStaleStreak = v as any; } });
defineGoalRuntimeGlobal("iterationCounter", { get: () => iterationCounter, set: (v) => { iterationCounter = v as any; } });
defineGoalRuntimeGlobal("toolCallsThisTurn", { get: () => toolCallsThisTurn, set: (v) => { toolCallsThisTurn = v as any; } });
defineGoalRuntimeGlobal("consecutiveErrorIterations", { get: () => consecutiveErrorIterations, set: (v) => { consecutiveErrorIterations = v as any; } });
defineGoalRuntimeGlobal("consecutiveAbortIterations", { get: () => consecutiveAbortIterations, set: (v) => { consecutiveAbortIterations = v as any; } });
defineGoalRuntimeGlobal("abortedStandDown", { get: () => abortedStandDown, set: (v) => { abortedStandDown = v as any; } });
defineGoalRuntimeGlobal("scheduleSessionTimeout", { get: () => scheduleSessionTimeout });
defineGoalRuntimeGlobal("clearSessionOwnedTimers", { get: () => clearSessionOwnedTimers });
defineGoalRuntimeGlobal("isActionableGoal", { get: () => isActionableGoal });
defineGoalRuntimeGlobal("freshCtx", { get: () => freshCtx });
defineGoalRuntimeGlobal("freshCtxForGeneration", { get: () => freshCtxForGeneration });
defineGoalRuntimeGlobal("scheduleQuotaRetryForSession", { get: () => scheduleQuotaRetryForSession });
defineGoalRuntimeGlobal("handleMainModelAgentEnd", { get: () => handleMainModelAgentEnd });
defineGoalRuntimeGlobal("createGoal", { get: () => createGoal });
defineGoalRuntimeGlobal("persistState", { get: () => persistState });
defineGoalRuntimeGlobal("persistenceDegradedNotified", { get: () => persistenceDegradedNotified, set: (v) => { persistenceDegradedNotified = v as any; } });
defineGoalRuntimeGlobal("shortObj", { get: () => shortObj });
defineGoalRuntimeGlobal("displaySlice", { get: () => displaySlice });
defineGoalRuntimeGlobal("goalNoun", { get: () => goalNoun });
defineGoalRuntimeGlobal("activeGoalCommand", { get: () => activeGoalCommand });
defineGoalRuntimeGlobal("activeGoalRoot", { get: () => activeGoalRoot });
defineGoalRuntimeGlobal("activeGoalSurfaceCommand", { get: () => activeGoalSurfaceCommand });
defineGoalRuntimeGlobal("activeGoalStatusCommand", { get: () => activeGoalStatusCommand });
defineGoalRuntimeGlobal("recoverySurfaceCommand", { get: () => recoverySurfaceCommand });
defineGoalRuntimeGlobal("notifyPersistenceState", { get: () => notifyPersistenceState });
defineGoalRuntimeGlobal("setGoal", { get: () => setGoal });
defineGoalRuntimeGlobal("updateGoal", { get: () => updateGoal });
defineGoalRuntimeGlobal("autoArbitrateStackedState", { get: () => autoArbitrateStackedState });
defineGoalRuntimeGlobal("fanOutListAuditFindings", { get: () => fanOutListAuditFindings });
defineGoalRuntimeGlobal("archiveCurrentGoal", { get: () => archiveCurrentGoal });
