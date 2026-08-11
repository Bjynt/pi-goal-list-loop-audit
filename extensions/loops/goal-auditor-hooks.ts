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
  guardGoalBeforeContinuation,
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
  buildReviewerSources,
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

type PendingCompletion = NonNullable<Goal["pendingCompletion"]>;

/** Release all process-local ownership of a detached audit. The worker is
 * already detached, so a stale MAIN must not keep the in-flight latch merely
 * because its old generation never reached the normal finally block. */
function clearDetachedAuditRuntime(): void {
  latestAuditProgress = null;
  completionAuditInFlight = false;
  completionAuditGeneration = null;
  completionAuditRecoveryArmed = false;
}

type CompletionAuditOrigin = "complete-goal" | "quota-retry" | "manual" | "session-recovery";

function newCompletionAuditAttemptId(): string {
  return `audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A logical completion claim can be retried after its old worker has left a
 * durable job directory behind. Each detached process attempt gets its own
 * filesystem identity; the claim's `pendingCompletion.attemptId` remains the
 * parent-generation identity used for stale-result rejection. */
/**
 * v0.34.104 ([Image-#1]): detect arithmetic impossibilities in the
 * agent-supplied completionSummary text. The agent's recap occasionally
 * reports test counts that violate pass ≤ total (field: "29/28 pass" on
 * 2026-08-08 10:29 dracon-platform — a 28-test suite cannot yield 29
 * passes). Pure except for the ledger append — unit-testable in
 * isolation. On a hit, ledger `completion_summary_impossible_count` and
 * append an honest `Counts appear inconsistent: X passed vs Y total.`
 * note to the recap so the user + auditor see the discrepancy. Returns
 * the (possibly amended) text to persist.
 */
function validateCompletionSummary(text: string, ctx: ExtensionContext): string {
  const flags: string[] = [];
  // Match "X/Y pass" / "X / Y pass" — anchor on the noun "pass" so we
  // don't false-positive on ratios like "1/2 done".
  const ratio = /(\d{1,4})\s*\/\s*(\d{1,4})\s*(?:tests?\s+)?pass(?:es|ed)?\b/i;
  const m = ratio.exec(text);
  if (m) {
    const passed = Number(m[1]);
    const total = Number(m[2]);
    if (Number.isFinite(passed) && Number.isFinite(total) && passed > total) {
      flags.push(`Counts appear inconsistent: ${passed} passed vs ${total} total in the suite.`);
    }
  }
  // "X tests, Y passed" — Y cannot exceed X.
  const aggregate = /(\d{1,4})\s+tests?[\s,]+(\d{1,4})\s+passed\b/i;
  const a = aggregate.exec(text);
  if (a) {
    const total = Number(a[1]);
    const passed = Number(a[2]);
    if (Number.isFinite(total) && Number.isFinite(passed) && passed > total) {
      flags.push(`Counts appear inconsistent: ${passed} passed vs ${total} total tests reported.`);
    }
  }
  if (flags.length === 0) return text;
  appendLedger(ctx.cwd, "completion_summary_impossible_count", {
    flags,
    excerpt: text.slice(0, 240),
  });
  return `${text.trimEnd()} — NOTE: ${flags.join(" ")}`;
}

function beginCompletionAudit(ctx: ExtensionContext, claim: PendingCompletion, origin: CompletionAuditOrigin): PendingCompletion {
  completionAuditRecoveryArmed = true;
  const startedMs = Date.now();
  const automaticRecoveryRetry = origin === "session-recovery"
    && (claim.phase ?? "recovery-pending") === "recovery-pending"
    && claim.automaticRecoveryAttempted !== true;
  const claimForAttempt = origin === "manual"
    ? { ...claim, quotaAttempts: undefined, quotaFirstAt: undefined, quotaAutoRetryUntil: undefined }
    : claim;
  const pending: PendingCompletion = {
    ...claimForAttempt,
    phase: "running",
    attemptId: newCompletionAuditAttemptId(),
    startedAt: new Date(startedMs).toISOString(),
    wallDeadlineAt: new Date(startedMs + AUDITOR_WALL_TIMEOUT_MS).toISOString(),
    recoveryAt: undefined,
    recoveryReason: undefined,
    ...(automaticRecoveryRetry
      ? {
        automaticRecoveryAttempted: true,
        automaticRecoveryAt: new Date(startedMs).toISOString(),
        automaticRecoveryGeneration: sessionGeneration,
      }
      : {}),
  };
  // A stored claim may be retried after a previous infrastructure pause.
  // Clear that old operational note before rebuilding the immutable auditor
  // prompt; otherwise the detached auditor sees stale EEXIST/model-error
  // text and the UI/request snapshot describes the previous attempt.
  updateGoal({
    status: "auditing",
    pendingCompletion: pending,
    pauseReason: undefined,
    pauseSuggestedAction: undefined,
    pauseKind: undefined,
    pauseOptions: undefined,
    pauseRecommended: undefined,
    pauseResumeAt: undefined,
  }, ctx);
  appendLedger(ctx.cwd, "audit_started", { goalId: state.goal?.id, attemptId: pending.attemptId, origin, wallDeadlineAt: pending.wallDeadlineAt });
  return pending;
}

// markCompletionAuditRecoveryPending moved to extensions/goal-recovery.ts (decomposition step 3, v0.34.111, cluster C).

function isAuditorTimeoutError(error: string | undefined): boolean {
  return !!error && (/^Auditor exceeded its .* wall-clock bound/i.test(error) || /^Auditor stalled —/i.test(error));
}

// isCompletionAuditRecoveryPending moved to extensions/goal-recovery.ts (decomposition step 3, v0.34.111, cluster C).
// goal-commands.ts (decomposition step 2) imports it directly from there.

const MAX_AUDITOR_QUOTA_AUTO_ATTEMPTS = 5;
/** v0.34.79 (note.md 112555): the FIRST auditor retry after an infra
 * failure is eager — 5s, mirroring runWithInfraRetry's default backoff for
 * the main thread — when the provider gave no upstream hint. A quota that
 * expired mid-audit must not park the goal for the base window (default
 * 60m) before the first probe; later attempts keep the exponential
 * minute-scale cadence. Provider hints still win (they are authoritative). */
const EAGER_AUDITOR_RETRY_SEC = 5;

/** Seconds-aware "auto-retry in …" label: "5s" under a minute, else "60m". */
function fmtRetryDelay(seconds: number): string {
  return seconds < 60 ? `${Math.round(seconds)}s` : `${Math.round(seconds / 60)}m`;
}

// v0.34.79: exported for tests — the eager-first-retry schedule is pure.
export function auditorQuotaRetryPlan(claim: PendingCompletion, quota: ReturnType<typeof parseQuotaError>, baseMinutes: number): {
  attempt: number;
  retryAfterSec: number;
  firstAt: string;
  autoRetryUntil: string;
  automatic: boolean;
  requestedSec: number;
} {
  const now = Date.now();
  const firstMs = claim.quotaFirstAt ? Date.parse(claim.quotaFirstAt) : Number.NaN;
  const firstAtMs = Number.isFinite(firstMs) ? firstMs : now;
  const firstAt = new Date(firstAtMs).toISOString();
  const untilMs = claim.quotaAutoRetryUntil && Number.isFinite(Date.parse(claim.quotaAutoRetryUntil))
    ? Date.parse(claim.quotaAutoRetryUntil)
    : firstAtMs + MAIN_MODEL_AUTO_RETRY_HORIZON_MS;
  const attempt = (claim.quotaAttempts ?? 0) + 1;
  // v0.34.79: eager first probe (5s) when the provider gave no hint — the
  // main thread retries infra errors after 5s; the auditor must not sit an
  // hour. Upstream Retry-After still wins.
  // v0.34.84 (note.md Screenshots 160846–161010): quota-shaped errors
  // (signal: "rate-limit" | "plan-quota" | "billing") get hour-aligned
  // probes on attempts 2+, not exponential rungs — the user wants to react
  // fast when the quota resets (which most providers do on a billing /
  // top-of-hour boundary). Non-quota transient infra errors keep the
  // exponential cadence (a stuck provider shouldn't be probed at 60m).
  const isQuota = quota.signal !== undefined;
  const requestedSec = quota.fromUpstream
    ? quota.retryAfterSec
    : attempt === 1
      ? EAGER_AUDITOR_RETRY_SEC
      : isQuota
        ? Math.max(60, Math.round((nextHourlyPromptMs(now) - now) / 1000))
        : quotaRetryDelaySeconds(attempt, baseMinutes);
  const retryAfterSec = capQuotaRetrySeconds(requestedSec);
  const automatic = attempt < MAX_AUDITOR_QUOTA_AUTO_ATTEMPTS && now + retryAfterSec * 1_000 <= untilMs;
  return { attempt, retryAfterSec, firstAt, autoRetryUntil: new Date(untilMs).toISOString(), automatic, requestedSec };
}

export type AuditorModelCandidate = { model: any; via: string };
type DetachedAuditResult = Awaited<ReturnType<typeof runDetachedGoalCompletionAuditor>>;

export type AutomaticCompletionRecoveryTrigger = "session-start" | "host-rebind" | "main-model-recovery";

/**
 * Start the one durable automatic retry reserved for a parked completion
 * claim. The caller must already have a healthy lifecycle/recovery signal;
 * this helper adds the current-generation/context and goal guards. The
 * transition to `phase: "running"` plus `automaticRecoveryAttempted: true`
 * happens synchronously in beginCompletionAudit before the detached worker
 * is launched, so repeated lifecycle events cannot create a second worker.
 * A failed automatic retry keeps the claim safe for explicit /goal resume but
 * is not eligible for another automatic event-triggered attempt.
 */
export function maybeAutoRetryParkedCompletionAudit(trigger: AutomaticCompletionRecoveryTrigger): boolean {
  const goal = state.goal;
  const claim = goal?.pendingCompletion;
  if (!goal || goal.status !== "paused" || !claim) return false;
  if ((claim.phase ?? "recovery-pending") !== "recovery-pending") return false;
  if (claim.automaticRecoveryAttempted === true || completionAuditInFlight) return false;

  const generation = sessionGeneration;
  const ctx = freshCtxForGeneration(generation);
  if (!ctx) return false;
  if (!guardGoalBeforeContinuation(ctx, "stored-completion-audit", goal.id, { allowAuditing: true })) return false;

  const current = state.goal;
  const currentClaim = current?.pendingCompletion;
  if (
    !current
    || current.id !== goal.id
    || current.status !== "paused"
    || !currentClaim
    || (currentClaim.phase ?? "recovery-pending") !== "recovery-pending"
    || currentClaim.automaticRecoveryAttempted === true
  ) return false;

  appendLedger(ctx.cwd, "audit_recovery_auto_retry_claimed", {
    goalId: current.id,
    previousAttemptId: currentClaim.attemptId,
    trigger,
    generation,
  });
  // beginCompletionAudit runs before retryStoredCompletionAudit reaches its
  // first await, atomically replacing the parked claim with a running claim
  // and consuming the durable one-shot marker.
  void retryStoredCompletionAudit("session-recovery");
  return true;
}

function auditorCandidateLabel(candidate: AuditorModelCandidate): string {
  const model = candidate.model;
  const modelName = typeof model === "string"
    ? model
    : model && typeof model === "object" && typeof model.provider === "string" && typeof model.id === "string"
      ? `${model.provider}/${model.id}`
      : "(unset)";
  return `${modelName} (${candidate.via})`;
}

/**
 * Run a detached audit through a bounded model cascade. Model selection has a
 * primary, optional pinned fallback, and the session model as the last rung.
 * A resolved primary can still fail after launch (provider auth, RPC startup,
 * or a dead stream), so selection-time fallback alone is insufficient. Retry
 * the same model once, then advance to the next candidate at most once per
 * candidate. The worker remains detached for every rung; this is a model
 * fallback, never an in-process/session fallback.
 */
export async function runDetachedCompletionWithFallback(
  candidates: AuditorModelCandidate[],
  run: (candidate: AuditorModelCandidate) => Promise<DetachedAuditResult>,
  opts: {
    shouldRetry?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (candidate: AuditorModelCandidate, error: string) => void;
    onFallback?: (from: AuditorModelCandidate, to: AuditorModelCandidate, error: string) => void;
  } = {},
): Promise<{ result: DetachedAuditResult; retriedOnce: boolean; fallbackUsed: boolean; via: string }> {
  // Preserve the normal "no model" diagnostic when resolution found no
  // candidate; that error is intentionally not retried or cascaded.
  const sequence = candidates.length > 0 ? candidates : [{ model: undefined, via: "unset" }];
  let retriedOnce = false;
  let fallbackUsed = false;

  for (let i = 0; i < sequence.length; i++) {
    const candidate = sequence[i]!;
    const outcome = await runWithInfraRetry(
      () => run(candidate),
      {
        shouldRetry: opts.shouldRetry,
        sleep: opts.sleep,
        onRetry: (error) => opts.onRetry?.(candidate, error),
      },
    );
    retriedOnce ||= outcome.retriedOnce;
    const result = outcome.result;
    const canAdvance = Boolean(
      result.error
      && !result.approved
      && !result.disapproved
      && !result.impossible
      && isRetriableInfraError(result.error)
      && i + 1 < sequence.length,
    );
    if (!canAdvance) return { result, retriedOnce, fallbackUsed, via: candidate.via };

    // A replacement may have invalidated the parent between the retry and
    // this boundary. Do not launch a fallback worker from that old generation.
    if (opts.shouldRetry) {
      try {
        if (!opts.shouldRetry()) return { result, retriedOnce, fallbackUsed, via: candidate.via };
      } catch {
        return { result, retriedOnce, fallbackUsed, via: candidate.via };
      }
    }
    const next = sequence[i + 1]!;
    fallbackUsed = true;
    opts.onFallback?.(candidate, next, result.error!);
  }

  // The loop always returns from the final candidate, but keep a defensive
  // result for future edits that alter the sequence construction.
  const last = sequence.at(-1)!;
  return { result: await run(last), retriedOnce, fallbackUsed, via: last.via };
}

/**
 * v0.28.26: quota-window retry for a STORED completion claim. The auditor
 * was quota-blocked at complete_goal time; the claim (completionSummary +
 * verificationSummary) was persisted on the goal, and when the quota window
 * elapses we re-run the AUDITOR directly — no agent turn. Re-engaging the
 * agent to re-submit an unchanged claim produced a hallucinated-closure
 * repetition loop in the field (π-games: the model concluded the goal was
 * closed, repeated the same essay 4×+, stormed continuations, compacted 14×
 * in 35 minutes, and burned the stall brake).
 *
 * Outcomes: approved → close + cascade (archiveCurrentGoal handles list
 * advance + reviewer); quota again → re-pause with a fresh scheduled retry
 * (claim preserved); anything else (disapproved, impossible, non-quota
 * infra) → preserve the claim and pause for explicit `/goal resume`, while
 * semantic verdicts remain durable in auditHistory.
 */
async function retryStoredCompletionAudit(origin: CompletionAuditOrigin = "quota-retry"): Promise<void> {
  const goal = state.goal;
  if (!goal?.pendingCompletion) return;
  const goalId = goal.id;
  if (completionAuditInFlight) return;
  const generation = sessionGeneration;
  // Delayed audit recovery has no safe fallback: if the current generation
  // cannot be proven live, the fresh session must rehydrate the durable claim.
  const initialCtx = freshCtxForGeneration(generation);
  if (!initialCtx) return;
  if (!guardGoalBeforeContinuation(initialCtx, "stored-completion-audit", goalId, { allowAuditing: true })) return;
  const guardedGoal = state.goal;
  if (!guardedGoal || guardedGoal.id !== goalId || !guardedGoal.pendingCompletion) return;
  completionAuditRecoveryArmed = true;
  let liveCtx: ExtensionContext = initialCtx;
  const claim = beginCompletionAudit(liveCtx, guardedGoal.pendingCompletion, origin);
  const auditGoal = state.goal;
  if (!auditGoal || auditGoal.id !== goalId) return;
  if (origin === "session-recovery") {
    appendLedger(liveCtx.cwd, "audit_recovery_started", { goalId, attemptId: claim.attemptId });
  } else {
    appendLedger(liveCtx.cwd, "goal_resumed", { via: origin === "manual" ? "manual-audit" : "quota-retry-direct-audit" });
  }
  liveCtx.ui.notify(origin === "manual"
    ? "Manual /goal verify — starting the detached auditor now (no agent turn needed)."
    : origin === "session-recovery"
      ? "Fresh session recovered the interrupted completion audit — starting a detached retry for the stored claim."
      : "Auditor quota window elapsed — starting a detached retry with your stored completion claim (no agent turn needed).", "info");
  const settings = loadSettings(liveCtx.cwd);
  const { model: auditorModel, error: modelError, via, fallbackModels } = resolveAuditorModel(liveCtx, settings.auditorModel, settings.auditorModelFallback, settings.auditorSameSessionSwap !== false);
  if (modelError) liveCtx.ui.notify(`Auditor model issue: ${modelError}`, "warning");
  const auditorCandidates: AuditorModelCandidate[] = [{ model: auditorModel, via: via ?? "unset" }, ...(fallbackModels ?? [])];
  completionAuditInFlight = true;
  completionAuditGeneration = generation;
  latestAuditProgress = {
    label: origin === "session-recovery" ? "recovery starting" : origin === "manual" ? "manual verify" : "quota retry",
    phase: "starting",
    lastEventAt: Date.now(),
  };
  const auditStartMs = Date.now();
  let result: Awaited<ReturnType<typeof runDetachedGoalCompletionAuditor>>;
  let fallbackUsed = false;
  try {
    ({ result, fallbackUsed } = await runDetachedCompletionWithFallback(
      auditorCandidates,
      (candidate) =>
        runDetachedGoalCompletionAuditor({
          cwd: liveCtx.cwd,
          goal: auditGoal,
          completionSummary: claim.completionSummary,
          verificationSummary: claim.verificationSummary,
          model: candidate.model,
          thinkingLevel: (settings.auditorThinkingLevel ?? "high") as any, // may be "max" — pi ≥0.83 understands it; the dev-types predate it
          runtime: { attemptId: () => newDetachedAuditJobAttemptId(claim.attemptId!), wallTimeoutMs: AUDITOR_WALL_TIMEOUT_MS },
          onProgress: (progress) => {
            publishDetachedAuditProgress(generation, goalId, claim.attemptId!, progress);
          },
          // v0.34.57: the parent-side heartbeat-without-progress watchdog
          // fired — persist the auditor_stalled ledger event so the recovery
          // path can distinguish "wedged worker" from other timeouts.
          onStalled: (info) => {
            const current = detachedAuditContext(generation, goalId, claim.attemptId!);
            if (!current) return;
            appendLedger(current.cwd, "auditor_stalled", { goalId, attemptId: claim.attemptId, ...info });
          },
        }),
      {
        shouldRetry: () => detachedAuditContext(generation, goalId, claim.attemptId!) !== null,
        onRetry: (candidate, err) => {
          const current = detachedAuditContext(generation, goalId, claim.attemptId!);
          if (current) appendLedger(current.cwd, "audit_infra_retry", { goalId, model: auditorCandidateLabel(candidate), error: err.slice(0, 200) });
        },
        onFallback: (from, to, err) => {
          const current = detachedAuditContext(generation, goalId, claim.attemptId!);
          if (!current) return;
          appendLedger(current.cwd, "auditor_runtime_model_fallback", { goalId, from: auditorCandidateLabel(from), to: auditorCandidateLabel(to), error: err.slice(0, 200) });
          current.ui.notify(`Detached auditor failed on ${auditorCandidateLabel(from)} — retrying with ${auditorCandidateLabel(to)}. This is infrastructure, not a verdict.`, "warning");
        },
      },
    ));
  } finally {
    if (ownsDetachedAudit(generation, goalId, claim.attemptId!)) {
      clearDetachedAuditProgress(generation, goalId, claim.attemptId!);
      completionAuditInFlight = false;
      completionAuditGeneration = null;
    }
  }
  const currentAfterAudit = freshCtxForGeneration(generation);
  if (!currentAfterAudit || !state.goal || state.goal.id !== goalId) {
    // v0.34.80 (field: 2026-08-07): NEVER drop a completed verdict silently.
    // The gate nulls out on a latched-stale LIVE session (extensionApiStale
    // from transient heartbeat-probe failures) — the goal then froze in
    // "auditing" with no in-flight audit and the stranded backstop
    // unreachable below the stale latch in heartbeatTick. The worker's
    // verdict (result.json) sat complete on disk for 30m+ while the queue
    // was blocked. Leave a durable marker via the kept last context so the
    // fresh session's recovery path parks the claim for an explicit resume.
    if (state.goal?.status === "auditing" && state.goal.pendingCompletion?.attemptId === claim.attemptId && lastCtx) {
      appendLedger(lastCtx.cwd, "audit_verdict_deferred", { goalId, attemptId: claim.attemptId, reason: "stale-latch-apply-gate" });
      markCompletionAuditRecoveryPending(lastCtx, "verdict-apply-gate");
    }
    return;
  }
  if (state.goal.pendingCompletion?.attemptId !== claim.attemptId) return; // a newer attempt owns the durable claim
  liveCtx = currentAfterAudit;

  // v0.34.61: focus revision guard — contract-scoped. The detached
  // worker captured (goalId, revision) at dispatch; only a CONTRACT
  // change (tweak / newObjective) bumps the counter now, so a mismatch
  // means the goal's contract moved while the audit ran — the verdict
  // must NOT apply to the new contract. Non-contract writes (pause,
  // status flips, quota machinery) no longer trip this guard; they do
  // v0.34.74 (interrupt-didn't-continue): the guard MUST normalize the
  // never-set revision (undefined) to 0 — the raw `undefined !== 0`
  // comparison spuriously refused verdicts for goals whose revision was
  // never bumped (field-observed in junk-runner 2026-08-07: goal
  // 20260806215307-4irtlm rev undefined, auditor captured 0, verdict
  // REFUSED even though the contract had NOT moved; the refusal then
  // stranded the goal and the loop went silent for 7.5h).
  // isGoalRevisionCurrent is the canonical normalized check.
  if (result.goalRevision && !isGoalRevisionCurrent(result.goalRevision, state.goal)) {
    appendLedger(liveCtx.cwd, "stale_revision_refused", {
      goalId,
      captured: result.goalRevision,
      current: { goalId: state.goal.id, revision: state.goal.revision ?? 0 },
      attemptId: claim.attemptId,
      approvedClaimed: result.approved,
      disapprovedClaimed: result.disapproved,
      error: result.error?.slice?.(0, 200),
    });
    liveCtx.ui.notify(
      `Stale auditor verdict REFUSED: goal ${goalId} revision is ${state.goal.revision ?? 0} but the auditor captured ${result.goalRevision.revision}. The goal moved on during the audit — its verdict was not applied. Run /goal verify again to audit the current state.`,
      "warning",
    );
    // v0.34.59: leave the goal active. The stale claim is consumed
    // (cleared) so we do not loop on a forever-stale retry. The user can
    // /goal verify to re-engage on current state.
    // v0.34.74: the status flip is REQUIRED, not cosmetic — the goal is in
    // `auditing` here, and isActionableGoal() (sendContinuation's gate)
    // requires status === "active". Without the flip the scheduled
    // continuation silently never sent, the heartbeat stranded the goal
    // 90s later, and the list item sat paused "completion audit
    // interrupted — no verdict" until a manual resume (the 2026-08-07
    // junk-runner incident).
    updateGoal({ ...(state.goal?.status === "auditing" ? { status: "active" } : {}), pendingCompletion: undefined }, liveCtx);
    scheduleContinuation(liveCtx, true);
    return;
  }

  // Record the run in history (same compact shape as the tool path).
  const auditorRan = result.output.trim().length > 0;
  const history = state.goal.auditHistory ?? [];
  if (auditorRan) {
    result.output = stripThinkBlocks(result.output);
    history.push({
      at: nowIso(),
      approved: result.approved,
      disapproved: result.disapproved,
      impossible: result.impossible,
      impossibleReason: result.impossibleReason,
      model: result.model,
      thinkingLevel: result.thinkingLevel,
      report: result.output,
      error: result.error,
      regressionShieldPassed: result.regressionShieldPassed,
      regressionShieldMissing: result.regressionShieldMissing,
      // v0.34.60 (steal #3): the revision the worker audited (captured at
      // dispatch) — the revision-bound validity gate reads this.
      revision: result.goalRevision?.revision ?? state.goal.revision ?? 0,
      durationMs: Date.now() - auditStartMs,
    } as any);
    if (history.length > 20) history.splice(0, history.length - 20);
  }

  if (result.approved && result.regressionShieldPassed !== false) {
    updateGoal({ auditHistory: history, pendingCompletion: undefined }, liveCtx);
    // v0.34.91: capture the recap BEFORE archiveCurrentGoal (it mutates
    // state.goal). The end-of-goal message says WHAT HAPPENED, not
    // "auditor approved" — that's process, not information (the field
    // complaint across Screenshot_20260808_012905/013220/013515: three
    // boilerplate "claim persisted/auditor queued" lines + a "Goal complete
    // — auditor X approved" card read as useless summary spam). The recap
    // is the agent's completionSummary when captured; the objective is the
    // fallback for legacy/aborted goals.
    const recapSrc = state.goal.completionSummary?.trim()
      ? state.goal.completionSummary.replace(/\s+/g, " ")
      : state.goal.objective;
    const recap = displaySlice(recapSrc, 110);
    const approvalVia = `${origin === "manual" ? " on /goal verify" : origin === "session-recovery" ? " after session recovery" : " on the quota retry"}${fallbackUsed ? " after an auditor-model fallback" : ""}`;
    archiveCurrentGoal(liveCtx, "complete", `auditor ${result.model} approved (${origin})`);
    liveCtx.ui.notify(`✓ done: ${recap} — auditor ${result.model} approved${approvalVia}.`, "info");
    notifyExternal(liveCtx, `Goal complete (auditor approved, ${origin}): ${displaySlice(recapSrc, 120)}`);
    return;
  }

  if (result.regressionShieldPassed === false) {
    const missing = result.regressionShieldMissing ?? [];
    const detail = missing.length > 0
      ? `its evidence did not reference these contract items:\n${missing.map((item) => `- ${item}`).join("\n")}`
      : "its report did not include a valid <evidence> block";
    updateGoal({
      status: "active",
      auditHistory: history,
      pendingCompletion: undefined,
      pauseReason: "regression shield: auditor approved, but the evidence contract was not satisfied",
      pauseSuggestedAction: "Call complete_goal again — the next auditor run is told exactly which evidence the shield requires.",
    }, liveCtx);
    liveCtx.ui.notify(
      `Regression shield blocked completion: the auditor approved, but ${detail}.\n\nCall complete_goal again; the next audit will be told to quote raw evidence for each item.`,
      "warning",
    );
    appendLedger(liveCtx.cwd, "audit_shield_blocked", { goalId, attemptId: claim.attemptId, missing });
    scheduleContinuation(liveCtx, true);
    return;
  }

  if (result.error && !result.disapproved && isAuditorTimeoutError(result.error)) {
    // Watchdog timeouts stay ahead of the durable retry branch: a hanging
    // verification command will hang again, so pause loudly and let
    // /goal resume re-enter the direct-audit path with the stored claim.
    const pending: PendingCompletion = {
      ...claim,
      phase: "recovery-pending",
      recoveryAt: nowIso(),
      recoveryReason: result.error.startsWith("Auditor exceeded") ? "wall-timeout" : "inactivity-timeout",
      automaticRecoveryAttempted: claim.automaticRecoveryAttempted ?? false,
    };
    updateGoal({
      status: "paused",
      auditHistory: history,
      pendingCompletion: pending,
      pauseKind: "error",
      pauseReason: `completion audit timed out — ${result.error}`,
      pauseSuggestedAction: `The claim is stored. Check long-running verification commands, then ${activeGoalSurfaceCommand("resume")} to retry the isolated auditor.`,
    }, liveCtx);
    appendLedger(liveCtx.cwd, result.error.startsWith("Auditor exceeded") ? "audit_wall_timeout" : "audit_inactivity_timeout", { goalId, attemptId: claim.attemptId, error: result.error.slice(0, 240) });
    liveCtx.ui.notify(`Completion auditor timed out (infrastructure, not a verdict). The stored claim is safe; fix the command/model and ${activeGoalSurfaceCommand("resume")} to retry it.`, "warning");
    return;
  }

  // v0.34.51: ANY infrastructure failure enters the durable bounded retry
  // plan — error text is not trusted to pick quota vs other failures (a
  // miss-classified quota wall is the common case), so "still failing"
  // preserves the claim on a bounded one-shot schedule instead of stopping
  // after three strikes.
  if (result.error && !result.disapproved) {
    // Preserve the claim, but use a durable bounded plan.
    const settingsNow = loadSettings(liveCtx.cwd);
    const defaultMinutes = settingsNow.quotaRetryMinutes ?? DEFAULT_QUOTA_RETRY_MINUTES;
    const quota = parseQuotaError(result.error, defaultMinutes * 60);
    const plan = auditorQuotaRetryPlan(claim, quota, defaultMinutes);
    const pending = {
      ...claim,
      phase: "quota-waiting" as const,
      recoveryAt: undefined,
      recoveryReason: undefined,
      quotaAttempts: plan.attempt,
      quotaFirstAt: plan.firstAt,
      quotaAutoRetryUntil: plan.autoRetryUntil,
    };
    const providerHint = plan.requestedSec !== plan.retryAfterSec ? ` (provider hint capped at ${Math.round(plan.retryAfterSec / 60)}m)` : "";
    if (!plan.automatic) {
      updateGoal({
        status: "paused",
        auditHistory: history,
        pendingCompletion: pending,
        pauseKind: "blocked",
        pauseResumeAt: undefined,
        pauseReason: `auditor retry: automatic retry horizon reached (${plan.attempt} attempts)`,
        pauseSuggestedAction: `The completion claim is stored, but automatic auditor probes are stopped. Check the provider reset/billing state, then ${activeGoalSurfaceCommand("resume")} to start a fresh bounded window.`,
      }, liveCtx);
      appendLedger(liveCtx.cwd, "auditor_retry_capped", { streak: plan.attempt, autoRetryUntil: plan.autoRetryUntil, requestedSec: plan.requestedSec });
      liveCtx.ui.notify(`Automatic auditor retries stopped after ${plan.attempt} bounded attempts — the claim stays stored; check the provider, then ${activeGoalSurfaceCommand("resume")}.`, "warning");
      return;
    }
    updateGoal({
      status: "paused",
      auditHistory: history,
      pendingCompletion: pending,
      pauseKind: "wait",
      pauseResumeAt: new Date(Date.now() + plan.retryAfterSec * 1000).toISOString(),
      pauseReason: `auditor retry: ${result.error}`,
      pauseSuggestedAction: `Auto-retry in ${fmtRetryDelay(plan.retryAfterSec)}${providerHint} — or ${activeGoalSurfaceCommand("resume")} to retry now`,
    }, liveCtx);
    appendLedger(liveCtx.cwd, "goal_paused", { reason: `auditor retry: retry in ${plan.retryAfterSec}s (stored-claim retry)`, attempt: plan.attempt, autoRetryUntil: plan.autoRetryUntil });
    liveCtx.ui.notify(`Auditor still failing — next auto-retry in ${fmtRetryDelay(plan.retryAfterSec)}${providerHint} (your completion claim is stored; no action needed).`, "warning");
    scheduleQuotaRetryForSession(liveCtx, plan.retryAfterSec, result.error, (fresh: ExtensionContext) => {
      if (state.goal && state.goal.status === "paused" && (state.goal.pauseReason ?? "").startsWith("auditor retry:") && state.goal.pendingCompletion) {
        void retryStoredCompletionAudit(origin);
      }
    });
    return;
  }



  // Any other outcome — disapproved or impossible — belongs to the agent:
  // resume and let the continuation drive the next step. The verdict is
  // durable in auditHistory + /goal status.
  updateGoal({
    status: "active",
    auditHistory: history,
    pendingCompletion: undefined,
    pauseReason: result.disapproved
      ? `auditor disapproved on quota-retry — see ${activeGoalStatusCommand()}`
      : result.impossible
        ? `auditor verdict: IMPOSSIBLE on quota-retry — ${(result.impossibleReason ?? "").slice(0, 120)}`
        : `auditor infrastructure error on quota-retry: ${(result.error ?? "").slice(0, 120)}`,
  }, liveCtx);
  liveCtx.ui.notify(
    result.disapproved
      ? `Auditor (${origin}) DISAPPROVED — resuming; the report is in ${activeGoalStatusCommand()}.`
      : result.impossible
        ? `Auditor (${origin}): goal IMPOSSIBLE — ${(result.impossibleReason ?? "").slice(0, 100)}. Resuming; consider ${activeGoalSurfaceCommand("tweak")}.`
        : `Auditor (${origin}) hit an infrastructure error — resuming; re-call complete_goal when ready.`,
    "warning",
  );
  appendLedger(liveCtx.cwd, "quota_retry_audit_verdict", {
    approved: false,
    disapproved: result.disapproved,
    impossible: result.impossible,
    error: result.error?.slice(0, 160),
  });
  scheduleContinuation(liveCtx, true);
}

/**
 * v0.26.0: bind the reviewer to the live session. Sources for finding
 * extraction: the archived goal markdown + its audit reports + the
 * durable audit log entries for this goal. List items are enqueued via
 * the ONE enqueue path; /goal proposals go through the agent (which
 * calls propose_goal_draft → the user's Confirm dialog).
 */
function fireReviewer(
  ctx: ExtensionContext,
  source: { kind: "goal" | "list"; goalId: string; objective: string; terminal: string },
  opts: { manual?: boolean; mode?: "off" | "on" | "auto" | "aggressive" } = {},
): void {
  try {
    const settings = loadSettings(ctx.cwd);
    // v0.27.5: dual-read `reviewer` (legacy) and `postaudit` (new) settings
    // keys. `postaudit` takes precedence when both are present — the
    // existing settings file shape is preserved; the rename is purely
    // vocabulary on the user-facing surface.
    const reviewerBlock = (settings.postaudit ?? settings.reviewer) as Partial<ReviewerConfig> | undefined;
    const config = resolveReviewerConfig(reviewerBlock);
    if (opts.mode) config.mode = opts.mode;
    let archiveText: string | undefined;
    try {
      archiveText = fs.readFileSync(archivedGoalPath(ctx.cwd, source.goalId), "utf-8");
    } catch {
      /* archive md may not exist for manual review of a live goal */
    }
    // v0.26.4 source curation: an APPROVED audit report is the executor's
    // own completion claims — meta-text with zero finding signal (the
    // 0.26.2/0.26.3 misfires both mined it). Disapprovals/errors carry the
    // independent auditor's required-fixes — the real findings.
    // v0.34.61: superseded-disapproval curation — a disapproval answered
    // by a later approval on the same goal must NOT be re-mined (its
    // required fixes are already shipped; re-mining re-queues them verbatim
    // — field-observed 2026-08-06: round-1 report sliced into 3 junk /list
    // items after the round-2 approval, auto-activated by autoResume).
    const auditTexts = curateAuditReviewSources(readAuditLog(ctx.cwd), source.goalId).map((e) => e.report);
    // v0.35.x: automatic postaudit must not mine the archive's Objective or
    // verification contract as if either were an independent finding. That
    // metadata contains reviewer trigger words and can create truncated,
    // contract-less queue items after an otherwise approved completion. An
    // explicit /review may still inspect the archive; automatic review uses
    // only curated auditor reports.
    const sources = buildReviewerSources(archiveText, auditTexts, !!opts.manual);
    let ledgerEntries: Array<{ type: string; at?: string; value?: any }> = [];
    try {
      ledgerEntries = parseLedgerEntries(fs.readFileSync(ledgerPath(ctx.cwd), "utf-8"));
    } catch {
      /* no ledger yet */
    }
    const outcome = runReviewer(config, source, {
      cwd: ctx.cwd,
      nowMs: Date.now(),
      manual: opts.manual,
      ledgerEntries,
      sources,
      enqueueListItems: (objectives) => enqueueItems(ctx, objectives, "reviewer", { autoActivate: loadGlobalSettings().autoResume === true }),
      proposeGoal: (objective, reason) => {
        try {
          safeSteerUser(ctx, 
            `[REVIEWER FOLLOW-UP — ${reason}. Propose this as a /goal via propose_goal_draft (the user Confirms or rejects): ${objective}]`);
          return true;
        } catch (err) {
          // v0.28.8 (E4): the phantom-reviewer hole — a swallowed throw used
          // to still count as "proposed" in the report + notify. Now the
          // failure is LOUD and the proposal goes uncounted.
          ctx.ui.notify(
            `Postaudit /goal proposal NOT delivered: ${err instanceof Error ? err.message : String(err)} — the follow-up never reached the session. Wait for a fresh session_start, then retry.`,
            "warning",
          );
          return false;
        }
      },
      notify: (message, level) => ctx.ui.notify(message, level),
      ledger: (type, value) => appendLedger(ctx.cwd, type, value),
    });
    if (!outcome.fired && outcome.suppressedReason && opts.manual) {
      ctx.ui.notify(`Postaudit suppressed: ${outcome.suppressedReason}`, "info");
    }
    // v0.27.5: surface the silent review to interactive users. The internal
    // runReviewer notify fires DURING the goal-completion handler, easy to
    // miss because pi is busy transitioning state. The second notify
    // arrives AFTER everything settles and points at the file directly.
    // Skipped when manual=true (manual /review has its own UX already) and
    // when the runner wasn't fired (suppressed / not applicable).
    if (!opts.manual && outcome.fired && outcome.reportPath) {
      const relPath = path.relative(ctx.cwd, outcome.reportPath) || outcome.reportPath;
      ctx.ui.notify(
        `↳ review written: ${relPath}${outcome.enqueued ? ` (${outcome.enqueued} enqueued to /list)` : ""}${outcome.proposed ? ` (${outcome.proposed} /goal proposed)` : ""}`,
        "info",
      );
    }
  } catch (err) {
    ctx.ui.notify(`Postaudit failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`, "warning");
  }
}



/* Runtime globals: preserve the old monolith lexical links across extracted modules. */
defineGoalRuntimeGlobal("clearDetachedAuditRuntime", { get: () => clearDetachedAuditRuntime });
defineGoalRuntimeGlobal("newCompletionAuditAttemptId", { get: () => newCompletionAuditAttemptId });
defineGoalRuntimeGlobal("validateCompletionSummary", { get: () => validateCompletionSummary });
defineGoalRuntimeGlobal("beginCompletionAudit", { get: () => beginCompletionAudit });
defineGoalRuntimeGlobal("isAuditorTimeoutError", { get: () => isAuditorTimeoutError });
defineGoalRuntimeGlobal("MAX_AUDITOR_QUOTA_AUTO_ATTEMPTS", { get: () => MAX_AUDITOR_QUOTA_AUTO_ATTEMPTS });
defineGoalRuntimeGlobal("EAGER_AUDITOR_RETRY_SEC", { get: () => EAGER_AUDITOR_RETRY_SEC });
defineGoalRuntimeGlobal("fmtRetryDelay", { get: () => fmtRetryDelay });
defineGoalRuntimeGlobal("auditorQuotaRetryPlan", { get: () => auditorQuotaRetryPlan });
defineGoalRuntimeGlobal("auditorCandidateLabel", { get: () => auditorCandidateLabel });
defineGoalRuntimeGlobal("runDetachedCompletionWithFallback", { get: () => runDetachedCompletionWithFallback });
defineGoalRuntimeGlobal("retryStoredCompletionAudit", { get: () => retryStoredCompletionAudit });
defineGoalRuntimeGlobal("maybeAutoRetryParkedCompletionAudit", { get: () => maybeAutoRetryParkedCompletionAudit });
defineGoalRuntimeGlobal("fireReviewer", { get: () => fireReviewer });
