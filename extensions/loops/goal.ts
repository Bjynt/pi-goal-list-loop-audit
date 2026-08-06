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
  shouldEscalateStall,
  isStaleApiError,
  mergeSettings,
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
  cloneGoal,
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
  isQuotaWallError,
  nextHourlyPromptMs,
  type ModelSwitchRecord,
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
  MAIN_MODEL_MAX_RETRY_DELAY_MS,
  modelRef,
  nextUntriedModelRef,
  normalizeModelRefs,
  sendStormEscalateMs,
  splitModelRef,
  type MainModelFailure,
} from "../main-model-recovery.js";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEYS,
  globalSettingsPath,
  loadGlobalSettings,
  loadSettings,
  projectSettingsPath,
  saveSettings,
  settingsProvenance,
  type Settings,
} from "../goal-settings.js";
import {
  DEFAULT_REVIEWER_CONFIG,
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
  buildModelPickItems,
  ModelPickerComponent,
  type ModelPickItem,
} from "../model-picker.js";
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

// =================================================================
// Constants
// =================================================================

const GOAL_EVENT_ENTRY = "goal-event";
// HELD_ON_RESTORE (stopReason marker for a restore-held loop) lives in
// goal-loop-forever.js since v0.28.17 — the display layer imports it too.

// =================================================================
// Module-level state (one per session)
// =================================================================

// The ExtensionAPI captured in the factory. sendMessage lives on the API,
// not on ExtensionContext, so continuation sends need it at module scope.
let extensionApi: ExtensionAPI | null = null;
// v0.26.7: pi invalidates the extension runtime on session replacement
// (newSession/fork/switchSession/reload). Once stale, every sendMessage
// throws FOREVER in this process — retrying for hours is the hegemon
// failure shape. Detect the stale signature once and go terminally loud.
let extensionApiStale = false;
// v0.32.0: CRITICAL — goStaleTerminal must gate on its OWN flag, not
// extensionApiStale: probeExtensionApiStale() sets extensionApiStale on
// detection, so the heartbeat's `probe → goStaleTerminal` sequence always
// found the flag already true and returned silently. The terminal orphan
// path must still ledger the stale handle, stop stale work, and preserve the
// interrupt marker so a later fresh lifecycle can restore it.
let staleTerminalDone = false;
// v0.34.19: delayed session-owned callbacks capture this generation. A
// clearTimeout can race a callback already queued by Node; without a
// generation check, an old compaction/refire callback can run after /reload
// and schedule work against the fresh session.
let sessionGeneration = 0;

// v0.34.24: sendMessage(triggerTurn) returning without throwing is only an
// accepted dispatch, not proof that pi started a turn. Keep one immutable
// attempt bound to the session generation and owner identity until a real
// before_agent_start/agent_start/turn_start event acknowledges it.
const CONTINUATION_START_TIMEOUT_MS = Number(process.env.GLLA_CONTINUATION_START_TIMEOUT_MS ?? 150_000);
let continuationStartTimeoutOverrideMs: number | null = null;
function continuationStartTimeoutMs(): number {
  return continuationStartTimeoutOverrideMs ?? CONTINUATION_START_TIMEOUT_MS;
}
/** Test-only: make the bounded start-proof watchdog observable without waiting 150s. */
export function __testOnlySetContinuationStartTimeout(timeoutMs: number | null): void {
  continuationStartTimeoutOverrideMs = timeoutMs;
}
let pendingContinuationDispatch: ContinuationDispatch | null = null;
let continuationStartTimer: NodeJS.Timeout | null = null;
let continuationDispatchStoodDown = false;

function sessionManagerId(ctx: ExtensionContext): string {
  try {
    const getId = (ctx.sessionManager as { getSessionId?: () => string }).getSessionId;
    return typeof getId === "function" ? String(getId.call(ctx.sessionManager)) : "unknown-session";
  } catch {
    return "unknown-session";
  }
}

/** v0.26.7: a stale api is terminal for this process — go loudly with
 * restart guidance instead of retrying sends that can never land.
 * v0.28.1 (S1/S2): goals STAY ACTIVE with an interrupt marker instead of
 * pausing — the restore gate only auto-resumes ACTIVE goals, so pausing
 * here stranded goals until manual /goal resume (hegemon/sraaal shape).
 * sendContinuation's extensionApiStale guard already stops further sends
 * in this doomed process; the next fresh session can restore the work. */
/** v0.34.16: lifecycle-first session-replacement survival. pi's
 * sanctioned pattern (docs/extensions.md lifecycle + the stale error text):
 * session_shutdown → persist handoff debt + stop old timers,
 * session_start → re-establish with the NEW ctx and consume the debt.
 * A successor module may still stand down via the owner file. An orphan with
 * no replacement is reported honestly: an invalid extension cannot repair its
 * own pi host, so glla never injects terminal keystrokes. */
const SESSION_REBIND_GRACE_MS = 60_000;
let sessionReplacementUntil = 0;
const instanceStartedAt = Date.now();
const instanceId = `${process.pid}:${instanceStartedAt}`;
let zombieStoodDown = false;

function ownerFilePath(cwd: string): string {
  return path.join(cwd, ".pi-glla", "owner.json");
}

function writeOwnerFile(cwd: string): void {
  try {
    fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
    fs.writeFileSync(ownerFilePath(cwd), JSON.stringify({ instanceId, pid: process.pid, at: Date.now() }));
  } catch {
    /* owner file is advisory — never block activation on it */
  }
}

function readOwnerFile(cwd: string): { instanceId?: string; pid?: number; at?: number } | null {
  try {
    return JSON.parse(fs.readFileSync(ownerFilePath(cwd), "utf8")) as { instanceId?: string; pid?: number; at?: number };
  } catch {
    return null;
  }
}

/** A stale probe is terminal only for ORPHANS. Returns true when the
 * stale sighting was absorbed (a rebind window is open, or a successor
 * instance owns this cwd and we stand down silently), false when the
 * caller should go terminal (orphan — no replacement came). */
function absorbStaleIfSuperseded(ctx: ExtensionContext): boolean {
  if (Date.now() < sessionReplacementUntil) {
    appendLedger(ctx.cwd, "stale_awaiting_rebind", {});
    return true;
  }
  const owner = readOwnerFile(ctx.cwd);
  if (owner && owner.pid === process.pid && typeof owner.instanceId === "string" && owner.instanceId !== instanceId) {
    appendLedger(ctx.cwd, "zombie_stood_down", { owner: owner.instanceId });
    zombieStoodDown = true;
    extensionApiStale = true; // silence the send paths WITHOUT the terminal theatre
    clearSessionOwnedTimers();
    return true;
  }
  return false;
}

function goStaleTerminal(ctx: ExtensionContext, where: string): void {
  if (staleTerminalDone) return; // already terminal — don't re-spam
  staleTerminalDone = true;
  extensionApiStale = true;
  appendLedger(ctx.cwd, "extension_api_stale", { where, kind: isLoopActive() ? "loop" : "goal" });
  // v0.34.57 (OPEN-ISSUES bug #1.1/#1.3 / tasklist item #2): also write a
  // structured `session_handle_invalidated` event with a `reason` enum so the
  // recovery path can pick the right strategy. The current stale-handle
  // detection cannot infer the cause from a generic stale error, so the
  // default reason is "unknown". Future callers MAY pass a more specific
  // reason when known (oom | manual-kill | provider-disconnect | unknown).
  appendLedger(ctx.cwd, "session_handle_invalidated", {
    where,
    kind: isLoopActive() ? "loop" : "goal",
    reason: "unknown",
  });
  const guidance = "pi invalidated this session's extension handle without delivering a replacement session. glla stopped stale sends and kept the work safe in .pi-glla/. A fresh session_start will resume it; if pi does not create one, restart pi normally and glla will restore the saved work.";
  // v0.35.x: an orphaned detached completion audit is not allowed to leave
  // the durable goal in AUDITING. Release the MAIN-side wait immediately and
  // preserve the exact claim as infrastructure/no-verdict recovery debt.
  if (state.goal?.status === "auditing") {
    markCompletionAuditRecoveryPending(ctx, `extension_api_stale:${where}`);
  }
  // v0.32.0: kill the continuation re-arm too — otherwise an orphaned goal
  // keeps spinning a flat 50ms retry below every watchdog.
  clearSessionOwnedTimers();
  if (isLoopActive()) {
    clearLoopTimer();
    state.loop = { ...state.loop!, active: false, stopReason: `extension api stale: ${guidance}` };
    persistState(ctx);
  } else if (state.goal && state.goal.status === "active") {
    updateGoal({ interruptedAt: nowIso(), interruptedReason: `extension api stale (${where})` }, ctx);
  }
  // The stale process loses its ticker immediately, so paint the durable
  // interrupted state synchronously while the old UI handle can still accept
  // updates. The next session_start paints it again from disk.
  refreshUI(ctx);
  ctx.ui.notify(`glla: ${guidance}`, "warning");
  notifyExternal(ctx, `glla: extension api stale — waiting for a fresh session_start; restart pi normally only if no replacement arrives. (${where})`);
}

/** v0.34.16: lifecycle handoff replaces terminal keystroke injection. A
 * stale extension cannot call pi, so recovery must cross the lifecycle
 * boundary: session_shutdown records durable resume debt, clears every timer
 * that could retain the old context, and session_start consumes the debt from
 * a fresh context. */
const SESSION_HANDOFF_FILE = "session-handoff.json";
const SESSION_HANDOFF_VERSION = 1;
const SESSION_HANDOFF_FRESH_MS = 300_000;
interface SessionHandoffRecord {
  version: typeof SESSION_HANDOFF_VERSION;
  pid: number;
  at: string;
  reason: string;
  generation: number;
  ownerSessionId: string;
}
function sessionHandoffPath(cwd: string): string {
  return path.join(piGlaDir(cwd), SESSION_HANDOFF_FILE);
}
function writeSessionHandoff(ctx: ExtensionContext, reason: string): boolean {
  // A stored completion claim is a lifecycle owner even though it is not a
  // normal supervisor. Keep a handoff record for it after we release the
  // MAIN-side audit wait; the successor may then apply its normal recovery
  // policy without treating the old detached worker as live.
  if (!isSupervising() && !(state.goal?.pendingCompletion && isCompletionAuditRecoveryPending(state.goal))) return false;
  // A user quit is an explicit stop, not a replacement boundary. Do not
  // leave debt that could silently resume the work on a later startup;
  // global autoResume may still apply by its own explicit policy.
  if (reason.trim().toLowerCase() === "quit") {
    try { fs.rmSync(sessionHandoffPath(ctx.cwd), { force: true }); } catch { /* advisory cleanup */ }
    appendLedger(ctx.cwd, "session_handoff_suppressed", { reason });
    return false;
  }
  try {
    fs.mkdirSync(piGlaDir(ctx.cwd), { recursive: true });
    const handoff: SessionHandoffRecord = {
      version: SESSION_HANDOFF_VERSION,
      pid: process.pid,
      at: new Date().toISOString(),
      reason,
      generation: sessionGeneration,
      ownerSessionId: sessionManagerId(ctx),
    };
    fs.writeFileSync(sessionHandoffPath(ctx.cwd), JSON.stringify(handoff));
    appendLedger(ctx.cwd, "session_handoff_pending", { reason, pid: process.pid, generation: sessionGeneration });
    return true;
  } catch {
    appendLedger(ctx.cwd, "session_handoff_write_failed", { reason });
    return false;
  }
}
function consumeSessionHandoff(
  cwd: string,
  expectedGeneration: number | null,
  expectedOwnerSessionId: string | null,
): boolean {
  try {
    const p = sessionHandoffPath(cwd);
    if (!fs.existsSync(p)) return false;
    const raw = fs.readFileSync(p, "utf-8");
    // Consume before validation: a stale, foreign, malformed, or mismatched
    // handoff must never be retried by a later session as if it were fresh.
    fs.unlinkSync(p);
    const data = JSON.parse(raw) as Partial<SessionHandoffRecord>;
    const at = Date.parse(data.at ?? "");
    const fresh = !Number.isNaN(at) && Date.now() - at < SESSION_HANDOFF_FRESH_MS;
    const matches = data.version === SESSION_HANDOFF_VERSION
      && data.pid === process.pid
      && data.reason?.trim().toLowerCase() !== "quit"
      && typeof data.generation === "number"
      && Number.isFinite(data.generation)
      && expectedGeneration !== null
      && data.generation === expectedGeneration
      && typeof data.ownerSessionId === "string"
      && expectedOwnerSessionId !== null
      && data.ownerSessionId === expectedOwnerSessionId;
    if (!fresh || !matches) {
      appendLedger(cwd, "session_handoff_rejected", {
        reason: !fresh ? "stale-or-invalid" : "identity-mismatch",
        expectedGeneration,
        actualGeneration: typeof data.generation === "number" ? data.generation : null,
      });
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** v0.34.14: /reload rebind detector. The extension runs INSIDE pi, so
 * process.pid IS pi's pid: an instance that boots and finds its OWN pid
 * already in the owner file is normally a same-process rebuild, not a cold
 * boot. A non-quit rebind resumes active goals/loops — holding mid-work
 * after an in-place rebuild is pure friction (user directive: keep going
 * unless we must stop; "the list is not continuing" after /reload,
 * hellhunter 2026-08-01). An explicit quit is stamped in the sidecar and
 * does not receive this implicit consent; cold boots (new pid) still honor
 * autoresume=off. Sidecar, not the ledger: read-before-write must be
 * atomic-ish and the ledger is append-only. */
const SESSION_OWNER_FILE = "session-owner.json";
interface SessionOwnerRecord {
  pid?: number;
  at?: string;
  generation?: number;
  ownerSessionId?: string;
  shutdownReason?: string;
  shutdownAt?: string;
}
interface SessionOwnerClaim {
  rebind: boolean;
  generation: number;
  previousGeneration: number | null;
  previousOwnerSessionId: string | null;
}
function markSessionOwnerShutdown(cwd: string, reason: string): void {
  try {
    const p = path.join(piGlaDir(cwd), SESSION_OWNER_FILE);
    const owner = JSON.parse(fs.readFileSync(p, "utf-8")) as SessionOwnerRecord;
    if (owner.pid === process.pid) {
      fs.writeFileSync(p, JSON.stringify({ ...owner, shutdownReason: reason, shutdownAt: new Date().toISOString() }));
    }
  } catch { /* advisory sidecar — lifecycle cleanup must not throw */ }
}
function claimSessionOwnerAndDetectRebind(
  cwd: string,
  currentGeneration: number,
  ownerSessionId: string,
): SessionOwnerClaim {
  try {
    const p = path.join(piGlaDir(cwd), SESSION_OWNER_FILE);
    let previous: SessionOwnerRecord = {};
    try {
      previous = JSON.parse(fs.readFileSync(p, "utf-8")) as SessionOwnerRecord;
    } catch { /* absent or corrupt — first boot */ }
    const previousGeneration = typeof previous.generation === "number" && Number.isFinite(previous.generation)
      ? previous.generation
      : null;
    const generation = previousGeneration === null
      ? currentGeneration
      : Math.max(currentGeneration, previousGeneration + 1);
    fs.writeFileSync(p, JSON.stringify({
      pid: process.pid,
      at: new Date().toISOString(),
      generation,
      ownerSessionId,
    } satisfies SessionOwnerRecord));
    const shutdownReason = previous.shutdownReason?.trim().toLowerCase();
    const hadShutdown = typeof shutdownReason === "string" && shutdownReason.length > 0;
    return {
      rebind: previous.pid === process.pid && !hadShutdown,
      generation,
      previousGeneration,
      previousOwnerSessionId: typeof previous.ownerSessionId === "string" ? previous.ownerSessionId : null,
    };
  } catch {
    return {
      rebind: false,
      generation: currentGeneration,
      previousGeneration: null,
      previousOwnerSessionId: null,
    };
  }
}

/** v0.34.13: consume the sidecar marker on session restore. Single-use,
 * freshness-bounded — a stale marker from an abandoned recovery must not
 * surprise-resume a later session. */
function consumeRecoveryResume(cwd: string): boolean {
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

/** TEST-ONLY hook (tests/harness): the stale flag is process-terminal in
 * production — only a pi restart clears it — so behavioral tests reset it
 * between stale scenarios. Never called by production code. */
export function __testOnlyResetStaleFlag(): void {
  extensionApiStale = false;
}

/** TEST-ONLY hook (tests/harness): clears the terminal/stand-down module
 * flags a stale-scenario test file may have latched. Production clears them
 * only on successor-absorb or process restart; bun test shares module state
 * across files, so an ordinary-events test file must be able to run even
 * when an earlier file latched them. Never called by production code. */
export function __testOnlyResetTerminalFlags(): void {
  staleTerminalDone = false;
  zombieStoodDown = false;
  sessionHandoffPending = false;
}

/** TEST-ONLY hook (tests/harness): set/clear the persisted lastModelRef
 * slot so a test can start from fresh-process semantics (no model observed
 * yet) without firing a session_start. Never called by production code. */
export function __testOnlySetLastModelRef(ref: string | undefined): void {
  state.lastModelRef = ref;
}

/** Test-only lifecycle driver: exercise the orphan watchdog without waiting
 * for the production 15-second heartbeat interval. This never ships as a
 * runtime command; it only lets the mock host reproduce an invalidated
 * context with no successor session_start. */
export function __testOnlyHeartbeatTick(): void {
  heartbeatTick();
}

/** Test-only: release the claimed session owner so a later test file can
 * drive agent_end with its own sessionManager identity (ownerSession is
 * process-wide module state; behavioral-orchestrator claims it first). */
export function __testOnlyResetOwnerSession(): void {
  ownerSession = null;
  ownerCwd = null;
  deadOwnerSession = null;
  deadOwnerCwd = null;
}

/** Lifecycle regression hook: drive the detached list-audit fan-out from the behavioral
 * harness. The production path passes the immutable cwd + generation from
 * archiveCurrentGoal; this hook uses the current generation so the test can
 * replace the session while the confirmation is suspended. */
export async function __testOnlyRunFanOutListAuditFindings(cwd: string): Promise<void> {
  await fanOutListAuditFindings(cwd, sessionGeneration);
}

/** v0.28.1 (S3): side-effect-free staleness probe — getSessionName()
 * routes through pi's assertActive() and throws the stale signature iff
 * pi invalidated this factory handle (session replacement). A positive
 * result is cached in extensionApiStale. */
function probeExtensionApiStale(): boolean {
  if (extensionApiStale) return true;
  if (!extensionApi) return false;
  try {
    extensionApi.getSessionName();
  } catch (err) {
    if (isStaleApiError(err)) extensionApiStale = true;
  }
  return extensionApiStale;
}

/** v0.34.7: orchestrator-path sendUserMessage that can NEVER crash the
 * process. Darklord 2026-08-01: fanOutListAuditFindings ran on a stale
 * handle (a /reload landed mid-collect), assertActive threw, the floating
 * promise from sync archiveCurrentGoal turned it into an uncaughtException
 * and pi EXITED mid-audit. Probe first, catch anyway, ledger the skip. */
function safeSteerUser(ctx: ExtensionContext, text: string): boolean {
  if (sessionHandoffPending) {
    appendLedger(ctx.cwd, "steer_skipped_handoff", { chars: text.length });
    return false;
  }
  if (probeExtensionApiStale()) {
    appendLedger(ctx.cwd, "steer_skipped_stale", { chars: text.length });
    return false;
  }
  try {
    extensionApi?.sendUserMessage(text, { deliverAs: ctx.isIdle() ? "followUp" : "steer" });
    return true;
  } catch (err) {
    if (isStaleApiError(err)) extensionApiStale = true;
    appendLedger(ctx.cwd, "steer_skipped_stale", { chars: text.length, threw: true });
    return false;
  }
}

/** v0.28.1 (S3): command-entry staleness probe + honest warning. Returns
 * true when the handle is stale — callers must skip send-dependent paths
 * and must NOT claim work started (S3's "created — starting now" lie). */
function warnIfStaleAtEntry(ctx: ExtensionContext, what: string): boolean {
  if (!probeExtensionApiStale()) return false;
  if (sessionHandoffPending) {
    ctx.ui.notify(`glla: this session is handing off to a fresh pi context — ${what} will be handled after session_start.`, "info");
    return true;
  }
  // v0.30.0: a successor may already own this session (e.g. a module
  // re-import) — the user's command belongs to the fresh instance; say so
  // softly instead of claiming the old handle can recover it.
  // v0.32.0: the rebind window means a fresh instance is COMING, not here —
  // the message names that handoff rather than pretending a send landed.
  if (Date.now() < sessionReplacementUntil) {
    ctx.ui.notify(`glla: this session is rebinding after /reload — ${what} will be handled by the refreshed instance; retry in a moment if it doesn't.`, "info");
    return true;
  }
  if (absorbStaleIfSuperseded(ctx)) {
    ctx.ui.notify(`glla: a refreshed instance owns this session — ${what} is handled there; nothing to do.`, "info");
    return true;
  }
  appendLedger(ctx.cwd, "extension_api_stale", { where: `entry probe (${what})` });
  ctx.ui.notify(
    `glla: this session's extension handle is stale (pi session replacement) — ${what} can't send continuations in this process. State is safe in .pi-glla/. A fresh session_start will resume it; if pi does not create one, restart pi normally and restore the saved work.`,
    "warning",
  );
  // Entry probes never mutate the terminal. The only recovery boundary is
  // pi's own session lifecycle; user-present commands keep an honest warning
  // and the durable state remains available to the fresh session.
  return true;
}

/** v0.28.12: draft-class confirm with the auto-accept escape hatch SURFACED.
 * The polis incident: a user sat through a 14-item batch Confirm having
 * already reviewed every item during drafting, never knowing /glla
 * autoaccept=on existed — the Yes/No dialog never mentioned it. Now every
 * draft dialog is a 3-choice select; the ALWAYS choice persists project
 * autoAcceptDrafts=true and accepts. Returns "stale" when the dialog can't
 * render (session replacement) so call sites keep their NOT-a-rejection
 * handling; falls back to the plain confirm if select is unavailable. */
type DraftChoice = "yes" | "no" | "stale";
async function confirmDraft(ctx: ExtensionContext, title: string, body: string): Promise<DraftChoice> {
  const ALWAYS = "Yes — and always auto-accept drafts (sets autoAcceptDrafts for this project)";
  try {
    const choice = await ctx.ui.select(`${title}\n\n${body}`, ["Yes", ALWAYS, "No"]);
    if (choice === ALWAYS) {
      saveSettings("project", ctx.cwd, { autoAcceptDrafts: true });
      appendLedger(ctx.cwd, "draft_autoaccept_enabled", { via: title });
      ctx.ui.notify("Draft auto-accept ON for this project — future draft confirms are skipped. Undo in /glla settings: Auto-accept drafts = off.", "info");
      return "yes";
    }
    return choice === "Yes" ? "yes" : "no";
  } catch (err) {
    if (isStaleApiError(err)) return "stale";
    try {
      return (await ctx.ui.confirm(title, body)) ? "yes" : "no";
    } catch (err2) {
      return isStaleApiError(err2) ? "stale" : "no";
    }
  }
}

// v0.28.14: ONE summary + policy application for stale carryover when NEW
// work activates. pause (default): surface what's waiting, stack nothing
// silently. clear: drop the queue, dismiss the held loop, archive the
// paused goal — honestly, with a ledger trail. resume: legacy silent
// behavior. A new GOAL replacing a paused one archives it in every policy
// (one-active-thing: state.goal holds exactly one goal).
function resolveCarryover(ctx: ExtensionContext, trigger: "goal" | "loop" | "list"): void {
  if (carryoverResolved || !carryoverSnapshot) return;
  carryoverResolved = true;
  const snap = carryoverSnapshot;
  carryoverSnapshot = null;
  const policy = loadSettings(ctx.cwd).carryover ?? "pause";
  if (policy === "resume") return; // legacy silent stacking
  const done: string[] = [];
  const waiting: string[] = [];
  const pausedGoal = state.goal && state.goal.status === "paused" ? state.goal : null;
  // A new goal OR list item replaces the goal slot; a loop leaves it paused.
  if (pausedGoal && (trigger === "goal" || trigger === "list" || policy === "clear")) {
    archiveCurrentGoal(ctx, "aborted", trigger === "loop" ? "carryover cleared" : `replaced by new ${trigger} (carryover)`);
    done.push(`archived paused goal "${displaySlice(snap.pausedGoal ?? pausedGoal.objective, 60)}"`);
  } else if (snap.pausedGoal) {
    waiting.push(`paused goal "${displaySlice(snap.pausedGoal, 60)}" (${workCommand(snap.pausedGoalPolicy, "resume")})`);
  }
  if (snap.listCount > 0) {
    if (policy === "clear") {
      state = { ...state, list: [] };
      done.push(`dropped ${snap.listCount} waiting list item(s)`);
    } else {
      waiting.push(`${snap.listCount} waiting list item(s) (/list next)`);
    }
  }
  if (snap.heldLoop) {
    if (policy === "clear" && state.loop && !state.loop.active && state.loop.stopReason === HELD_ON_RESTORE) {
      state.loop = { ...state.loop, stopReason: "cleared: carryover" };
      done.push(`dismissed held loop "${displaySlice(snap.heldLoop, 60)}"`);
    } else {
      waiting.push(`held loop "${displaySlice(snap.heldLoop, 60)}" (/loop to resume)`);
    }
  }
  persistState(ctx);
  appendLedger(ctx.cwd, "carryover_resolved", { policy, trigger, cleared: done.length, waiting: waiting.length });
  const summary = [...done.map((d) => `✂ ${d}`), ...waiting.map((w) => `⏸ ${w}`)].join(" · ");
  if (!summary) return;
  ctx.ui.notify(
    policy === "clear"
      ? `Carryover cleared (${trigger}): ${summary}`
      : `Carryover from before this session: ${summary}${waiting.length > 0 ? " — set Carryover = clear in /glla settings to drop these automatically." : ""}`,
    "info",
  );
}

// The most recent ExtensionContext seen from any event or command handler.
// pi replaces sessions (newSession/fork/reload) and stale ctx throws on use,
// so timers must never capture a ctx — they read lastCtx at fire time.
let lastCtx: ExtensionContext | null = null;
// v0.34.16: shutdown sets this before pi invalidates the old context. Any
// timer or late event that reaches the old module must stand down until the
// fresh session_start rebinds it.
let sessionHandoffPending = false;
// v0.34.18: pi's initial `session_start` fires before interactive mode
// renders the selected transcript. A plain `pi` startup is also a fresh,
// empty session; do not let project-scoped autoResume launch work into that
// placeholder before the user has loaded a real session.
let initialSessionLoadPending = false;
const sessionTimeouts = new Set<NodeJS.Timeout>();
// v0.23.8: the session that OWNS the loop (its sessionManager). Subagent
// sessions (pi-subagents binds extensions there too) fire our handlers
// with their own ctx — they must never take over lastCtx (a headless
// subagent ctx would silently kill the heartbeat/wedge machinery).
let ownerSession: unknown = null;
let ownerCwd: string | null = null;
// v0.34.25: clearSessionOwnedTimers nulls ownerSession at the stale terminal,
// erasing the very identity a successor-absorption decision needs. Keep the
// dead owner here so a live file-backed ctx can still be recognized as the
// replacement HOST session (vs an in-memory subagent worker) after the park.
let deadOwnerSession: unknown = null;
let deadOwnerCwd: string | null = null;

function sessionHasConversation(ctx: ExtensionContext): boolean | undefined {
  try {
    const manager = ctx.sessionManager as unknown as {
      buildSessionContext?: () => { messages?: unknown[] };
    };
    if (typeof manager.buildSessionContext !== "function") return undefined;
    return (manager.buildSessionContext().messages?.length ?? 0) > 0;
  } catch {
    // Older pi contexts and test doubles may not expose the session reader;
    // preserve their existing behavior rather than guessing that they are blank.
    return undefined;
  }
}

function isBlankInitialStartup(ctx: ExtensionContext, reason: string): boolean {
  if (reason !== "startup" && reason !== "unknown") return false;
  return sessionHasConversation(ctx) === false;
}

function releaseInitialSessionLoadBarrier(): void {
  initialSessionLoadPending = false;
  // The factory starts the heartbeat, but a future pi/context may not. This
  // is idempotent and makes an explicit /goal resume or /loop start usable.
  startHeartbeat();
}

function ownerProbeLive(): boolean {
  if (!ownerSession || !lastCtx) return false;
  try { lastCtx.isIdle(); return true; } catch { /* owner went stale (session replaced) */ }
  return false;
}

/** v0.34.25: is this ctx a real pi host session (file-backed), not a subagent
 * worker? pi-subagents sessions are SessionManager.inMemory — no session
 * file (pi-subagents agent-runner.ts). A silent host replacement keeps file
 * persistence; an in-memory ctx can only be an ephemeral worker. Fail closed
 * on any probe error. */
function isHostSuccessorCtx(ctx: ExtensionContext): boolean {
  try {
    const sm = ctx.sessionManager as { getSessionFile?: unknown } | null | undefined;
    if (!sm || typeof sm.getSessionFile !== "function") return false;
    return Boolean((sm.getSessionFile as () => string | undefined)());
  } catch {
    return false;
  }
}

/** v0.34.27: a file-backed context is a successor only when it is from the
 * same workspace as the dead owner. The file-backed test separates host
 * sessions from pi-subagents' in-memory workers; the cwd test also prevents
 * a different project/worktree context from claiming this process-wide goal
 * plane. Owner liveness remains fail-closed unless this instance has already
 * declared the old handle terminal. */
function isHostSuccessorContact(ctx: ExtensionContext): boolean {
  const recordedOwner = ownerSession ?? deadOwnerSession;
  if (recordedOwner === null || ctx.sessionManager === recordedOwner) return false;
  if (!isHostSuccessorCtx(ctx)) return false;
  const recordedCwd = ownerSession !== null ? ownerCwd : deadOwnerCwd;
  if (recordedCwd && ctx.cwd !== recordedCwd) return false;
  return staleTerminalDone || !ownerProbeLive();
}

/** v0.34.25: same-host successor absorption. pi can replace the host session
 * WITHOUT delivering session_start (the silent swap around compaction —
 * deathrun/hegemon/pulis sessions parked forever as "host session lost"
 * while the user sat at a live prompt). The replacement session is ALIVE and
 * reaches us through ordinary tool calls and events: a foreign ctx that is
 * file-backed while the recorded owner is provably dead IS the replacement
 * host session. Absorb it as the goal-plane owner, clear the stale-terminal
 * theatre, and resume the interrupted chain with lifecycle-rebind consent
 * semantics (the session never died; there was no load decision to gate).
 * Subagent workers (in-memory) and ambiguous cases (owner still live) keep
 * failing closed; a zombie-stood-down instance never reclaims the plane. */
function tryAbsorbHostSuccessor(ctx: ExtensionContext, via: string): boolean {
  if (zombieStoodDown) return false; // a successor INSTANCE owns owner.json — this instance stands down forever
  if (!isHostSuccessorContact(ctx)) return false;
  const interruptedAudit = state.goal?.status === "auditing" && !!state.goal.pendingCompletion;
  ownerSession = ctx.sessionManager;
  ownerCwd = ctx.cwd;
  deadOwnerSession = null;
  deadOwnerCwd = null;
  lastCtx = ctx;
  extensionApiStale = false;
  staleTerminalDone = false;
  sessionHandoffPending = false;
  sessionGeneration++; // a dead generation's delayed callbacks must not fire into the new owner
  clearDraftingState(); // the old interview belongs to the disposed generation
  appendLedger(ctx.cwd, "session_rebind_via_live_ctx", { via, generation: sessionGeneration });
  if (interruptedAudit) {
    // The old generation's detached worker/result handler is now stale. Do
    // not let its finally block leave completionAuditInFlight latched in the
    // successor; release the MAIN and require explicit recovery consent.
    markCompletionAuditRecoveryPending(ctx, `silent-host-successor:${via}`);
    ctx.ui.notify(`glla: detached completion auditor lost with the old host — no verdict was reached; the MAIN is released. ${activeGoalSurfaceCommand("resume")} retries the stored claim.`, "warning");
  }
  ctx.ui.notify("glla: pi replaced this session without delivering session_start — absorbed the live replacement as the goal-plane owner (in-memory subagent sessions stay refused).", "info");
  startHeartbeat();
  if (state.goal && state.goal.status === "active" && state.goal.interruptedAt) {
    updateGoal({ interruptedAt: undefined, interruptedReason: undefined }, ctx);
    ctx.ui.notify(`Resuming ${state.goal.policy === "list" ? "list item" : "goal"}: ${displaySlice(state.goal.objective, 70)} — auto-resumed after the silent session swap`, "info");
    postRestoreGraceTurns = 2;
    scheduleContinuation(ctx, true);
  }
  refreshUI(ctx);
  return true;
}

function rememberCtx(ctx: ExtensionContext): void {
  // v0.34.25: absorb BEFORE the stale gates drop the ctx — after pi's silent
  // swap, the first sign of life is an ordinary command/event from the
  // replacement session, and every gate below would discard it forever.
  if (tryAbsorbHostSuccessor(ctx, "rememberCtx")) return;
  // Late events from a disposed session must never reclaim lastCtx after the
  // lifecycle handoff has been declared. Only session_start clears these
  // gates and may bind a fresh context.
  if (sessionHandoffPending || staleTerminalDone || zombieStoodDown) return;
  const ownerLive = ownerProbeLive();
  const claim = classifySessionCtx(ownerSession, ownerLive, ctx.sessionManager);
  if (claim === "foreign") return;
  // v0.34.25: with a dead owner the old code rebound to ANY ctx — including
  // an in-memory subagent worker, locking the real host out of its own goal
  // plane. Only a file-backed host successor may claim (absorption above).
  const recordedOwner = ownerSession ?? deadOwnerSession;
  if (recordedOwner && ctx.sessionManager !== recordedOwner && !isHostSuccessorContact(ctx)) return;
  ownerSession = ctx.sessionManager;
  ownerCwd = ctx.cwd;
  lastCtx = ctx;
}

/** True when ctx belongs to a subagent/foreign session, not the loop owner. */
function isForeignCtx(ctx: ExtensionContext): boolean {
  return ownerSession !== null && ctx.sessionManager !== ownerSession;
}

/**
 * Host-owned replacement events are the one exception to the foreign-session
 * guard. A same-process /new, /resume, /fork, or /reload can deliver
 * session_start with a NEW SessionManager and (on the affected pi paths)
 * without a preceding session_shutdown. Treating that event as a subagent
 * leaves the old owner in place forever and discards the only rebind event.
 *
 * pi-subagents creates fresh sessions with the default `startup` event, so
 * keeping `startup` foreign preserves the subagent isolation guard. The
 * previousSessionFile field is an additional host-runtime signal for future
 * replacement reasons.
 */
function isHostLifecycleSessionStart(event: unknown): boolean {
  const candidate = event as { reason?: unknown; previousSessionFile?: unknown } | null;
  const reason = typeof candidate?.reason === "string" ? candidate.reason.trim().toLowerCase() : "";
  return ["new", "resume", "fork", "reload"].includes(reason)
    || typeof candidate?.previousSessionFile === "string";
}

const FOREIGN_SESSION_TOOL_MESSAGE =
  "This tool changes goal/loop/list state, which only the MAIN session owns — you are running in a subagent session. Report back to the main agent; it owns the goal and can call this tool.";

/** Refusal message when a state-mutating tool is called from a subagent session, else null. */
function foreignToolGuard(execCtx: unknown): string | null {
  const c = execCtx as ExtensionContext | undefined;
  if (!c) return null;
  // v0.34.25: absorb FIRST — the first sign of pi's silent session swap is
  // often a TOOL CALL from the live replacement session, and after the stale
  // terminal the recorded owner is nulled (the successor is not even
  // "foreign"). A file-backed host successor rebinds here, never refuses.
  if (tryAbsorbHostSuccessor(c, "tool-call")) return null;
  if (isForeignCtx(c)) return FOREIGN_SESSION_TOOL_MESSAGE;
  // Post-park the owner is nulled; the dead-owner record means only the
  // file-backed successor may act — ephemeral workers stay refused instead of
  // slipping through the null-owner gap (pre-v0.34.25 hole).
  if (!ownerSession && deadOwnerSession && c.sessionManager !== deadOwnerSession && !isHostSuccessorContact(c)) {
    return FOREIGN_SESSION_TOOL_MESSAGE;
  }
  return null;
}

let state: State = { goal: null };

// Main-session model recovery is separate from detached-auditor quota retry.
// It is opt-in for model rotation (via mainModelFallbacks), but the durable
// wait also protects a supervised goal when every configured model is
// temporarily quota-blocked. One timer, one probe, no blind resend storm.
let mainModelRecoveryTimer: NodeJS.Timeout | null = null;
let mainModelSwitchInFlight = false;
let mainModelAbortForRecovery = false;
let lastMainModelFailure: MainModelFailure | null = null;

// v0.34.58 (bug #1.15): hourly quota-resume prompter. A quota wall parks the
// goal into durable recovery; the prompter schedules ONE sendUserMessage at
// the next :00 clock minute (quota windows refresh on the hour) with the
// original turn context so the user can pick the work back up. NOT a
// self-resume — the message only asks; gated on autoResume: true (the same
// gate that permits automatic continuation). One pending schedule per
// session: a second wall while one is pending never double-schedules.
let quotaPromptTimer: NodeJS.Timeout | null = null;
let quotaPromptScheduledFor: number | null = null;
let quotaPromptContext: string | null = null;
let quotaPromptCtx: ExtensionContext | null = null;
let quotaPromptFired = false;
let quotaPromptClockOverride: number | null = null; // __testOnly

// Drafting mode: a no-arg loop command starts a clarification turn; the agent
// must call propose_goal_draft / propose_loop_draft, which opens the user's
// Confirm dialog. The target decides where the confirmed contract lands.
let draftingTarget: "goal" | "list" | "loop" | null = null;
// v0.14.0 drafting floor: user replies counted while drafting; the injected
// seed prompt itself arrives as a user message — skip exactly that one.
let draftingUserReplies = 0;
let draftingBlockedProposals = 0; // v0.15.1: stuck-gate escape hatch
let draftingSeedInFlight = false;

/** Drafting is ephemeral session state, not durable goal/list state. A stale
 * seed or an in-flight Confirm must never leave the next MAIN session behind
 * the old interview gate. */
function clearDraftingState(): void {
  draftingTarget = null;
  draftingUserReplies = 0;
  draftingBlockedProposals = 0;
  draftingSeedInFlight = false;
}

const DRAFT_SESSION_INTERRUPTED_MESSAGE =
  "The drafting flow was interrupted by a pi session replacement. This is NOT a rejection — do not refine or re-propose from the old turn. Wait for a fresh session_start, then run the drafting command again.";

// Dedup set for token accounting (agent_end may replay seen messages).
const countedTokenMessages = new Set<string>();
const countedLoopTokenMessages = new Set<string>();

// Heartbeat self-watchdog state: liveness is the loop's own job.
let lastActivityAt = Date.now();
// v0.29.16: zombie-run watchdog clock — updated ONLY by genuine pi stream
// events (message_update / tool_call / agent_start / turn_start /
// agent_end), never by heartbeat-internal bookkeeping. A session pi
// reports as BUSY with zero stream events for N min is a hung provider
// stream (pi has no read timeout): continuations queue into the void and
// the busy flag conceals the wedge from every other watchdog (field:
// hellhunter + hegemon 2026-07-30, MiniMax streams died silently).
let lastStreamActivityAt = Date.now();
// A fresh UI session starts without stream proof. The clock still has a
// startup value for the zombie watchdog, but the live-work pulse must wait
// for a real host stream event in this session.
let streamActivityObserved = false;
let lastZombieAlertAt = 0;
let lastWedgeAlertAt = 0;
let heartbeatNudges = 0;
// v0.28.4 (P3): skip nudge accounting for the first agent_end turns after a
// session_start restore — recovery chatter is not a stall.
let postRestoreGraceTurns = 0;
// v0.26.1: consecutive heartbeat refires that produced NO real agent turn.
// Resets only on real activity (agent_end / tool_call) — never on the
// refire's own noteActivity, which is what made the hegemon zombie spin
// self-sustaining (619 refires / 23.5h / zero turns).
let consecutiveStalls = 0;
// v0.28.14: carryover snapshot — unfinished work loaded from disk at
// session_start (predates this session). Resolved ONCE per session at the
// first NEW activation (new goal / new loop) per the carryover setting.
let carryoverSnapshot: { pausedGoal?: string; pausedGoalPolicy?: Policy; listCount: number; heldLoop?: string } | null = null;
let carryoverResolved = true;
// v0.26.6: precise replacement for the removed ship-recency suppression —
// set while complete_goal's isolated audit runs, so the heartbeat never
// refires into an in-flight completion.
let completionAuditInFlight = false;
// v0.34.20: an old auditor's finally block must not clear the in-flight
// marker belonging to a fresh lifecycle generation.
let completionAuditGeneration: number | null = null;
// v0.34.21: durable recovery is only auto-fired when the lifecycle event or
// an explicit /goal resume supplied continuation consent. A cold startup with
// autoResume off may display a recovery-pending claim without launching it.
let completionAuditRecoveryArmed = false;
// v0.32.0 compatibility mirror: durable pendingCompletion.quotaAttempts is
// authoritative; this display/ledger counter survives only within a process.
let quotaRetryStreak = 0;
let heartbeatTimer: NodeJS.Timeout | null = null;

const ZOMBIE_RUN_SILENT_MS = 20 * 60_000;
const ZOMBIE_RUN_ALERT_THROTTLE_MS = 10 * 60_000;
// v0.34.11/v0.34.24: compatibility alias for the old unanswered-send
// watchdog. The bounded dispatch-start timer is now the primary proof path;
// this value remains named for older ledger/tests and fallback diagnostics.
const CONTINUATION_UNANSWERED_MS = CONTINUATION_START_TIMEOUT_MS;
const CONTINUATION_UNANSWERED_THROTTLE_MS = 300_000;
// v0.34.12: eager-continuation settle delay. Hellhunter 2026-08-01 (post-
// restart): every turn cycle paid a 60s heartbeat tax because the eager
// continuation fires AT agent_end — exactly pi's turn-teardown blackhole
// window — so it vanished and the 60s heartbeat refire did the real work.
// Ledger showed the tell: goal_continuation_sent pairs + a refire per
// cycle. Sending 2.5s AFTER agent_end lets teardown settle; the send lands
// and the next turn starts immediately. 2.5s per turn beats 60s per turn.
const EAGER_CONTINUATION_SETTLE_MS = Number(process.env.GLLA_EAGER_SETTLE_MS ?? 2_500);
// v0.34.16: retain the old recovery marker for one compatibility window so
// an in-flight v0.34.15 reload can still resume once. New recovery debt uses
// the session lifecycle handoff below and never injects terminal keystrokes.
const RECOVERY_RESUME_MARKER = "recovery-resume.json";
const RECOVERY_RESUME_FRESH_MS = 300_000;
// v0.29.19: dead-turn caps (agent_end exemption path). 6 consecutive
// provider-error turns = a real outage, not bad luck — stop honestly.
// 3 consecutive user aborts = the user means it (user aborts mean STOP).
const LOOP_MAX_CONSECUTIVE_ERRORS = 6;
const LOOP_MAX_CONSECUTIVE_ABORTS = 3;

let lastRealActivityAt = 0;
let lastContinuationSentAt = 0;
let lastUnansweredAlertAt = 0;

function noteActivity(real = false): void {
  lastActivityAt = Date.now();
  if (real) { consecutiveStalls = 0; lastRealActivityAt = lastActivityAt; }
}

function isSupervising(): boolean {
  return isLoopActive() || (!!state.goal && state.goal.status === "active" && state.goal.autoContinue);
}

// =================================================================
// Live TUI (v0.9.0): persistent status segment + above-editor widget.
// "Can't tell if it's on" is a bug, not a nice-to-have.
// =================================================================

let latestAuditProgress: AuditDisplayProgress | null = null;
let uiTicker: NodeJS.Timeout | null = null;
const LIVE_STREAM_PROOF_MS = 15_000;

/**
 * Completion-auditor progress is ephemeral, but it still has an owner. A
 * session generation alone is not enough: a cancelled goal can be replaced
 * by a new goal without a session replacement, and the old detached worker
 * may report one last progress snapshot after cancellation.
 */
function ownsDetachedAudit(generation: number, goalId: string, attemptId: string): boolean {
  return completionAuditGeneration === generation
    && state.goal?.id === goalId
    && state.goal.pendingCompletion?.attemptId === attemptId;
}

function detachedAuditContext(generation: number, goalId: string, attemptId: string): ExtensionContext | null {
  if (!ownsDetachedAudit(generation, goalId, attemptId)) return null;
  return freshCtxForGeneration(generation);
}

function publishDetachedAuditProgress(
  generation: number,
  goalId: string,
  attemptId: string,
  progress: AuditorProgress,
): boolean {
  const current = detachedAuditContext(generation, goalId, attemptId);
  if (!current) return false;
  latestAuditProgress = {
    currentTool: progress.currentTool,
    currentToolArgs: progress.currentToolArgs,
    currentToolStartedAt: progress.currentToolStartedAt,
    phase: progress.phase,
    elapsedMs: progress.elapsedMs,
    recentOutput: progress.recentOutput,
    toolCalls: progress.toolCalls,
    // v0.34.56: expose explicit unmatched-tool-fact counts to the HUD.
    unmatchedToolStarts: progress.unmatchedToolStarts?.length ?? 0,
    unmatchedToolEnds: progress.unmatchedToolEnds?.length ?? 0,
    lastEventAt: Date.now(),
    lastActivityAt: progress.lastActivityAt,
  };
  refreshUI(current);
  return true;
}

function clearDetachedAuditProgress(generation: number, goalId: string, attemptId: string): void {
  if (!ownsDetachedAudit(generation, goalId, attemptId)) return;
  latestAuditProgress = null;
}


// v0.33.0: slim widget "last action" feed — a tiny ring of finished tool
// calls {name, arg, ms, ok} captured from the tool_call/tool_result stream.
// Display-only, never persisted; cleared implicitly as new actions land.
const recentActions: import("../goal-loop-display.js").RecentActionDisplay[] = [];
const inFlightToolCalls = new Map<string, { name: string; arg?: string; at: number }>();
function summarizeToolArg(name: string, input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const v = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.query ?? input.url ?? input.title;
  if (typeof v !== "string" || v.length === 0) return undefined;
  // v0.33.1: strip control chars BEFORE truncating — a raw \n breaks the
  // widget card into un-prefixed lines (footer spoof), a raw ESC corrupts
  // the TUI. The objective path was already whitespace-collapsed; this
  // path was the gap.
  const base = (name === "bash" ? v : v.split("/").pop() || v).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  return base.length <= 24 ? base : base.slice(0, 23) + "…";
}
function noteToolCall(event: any): void {
  const name = String(event?.toolName ?? "?");
  const id = String(event?.toolCallId ?? event?.id ?? `anon-${Date.now()}`);
  if (inFlightToolCalls.size >= 20) inFlightToolCalls.delete(inFlightToolCalls.keys().next().value!); // v0.33.1: evict BEFORE the 21st
  inFlightToolCalls.set(id, { name, arg: summarizeToolArg(name, event?.input ?? event?.args), at: Date.now() });
}
function noteToolResult(event: any): void {
  const id = String(event?.toolCallId ?? event?.id ?? "");
  const f = id ? inFlightToolCalls.get(id) : undefined;
  if (id) inFlightToolCalls.delete(id);
  const ok = !Boolean(event?.isError ?? event?.error);
  const name = f?.name ?? String(event?.toolName ?? "?");
  recentActions.push({ name, arg: f?.arg ?? summarizeToolArg(name, event?.input ?? event?.args), ms: f ? Date.now() - f.at : 0, ok });
  if (recentActions.length > 3) recentActions.shift();
}

function displayActivityFor(ctx: ExtensionContext): {
  activity?: import("../goal-loop-display.js").GoalDisplayActivity;
  lastActivityAt?: number;
  lastStreamActivityAt?: number;
} {
  const goal = state.goal;
  if (!goal || goal.status !== "active") return {};
  const telemetry = goal.telemetry;
  const goalStartedAt = Date.parse(goal.createdAt);
  const hasRealActivity = lastRealActivityAt > 0
    && (!Number.isFinite(goalStartedAt) || lastRealActivityAt >= goalStartedAt);
  const noTurnYet = !telemetry
    && !hasRealActivity
    && (goal.usage?.tokensUsed ?? 0) === 0
    && pendingContinuationDispatch === null;
  if (noTurnYet) return { activity: "awaiting-first-turn" };
  let idle = false;
  let pending = false;
  try {
    idle = ctx.isIdle();
    pending = ctx.hasPendingMessages();
  } catch {
    // A stale/unknown host state is not proof of work. Keep the durable
    // active marker, but do not animate it.
    return { activity: "active" };
  }
  const scheduled = continuationTimer !== null || pendingContinuationDispatch !== null || continuationDispatchStoodDown;
  const lastActivityAt = lastRealActivityAt > 0
    && (!Number.isFinite(goalStartedAt) || lastRealActivityAt >= goalStartedAt)
    ? lastRealActivityAt
    : undefined;
  const streamAt = streamActivityObserved
    && (!Number.isFinite(goalStartedAt) || lastStreamActivityAt >= goalStartedAt)
    ? lastStreamActivityAt
    : undefined;
  const streamFresh = streamAt !== undefined && Date.now() - streamAt <= LIVE_STREAM_PROOF_MS;
  const toolActive = inFlightToolCalls.size > 0;
  // A spinner means pi is busy AND we have recent stream/tool evidence. A
  // busy host with no fresh evidence gets a static BUSY label instead, so a
  // hung provider cannot masquerade as progress.
  if (toolActive || (!idle && streamFresh)) {
    return { activity: "working", lastActivityAt, lastStreamActivityAt: streamAt };
  }
  if (!idle) return { activity: "busy", lastActivityAt, lastStreamActivityAt: streamAt };
  if (pending || scheduled) return { activity: "queued", lastActivityAt, lastStreamActivityAt: streamAt };
  // A short idle gap is normal between agent_end and the settled eager
  // continuation. Only surface idle after a real minute with no queued send;
  // otherwise keep the durable state neutral rather than inventing work.
  if (lastActivityAt === undefined || Date.now() - lastActivityAt >= 60_000) {
    return { activity: "idle", lastActivityAt, lastStreamActivityAt: streamAt };
  }
  return { activity: "active", lastActivityAt, lastStreamActivityAt: streamAt };
}

function refreshUI(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  try {
    const theme = ctx.ui.theme as unknown as import("../goal-loop-display.js").DisplayTheme | undefined;
    // Terminal width for truncation budgets: on wide terminals the widget
    // uses the room instead of cutting at fixed ~60-char floors.
    const width = process.stdout.columns || 80;
    const activity = displayActivityFor(ctx);
    const extras = { stalls: consecutiveStalls, recent: recentActions, ...activity };
    ctx.ui.setStatus("pi-glla", buildStatusText(state, latestAuditProgress, Date.now(), theme, extras));
    ctx.ui.setWidget("pi-glla", buildWidgetLines(state, latestAuditProgress, Date.now(), theme, width, extras));
  } catch {
    // stale ctx — next event refreshes
  }
}

function startUITicker(): void {
  if (uiTicker) return;
  uiTicker = setInterval(() => {
    const ctx = freshCtx();
    // v0.34.12: keep ticking during a timed wait-pause too — the status
    // line counts down to resumeAt live (pully field request 2026-08-01).
    if (ctx && (isSupervising() || (state.goal?.status === "paused" && !!state.goal.pauseResumeAt))) refreshUI(ctx);
  }, 1_000);
  uiTicker.unref?.();
}

/** v0.26.5: shared loud-stop for both stall paths (refire streak and
 * pending-latch streak). Returns true when it escalated. */
// v0.28.5 (E3): send-retry re-arm accounting. The 50ms BACKOFF_IDLE_RETRY
// re-arm loop used to spin for HOURS with zero ledger events while the idle
// watchdogs stayed suppressed. Now: counted, ledgered (start + every 30s),
// and escalated loudly past 5 minutes.
let continuationRearmStreak = 0;
let loopRearmStreak = 0;
// v0.28.24: post-compaction grace — a just-replaced session gets 3 minutes
// to settle (queue drain, provider recovery) before stall counting resumes.
// Field-observed in junk-runner: a 196k-token compact finished, then the
// heartbeat burned all 5 stall refires in the next 5 minutes into a session
// whose turn trigger was still dead — pausing a resumable goal 4 minutes
// after the compact instead of giving pi room to recover.
let compactionGraceUntil = 0;
// v0.34.57: timestamp of the most recent session_compact event. The 150s
// continuation-start watchdog checks this so a compaction that lands inside
// the watchdog window pauses/resets the watchdog instead of being misread
// as a stall (field: 115855/115858/115901 — the watchdog fired while the
// session was still mid-compact; the work was completed on disk but the
// session handle was lost, so the user saw the false-positive warning).
let lastCompactionAt = 0;
// v0.34.57: per-record counter capping the compaction-paused re-arm loop.
// A stuck session that never produces a new compaction event must not
// re-arm indefinitely; after 3 rearms (default 3 × 150s = 7.5m) the
// watchdog fires the unacknowledged warning so the user can intervene.
const COMPACTION_REARM_CAP = 3;
const continuationStartCompactionRearms = new Map<string, number>();
/** Test-only: simulate a compaction event at a controlled time without firing
 * the full session_compact plumbing. Pass null to clear. */
export function __testOnlySetLastCompactionAt(at: number | null): void {
  lastCompactionAt = at ?? 0;
}

// v0.34.58 (bug #1.15): hourly quota-resume prompter test hooks — clock
// override for the next-:00 math, full state reset, and a fire entry point
// that shares fireQuotaResumePrompt() with the real timer callback.
export function __testOnlySetQuotaPromptNow(now: number | null): void {
  quotaPromptClockOverride = now;
}

export function __testOnlyResetQuotaPrompt(): void {
  clearQuotaPromptTimer();
  quotaPromptScheduledFor = null;
  quotaPromptContext = null;
  quotaPromptCtx = null;
  quotaPromptFired = false;
}

export function __testOnlyQuotaPromptState(): { scheduledFireAt: number | null; context: string | null; fired: boolean } {
  return { scheduledFireAt: quotaPromptScheduledFor, context: quotaPromptContext, fired: quotaPromptFired };
}

export function __testOnlyFireQuotaPrompt(): void {
  fireQuotaResumePrompt();
}

/** Load the module state singleton from a cwd's disk state — the exact
 * assignment session_start performs (goal.ts:8827) — WITHOUT firing
 * session_start (co-residency rule: a second session_start claim in a
 * co-resident test file poisons the behavioral driver). */
export function __testOnlyLoadState(cwd: string): void {
  state = readState(cwd);
}

/** Register the agent tools (complete_goal etc.) the way session_start
 * does, WITHOUT firing session_start (co-residency rule). runTool tests
 * that must not claim the session use this. MockPi.registerTool is a map
 * write — re-registration is idempotent on the harness. */
export function __testOnlyRegisterAgentTools(pi: any): void {
  registerAgentTools(pi);
}

/** Pin the context freshCtx() resolves to (normally set by event/command
 * handlers) WITHOUT firing session_start — lets the detached-audit apply
 * path (freshCtxForGeneration) rebind in co-resident test files. */
export function __testOnlyRememberCtx(ctx: ExtensionContext): void {
  rememberCtx(ctx);
}
function noteCompactionRearm(id: string): number {
  const next = (continuationStartCompactionRearms.get(id) ?? 0) + 1;
  continuationStartCompactionRearms.set(id, next);
  return next;
}
function clearCompactionRearms(id: string): void {
  continuationStartCompactionRearms.delete(id);
}
// v0.32.1 (pi-goal-x's lesson — "recover from compacts smarter"): a compact
// leaves a RESUME DEBT, not just two fixed-offset settle probes that can both
// lose (field: hellhunter 4-min dangle 2026-07-31; polis stall same day).
// postCompactResumeOwed discharges only when a real turn starts (agent_start);
// every heartbeat tick past grace retries it. postCompactResyncPending arms a
// deterministic [POST-COMPACTION RESYNC] block on the next continuation/loop
// message (pi-goal-x's #5) so the compacted agent re-anchors on artifact
// state instead of lost chat history.
let postCompactResumeOwed = false;
let postCompactResyncPending = false;
const COMPACTION_GRACE_MS = 3 * 60_000;
// v0.28.25: provider-error retry cadence. Field-observed in dracon-utilities
// (kimi, 19-session fleet on one provider account): a "concurrent request
// limit" 403 storm got 5 retries BACK-TO-BACK (delay 0 after each errored
// turn — the session is idle at agent_end, so scheduleContinuation fired
// instantly) and the brake then cycled on a flat 60s cooldown for 1h 38m.
// The condition clears on a minutes-to-fleet scale, not milliseconds:
// ladder the inter-error retries (5s, 15s, 45s, 90s, 3m — the 5-retry
// budget now spans ~5.5m) and escalate the brake cooldown per consecutive
// brake (1m, 2m, 4m, 8m, 16m cap). A successful turn resets both.
const ERROR_RETRY_LADDER_MS = [5_000, 15_000, 45_000, 90_000, 180_000];
const SEND_REARM_LEDGER_MILESTONES_MS = [2 * 60_000, 5 * 60_000, 10 * 60_000];
// v0.28.29: escalation is TIME-based and ACTIVITY-gated. A busy session is
// NORMAL — the user conversing, or one long subagent turn — and the old
// flat-50ms × 6000-count rule misread 5 minutes of busy as "wedged" and
// paused the goal (the polis field report). Escalate only after 15 minutes
// of failed sends AND no session activity in the last 5 minutes (a wedged
// queue shows no events at all; a busy one streams constantly).
const SEND_REARM_ESCALATE_AFTER_MS = 15 * 60_000;
const SEND_REARM_ESCALATE_SILENT_MS = 5 * 60_000;
let continuationRearmSince = 0;
let loopRearmSince = 0;
// v0.34.57: when the last surfaced provider failure was a long-lived class
// (quota/billing/auth), a send wedge inside this window is almost certainly
// the same wall — escalate the storm into recovery after 3m, not 15m.
let lastLongLivedFailureAt = 0;
let continuationRearmMilestone = 0;
let loopRearmMilestone = 0;

/** v0.28.29: busy-retry cadence backs off — 50ms for the first beats
 * (instant pickup right after a turn ends), then 250ms, 1s, 5s, 15s, 30s
 * cap. agent_end reschedules independently, so the slow tail costs nothing
 * in the common case; it only caps the ledger/CPU spam of a long busy stretch. */
function sendRearmDelayMs(streak: number): number {
  if (streak <= 4) return 50;
  if (streak <= 8) return 250;
  if (streak <= 12) return 1_000;
  if (streak === 13) return 5_000;
  if (streak === 14) return 15_000;
  return 30_000;
}

function accountSendRearm(ctx: ExtensionContext, kind: "continuation" | "loop"): void {
  const streak = kind === "continuation" ? ++continuationRearmStreak : ++loopRearmStreak;
  if (streak === 1) {
    if (kind === "continuation") { continuationRearmSince = Date.now(); continuationRearmMilestone = 0; } else { loopRearmSince = Date.now(); loopRearmMilestone = 0; }
    appendLedger(ctx.cwd, "send_rearm_start", { kind });
    return;
  }
  const since = kind === "continuation" ? continuationRearmSince : loopRearmSince;
  const elapsed = Date.now() - since;
  const milestone = kind === "continuation" ? continuationRearmMilestone : loopRearmMilestone;
  if (milestone < SEND_REARM_LEDGER_MILESTONES_MS.length && elapsed >= SEND_REARM_LEDGER_MILESTONES_MS[milestone]!) {
    if (kind === "continuation") continuationRearmMilestone++; else loopRearmMilestone++;
    appendLedger(ctx.cwd, "send_rearm_storm", { kind, streak, minutes: Math.round(elapsed / 60000) });
  }
  if (elapsed >= sendStormEscalateMs(lastLongLivedFailureAt) && Date.now() - lastActivityAt >= SEND_REARM_ESCALATE_SILENT_MS) {
    if (kind === "continuation") { continuationRearmStreak = 0; continuationRearmSince = 0; } else { loopRearmStreak = 0; loopRearmSince = 0; }
    escalateSendRearmStorm(ctx, kind);
  }
}

function escalateSendRearmStorm(ctx: ExtensionContext, kind: "continuation" | "loop"): void {
  // Same loud-terminal shape as escalateStallNow (v0.24.7). v0.28.29: this
  // only fires on a REAL wedge now (15m of failed sends + 5m of zero
  // session activity) — busy-but-alive sessions never reach it.
  const mins = Math.round(sendStormEscalateMs(lastLongLivedFailureAt) / 60000);
  const silent = Math.round(SEND_REARM_ESCALATE_SILENT_MS / 60000);
  appendLedger(ctx.cwd, "send_rearm_escalated", { kind, afterMinutes: mins, silentMinutes: silent });
  if (kind === "loop" && isLoopActive()) {
    void recoverMainModelFromSendStorm(ctx, kind);
    return;
  }
  if (
    state.goal &&
    (state.goal.status === "auditing" || completionAuditInFlight || state.goal.pendingCompletion)
  ) {
    // v0.29.1: NEVER storm-pause the completion lifecycle. An isolated
    // auditor run takes minutes and the main session is EXPECTED to be
    // silent while it works — 15m of wedged re-arms + that silence is the
    // exact trigger shape, so completing a goal under a wedged queue used
    // to guarantee a mid-audit pause (field-observed in pully + hellhunter
    // + junk-runner: "complete ending in a pause retry storm"). The audit
    // lifecycle owns its own pauses (quota etc.).
    appendLedger(ctx.cwd, "send_rearm_escalated_suppressed", { reason: "audit-lifecycle" });
    ctx.ui.notify("Send-retry storm during the completion audit — NOT pausing; the auditor's silence is expected. If pi is wedged, Escape cancels the stuck run; the stored claim survives.", "info");
    return;
  }
  // A provider-held retry is different from a dead dispatch: after 15m of
  // zero stream activity, stop the stuck core retry, rotate to a configured
  // backup when possible, and install a durable recovery probe. This keeps
  // the old no-blind-resend invariant without requiring the user to notice
  // the wedge and press Escape two hours before quota returns.
  if (isSupervising()) {
    void recoverMainModelFromSendStorm(ctx, kind);
    return;
  }
  if (state.goal && state.goal.status === "active") {
    updateGoal({
      status: "paused",
      pauseKind: "error",
      pauseReason: `send-retry storm: ${mins}m of re-arms with no session activity for ${silent}m — the session never went idle for the continuation`,
      pauseSuggestedAction: `The session produced no events while the send retried (wedged queue — often pi's own rate-limit retry holding the run; pi prints 'escape to cancel'). Press Escape, then ${activeGoalSurfaceCommand("resume")}. A fresh session_start rebinds the goal; restart pi normally only if no replacement arrives.`,
    }, ctx);
    ctx.ui.notify(`${goalNoun()} paused: send-retry storm (${mins}m, session silent ${silent}m). Escape cancels the stuck run, then ${activeGoalSurfaceCommand("resume")}. A fresh session_start rebinds it; restart pi normally only if no replacement arrives.`, "warning");
    notifyExternal(ctx, `${goalNoun()} paused: send-retry storm.`);
  }
}

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

function heartbeatTick(): void {
  if (zombieStoodDown || initialSessionLoadPending) return; // blank startup waits for pi to bind a real session
  // Probe the ExtensionAPI BEFORE probing the captured context. When pi
  // invalidates both handles and emits no replacement session_start,
  // freshCtx() deliberately returns null; probing it first used to make the
  // orphan watchdog silently return forever, leaving the goal green without
  // a durable interruption marker. Keep the last context long enough for the
  // terminal path to persist the honest orphan state.
  const knownCtx = lastCtx;
  if (probeExtensionApiStale()) {
    if (knownCtx && !absorbStaleIfSuperseded(knownCtx)) goStaleTerminal(knownCtx, "heartbeat probe");
    return;
  }
  const ctx = freshCtx();
  if (!ctx) return;
  if (mainModelRecoveryActive()) return;
  let idle = false;
  let pending = false;
  try {
    idle = ctx.isIdle();
    pending = ctx.hasPendingMessages();
  } catch {
    return;
  }
  const sessionIdle = idle && !pending;
  // v0.28.24: post-compaction grace — the whole stall/refire/watchdog
  // machinery below stays quiet for 3 minutes while the replaced session
  // settles (latch watchdog, wedge alert, refire counting all resume after).
  if (Date.now() < compactionGraceUntil) return;
  // v0.34.24: an accepted dispatch with no start proof owns the watchdog
  // until its bounded timeout. Do not let the generic heartbeat create a
  // second blind send underneath it; explicit resume or a fresh session
  // releases the stand-down latch.
  if (continuationDispatchStoodDown || pendingContinuationDispatch) return;
  // v0.33.1: nothing supervised → the compact debt/resync belong to a dead
  // goal/loop. Discharge here so a later goal can't inherit a bogus RESYNC
  // block or a spurious forced refire (the old in-guard `else` was
  // unreachable — isSupervising() ≡ isLoopActive() || isActionableGoal()).
  if (!isSupervising() && (postCompactResumeOwed || postCompactResyncPending)) {
    postCompactResumeOwed = false;
    postCompactResyncPending = false;
  }
  // v0.32.1: post-compaction resume debt — retry on every heartbeat tick
  // past grace until a turn actually starts. Fixed-offset settles alone
  // can both lose (pi busy at 2s AND at grace+2s = a dangling chain).
  if (postCompactResumeOwed && isSupervising() && !abortedStandDown) {
    try {
      if (ctx.isIdle() && !ctx.hasPendingMessages() && continuationTimer === null && loopTimer === null) {
        if (isLoopActive()) {
          appendLedger(ctx.cwd, "compaction_resume_owed_refire", { kind: "loop" });
          scheduleLoopTick(ctx);
        } else if (isActionableGoal()) {
          appendLedger(ctx.cwd, "compaction_resume_owed_refire", { kind: "goal" });
          scheduleContinuation(ctx, true);
        } else {
          postCompactResumeOwed = false; // nothing to resume — discharge
        }
      }
    } catch { /* next tick */ }
  }
  // v0.29.16: zombie-run watchdog. pi reports BUSY (a run is "active") but
  // zero stream events for 20 min = the provider stream hung silently —
  // queued continuations can't land, and every other watchdog stays quiet
  // because busy≠wedged. Detection + loud guidance only: aborting a turn
  // is the user's call (consent line); Esc frees the queue and the
  // heartbeat refires the goal/loop by itself.
  const streamSilentMs = Date.now() - lastStreamActivityAt;
  if (isSupervising() && !idle && streamSilentMs >= ZOMBIE_RUN_SILENT_MS && Date.now() - lastZombieAlertAt >= ZOMBIE_RUN_ALERT_THROTTLE_MS) {
    lastZombieAlertAt = Date.now();
    appendLedger(ctx.cwd, "zombie_run_suspected", { streamSilentMs, pending });
    ctx.ui.notify(`glla: the session has been BUSY with zero stream activity for ${Math.round(streamSilentMs / 60000)} min — the provider stream is hung (pi never times it out; queued continuations can't land). Press Esc to abort the zombie turn — the goal/loop refires itself.`, "warning");
    notifyExternal(ctx, `glla: zombie run suspected (${Math.round(streamSilentMs / 60000)} min busy-silent) — press Esc to abort.`);
    return;
  }
  // v0.34.11: legacy unanswered-continuation diagnostics. The new
  // generation-bound dispatch watchdog returns above while a dispatch is
  // pending, so this branch is only a compatibility fallback for state that
  // predates the dispatch sidecar. It never initiates a second send.
  if (
    isSupervising() &&
    lastContinuationSentAt > 0 &&
    lastRealActivityAt < lastContinuationSentAt &&
    Date.now() - lastContinuationSentAt >= CONTINUATION_UNANSWERED_MS &&
    Date.now() - lastUnansweredAlertAt >= CONTINUATION_UNANSWERED_THROTTLE_MS
  ) {
    lastUnansweredAlertAt = Date.now();
    appendLedger(ctx.cwd, "continuation_unanswered", { silentMs: Date.now() - lastContinuationSentAt });
    const mins = Math.round((Date.now() - lastContinuationSentAt) / 60_000);
    const msg = `glla: pi accepted the continuation ${mins}m ago but NO turn has started — no tool calls, no tokens, transcript frozen (the turn trigger is wedged). Re-sends do not unstick it. A fresh session_start will rebind the ${isLoopActive() ? "loop" : "goal/list item"}; if no replacement arrives, restart pi normally and restore the saved work.`;
    ctx.ui.notify(msg, "warning");
    notifyExternal(ctx, msg);
  }
  // v0.29.1: stranded-audit recovery. A goal left in "auditing" with NO
  // in-flight audit means the auditor's result never landed (wedged queue
  // ate the tool result; compaction/restart mid-audit). Field-observed in
  // pully: 12h+ stuck "auditing" while the model had already confabulated
  // the closure narrative. The audit silence is expected ONLY while
  // completionAuditInFlight — its absence here means the run is orphaned.
  // Release a stranded completion claim to the MAIN as infrastructure/no-
  // verdict. A heartbeat must never silently launch another detached worker;
  // /goal resume (or the mode-correct list/loop resume route) is the explicit
  // one-fresh-dispatch gate.
  if (
    state.goal?.status === "auditing" &&
    !completionAuditInFlight &&
    (!state.goal.pendingCompletion || completionAuditRecoveryArmed) &&
    Date.now() - lastActivityAt >= 90_000
  ) {
    appendLedger(ctx.cwd, "stranded_audit_recovered", { goalId: state.goal.id, via: state.goal.pendingCompletion ? "stored-claim" : "resume-active" });
    if (state.goal.pendingCompletion) {
      markCompletionAuditRecoveryPending(ctx, "heartbeat-recovery");
      ctx.ui.notify(`Completion audit blocked — no verdict. The stored claim is safe; ${activeGoalSurfaceCommand("resume")} starts exactly one fresh auditor.`, "warning");
    } else {
      updateGoal({
        status: "paused",
        pauseKind: "blocked",
        pauseReason: "completion audit interrupted — no verdict",
        pauseSuggestedAction: `The completion attempt was not evaluated. ${activeGoalSurfaceCommand("resume")} returns to the work so it can call complete_goal again.`,
      }, ctx);
      ctx.ui.notify(`Completion audit interrupted — no verdict. MAIN released; ${activeGoalSurfaceCommand("resume")} to continue.`, "warning");
    }
    return;
  }
  // v0.26.5: pending-latch watchdog — a queued continuation whose turn
  // trigger was dropped (field-observed post-compaction: continuation
  // ACCEPTED at compact+0s, then 22 minutes of silence). The stuck latch
  // keeps sessionIdle false, which suppresses the refire path AND the
  // stall escalation below — without this branch the session is silent
  // forever. We never re-send here (the message is already queued
  // pi-side; hegemon proved re-sends don't unstick a dropped trigger) —
  // count, notify, escalate to a loud stop.
  const latchSilentMs = Date.now() - lastActivityAt;
  if (
    shouldFirePendingLatchWatchdog({
      supervising: isSupervising(),
      idle,
      pending,
      timerPending: continuationTimer !== null || loopTimer !== null,
      silentMs: latchSilentMs,
      thresholdMs: PENDING_LATCH_STUCK_MS,
    })
  ) {
    consecutiveStalls++;
    appendLedger(ctx.cwd, "pending_latch_stuck", { consecutiveStalls, silentMs: latchSilentMs });
    noteActivity(); // re-arm the 3-minute cadence; never resets the stall streak
    const stallEscalation = loadSettings(ctx.cwd).stallEscalationRefires ?? DEFAULT_STALL_ESCALATION_REFIRES;
    if (escalateStallNow(ctx, stallEscalation)) return;
    const msg = `Heartbeat: a queued continuation never started its turn for ${Math.round(latchSilentMs / 60_000)}m — pi's pending-message latch appears stuck (known post-compaction failure; stall ${consecutiveStalls}/${stallEscalation > 0 ? stallEscalation : "∞"}). If this repeats, restart pi.`;
    ctx.ui.notify(msg, "warning");
    notifyExternal(ctx, msg);
    return;
  }
  const fire = shouldHeartbeatRefire({
    supervising: isSupervising(),
    sessionIdle,
    timerPending: continuationTimer !== null || loopTimer !== null || continuationStartTimer !== null || pendingContinuationDispatch !== null,
    msSinceActivity: Date.now() - lastActivityAt,
    stallMs: HEARTBEAT_STALL_MS,
    consecutiveStalls,
  });
  // Wedge alert (v0.23.2): session BUSY but silent for the threshold —
  // the classic hung-command case (a test suite that never exits holds
  // the entire goal hostage; field-observed at 5,056s and 6,800s on the
  // same wedged tool call). Independent of the refire path, which only
  // watches idle sessions.
  const wedgeMinutes = resolveEffectiveAggressiveSettings(loadSettings(ctx.cwd)).wedgeAlertMinutes ?? WEDGE_ALERT_DEFAULT_MINUTES;
  if (
    shouldWedgeAlert({
      supervising: isSupervising(),
      // v0.26.5: !idle, not !sessionIdle — an idle session with a stuck
      // pending latch is the watchdog's job above, not a "hung command".
      sessionBusy: !idle,
      silentMs: Date.now() - lastActivityAt,
      msSinceLastAlert: Date.now() - lastWedgeAlertAt,
      thresholdMs: wedgeMinutes * 60_000,
    })
  ) {
    lastWedgeAlertAt = Date.now();
    // v0.34.5: a wedge while blocked on a subagent wait is a DIFFERENT animal
    // from a hung bash command (junk-runner 2026-08-01: 2 Explore agents
    // "thinking…" 31 minutes — working, but indistinguishable from hung
    // without this hint). Name the wait and give the liveness check: a child
    // whose tool-use counter stops moving is hung, not thinking.
    const subWaits = new Set(
      [...inFlightToolCalls.values()]
        .filter((t) => t.name === "get_subagent_result" || t.name === "Agent")
        .map((t) => t.name),
    );
    const subHint = subWaits.size > 0
      ? ` The in-flight call is a SUBAGENT WAIT (${[...subWaits].join("/")}) — check the Agents panel: a child whose tool-use/token counters have stopped moving between checks is hung, not thinking (hard failures surface as ✗ failed + the wait returns; a HANG is silent). Esc interrupts the wait — then collect the survivors with get_subagent_result and absorb the dead scope inline.`
      : "";
    const msg = `${goalNoun()} appears wedged: no activity for ${Math.round((Date.now() - lastActivityAt) / 60_000)}m while the session is busy — likely a hung command (test/build/dev server without a timeout).${subHint} Check the session; Esc kills a stuck tool call.`;
    appendLedger(ctx.cwd, "wedge_alert", { silentMs: Date.now() - lastActivityAt, subagentWait: subWaits.size > 0 });
    ctx.ui.notify(msg, "warning");
    notifyExternal(ctx, msg);
  }
  // v0.29.5: user-abort stand-down — the chain stays DOWN until the
  // user resumes. Without this guard the 60s heartbeat re-fired the
  // continuation and defeated the 0.29.4 stand-down within a minute.
  if (abortedStandDown) return;
  if (!fire) return;
  // v0.26.6: the 0.25.0 "recent ship (<5m)" suppression was REMOVED. It fed
  // lastShippedAtMs, which read the state-file MTIME — and the heartbeat's
  // own suppressed-tick ledger writes refreshed that mtime every 15s,
  // making the suppression self-sustaining forever (field-observed in
  // darklord: 2,184 suppressed ticks over 9.1h after a post-compaction
  // send failure; the completed list item never closed). Under an
  // auto-committing daemon the git-head term self-sustains too. The legit
  // windows are already covered precisely — busy mid-turn, pending
  // messages, scheduled timers — plus the audit-in-flight flag below.
  if (completionAuditInFlight) return;
  noteActivity();
  consecutiveStalls++;
  appendLedger(ctx.cwd, "heartbeat_refire", { nudgesSoFar: heartbeatNudges, consecutiveStalls });
  // v0.26.1: a refire streak means the continuation is NOT landing (wedged
  // message queue, stale API handle, dead turn trigger). Nudges can't catch
  // this — they count turns, and a zombie runs none. Escalate to a loud,
  // actionable stop instead of spinning silently forever.
  const stallEscalation = loadSettings(ctx.cwd).stallEscalationRefires ?? DEFAULT_STALL_ESCALATION_REFIRES;
  if (escalateStallNow(ctx, stallEscalation)) return;
  ctx.ui.notify(`Heartbeat: supervisor active but session stalled — re-firing continuation (stall ${consecutiveStalls}/${stallEscalation > 0 ? stallEscalation : "∞"}).`, "info");
  if (isLoopActive()) {
    scheduleLoopTick(ctx);
  } else {
    scheduleContinuation(ctx, true);
  }
}

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(heartbeatTick, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}
let continuationTimer: NodeJS.Timeout | null = null;
let continuationScheduledFor: string | null = null;
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
let consecutiveNoToolIterations = 0;

// =================================================================
// Helpers
// =================================================================

function clearContinuationTimer(): void {
  if (continuationTimer) {
    clearTimeout(continuationTimer);
    continuationTimer = null;
  }
  continuationScheduledFor = null;
}

function clearContinuationStartWatchdog(): void {
  if (continuationStartTimer) {
    clearTimeout(continuationStartTimer);
    continuationStartTimer = null;
  }
  if (pendingContinuationDispatch) clearCompactionRearms(pendingContinuationDispatch.id);
  pendingContinuationDispatch = null;
  lastContinuationSentAt = 0;
}

function dispatchLabel(record: ContinuationDispatch): string {
  if (record.kind === "loop") return `loop iteration ${record.iteration ?? "?"}`;
  if (record.kind === "stall") return "stall warning";
  if (record.kind === "length") return "length continuation";
  return `${state.goal?.policy === "list" ? "list item" : "goal"}${record.goalId ? ` ${record.goalId}` : ""}`;
}

/**
 * Keep the dispatch lifecycle facts together in every ledger boundary. The
 * sidecar phase is useful for recovery, but a ledger reader also needs to
 * distinguish enqueue acknowledgement, start proof, timeout, and settlement
 * without inferring one from a neighboring event.
 */
function dispatchLedgerValue(record: ContinuationDispatch, facts: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: record.id,
    kind: record.kind,
    ...(record.goalId === undefined ? {} : { goalId: record.goalId }),
    ...(record.iteration === undefined ? {} : { iteration: record.iteration }),
    generation: record.generation,
    ownerSessionId: record.ownerSessionId,
    marker: record.marker,
    sentAt: record.sentAt,
    phase: record.phase,
    timeoutMs: record.timeoutMs ?? continuationStartTimeoutMs(),
    ...facts,
  };
}

function dispatchPrepare(
  ctx: ExtensionContext,
  input: Omit<Parameters<typeof createContinuationDispatch>[0], "id" | "sentAt">,
): ContinuationDispatch | null {
  const record: ContinuationDispatch = {
    ...createContinuationDispatch({
      ...input,
      id: `${instanceId}:${input.generation}:${newGoalId()}`,
    }),
    timeoutMs: continuationStartTimeoutMs(),
  };
  // Persist ownership BEFORE asking pi to enqueue the follow-up. If this
  // fails, an accepted send would be impossible to reconcile after a reload.
  if (!persistDispatchRecord(ctx.cwd, record)) {
    continuationDispatchStoodDown = true;
    appendLedger(ctx.cwd, "continuation_dispatch_persistence_failed", { id: record.id, phase: record.phase, generation: record.generation });
    ctx.ui.notify("glla: could not persist the continuation dispatch record, so no automatic turn was sent. Fix .pi-glla storage, then resume explicitly.", "error");
    return null;
  }
  pendingContinuationDispatch = record;
  appendLedger(ctx.cwd, "continuation_dispatch_prepared", dispatchLedgerValue(record, {
    acknowledgement: "pending",
    startProofSource: null,
    settlement: "pending",
    resync: record.resync,
  }));
  return record;
}

function dispatchFailed(ctx: ExtensionContext, record: ContinuationDispatch, reason: string): void {
  if (pendingContinuationDispatch !== record) return;
  const settledAt = Date.now();
  const failed: ContinuationDispatch = {
    ...transitionDispatch(record, "failed"),
    settledAt,
  };
  pendingContinuationDispatch = failed;
  persistDispatchRecord(ctx.cwd, failed);
  appendLedger(ctx.cwd, "continuation_dispatch_failed", dispatchLedgerValue(failed, {
    acknowledgement: "rejected",
    startProofSource: null,
    settlement: "failed",
    settledAt,
    reason,
  }));
  clearContinuationStartWatchdog();
}

function dispatchStartAcknowledged(ctx: ExtensionContext, source: string, prompt?: unknown): boolean {
  const record = pendingContinuationDispatch;
  if (!record || sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) return false;
  if (record.generation !== sessionGeneration || isForeignCtx(ctx)) return false;
  if (!dispatchMatchesOwner(record, sessionGeneration, sessionManagerId(ctx))) return false;
  // before_agent_start is the strongest proof: it must carry this exact
  // dispatch marker. Later low-level events are accepted as compatibility
  // proofs because older pi builds may not expose the prompt there.
  if (source === "before_agent_start" && !dispatchPromptMatches(record, prompt)) return false;
  const settledAt = Date.now();
  const started: ContinuationDispatch = {
    ...transitionDispatch(record, "started"),
    startedAt: settledAt,
    settledAt,
    startProofSource: source,
  };
  pendingContinuationDispatch = started;
  persistDispatchRecord(ctx.cwd, started);
  clearContinuationStartWatchdog();
  clearCompactionRearms(record.id);
  clearDispatchRecord(ctx.cwd);
  lastContinuationSentAt = 0;
  if (record.resync) postCompactResyncPending = false;
  noteActivity(true);
  appendLedger(ctx.cwd, "continuation_start_acknowledged", dispatchLedgerValue(started, {
    acknowledgement: "accepted",
    startProofSource: source,
    settlement: "started",
    startedAt: started.startedAt,
    settledAt,
  }));
  return true;
}

function dispatchStartUnacknowledged(ctx: ExtensionContext, record: ContinuationDispatch): void {
  if (pendingContinuationDispatch !== record || record.phase !== "accepted") return;
  const timedOutAt = Date.now();
  const unacknowledged: ContinuationDispatch = {
    ...transitionDispatch(record, "unacknowledged"),
    timedOutAt,
    settledAt: timedOutAt,
  };
  persistDispatchRecord(ctx.cwd, unacknowledged);
  clearContinuationStartWatchdog();
  continuationDispatchStoodDown = true;
  lastContinuationSentAt = 0;
  const reason = `continuation start acknowledgement timed out (${record.id})`;
  appendLedger(ctx.cwd, "continuation_start_unacknowledged", dispatchLedgerValue(unacknowledged, {
    acknowledgement: "accepted",
    startProofSource: null,
    settlement: "unacknowledged",
    timedOutAt,
    settledAt: timedOutAt,
  }));
  if (record.kind === "loop" && state.loop?.active) {
    clearLoopTimer();
    state.loop = {
      ...state.loop,
      active: false,
      stopReason: `stalled: continuation start acknowledgement timed out (${record.id}) — /loop resume to retry explicitly`,
    };
    persistState(ctx);
  }
  if (state.goal && state.goal.status === "active" && (record.kind === "goal" || record.kind === "stall")) {
    updateGoal({ interruptedAt: nowIso(), interruptedReason: reason }, ctx);
  }
  const msg = `glla: pi accepted the ${dispatchLabel(record)} continuation, but no observable turn-start event arrived within ${Math.round(continuationStartTimeoutMs() / 1000)}s. Automatic re-sends are stopped to avoid a blind queue storm. The work is safe in .pi-glla; start a fresh session or use /goal resume, /list resume, or /loop resume to retry explicitly.`;
  ctx.ui.notify(msg, "warning");
  notifyExternal(ctx, sanitizeDisplayText(msg));
  refreshUI(ctx);
}

function armContinuationStartWatchdog(ctx: ExtensionContext, record: ContinuationDispatch): void {
  if (pendingContinuationDispatch !== record || record.phase !== "accepted") return;
  if (continuationStartTimer) clearTimeout(continuationStartTimer);
  const generation = record.generation;
  continuationStartTimer = scheduleSessionTimeout(() => {
    continuationStartTimer = null;
    if (pendingContinuationDispatch !== record || record.phase !== "accepted") return;
    const current = freshCtxForGeneration(generation);
    if (!current) return;
    // v0.34.57: a compaction that landed AFTER the dispatch was accepted is
    // legitimate busy time — the session is mid-compact and the turn-start
    // event will arrive after the compact + resume debt. Re-arm the watchdog
    // instead of firing the false-positive unacknowledged warning. The 3-min
    // compactionGraceUntil alone misses compactions that finish within or
    // past the grace window (field 115855/115858/115901).
    if (lastCompactionAt > (record.acceptedAt ?? 0)) {
      const rearms = noteCompactionRearm(record.id);
      appendLedger(current.cwd, "continuation_start_paused_for_compaction", dispatchLedgerValue(record, {
        lastCompactionAt,
        acceptedAt: record.acceptedAt ?? 0,
        rearmCount: rearms,
        capped: rearms >= COMPACTION_REARM_CAP,
      }));
      if (rearms < COMPACTION_REARM_CAP) {
        armContinuationStartWatchdog(current, record);
        return;
      }
      // Cap reached: fall through to the unacknowledged warning so the
      // user can intervene. A stuck session must not loop forever.
    }
    if (dispatchTimedOut(record, Date.now(), record.timeoutMs ?? continuationStartTimeoutMs())) {
      dispatchStartUnacknowledged(current, record);
    }
  }, record.timeoutMs ?? continuationStartTimeoutMs());
}

function dispatchAccepted(ctx: ExtensionContext, record: ContinuationDispatch): boolean {
  // A synchronous before_agent_start can acknowledge while sendMessage is
  // still on the stack. Do not overwrite that proof with "accepted".
  if (pendingContinuationDispatch !== record) return true;
  const acceptedAt = Date.now();
  const accepted: ContinuationDispatch = {
    ...transitionDispatch(record, "accepted"),
    acceptedAt,
  };
  pendingContinuationDispatch = accepted;
  appendLedger(ctx.cwd, "continuation_dispatch_accepted", dispatchLedgerValue(accepted, {
    acknowledgement: "accepted",
    startProofSource: null,
    settlement: "pending",
    acceptedAt,
  }));
  if (!persistDispatchRecord(ctx.cwd, accepted)) {
    dispatchStartUnacknowledged(ctx, accepted);
    return false;
  }
  armContinuationStartWatchdog(ctx, accepted);
  return true;
}

function releaseContinuationDispatchStandDown(): void {
  continuationDispatchStoodDown = false;
  clearContinuationStartWatchdog();
}

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
  if (queueStuckProbe) { clearTimeout(queueStuckProbe); queueStuckProbe = null; }
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

function clearMainModelRecoveryTimer(): void {
  if (mainModelRecoveryTimer) {
    clearTimeout(mainModelRecoveryTimer);
    mainModelRecoveryTimer = null;
  }
}

function mainModelFallbackRefs(ctx: ExtensionContext): string[] {
  try { return normalizeModelRefs(loadGlobalSettings().mainModelFallbacks); } catch { return []; }
}

function mainModelRecoveryActive(): boolean { return !!state.mainModelRecovery?.retryAt; }

function mainModelRecoveryKind(): "goal" | "loop" { return state.loop?.active ? "loop" : "goal"; }

function mainModelRecoveryReason(failure: MainModelFailure): string {
  const detail = failure.raw.replace(/\s+/g, " ").trim().slice(0, 180);
  return `main model ${failure.kind}${detail ? `: ${detail}` : " failure"}`;
}

function withMainModelRecoveryWindow(recovery: MainModelRecovery, now = Date.now()): MainModelRecovery {
  const firstMs = recovery.firstFailureAt ? Date.parse(recovery.firstFailureAt) : Number.NaN;
  const firstFailureAt = Number.isFinite(firstMs) ? recovery.firstFailureAt : new Date(now).toISOString();
  const untilMs = recovery.autoRetryUntil ? Date.parse(recovery.autoRetryUntil) : Number.NaN;
  const autoRetryUntil = Number.isFinite(untilMs) && untilMs > (Number.isFinite(firstMs) ? firstMs : now)
    ? recovery.autoRetryUntil
    : mainModelAutoRetryUntil(Number.isFinite(firstMs) ? firstMs : now, MAIN_MODEL_AUTO_RETRY_HORIZON_MS);
  return { ...recovery, firstFailureAt, autoRetryUntil };
}

function holdMainModelRecovery(ctx: ExtensionContext, recovery: MainModelRecovery, why: string): void {
  const normalized = withMainModelRecoveryWindow(recovery);
  clearMainModelRecoveryTimer();
  clearContinuationTimer();
  clearLoopTimer();
  continuationDispatchStoodDown = true;
  state.mainModelRecovery = { ...normalized, retryAt: undefined, manualResumeRequired: true };
  const resumeCmd = state.goal?.policy === "list" ? "/list resume" : normalized.kind === "loop" ? "/loop resume" : "/goal resume";
  const quotaMarker = /quota|rate.?limit|usage.?limit|token.?plan|plan.?limit/i.test(normalized.reason) ? ` · ${normalized.reason}` : "";
  const pauseReason = `main model recovery — automatic probes stopped (${why})${quotaMarker}`;
  const action = `No automatic provider probes remain. Check the provider reset/billing state or switch /model, then ${resumeCmd} to start a fresh recovery window; ${activeGoalSurfaceCommand("cancel")} stops it.`;
  if (normalized.kind === "goal" && state.goal) {
    updateGoal({
      status: "paused",
      pauseKind: "blocked",
      pauseResumeAt: undefined,
      pauseReason,
      pauseSuggestedAction: action,
    }, ctx);
  } else if (normalized.kind === "loop" && state.loop) {
    state.loop = { ...state.loop, active: false, stopReason: `${pauseReason}; ${resumeCmd} to retry manually` };
    persistState(ctx);
  } else {
    persistState(ctx);
  }
  appendLedger(ctx.cwd, "main_model_recovery_manual_hold", {
    kind: normalized.kind,
    attempts: normalized.attempts,
    autoRetryUntil: normalized.autoRetryUntil,
    resetAt: normalized.resetAt,
    why,
  });
  ctx.ui.notify(`Main-model recovery stopped automatic probes: ${why}. Work is saved; check the provider or switch /model, then ${resumeCmd}.`, "warning");
  notifyExternal(ctx, `Main-model recovery requires manual resume: ${why}.`);
}

/** Resolve a configured provider/model using only the public registry API. */
function resolveMainModel(ctx: ExtensionContext, ref: string): any | undefined {
  const parts = splitModelRef(ref);
  if (!parts) return undefined;
  try { return ctx.modelRegistry?.find?.(parts.provider, parts.id) as any; } catch { return undefined; }
}

/** Select one configured backup before pi's own agent-level retry continues. */
async function tryMainModelFallback(ctx: ExtensionContext, failure: MainModelFailure): Promise<boolean> {
  if (mainModelSwitchInFlight || failure.kind === "non-recoverable") return false;
  const refs = mainModelFallbackRefs(ctx);
  if (refs.length === 0) return false;
  const current = modelRef(ctx.model);
  if (!current) return false;
  const generation = sessionGeneration;
  const existing = state.mainModelRecovery;
  const recovery: MainModelRecovery = withMainModelRecoveryWindow(existing ?? {
    primary: current,
    active: current,
    attempted: [current],
    attempts: 0,
    reason: mainModelRecoveryReason(failure),
    resetAt: failure.resetAt,
    kind: mainModelRecoveryKind(),
  });
  if (!recovery.attempted.includes(current)) recovery.attempted.push(current);
  for (;;) {
    const candidateRef = nextUntriedModelRef(current, refs, recovery.attempted);
    if (!candidateRef) {
      state.mainModelRecovery = { ...recovery, active: current, reason: mainModelRecoveryReason(failure) };
      persistState(ctx);
      return false;
    }
    recovery.attempted.push(candidateRef);
    const candidate = resolveMainModel(ctx, candidateRef);
    if (!candidate) {
      appendLedger(ctx.cwd, "main_model_fallback_unavailable", { ref: candidateRef, reason: "not in the configured model registry" });
      continue;
    }
    mainModelSwitchInFlight = true;
    try {
      const accepted = await extensionApi?.setModel(candidate);
      if (generation !== sessionGeneration || !freshCtxForGeneration(generation)) return false;
      if (!accepted) {
        appendLedger(ctx.cwd, "main_model_fallback_unavailable", { ref: candidateRef, reason: "no configured auth" });
        continue;
      }
      recovery.active = candidateRef;
      recovery.reason = mainModelRecoveryReason(failure);
      recovery.kind = mainModelRecoveryKind();
      state.mainModelRecovery = recovery;
      persistState(ctx);
      appendLedger(ctx.cwd, "main_model_failover", { from: current, to: candidateRef, reason: failure.kind });
      ctx.ui.notify(`Main session model failover: ${current} → ${candidateRef}. The next turn will use the backup; a successful turn clears recovery.`, "warning");
      return true;
    } catch (err) {
      appendLedger(ctx.cwd, "main_model_fallback_unavailable", { ref: candidateRef, reason: err instanceof Error ? err.message : String(err) });
      if (isStaleApiError(err)) extensionApiStale = true;
    } finally {
      mainModelSwitchInFlight = false;
    }
  }
}

function setMainModelRecoveryPause(ctx: ExtensionContext, recovery: MainModelRecovery, delayMs: number): boolean {
  const normalized = withMainModelRecoveryWindow(recovery);
  const now = Date.now();
  const deadlineMs = normalized.autoRetryUntil ? Date.parse(normalized.autoRetryUntil) : Number.NaN;
  const requestedDelayMs = Math.max(1_000, delayMs);
  if (normalized.manualResumeRequired || (Number.isFinite(deadlineMs) && (now >= deadlineMs || now + requestedDelayMs > deadlineMs))) {
    holdMainModelRecovery(ctx, normalized, Number.isFinite(deadlineMs) && now >= deadlineMs
      ? "the 24h automatic recovery horizon was reached"
      : "the automatic recovery horizon would be exceeded");
    return false;
  }
  const retryAt = new Date(now + requestedDelayMs).toISOString();
  const minutes = Math.max(1, Math.round(requestedDelayMs / 60_000));
  state.mainModelRecovery = { ...normalized, retryAt, manualResumeRequired: undefined };
  clearMainModelRecoveryTimer();
  clearContinuationTimer();
  clearLoopTimer();
  continuationDispatchStoodDown = true;
  const resumeCmd = state.goal?.policy === "list" ? "/list resume" : normalized.kind === "loop" ? "/loop resume" : "/goal resume";
  if (normalized.kind === "goal" && state.goal) {
    updateGoal({
      status: "paused",
      pauseKind: "wait",
      pauseResumeAt: retryAt,
      pauseReason: `main model recovery — retrying in ${minutes}m (${normalized.reason})`,
      pauseSuggestedAction: `The provider/quota wall is being retried automatically; configured backup models are tried in order. ${resumeCmd} retries immediately; ${activeGoalSurfaceCommand("cancel")} stops it.`,
    }, ctx);
  } else if (normalized.kind === "loop" && state.loop) {
    state.loop = { ...state.loop, active: false, stopReason: `main model recovery — retrying in ${minutes}m (${normalized.reason}); /loop resume retries immediately` };
    persistState(ctx);
  } else {
    persistState(ctx);
  }
  appendLedger(ctx.cwd, "main_model_recovery_wait", { kind: normalized.kind, retryAt, attempts: normalized.attempts, autoRetryUntil: normalized.autoRetryUntil, resetAt: normalized.resetAt, reason: normalized.reason });
  ctx.ui.notify(`Main model recovery: ${normalized.reason}. Trying again in ${minutes}m; work is saved and will not be abandoned.`, "warning");
  notifyExternal(ctx, `Main model recovery scheduled in ${minutes}m — work remains saved.`);
  return true;
}

function scheduleMainModelRecoveryTimer(ctx: ExtensionContext, delayMs: number): void {
  const generation = sessionGeneration;
  clearMainModelRecoveryTimer();
  mainModelRecoveryTimer = scheduleSessionTimeout(() => {
    mainModelRecoveryTimer = null;
    const fresh = freshCtxForGeneration(generation);
    if (!fresh || !state.mainModelRecovery) return;
    void probeMainModelRecovery(fresh).catch((err) => { if (isStaleApiError(err)) extensionApiStale = true; });
  }, Math.max(1_000, delayMs));
  void ctx;
}

/** An explicit resume is consent to start a fresh automatic window after the
 * five-hour/24-hour safety hold. It does not silently reset the window during
 * reload or heartbeat recovery. */
function manuallyResumeMainModelRecovery(ctx: ExtensionContext): boolean {
  const recovery = state.mainModelRecovery;
  if (!recovery?.manualResumeRequired) return false;
  const current = modelRef(ctx.model);
  const now = Date.now();
  state.mainModelRecovery = {
    ...recovery,
    active: current ?? recovery.active,
    attempted: current ? [current] : [],
    attempts: 0,
    firstFailureAt: new Date(now).toISOString(),
    autoRetryUntil: mainModelAutoRetryUntil(now, MAIN_MODEL_AUTO_RETRY_HORIZON_MS),
    retryAt: undefined,
    manualResumeRequired: undefined,
    resumeCurrent: undefined,
  };
  clearMainModelRecoveryTimer();
  continuationDispatchStoodDown = false;
  persistState(ctx);
  ctx.ui.notify("Manual resume starts a fresh bounded main-model recovery window — one provider probe, then configured backups if needed.", "info");
  void probeMainModelRecovery(ctx);
  return true;
}

async function probeMainModelRecovery(ctx: ExtensionContext): Promise<void> {
  const generation = sessionGeneration;
  const recovery = state.mainModelRecovery;
  if (!recovery) return;
  const current = modelRef(ctx.model);
  const refs = [recovery.primary, ...mainModelFallbackRefs(ctx)];
  if (recovery.resumeCurrent && current) {
    state.mainModelRecovery = { ...recovery, active: current, attempted: [current], retryAt: undefined, resumeCurrent: undefined };
    continuationDispatchStoodDown = false;
    if (recovery.kind === "goal" && state.goal?.status === "paused" && (state.goal.pauseReason ?? "").startsWith("main model recovery")) {
      updateGoal({ status: "active", pauseResumeAt: undefined, pauseReason: undefined, pauseSuggestedAction: undefined }, ctx);
      scheduleContinuation(ctx, true, 1_000);
    } else if (recovery.kind === "loop" && state.loop && !state.loop.active && (state.loop.stopReason ?? "").startsWith("main model recovery")) {
      state.loop = { ...state.loop, active: true, stopReason: undefined };
      persistState(ctx);
      scheduleLoopTick(ctx);
    }
    appendLedger(ctx.cwd, "main_model_probe", { from: current, to: current, attempts: recovery.attempts, mode: "resume-backup" });
    ctx.ui.notify(`Main model recovery probe: continuing on ${current}; primary will be tested after this supervised turn.`, "info");
    return;
  }
  const target = refs.find((ref) => ref !== current);
  if (!target) {
    if (!current) {
      const delay = mainModelRetryDelayMs(recovery.attempts + 1, loadGlobalSettings().mainModelRetryMinutes);
      if (setMainModelRecoveryPause(ctx, { ...withMainModelRecoveryWindow(recovery), attempts: recovery.attempts + 1, attempted: [] }, delay)) {
        scheduleMainModelRecoveryTimer(ctx, delay);
      }
      return;
    }
    // No backup is configured (or every backup has already been tried):
    // retry the currently selected model itself. This is the critical probe
    // that notices a quota window returning after an otherwise quiet hour.
    state.mainModelRecovery = { ...recovery, active: current, attempted: [current], retryAt: undefined, resumeCurrent: undefined };
    continuationDispatchStoodDown = false;
    if (recovery.kind === "goal" && state.goal?.status === "paused" && (state.goal.pauseReason ?? "").startsWith("main model recovery")) {
      updateGoal({ status: "active", pauseResumeAt: undefined, pauseReason: undefined, pauseSuggestedAction: undefined }, ctx);
      scheduleContinuation(ctx, true, 1_000);
    } else if (recovery.kind === "loop" && state.loop && !state.loop.active && (state.loop.stopReason ?? "").startsWith("main model recovery")) {
      state.loop = { ...state.loop, active: true, stopReason: undefined };
      persistState(ctx);
      scheduleLoopTick(ctx);
    }
    appendLedger(ctx.cwd, "main_model_probe", { from: current, to: current, attempts: recovery.attempts });
    ctx.ui.notify(`Main model recovery probe: retrying ${current} without rotating models.`, "info");
    return;
  }
  const candidate = resolveMainModel(ctx, target);
  if (!candidate) {
    appendLedger(ctx.cwd, "main_model_fallback_unavailable", { ref: target, reason: "recovery probe not in registry" });
    const delay = mainModelRetryDelayMs(recovery.attempts + 1, loadGlobalSettings().mainModelRetryMinutes);
    if (setMainModelRecoveryPause(ctx, { ...withMainModelRecoveryWindow(recovery), attempts: recovery.attempts + 1, attempted: [...(current ? [current] : []), target] }, delay)) {
      scheduleMainModelRecoveryTimer(ctx, delay);
    }
    return;
  }
  mainModelSwitchInFlight = true;
  try {
    const accepted = await extensionApi?.setModel(candidate);
    if (generation !== sessionGeneration || !freshCtxForGeneration(generation)) return;
    if (!accepted) throw new Error(`no configured auth for ${target}`);
    state.mainModelRecovery = { ...recovery, active: target, attempted: current ? [current, target] : [target], retryAt: undefined };
    persistState(ctx);
    appendLedger(ctx.cwd, "main_model_probe", { from: current, to: target, attempts: recovery.attempts });
    continuationDispatchStoodDown = false;
    if (recovery.kind === "goal" && state.goal?.status === "paused" && (state.goal.pauseReason ?? "").startsWith("main model recovery")) {
      updateGoal({ status: "active", pauseResumeAt: undefined, pauseReason: undefined, pauseSuggestedAction: undefined }, ctx);
      scheduleContinuation(ctx, true, 1_000);
    } else if (recovery.kind === "loop" && state.loop && !state.loop.active && (state.loop.stopReason ?? "").startsWith("main model recovery")) {
      state.loop = { ...state.loop, active: true, stopReason: undefined };
      persistState(ctx);
      scheduleLoopTick(ctx);
    }
    ctx.ui.notify(`Main model recovery probe: ${target} selected; sending one supervised probe.`, "info");
  } catch (err) {
    appendLedger(ctx.cwd, "main_model_probe_failed", { ref: target, error: err instanceof Error ? err.message : String(err) });
    const failure = classifyMainModelFailure(err instanceof Error ? err.message : String(err));
    // v0.34.51: no billing special case — every provider failure retries on
    // the uniform durable envelope (credits can be topped up; a miss-classified
    // quota wall must not become a manual-action stop).
    const next = withMainModelRecoveryWindow({ ...recovery, attempts: recovery.attempts + 1, attempted: [...(current ? [current] : []), target], reason: mainModelRecoveryReason(failure), resetAt: failure.resetAt ?? recovery.resetAt });
    // v0.34.58: no quota-only parking — an over-budget upstream reset hint
    // never holds the goal for a manual resume; the bounded envelope owns
    // the wait (mainModelFailureDelayMs falls back to the bounded cadence
    // when the hint exceeds the 5h probe budget).
    const delay = mainModelFailureDelayMs(failure, next.attempts, loadGlobalSettings().mainModelRetryMinutes);
    if (setMainModelRecoveryPause(ctx, next, delay)) scheduleMainModelRecoveryTimer(ctx, delay);
  } finally {
    mainModelSwitchInFlight = false;
  }
}

function parkMainModelAfterFailure(ctx: ExtensionContext, failure: MainModelFailure): void {
  if (!isSupervising() || mainModelRecoveryActive()) return;
  const current = modelRef(ctx.model);
  if (!current) return;
  const existing = withMainModelRecoveryWindow(state.mainModelRecovery ?? {
    primary: current,
    active: current,
    attempted: [current],
    attempts: 0,
    reason: mainModelRecoveryReason(failure),
    resetAt: failure.resetAt,
    kind: mainModelRecoveryKind(),
  } satisfies MainModelRecovery);
  const nextRecovery = withMainModelRecoveryWindow({
    ...existing,
    active: current,
    attempts: existing.attempts + 1,
    reason: mainModelRecoveryReason(failure),
    resetAt: failure.resetAt ?? existing.resetAt,
  });
  // v0.34.58: uniform envelope even for over-budget upstream hints — the
  // goal never parks on a quota-only manual hold; the bounded cadence owns
  // the wait and the 24h horizon ends automatic probes (kind-independent).
  const delay = mainModelFailureDelayMs(failure, nextRecovery.attempts, loadGlobalSettings().mainModelRetryMinutes);
  if (!setMainModelRecoveryPause(ctx, nextRecovery, delay)) return;
  mainModelAbortForRecovery = true;
  try { ctx.abort(); } catch { /* abort is best effort; the recovery guard prevents re-send storms */ }
  scheduleMainModelRecoveryTimer(ctx, delay);
  // v0.34.58 (bug #1.15): only quota walls get the hourly resume prompt;
  // billing/auth/transient have different reset semantics and must not
  // promise a top-of-hour refresh. Detection delegates to the goal-loop-core
  // detector (isQuotaWallError) — the same recognition the tests pin.
  if (isQuotaWallError(failure.raw)) scheduleQuotaResumePrompt(ctx, failure);
}

// v0.34.58 (bug #1.15) — hourly quota-resume prompter implementation.
// The schedule is a one-shot timer to the next :00; firing sends exactly one
// sendUserMessage with the original turn context (objective/target + failure
// detail, captured at schedule time — never re-read at fire time). The
// session-generation guard on scheduleSessionTimeout means a reload that
// lands before :00 simply drops the prompt instead of firing stale.

function clearQuotaPromptTimer(): void {
  if (quotaPromptTimer) {
    clearTimeout(quotaPromptTimer);
    quotaPromptTimer = null;
  }
}

/** The original turn context: what the session was doing when the wall hit. */
function quotaPromptTurnContext(failure: MainModelFailure): string {
  const identity = state.goal
    ? `goal: ${state.goal.objective}`
    : state.loop?.active
      ? `loop: ${state.loop.target}`
      : "the active session";
  return `${identity} — ${mainModelRecoveryReason(failure)}`;
}

/** Fire the pending prompt (the timer callback and the __testOnly hook share
 * this one code path). Consumes the schedule exactly once; a fire with no
 * pending schedule, or after recovery already succeeded, is a silent no-op.
 * The ONLY side effects are the ledger entry and the sendUserMessage — the
 * parked goal stays parked (no self-resume, ever). */
function fireQuotaResumePrompt(): void {
  clearQuotaPromptTimer();
  const ctx = quotaPromptCtx;
  const fireAt = quotaPromptScheduledFor;
  const context = quotaPromptContext;
  quotaPromptCtx = null;
  quotaPromptScheduledFor = null;
  quotaPromptContext = null;
  quotaPromptFired = true;
  if (!ctx || fireAt === null || context === null) return;
  if (!state.mainModelRecovery) return; // wall already lifted — nothing to prompt
  const resumeCmd = state.goal?.policy === "list" ? "/list resume" : state.loop?.active ? "/loop resume" : "/goal resume";
  appendLedger(ctx.cwd, "quota_prompt_sent", { fireAt: new Date(fireAt).toISOString(), at: new Date().toISOString() });
  safeSteerUser(
    ctx,
    `Provider quota wall — ${context}. Hourly quota windows usually refresh at the top of the hour: run ${resumeCmd} (or just reply) to pick the work back up.`,
  );
}

/** Schedule exactly one prompt at the next :00 with the original turn
 * context. Gated on autoResume: true; a schedule already pending for this
 * session is never replaced or duplicated. */
function scheduleQuotaResumePrompt(ctx: ExtensionContext, failure: MainModelFailure): void {
  if (loadGlobalSettings().autoResume !== true) return; // gated — no prompt without autoResume
  if (quotaPromptScheduledFor !== null) return; // exactly one pending schedule
  const now = quotaPromptClockOverride ?? Date.now();
  const fireAt = nextHourlyPromptMs(now);
  quotaPromptScheduledFor = fireAt;
  quotaPromptContext = quotaPromptTurnContext(failure);
  quotaPromptCtx = ctx;
  quotaPromptFired = false;
  appendLedger(ctx.cwd, "quota_prompt_scheduled", {
    fireAt: new Date(fireAt).toISOString(),
    at: new Date(now).toISOString(),
    kind: state.loop?.active ? "loop" : "goal",
    reason: mainModelRecoveryReason(failure),
  });
  clearQuotaPromptTimer();
  quotaPromptTimer = scheduleSessionTimeout(() => {
    fireQuotaResumePrompt();
  }, Math.max(1_000, fireAt - now));
}

async function recoverMainModelFromSendStorm(ctx: ExtensionContext, kind: "continuation" | "loop"): Promise<void> {
  if (!isSupervising() || mainModelRecoveryActive()) return;
  const failure = classifyMainModelFailure("429 rate limit: pi held the provider retry with no stream activity");
  lastLongLivedFailureAt = Date.now();
  const switched = await tryMainModelFallback(ctx, failure);
  if (switched) {
    const current = modelRef(ctx.model);
    if (!current) return;
    const recovery = state.mainModelRecovery;
    if (!recovery) return;
    if (setMainModelRecoveryPause(ctx, { ...recovery, kind: kind === "loop" ? "loop" : "goal", active: current, resumeCurrent: true }, 1_000)) {
      mainModelAbortForRecovery = true;
      try { ctx.abort(); } catch { /* best effort; recovery guard prevents re-send storms */ }
      scheduleMainModelRecoveryTimer(ctx, 1_000);
    }
    return;
  }
  parkMainModelAfterFailure(ctx, failure);
}

function mainModelRecoverySucceeded(ctx: ExtensionContext): void {
  const recovery = state.mainModelRecovery;
  if (!recovery) return;
  clearMainModelRecoveryTimer();
  clearQuotaPromptTimer(); // v0.34.58: a wall that lifted before :00 must not prompt
  quotaPromptScheduledFor = null;
  quotaPromptContext = null;
  state.mainModelRecovery = undefined;
  lastMainModelFailure = null;
  mainModelAbortForRecovery = false;
  continuationDispatchStoodDown = false;

  // A pi-core retry can succeed after glla has already parked the goal. The
  // old code cleared only the recovery record, leaving the goal durably
  // paused (the next screenshot then looked like a stale QUOTA WALL). Resume
  // only our own recovery wait — never a user decision/error pause.
  const recoveryPause = state.goal
    && state.goal.status === "paused"
    && state.goal.pauseKind === "wait"
    && (state.goal.pauseReason ?? "").startsWith("main model recovery —");
  const recoveryLoop = state.loop
    && !state.loop.active
    && (state.loop.stopReason ?? "").startsWith("main model recovery —");
  const resumed = recovery.kind === "goal" && recoveryPause
    ? "goal"
    : recovery.kind === "loop" && recoveryLoop
      ? "loop"
      : undefined;
  appendLedger(ctx.cwd, "main_model_recovered", { model: modelRef(ctx.model), attempts: recovery.attempts, resumed });
  if (resumed === "goal") {
    updateGoal({ status: "active", pauseKind: undefined, pauseResumeAt: undefined, pauseReason: undefined, pauseSuggestedAction: undefined }, ctx);
    scheduleContinuation(ctx, true, 1_000);
  } else if (resumed === "loop") {
    state.loop = { ...state.loop!, active: true, stopReason: undefined };
    persistState(ctx);
    scheduleLoopTick(ctx);
  } else {
    persistState(ctx);
  }
  ctx.ui.notify(`Main session model recovered on ${modelRef(ctx.model) ?? "the active model"}; automatic recovery is cleared${resumed ? ` and the ${resumed} is resuming` : ""}.`, "info");
}

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

// v0.34.15 (hegemon 2026-08-01): pi ACCEPTED the continuation — footer showed
// "1 queued" — but the turn trigger was dead, so the message sat queued while
// pi idled. The 0.34.11 watchdog gates on "pi reported NO pending" and the
// stall ladder takes ~10 minutes; a send that lands queued-without-a-turn is
// a CONFIRMED dead trigger (hegemon law), so probe once, ~45s after every
// landed send, and report it without terminal input. A consumed message (even
// an instant-429 turn consumes it) or any real activity disarms the probe.
function queueStuckProbeMs(): number {
  return Number(process.env.GLLA_QUEUE_STUCK_MS ?? 45_000);
}
let queueStuckProbe: ReturnType<typeof setTimeout> | null = null;
function armQueueStuckProbe(sentAt: number): void {
  if (queueStuckProbe) clearTimeout(queueStuckProbe);
  queueStuckProbe = scheduleSessionTimeout(() => {
    queueStuckProbe = null;
    try {
      const ctx = freshCtx();
      if (!ctx) return; // no fresh lifecycle context — do not touch a stale one
      if (!isSupervising()) return; // paused/completed meanwhile
      if (lastContinuationSentAt !== sentAt) return; // a newer send armed its own probe
      if (lastRealActivityAt > sentAt) return; // the turn started and worked
      if (!ctx.isIdle()) return; // a turn is running — healthy
      if (!ctx.hasPendingMessages()) return; // consumed — even an instant 429 consumes
      appendLedger(ctx.cwd, "queue_stuck_detected", { waitedMs: Date.now() - sentAt });
      const msg = `${goalNoun()}: the continuation is QUEUED but pi won't start a turn — the turn trigger is dead (re-sends only queue). glla will resume from a fresh session_start; if no replacement arrives, restart pi normally and restore the saved work.`;
      ctx.ui.notify(msg, "warning");
      notifyExternal(ctx, msg);
    } catch { /* stale ctx — the live instance owns the probe now */ }
  }, queueStuckProbeMs());
}

function scheduleContinuation(ctx: ExtensionContext, force = false, delayMs?: number): void {
  if (mainModelRecoveryActive()) return;
  if (sessionHandoffPending || initialSessionLoadPending || extensionApiStale || staleTerminalDone || zombieStoodDown) return;
  if (pendingContinuationDispatch) return;
  if (continuationDispatchStoodDown && !force) return;
  if (force) releaseContinuationDispatchStandDown();
  abortedStandDown = false; // v0.29.5: any explicit schedule ends the stand-down
  if (!isActionableGoal()) return;
  rememberCtx(ctx);
  const goalId = state.goal!.id;
  if (!force && continuationScheduledFor === goalId) return;
  clearContinuationTimer();
  let delay = 0;
  try {
    delay = delayMs ?? (ctx.isIdle() && !ctx.hasPendingMessages() ? 0 : BACKOFF_IDLE_RETRY_MS);
  } catch {
    return;
  }
  continuationScheduledFor = goalId;
  continuationTimer = scheduleSessionTimeout(() => sendContinuation(goalId), delay);
}

function sendContinuation(goalId: string): void {
  if (mainModelRecoveryActive()) return;
  if (sessionHandoffPending || initialSessionLoadPending || extensionApiStale || staleTerminalDone || zombieStoodDown || continuationDispatchStoodDown || pendingContinuationDispatch) return;
  continuationTimer = null;
  continuationScheduledFor = null;
  if (!isActionableGoal()) return;
  const ctx = freshCtx();
  if (!ctx) {
    // v0.32.0: a stale handle must not spin a flat 50ms re-arm below every
    // watchdog — the heartbeat's terminal path does the theatre; we just stop.
    if (probeExtensionApiStale()) return;
    // No live ctx — retry shortly; the next session event will refresh it.
    continuationScheduledFor = goalId;
    continuationTimer = scheduleSessionTimeout(() => sendContinuation(goalId), BACKOFF_IDLE_RETRY_MS);
    return;
  }
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    accountSendRearm(ctx, "continuation");
    continuationScheduledFor = goalId;
    // v0.28.29: backing-off cadence (was flat 50ms — 6,000 spins in 5m).
    continuationTimer = scheduleSessionTimeout(() => sendContinuation(goalId), sendRearmDelayMs(continuationRearmStreak));
    return;
  }
  if (!extensionApi || extensionApiStale) return;
  try {
    let resync = "";
    // v0.33.1: a builder throw (corrupt restored state) must not masquerade
    // as a transport failure — send without the block instead.
    if (postCompactResyncPending) { try { resync = buildPostCompactResync(); } catch { resync = ""; } }
    const attempt = dispatchPrepare(ctx, {
      generation: sessionGeneration,
      ownerSessionId: sessionManagerId(ctx),
      kind: "goal",
      goalId,
      marker: `[GOAL CHECKPOINT goalId=${goalId}]`,
      resync: Boolean(resync),
    });
    if (!attempt) return;
    extensionApi.sendMessage({
      customType: GOAL_EVENT_ENTRY,
      content: resync + continuationPrompt(state.goal!),
      display: false,
    }, { triggerTurn: true, deliverAs: "followUp" });
    if (!dispatchAccepted(ctx, attempt)) return;
    continuationRearmStreak = 0; continuationRearmSince = 0; // v0.28.5 (E3): an accepted dispatch clears the storm
    appendLedger(ctx.cwd, "goal_continuation_sent", { goalId, attemptId: attempt.id, generation: attempt.generation });
    if (pendingContinuationDispatch === null) return; // before_agent_start acked synchronously
    lastContinuationSentAt = attempt.sentAt;
    armQueueStuckProbe(lastContinuationSentAt);
  } catch (err) {
    if (pendingContinuationDispatch) dispatchFailed(ctx, pendingContinuationDispatch, err instanceof Error ? err.message : String(err));
    appendLedger(ctx.cwd, "goal_continuation_send_failed", { goalId, error: err instanceof Error ? err.message : String(err) });
    // v0.26.7: stale runtime = terminal (sends can never land); anything
    // else is transient — next agent_end/session_start reschedules.
    if (isStaleApiError(err)) goStaleTerminal(ctx, "sendContinuation");
  }
}

// v0.28.4 (P1): graduated escalation entry — sent at nudge 1 and 2, BEFORE
// the HEARTBEAT_MAX_NUDGES brake can pause the goal. Tells the model exactly
// what closes the turn: complete_goal if done, pause_goal if blocked, a tool
// call otherwise. display: true — the user should see the warning too.
function sendStallEscalation(ctx: ExtensionContext, nudges: number): void {
  if (sessionHandoffPending || initialSessionLoadPending || !extensionApi || extensionApiStale || continuationDispatchStoodDown || pendingContinuationDispatch) return;
  const remaining = HEARTBEAT_MAX_NUDGES - nudges;
  const text = [
    `[STALL WARNING ${nudges}/${HEARTBEAT_MAX_NUDGES}] The last turn produced no tool calls.`,
    "If the goal is DONE, call complete_goal NOW — prose closes nothing; only an auditor-approved complete_goal call closes a goal.",
    "If you are BLOCKED, call pause_goal with the blocker and a suggested action.",
    "Otherwise make a tool call that advances the goal this turn.",
    remaining === 1 ? "ONE more unproductive turn pauses the goal." : `${remaining} more unproductive turns pause the goal.`,
  ].join(" ");
  appendLedger(ctx.cwd, "stall_escalation_nudge", { nudges, remaining });
  const attempt = dispatchPrepare(ctx, {
    generation: sessionGeneration,
    ownerSessionId: sessionManagerId(ctx),
    kind: "stall",
    goalId: state.goal?.id,
    marker: `[STALL WARNING ${nudges}/${HEARTBEAT_MAX_NUDGES}]`,
    resync: false,
  });
  if (!attempt) return;
  try {
    extensionApi.sendMessage({ customType: GOAL_EVENT_ENTRY, content: text, display: true }, { triggerTurn: true, deliverAs: "followUp" });
    if (!dispatchAccepted(ctx, attempt)) return;
    appendLedger(ctx.cwd, "stall_escalation_dispatched", { nudges, remaining, attemptId: attempt.id });
    if (pendingContinuationDispatch === null) return;
    lastContinuationSentAt = attempt.sentAt;
    armQueueStuckProbe(lastContinuationSentAt);
  } catch (err) {
    if (pendingContinuationDispatch) dispatchFailed(ctx, pendingContinuationDispatch, err instanceof Error ? err.message : String(err));
    appendLedger(ctx.cwd, "stall_escalation_nudge_failed", { error: err instanceof Error ? err.message : String(err) });
    if (isStaleApiError(err)) goStaleTerminal(ctx, "sendStallEscalation");
  }
}

// v0.27.2: send the truncation-continue nudge. Same guards as
// sendContinuation (stale api = terminal), independent of goal state —
// plain sessions truncate too.
function sendLengthContinue(ctx: ExtensionContext, consecutive: number): void {
  if (sessionHandoffPending || initialSessionLoadPending || !extensionApi || extensionApiStale || continuationDispatchStoodDown || pendingContinuationDispatch) return;
  const attempt = dispatchPrepare(ctx, {
    generation: sessionGeneration,
    ownerSessionId: sessionManagerId(ctx),
    kind: "length",
    marker: LENGTH_CONTINUE_TEXT.slice(0, 80),
    resync: false,
  });
  if (!attempt) return;
  try {
    extensionApi.sendMessage({
      customType: GOAL_EVENT_ENTRY,
      content: LENGTH_CONTINUE_TEXT,
      display: true,
    }, { triggerTurn: true, deliverAs: "followUp" });
    if (!dispatchAccepted(ctx, attempt)) return;
    appendLedger(ctx.cwd, "length_continue_sent", { consecutive, attemptId: attempt.id });
    ctx.ui.notify(`Response hit the output-token cap — auto-continuing (${consecutive}/${LENGTH_CONTINUE_MAX})`, "warning");
  } catch (err) {
    if (pendingContinuationDispatch) dispatchFailed(ctx, pendingContinuationDispatch, err instanceof Error ? err.message : String(err));
    appendLedger(ctx.cwd, "length_continue_send_failed", { consecutive, error: err instanceof Error ? err.message : String(err) });
    if (isStaleApiError(err)) goStaleTerminal(ctx, "sendLengthContinue");
  }
}

/** v0.32.1: deterministic post-compaction re-anchor (pi-goal-x's #5) —
 * prepended to the first continuation/loop message after a compact. */
function buildPostCompactResync(): string {
  const lines: string[] = [
    "[POST-COMPACTION RESYNC] The transcript was just compacted. Trust the artifacts on disk and .pi-glla/ state — NOT your memory of the prior chat. Re-read files before editing them.",
  ];
  if (state.goal) {
    lines.push(`Goal ${state.goal.id} — status ${state.goal.status}`);
    lines.push(`Objective: ${state.goal.objective.slice(0, 200)}`);
    const next = findNextPendingTask(state.goal.taskList?.tasks ?? []);
    if (next) lines.push(`Next pending task: \`${next.id}\` — ${next.title}`);
    const lastAudit = state.goal.auditHistory?.[state.goal.auditHistory.length - 1];
    if (lastAudit) lines.push(`Last audit: ${auditVerdictLabel(lastAudit).toUpperCase()} (${lastAudit.at})`);
  } else if (state.loop?.active) {
    lines.push(`Loop: ${state.loop.target.slice(0, 160)} — iteration ${state.loop.iteration}`);
  }
  return lines.join("\n") + "\n\n";
}

function continuationPrompt(goal: Goal): string {
  // Read the .md file as the template, then substitute {{tokens}}.
  // For v0.1.0 we inline-substitute so we don't need fs at runtime.
  const next = findNextPendingTask(goal.taskList?.tasks ?? []);
  const nextBlock = next
    ? `**Next pending task**: \`${next.id}\` — ${next.title}`
    : "**Next pending task**: (none — only call complete_goal when the objective is satisfied)";
  const taskSummary = goal.taskList?.tasks.length
    ? buildTaskSummary(goal.taskList.tasks)
    : "(no task list)";
  const tmplPath = path.resolve(__dirname, "..", "..", "prompts", "goal-loop-continuation.md");
  let tmpl: string;
  try {
    tmpl = fs.readFileSync(tmplPath, "utf-8");
  } catch {
    tmpl = "[template-not-found]";
  }
  // v0.25.0 (contract items 22/28): conditional directives — aggressiveMode
  // TODOs from the audit cap, and the full-audit fan-out directive when the
  // objective reads as a survey pivot.
  const directives: string[] = [];
  const effSettings = resolveEffectiveAggressiveSettings(loadSettings(freshCtx()?.cwd ?? process.cwd()));
  if (goal.pendingTasks && goal.pendingTasks.length > 0) {
    directives.push(
      `## AUDITOR TODO LIST (from ${goal.pauseReason?.includes("cap") ? "the disapproval cap" : "the last audit"})\n\nAddress these objections, in order, before re-calling complete_goal:\n${goal.pendingTasks.map((t, i) => `${i + 1}. ${t}`).join("\n")}`,
    );
  }
  if (effSettings.aggressiveMode && isFullAuditObjective(goal.objective)) {
    directives.push(
      "## FULL-AUDIT MODE (aggressiveMode + survey objective)\n\nThis objective is a survey, not a single fix. Spawn 3+ `Explore` subagents NOW — one per subsystem, in a single message so they run in parallel — synthesize their findings, and call `propose_task_list` with the result. Do not start fixing before the task list exists.",
    );
  }
  const dynamicDirectives = directives.length > 0 ? directives.join("\n\n") : "(no active directives)";
  return tmpl
    .replace(/\$\{GOAL_ID\}/g, goal.id)
    .replace(/\$\{OBJECTIVE\}/g, goal.objective)
    .replace(/\$\{VERIFICATION_CONTRACT\}/g, goal.verificationContract || "(none — auditor will decide based on objective)")
    .replace(/\$\{TASK_LIST\}/g, taskSummary)
    .replace(/\$\{NEXT_PENDING_TASK_BLOCK\}/g, nextBlock)
    .replace(/\$\{DYNAMIC_DIRECTIVES\}/g, dynamicDirectives);
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
  // Persist explicit null for the optional top-level recovery slot. JSON
  // omits undefined, while readState intentionally merges state snapshots;
  // omission would resurrect an older quota wall after a successful retry.
  // v0.34.57: lastModelRef is carried on the state line so a fresh process
  // can restore it (readState) and the turn-boundary check can catch a
  // changed default model across sessions (bug #1.14).
  appendLedger(ctx.cwd, "state", { goal: state.goal, list: state.list ?? [], loop: state.loop ?? null, mainModelRecovery: state.mainModelRecovery ?? null, lastModelRef: state.lastModelRef });
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

function setGoal(goal: Goal, ctx: ExtensionContext, via = "user"): void {
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
  quotaRetryStreak = 0;
  countedTokenMessages.clear();
  recentActions.length = 0;
  // v0.28.14: never silently orphan a live goal — a paused/active goal
  // being replaced is archived honestly first (the old behavior left it in
  // goals/ but untracked: "older goals lying around leading to confusion").
  if (state.goal && state.goal.id !== goal.id && (state.goal.status === "active" || state.goal.status === "paused")) {
    archiveCurrentGoal(ctx, "aborted", `replaced by goal ${goal.id}`);
  }
  goal.createdVia = via; // v0.28.28: provenance — answerable from the ledger + /glla log
  // v0.34.60: disk-first write order. The active-goal .md lands BEFORE
  // the in-memory state commit, so a stale extension handle (post
  // /reload, torn jsonl, process restart) can recover from disk. The
  // active goal .md path is also where any state.goal.id lookup in a
  // fresh process lands, so writing it first closes the
  // "in-memory knows about a goal the disk does not" gap.
  const file = writeGoalMd(ctx.cwd, goal);
  state = { ...state, goal }; // preserve list AND loop (v0.28.14: the bare reconstruction used to nuke a held/active loop whenever a goal was set)
  state.goal!.activePath = path.relative(ctx.cwd, file) || file;
  persistState(ctx);
  appendLedger(ctx.cwd, "goal_created", { goalId: goal.id, objective: goal.objective, policy: goal.policy, via });
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
    state = { ...state, loop: { ...loop, active: false, stopReason: "auto-arbitrated on session load: the goal was more recent (one active thing)" } };
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
  const queuedText = listQueue().map((i) => i.objective).join("\n");
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

function archiveCurrentGoal(ctx: ExtensionContext, status: Status, stopReason?: string): void {
  releaseContinuationDispatchStandDown();
  clearDispatchRecord(ctx.cwd);
  postCompactResumeOwed = false; // v0.33.1: the dead goal's compact debt/resync dies with it
  postCompactResyncPending = false;
  if (!state.goal) return;
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
  if (archived) {
    try { fs.unlinkSync(goalMdPath(ctx.cwd, goal.id)); } catch {}
  }
  state = {
    ...state,
    goal: {
      ...goal,
      status,
      archivedPath: path.relative(ctx.cwd, target) || target,
      stopReason,
      // A cancelled/archived goal cannot accept a late detached worker result.
      pendingCompletion: undefined,
    },
  };
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
  // Loop 2: a list-sourced goal COMPLETED → auto-activate the next item.
  // Aborts are user actions (/list next, /goal cancel, list_activate) which
  // pick their own next step — auto-advancing on abort double-activates
  // (v0.2.0 bug: bare /list next silently consumed TWO items, found by the
  // pick-any-item verification in v0.10.0).
  if (goal.policy === "list" && status === "complete") {
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
    // v0.26.0: the queue just EMPTIED on a completion → list-complete.
    if (!advanced && !isListAuditCollect) {
      fireReviewer(ctx, { kind: "list", goalId: goal.id, objective: goal.objective, terminal: "goal-complete" });
      // v0.29.0: the well ran dry — point at the project-audit loop. A
      // suggestion, not an action: consent, never auto-start (v0.28.28).
      ctx.ui.notify("List complete. /loop audit to sweep the project for the next batch of work.", "info");
    }
    return;
  }
  // v0.26.0: a /goal (non-list) reached a terminal state → maybe fire.
  if (goal.policy !== "list") {
    fireReviewer(ctx, { kind: "goal", goalId: goal.id, objective: goal.objective, terminal: status === "complete" ? "goal-complete" : status === "aborted" ? "goal-aborted" : "goal-paused" });
  }
}

/** v0.34.21: durable completion-audit lifecycle helpers. A claim without
 * an explicit phase is legacy state and is treated as recovery-pending after
 * a fresh lifecycle event; it is never silently presented as an active run. */
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
function beginCompletionAudit(ctx: ExtensionContext, claim: PendingCompletion, origin: CompletionAuditOrigin): PendingCompletion {
  completionAuditRecoveryArmed = true;
  const startedMs = Date.now();
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

function markCompletionAuditRecoveryPending(ctx: ExtensionContext, reason: string): boolean {
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

function isAuditorTimeoutError(error: string | undefined): boolean {
  return !!error && (/^Auditor exceeded its .* wall-clock bound/i.test(error) || /^Auditor stalled —/i.test(error));
}

function isCompletionAuditRecoveryPending(goal: Goal | null | undefined): boolean {
  return !!goal?.pendingCompletion && goal.pendingCompletion.phase !== "running";
}

const MAX_AUDITOR_QUOTA_AUTO_ATTEMPTS = 5;

function auditorQuotaRetryPlan(claim: PendingCompletion, quota: ReturnType<typeof parseQuotaError>, baseMinutes: number): {
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
  const requestedSec = quota.fromUpstream ? quota.retryAfterSec : quotaRetryDelaySeconds(attempt, baseMinutes);
  const retryAfterSec = capQuotaRetrySeconds(requestedSec);
  const automatic = attempt < MAX_AUDITOR_QUOTA_AUTO_ATTEMPTS && now + retryAfterSec * 1_000 <= untilMs;
  return { attempt, retryAfterSec, firstAt, autoRetryUntil: new Date(untilMs).toISOString(), automatic, requestedSec };
}

export type AuditorModelCandidate = { model: any; via: string };
type DetachedAuditResult = Awaited<ReturnType<typeof runDetachedGoalCompletionAuditor>>;

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
  completionAuditRecoveryArmed = true;
  let liveCtx: ExtensionContext = initialCtx;
  const claim = beginCompletionAudit(liveCtx, goal.pendingCompletion, origin);
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
  if (!currentAfterAudit || !state.goal || state.goal.id !== goalId) return; // replacement/stale/goal boundary — fresh session rebinds durable state
  if (state.goal.pendingCompletion?.attemptId !== claim.attemptId) return; // a newer attempt owns the durable claim
  liveCtx = currentAfterAudit;

  // v0.34.61: focus revision guard — contract-scoped. The detached
  // worker captured (goalId, revision) at dispatch; only a CONTRACT
  // change (tweak / newObjective) bumps the counter now, so a mismatch
  // means the goal's contract moved while the audit ran — the verdict
  // must NOT apply to the new contract. Non-contract writes (pause,
  // status flips, quota machinery) no longer trip this guard; they do
  // not change the contract the verdict applies to.
  // Surface the refusal loudly via the HUD rather than silently
  // overwriting a goal that moved on.
  if (result.goalRevision && state.goal.revision !== result.goalRevision.revision) {
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
    updateGoal({ pendingCompletion: undefined }, liveCtx);
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
    const objective = state.goal.objective;
    const approvalVia = `${origin === "manual" ? " on /goal verify" : origin === "session-recovery" ? " after session recovery" : " on the quota retry"}${fallbackUsed ? " after an auditor-model fallback" : ""}`;
    archiveCurrentGoal(liveCtx, "complete", `auditor ${result.model} approved (${origin})`);
    liveCtx.ui.notify(`Goal complete — auditor ${result.model} approved${approvalVia}.`, "info");
    notifyExternal(liveCtx, `Goal complete (auditor approved, ${origin}): ${displaySlice(objective, 120)}`);
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
    quotaRetryStreak = plan.attempt;
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
    const retryMin = Math.max(1, Math.round(plan.retryAfterSec / 60));
    updateGoal({
      status: "paused",
      auditHistory: history,
      pendingCompletion: pending,
      pauseKind: "wait",
      pauseResumeAt: new Date(Date.now() + plan.retryAfterSec * 1000).toISOString(),
      pauseReason: `auditor retry: ${result.error}`,
      pauseSuggestedAction: `Auto-retry in ${retryMin}m${providerHint} — or ${activeGoalSurfaceCommand("resume")} to retry now`,
    }, liveCtx);
    appendLedger(liveCtx.cwd, "goal_paused", { reason: `auditor retry: retry in ${plan.retryAfterSec}s (stored-claim retry)`, attempt: plan.attempt, autoRetryUntil: plan.autoRetryUntil });
    liveCtx.ui.notify(`Auditor still failing — next auto-retry in ${retryMin}m${providerHint} (your completion claim is stored; no action needed).`, "warning");
    scheduleQuotaRetryForSession(liveCtx, plan.retryAfterSec, result.error, (fresh) => {
      if (state.goal && state.goal.status === "paused" && (state.goal.pauseReason ?? "").startsWith("auditor retry:") && state.goal.pendingCompletion) {
        void retryStoredCompletionAudit(origin);
      }
    });
    return;
  }



  // Any other outcome — disapproved or impossible — belongs to the agent:
  // resume and let the continuation drive the next step. The verdict is
  // durable in auditHistory + /goal status.
  quotaRetryStreak = 0;
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
    const sources: Array<{ name: string; text: string }> = [];
    try {
      sources.push({ name: "archive", text: fs.readFileSync(archivedGoalPath(ctx.cwd, source.goalId), "utf-8") });
    } catch {
      /* archive md may not exist for manual review of a live goal */
    }
    // v0.26.4 source curation: an APPROVED audit report is the executor's
    // own completion claims — meta-text with zero finding signal (the
    // 0.26.2/0.26.3 misfires both mined it). Disapprovals/errors carry the
    // independent auditor's required-fixes — the real findings.
    const auditTexts = readAuditLog(ctx.cwd)
      .filter((e) => e.goalId === source.goalId && (e.verdict === "disapproved" || e.verdict === "error"))
      .map((e) => e.report);
    for (const t of auditTexts) sources.push({ name: "audit", text: t });
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

// =================================================================
// Loop 2: /list list
// =================================================================

function listQueue(): NonNullable<State["list"]> {
  return state.list ?? [];
}

function activateNextListItem(ctx: ExtensionContext, n = 1): boolean {
  // An explicit list activation is user consent even when pi initially
  // reported a blank startup context; automatic restore never reaches here.
  releaseInitialSessionLoadBarrier();
  // v0.28.14: one-active-thing choke point — NO call site (session_start,
  // completion cascade, /list next, list_activate, list-draft auto-activate)
  // may activate a list item over a live loop, present or future.
  if (isLoopActive()) {
    appendLedger(ctx.cwd, "list_activation_blocked_loop", {});
    return false;
  }
  // v0.28.14: carryover resolution runs BEFORE the item is taken — under
  // carryover=clear the stale queue is dropped first and there is nothing
  // to activate; under pause the ONE summary precedes the activation.
  resolveCarryover(ctx, "list");
  const queue = listQueue();
  const taken = takeAt(queue, n);
  if (!taken) return false;
  const [next, rest] = taken;
  state = { ...state, list: rest };
  // v0.34.60: remove the disk sidecar. The active goal .md takes its
  // place via setGoal → writeGoalMd; the sidecar would re-show the item
  // as queued if a stale-handle /list read happened later.
  deleteQueueItemFile(ctx.cwd, next.id);
  const goal = createGoal(next.objective, ctx, "list");
  if (next.verificationContract) goal.verificationContract = next.verificationContract;
  setGoal(goal, ctx, "list-cascade");
  iterationCounter = 0;
  consecutiveErrorIterations = 0;
  consecutiveAbortIterations = 0;
  ctx.ui.notify(`List item #${n} activated (${rest.length} remaining): ${displaySlice(goal.objective, 80)}`, "info");
  scheduleContinuation(ctx, true);
  return true;
}

// =================================================================
// Drafting: /goal with no args → clarify → Confirm dialog → activate
// =================================================================

async function startDrafting(ctx: ExtensionContext, target: "goal" | "list" | "loop", seed?: string): Promise<boolean> {
  // A stale/handoff-bound MAIN cannot deliver the seed. Do not leave the
  // module in drafting mode: that orphaned gate makes later list_add and
  // propose_goal_draft calls look like user disapprovals until restart.
  if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown || probeExtensionApiStale()) {
    clearDraftingState();
    return false;
  }
  draftingTarget = target;
  const prompts: Record<string, [string, string, string]> = {
    goal: ["goal-loop-draft.md", "Goal drafting", "propose_goal_draft"],
    list: ["goal-loop-draft.md", "Goal drafting (for the list)", "propose_goal_draft"],
    loop: ["goal-loop-forever-draft.md", "Loop drafting", "propose_loop_draft"],
  };
  const [file, label, tool] = prompts[target]!;
  const seededHint =
    target === "list"
      ? `${label}: free-text is valid without a "Done when:" clause — the agent will turn it into short list items and grill for concrete per-item contracts (nothing activates until you confirm). To skip drafting, include a per-item "Done when:" clause.`
      : target === "loop"
        ? `${label}: a loop target needs a metric and a direction — the agent will help you design them first (nothing activates until you confirm). Skip the interview entirely: /loop start "<target>" (bare = infinite metricless) or /loop start "<target>" measure="<cmd>" direction=min|max [window=5] [max=50] [time=h] [tokens=n] [branch=1].`
        : `${label}: the objective has no "Done when:" clause — the agent will grill you about it first (nothing activates until you confirm). Skip the interview entirely: /goal start <objective>.`;
  const tmplPath = path.resolve(__dirname, "..", "..", "prompts", file);
  let tmpl: string;
  try {
    tmpl = fs.readFileSync(tmplPath, "utf-8");
    if (target === "list") {
      tmpl = tmpl.replace(
        "[GOAL DRAFTING]",
        "[LIST DRAFTING — the confirmed item goes into the /list LIST, it does not activate immediately. " +
          "/list items are SHORT tasks, not multi-hour objectives: each item should fit comfortably in a single agent run " +
          "(minutes of work, a single focused change). The list's long-running property is QUEUE DEPTH — hundreds of short " +
          "items activated one at a time over days/weeks — never any single item's scope. " +
          "If the user describes work that would take hours, propose breaking it into multiple /list items, or suggest /goal " +
          "for the big version. When the user has many items to enqueue at once ('queue these 50 audits'), propose them ALL AT " +
          "ONCE with the items[] parameter — one Confirm for the whole batch, never 50 separate proposals. Each items[] entry " +
          "is still a SHORT task — never an aggregate wrapper ('land all N findings' with a '≥N commits' contract is the " +
          "canonical anti-pattern: the auto-committer squashes, the count fails, the auditor disapproves finished work).]",
      );
    }
  } catch {
    tmpl = `[DRAFTING] Clarify the user's ${target}, then call ${tool}.`;
  }
  // v0.14.0: the LLM grills (its strength — v0.13.0's canned questionnaire
  // accepted non-answers), the plugin enforces the floor: propose_goal_draft
  // is blocked until the user has replied at least once (see message_start).
  if (seed) {
    tmpl = buildSeedGrillMessage(tmpl, seed, tool);
    // v0.25.3: cross-mode recommendation — catch wrapper-goal seeds and
    // mode mismatches BEFORE the draft crystallizes.
    if (target === "goal" || target === "list") {
      const xr = crossRecommendMode(seed, target);
      if (xr) tmpl += `\n\n${xr}`;
    }
  }
  try {
    const wasStale = extensionApiStale;
    const sent = safeSteerUser(ctx, tmpl);
    if (!sent) {
      clearDraftingState();
      // safeSteerUser deliberately catches stale API errors, so its caller
      // must handle a false result explicitly rather than relying on catch.
      if (extensionApiStale && !wasStale) {
        appendLedger(ctx.cwd, "extension_api_stale", { where: "startDrafting seed" });
        ctx.ui.notify("glla: can't start the drafting interview — this session's extension handle is stale (pi session replacement). A fresh session_start will rebind it; if no replacement arrives, restart pi normally, then re-run the command.", "warning");
      }
      return false;
    }
    ctx.ui.notify(
      seed
        ? seededHint
        : `${label} started. The agent will grill until the contract is concrete, then ${tool} opens a Confirm dialog. No work begins before confirmation.`,
      "info",
    );
    draftingUserReplies = 0;
    draftingBlockedProposals = 0;
    draftingSeedInFlight = true; // our injected prompt also arrives as a user message — don't count it
    return true;
  } catch (err) {
    clearDraftingState();
    // v0.28.1 (E6): the seed send used to fail SILENTLY — the user pressed
    // Enter on /goal and nothing happened. Now: loud, and stale handles get
    // the honest restart guidance.
    if (isStaleApiError(err)) {
      extensionApiStale = true;
      appendLedger(ctx.cwd, "extension_api_stale", { where: "startDrafting seed" });
      ctx.ui.notify("glla: can't start the drafting interview — this session's extension handle is stale (pi session replacement). A fresh session_start will rebind it; if no replacement arrives, restart pi normally, then re-run the command.", "warning");
    } else {
      ctx.ui.notify(`glla: couldn't start the drafting interview (${err instanceof Error ? err.message : String(err)}) — try again.`, "warning");
    }
    return false;
  }
}

// =================================================================
// /goal router (v0.8.0): subcommands route to their handlers; everything
// else is an objective (draft if empty, set+start otherwise).
// =================================================================

async function cmdGoal(args: string, ctx: ExtensionContext): Promise<void> {
  const route = routeGoalArgs(args);
  if (route.kind === "sub") {
    if (route.name === "status") return cmdStatus(ctx);
    if (route.name === "pause") return cmdPause(ctx);
    if (route.name === "resume") return cmdResume(ctx);
    if (route.name === "cancel") return cmdCancel(ctx);
    // v0.28.23: re-open the decision picker for a decision pause (the
    // popup auto-opens when the pause lands; this is the on-demand path).
    if (route.name === "decide") {
      const shown = await showDecisionPrompt(ctx);
      if (!shown) ctx.ui.notify("No pending decision — the goal isn't paused on a choice (or no UI).", "info");
      return;
    }
    // v0.29.8: /goal audit [focus] — the ONE-SHOT project audit (user:
    // "/goal audit IS the audit goal — we are not auditing the current
    // goal, that happens automatically"). Fire-and-address: one audit
    // pass, FIX findings fixed autonomously (a bug is not a decision),
    // DECIDE findings presented, untouched. Runs as a normal goal through
    // cmdSet — the isolated auditor verifies the finish line.
    if (route.name === "audit") {
      // v0.31.1: an active audit loop already owns auditing here — the
      // one-shot duplicates it (same stacking confusion as junk-runner).
      if (state.loop?.active && state.loop.target.includes(LOOP_AUDIT_MARKER)) {
        appendLedger(ctx.cwd, "audit_stack_warn", { have: "loop", starting: "goal" });
        ctx.ui.notify(
          "An audit loop is already running here — a one-shot /goal audit duplicates its work. /loop status to see it; /loop stop first if you want the one-shot instead.",
          "warning",
        );
      }
      return cmdSet(projectAuditTarget(route.rest || undefined), ctx, true);
    }
    // v0.28.27 (renamed /goal audit → /goal verify in v0.29.8): run the
    // isolated auditor on the current goal
    // RIGHT NOW, without engaging the agent. The user's "the work looks
    // done — just verify it" handle (and the manual counterpart of the
    // v0.28.26 stored-claim quota retry). Seeds a synthesized claim so a
    // quota block falls into the same pendingCompletion retry machinery.
    if (route.name === "verify") {
      if (!state.goal) {
        ctx.ui.notify("No active goal — /goal verify needs a goal to verify.", "warning");
        return;
      }
      if (completionAuditInFlight) {
        ctx.ui.notify("An audit is already running…", "info");
        return;
      }
      updateGoal({
        pendingCompletion: {
          completionSummary: "Manual audit requested by the user via /goal verify (no agent completion claim). Verify the objective against the repo directly.",
          at: nowIso(),
        },
      }, ctx);
      appendLedger(ctx.cwd, "manual_audit_requested", { goalId: state.goal.id });
      void retryStoredCompletionAudit("manual");
      return;
    }
    if (route.name === "tweak") return cmdTweak(route.rest, ctx);
    if (route.name === "archive") return cmdGoals(ctx);
    // v0.16.0: /goal start <objective> — explicit skip-draft. Activates
    // immediately, no interview, no "Done when:" heuristic. Symmetric
    // with /loop start. The auditor infers the contract from the objective.
    if (route.name === "start") {
      if (!route.rest) {
        ctx.ui.notify("Usage: /goal start <objective> — activates immediately, skipping the drafting interview. (Without start, an objective needs a 'Done when:' clause or it gets drafted first.)", "warning");
        return;
      }
      return cmdSet(route.rest, ctx, true);
    }
  }
  return cmdSet(route.kind === "set" ? route.text : "", ctx);
}

// =================================================================
// /goal: bypass drafting, start now (the only entry in v0.1.0)
// =================================================================

async function cmdSet(args: string, ctx: ExtensionContext, skipDraft = false): Promise<void> {
  releaseInitialSessionLoadBarrier();
  // v0.28.1 (S3): probe at the creation entry — no "created — starting now"
  // lie in a doomed process. (The draft path's seed send has its own loud
  // stale handling — E6.)
  const staleEntry = warnIfStaleAtEntry(ctx, "/goal");
  let raw = args.trim();
  // Users naturally quote the objective ("/goal \"do X\""); strip one layer of
  // surrounding matching quotes so they don't leak into the goal text.
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    raw = raw.slice(1, -1).trim();
  }
  if (!raw) {
    // A stale MAIN cannot deliver the interview seed. Do not create an
    // orphaned drafting gate after the entry warning has fired.
    if (staleEntry) return;
    await startDrafting(ctx, "goal");
    return;
  }
  if (isLoopActive()) {
    ctx.ui.notify("A /loop is active — /loop stop it before setting a goal.", "warning");
    return;
  }
  // v0.11.0: a contract-less objective gets drafted, not activated raw —
  // the pi-goal-x lesson: arg + Enter is worse than a 5-minute draft.
  // Include an explicit "Done when: …" clause to activate instantly.
  // v0.16.0: /goal start bypasses this by explicit user command.
  if (!skipDraft && goalArgsNeedDrafting(raw)) {
    if (staleEntry) return;
    await startDrafting(ctx, "goal", raw);
    return;
  }
  draftingTarget = null; // explicit objective cancels any drafting session
  resolveCarryover(ctx, "goal"); // v0.28.14: surface/clear stale leftovers
  const goal = createGoal(raw, ctx);
  setGoal(goal, ctx);
  // Reset counters
  iterationCounter = 0;
  consecutiveErrorIterations = 0;
  consecutiveAbortIterations = 0;
  consecutiveNoToolIterations = 0;
  if (staleEntry) {
    // v0.28.1 (S3): the goal is persisted — mark the interrupt so the next
    // fresh session LOADS it (held by default since v0.28.21), and tell the truth instead of "starting now".
    updateGoal({ interruptedAt: nowIso(), interruptedReason: "created in a stale session" }, ctx);
    ctx.ui.notify(`Goal saved: ${shortObj(goal.objective)} — safe in .pi-glla/, but this stale process can't send continuations. A fresh session_start will resume it; if no replacement arrives, restart pi normally, then ${activeGoalSurfaceCommand("resume")} if autoresume is off.`, "warning");
    return;
  }
  ctx.ui.notify(`Goal started: ${shortObj(goal.objective)} — the auditor will verify on completion.`, "info");
  scheduleContinuation(ctx, true);
}

async function cmdStatus(ctx: ExtensionContext): Promise<void> {
  if (!state.goal) {
    ctx.ui.notify("No active goal. Use /goal <objective>.", "info");
    return;
  }
  const g = state.goal;
  const lines = [
    `${statusLabel(g.status)}: ${sanitizeDisplayText(g.objective)}`,
    // v0.24.7: name WHERE the work came from — a queue item is not a goal.
    ...(g.policy === "list" ? [`Source: /list queue (${listQueue().length} waiting) — /list to manage`] : []),
    `Auto-continue: ${g.autoContinue ? "on" : "off"}`,
    `Iteration: ${iterationCounter}`,
    `Tokens: ${(g.usage?.tokensUsed ?? 0).toLocaleString()}${(g.usage?.tokensLimit ?? 0) > 0 ? ` / ${(g.usage!.tokensLimit).toLocaleString()}` : " (no cap — set Token limit in /glla settings)"}`, 
  ];
  if (g.auditHistory && g.auditHistory.length > 0) {
    lines.push(`Audits: ${g.auditHistory.length} (${g.auditHistory.filter((v) => v.approved).length} approved)`);
  }
  if (g.status === "auditing") {
    lines.push(`Completion audit: ${isCompletionAuditRecoveryPending(g) ? `recovery pending — ${activeGoalSurfaceCommand("resume")} retries the stored claim` : completionAuditInFlight && latestAuditProgress?.label === "queued" ? "detached auditor queued" : completionAuditInFlight ? "detached auditor running" : "awaiting lifecycle recovery"}`);
  }
  if (g.pauseReason) lines.push(`Paused: ${g.pauseReason}`);
  ctx.ui.notify(lines.join("\n"), "info");
}

async function cmdPause(ctx: ExtensionContext): Promise<void> {
  if (!state.goal) return;
  if (state.mainModelRecovery?.kind === "goal") {
    clearMainModelRecoveryTimer();
    state.mainModelRecovery = undefined;
    mainModelAbortForRecovery = false;
  }
  releaseContinuationDispatchStandDown();
  clearDispatchRecord(ctx.cwd);
  const resumeCommand = activeGoalCommand("resume");
  updateGoal({
    status: "paused",
    pauseKind: "blocked",
    pauseReason: "paused by user",
    pauseSuggestedAction: `${resumeCommand} to continue`,
    pauseResumeAt: undefined,
  }, ctx);
  // v0.22.7: name WHAT was paused — a list item resumes through /list.
  if (state.goal.policy === "list") {
    const queued = listQueue().length;
    ctx.ui.notify(`List item "${shortObj(state.goal.objective)}" paused${queued > 0 ? ` (${queued} waiting in the list)` : ""}. ${resumeCommand} to continue.`, "info");
    return;
  }
  ctx.ui.notify(`Goal "${shortObj(state.goal.objective)}" paused. ${resumeCommand} to continue.`, "info");
}

async function cmdResume(ctx: ExtensionContext): Promise<void> {
  releaseInitialSessionLoadBarrier();
  const resumeCommand = activeGoalCommand("resume");
  if (manuallyResumeMainModelRecovery(ctx)) return;
  if (state.mainModelRecovery?.retryAt) {
    clearMainModelRecoveryTimer();
    continuationDispatchStoodDown = false;
    ctx.ui.notify("Retrying the saved main-model recovery now — one provider probe, then the configured backups if needed.", "info");
    void probeMainModelRecovery(ctx);
    return;
  }
  // v0.34.3: /goal resume on an ACTIVE-but-idle goal re-kicks its
  // continuation (was: silent return — the user got NOTHING while the
  // widget said "active"). One-active-thing still holds: an active loop
  // wins over the re-kick.
  if (state.goal && state.goal.status === "active") {
    if (isLoopActive()) {
      ctx.ui.notify("A loop is active — one active thing at a time. /loop stop it first, then resume the goal.", "warning");
      return;
    }
    appendLedger(ctx.cwd, "resume_rekick", { goalId: state.goal.id, policy: state.goal.policy, via: resumeCommand });
    if (state.goal.interruptedAt) updateGoal({ interruptedAt: undefined, interruptedReason: undefined }, ctx); // v0.34.7: same marker law here
    ctx.ui.notify(
      `The ${state.goal.policy === "list" ? "list item" : "goal"} is ACTIVE but idle — re-firing its continuation: ${displaySlice(state.goal.objective, 70)}`,
      "info",
    );
    scheduleContinuation(ctx, true);
    return;
  }
  if (state.goal?.status === "auditing") {
    if (!state.goal.pendingCompletion) {
      ctx.ui.notify(`A detached completion auditor is in flight — wait for its verdict (the status line shows auditor running). ${activeGoalSurfaceCommand("cancel")} discards the pending claim.`, "info");
      return;
    }
    if (completionAuditInFlight) {
      ctx.ui.notify(`The detached completion auditor is already running — wait for its verdict or ${activeGoalSurfaceCommand("cancel")} to discard the pending claim.`, "info");
      return;
    }
    if (isLoopActive()) {
      ctx.ui.notify("A loop is active — one active thing at a time. /loop stop it first, then resume the completion audit.", "warning");
      return;
    }
    const staleEntry = warnIfStaleAtEntry(ctx, resumeCommand);
    if (staleEntry) return;
    markCompletionAuditRecoveryPending(ctx, "manual-resume");
    completionAuditRecoveryArmed = true;
    ctx.ui.notify("Resuming the stored completion claim — starting a detached auditor (no agent turn needed).", "info");
    void retryStoredCompletionAudit("manual");
    return;
  }
  if (!state.goal || state.goal.status !== "paused") return;
  // v0.28.21: one-active-thing — the LAST unguarded activation path. A
  // paused goal/list-item must not resume over a live loop (covers
  // /goal resume AND /list resume, which routes here).
  if (isLoopActive()) {
    ctx.ui.notify("A loop is active — one active thing at a time. /loop stop it first, then resume the goal.", "warning");
    return;
  }
  // v0.28.1 (S1/S3): resuming in a stale session used to flip status to
  // active, claim "Resumed goal", then re-pause on the stale send failure
  // (or zombie — S1). Now: persist the resume (the next fresh session
  // auto-resumes ACTIVE goals), mark the interrupt, tell the truth, and
  // skip the send that can never land.
  const staleEntry = warnIfStaleAtEntry(ctx, resumeCommand);
  // v0.12.0: refresh the token cap from CURRENT settings on resume — goals
  // snapshot the cap at creation, so a goal paused under an old default
  // (e.g. 10M) would re-pause instantly even after the default changed.
  const freshLimit = loadSettings(ctx.cwd).tokenLimit ?? DEFAULT_TOKEN_LIMIT;
  const usage = state.goal.usage
    ? { tokensUsed: state.goal.usage.tokensUsed, tokensLimit: freshLimit }
    : undefined;
  // v0.34.2: clear the stale-handle interrupt marker on a MANUAL resume too —
  // the only clear-site used to be the autoResume restore path, so with
  // autoresume=off a resumed goal kept the red "⚠ interrupted — stale handle"
  // status line forever while actively working (hegemon, 2026-08-01). The
  // marker's promise ("a fresh session will resume you") is fulfilled by a
  // manual resume exactly as by an automatic one. (staleEntry still re-marks
  // below — a resume inside a stale session is a NEW interrupt.)
  const storedCompletion = state.goal.pendingCompletion;
  updateGoal({ status: "active", pauseReason: undefined, pauseSuggestedAction: undefined, pauseKind: undefined, pauseOptions: undefined, pauseRecommended: undefined, pauseResumeAt: undefined, interruptedAt: undefined, interruptedReason: undefined, ...(staleEntry ? { interruptedAt: nowIso(), interruptedReason: "resumed in a stale session" } : {}), ...(usage ? { usage } : {}) }, ctx);
  if (staleEntry) return;
  // A stored completion claim is a direct-audit resume, not an agent turn.
  // Keeping the claim while merely scheduling a continuation left manual
  // pause/resume with an ACTIVE goal that no timer would ever consume.
  if (storedCompletion) {
    ctx.ui.notify("Resuming the stored completion claim — starting a detached auditor (no agent turn needed).", "info");
    void retryStoredCompletionAudit("manual");
    return;
  }
  // v0.22.5: say what was resumed — with a non-empty list this also resumes
  // the queue (the active goal IS the list's head item).
  // v0.22.7: name WHAT was resumed — list items resume through /list.
  const queued = listQueue().length;
  const isListItem = state.goal.policy === "list";
  ctx.ui.notify(
    isListItem
      ? `Resumed list item [${state.goal.id}]: ${displaySlice(state.goal.objective, 70)}${queued > 0 ? ` (+${queued} waiting in the list)` : ""}`
      : `Resumed goal [${state.goal.id}]: ${displaySlice(state.goal.objective, 70)}${queued > 0 ? ` (+${queued} waiting in the list — resuming the list's head)` : ""}`,
    "info",
  );
  scheduleContinuation(ctx, true);
}

async function cmdCancel(ctx: ExtensionContext): Promise<void> {
  if (!state.goal) {
    // v0.28.14: users reach for /goal cancel to kill a LOOP (no goal
    // active) — point at the right verb instead of doing nothing silently.
    if (isLoopActive()) {
      ctx.ui.notify("No goal to cancel — a LOOP is active: /loop stop (or /loop cancel) ends it.", "info");
    }
    return;
  }
  archiveCurrentGoal(ctx, "aborted", "user cancelled");
  ctx.abort();
  ctx.ui.notify(`${goalNoun()} aborted.${isLoopActive() ? " A loop is still active — /loop stop ends it." : ""}`, "info");
}

// ---- v0.28.23: decision picker popup ----
// A decision pause is ACTIONABLE — the widget card summarizes (and
// truncates) it, but picking from a truncated wall was the user's
// complaint. Borrow Claude Code / muselinn-Ask: a real select() modal
// with the FULL option text, pick → act. Escape leaves the card as the
// fallback; /goal decide re-opens the picker at any time.

let decisionPromptOpen = false;

/** True when the goal is paused on a user decision with options. */
function pendingDecision(): Goal | null {
  const g = state.goal;
  return g && g.status === "paused" && g.pauseKind === "decision" && g.pauseOptions && g.pauseOptions.length > 0 ? g : null;
}

/** Open the decision picker for the current decision pause. Returns true
 * when a picker was shown (false → caller notifies "no pending decision"). */
async function showDecisionPrompt(ctx: ExtensionContext): Promise<boolean> {
  const g = pendingDecision();
  if (!g || !ctx.hasUI || decisionPromptOpen) return false;
  decisionPromptOpen = true;
  try {
    const title = `Decision needed — ${displaySlice(g.objective, 72)}${g.pauseReason ? ` · ${displaySlice(g.pauseReason, 80)}` : ""}`;
    const options = g.pauseOptions!.map((o, i) => (g.pauseRecommended === i + 1 ? `${o}  (recommended)` : o));
    const pick = await ctx.ui.select(title, options);
    if (!pick) return true; // Escape — the widget card remains the fallback
    const idx = options.indexOf(pick);
    const label = g.pauseOptions![idx] ?? pick.replace(/ {2}\(recommended\)$/, "");
    // v0.29.3: the wipe escape — "… (/glla wipe)" options run the wipe
    // (which Confirms on its own — destructive actions keep their gate).
    if (/\(\/glla wipe\)\s*$/.test(label)) {
      await cmdGllaWipe(ctx);
      return true;
    }
    // Executable options — "Label (/goal cancel)" — RUN the command.
    // Placeholder commands (…/<arg>) fall through to the message path.
    const cmdMatch = label.match(/\(\/(goal|list|loop) ([a-z]+)\)\s*$/);
    if (cmdMatch && !label.includes("…") && !label.includes("<")) {
      const [, group, verb] = cmdMatch;
      if (group === "goal" && verb === "resume") await cmdResume(ctx);
      else if (group === "goal" && verb === "cancel") await cmdCancel(ctx);
      else if (group === "loop" && verb === "stop") await cmdLoop("stop", ctx);
      else if (group === "loop" && verb === "resume") await cmdLoop("resume", ctx);
      else {
        safeSteerUser(ctx, `Decision for the paused goal "${displaySlice(g.objective, 240)}": ${sanitizeDisplayText(label)} — continue on this path.`);
        await cmdResume(ctx);
      }
      return true;
    }
    // Content choice — deliver to the agent, then resume.
    safeSteerUser(ctx, `Decision for the paused goal "${displaySlice(g.objective, 240)}": ${sanitizeDisplayText(label)} — continue on this path.`);
    await cmdResume(ctx);
    return true;
  } finally {
    decisionPromptOpen = false;
  }
}

/** Pop the picker after a decision pause lands — deferred so the current
 * turn finishes first (pi serializes dialogs). No-ops without a UI, when
 * disabled (set Decision popup = off in /glla settings), or when one is already open. */
function maybeDecisionPopup(ctx: ExtensionContext): void {
  if (!ctx.hasUI || loadSettings(ctx.cwd).decisionPopup === false) return;
  const cwd = ctx.cwd;
  scheduleSessionTimeout(() => {
    const fresh = freshCtx();
    if (!fresh || fresh.cwd !== cwd) return;
    void showDecisionPrompt(fresh).catch(() => {});
  }, 600);
}

async function cmdGoals(ctx: ExtensionContext): Promise<void> {
  const dir = archiveDir(ctx.cwd);
  if (!fs.existsSync(dir)) {
    ctx.ui.notify("No archived goals yet.", "info");
    return;
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse();
  if (files.length === 0) {
    ctx.ui.notify("No archived goals yet.", "info");
    return;
  }
  const lines = files.slice(0, 20).map((f) => {
    let status = "?";
    let stop = "";
    let obj = "";
    try {
      const content = fs.readFileSync(path.join(dir, f), "utf-8");
      status = content.match(/\*\*Status\*\*:\s*(\w+)/)?.[1] ?? "?";
      stop = content.match(/\*\*Stop reason\*\*:\s*(.+)/)?.[1]?.trim() ?? "";
      obj = content.match(/## Objective\s+>\s*(.+)/)?.[1]?.trim() ?? "";
    } catch { /* unreadable file — show name only */ }
    return `${f.replace(/\.md$/, "")} [${status}] ${displaySlice(obj, 60)}${stop ? ` — ${displaySlice(stop, 40)}` : ""}`;
  });
  ctx.ui.notify(
    `Archived goals (${files.length}${files.length > 20 ? ", showing 20" : ""}):\n` + lines.join("\n"),
    "info",
  );
}

async function cmdTweak(args: string, ctx: ExtensionContext, mode: "goal" | "list" = "goal"): Promise<void> {
  const current = state.goal;
  const expectedStatus = mode === "list" ? "paused" : "active";
  if (!current || current.status !== expectedStatus || (mode === "list" && current.policy !== "list")) {
    ctx.ui.notify(
      mode === "list"
        ? "No paused list item to tweak. /list tweak <replacement objective, optional 'Done when: ...' clause>"
        : "No active goal to tweak. /goal <objective> to start one.",
      "info",
    );
    return;
  }
  let raw = args.trim();
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    raw = raw.slice(1, -1).trim();
  }
  if (!raw) {
    ctx.ui.notify(
      mode === "list"
        ? "Usage: /list tweak <replacement objective, optional 'Done when: ...' clause>"
        : "Usage: /goal tweak <replacement objective, optional 'Done when: ...' clause>",
      "info",
    );
    return;
  }
  const proposed = extractVerificationContract(raw);
  const newObjective = proposed.objective;
  if (!newObjective) {
    ctx.ui.notify(
      mode === "list"
        ? "Usage: /list tweak <replacement objective, optional 'Done when: ...' clause>"
        : "Usage: /goal tweak <replacement objective, optional 'Done when: ...' clause>",
      "info",
    );
    return;
  }
  // v0.34.51 contract-text semantics (defined + pinned by tests):
  //   supplied clause  → REPLACE the stored contract
  //   omitted clause   → PRESERVE the stored contract (a reword must not
  //                      silently destroy the verification gate)
  //   bare marker      → CLEAR the stored contract ("Done when:" with nothing)
  const hasNewContract = proposed.verificationContract.length > 0;
  const clearsContract = !hasNewContract && proposed.explicitClear;
  let confirmed = false;
  try {
    confirmed = await ctx.ui.confirm(
      mode === "list" ? "Tweak list item?" : "Tweak goal?",
      `CURRENT:\n${sanitizeDisplayText(current.objective)}\n\nNEW:\n${sanitizeDisplayText(newObjective)}` +
      (hasNewContract
        ? `\n\nNew contract:\n${sanitizeDisplayText(proposed.verificationContract)}`
        : clearsContract
          ? "\n\n(Empty 'Done when:' — the verification contract is cleared.)"
          : "\n\n(New text carries no contract; the old contract is kept.)"),
    );
  } catch {
    confirmed = false;
  }
  if (!confirmed) {
    ctx.ui.notify("Tweak cancelled; goal unchanged.", "info");
    return;
  }
  const patch: Partial<Goal> = { objective: newObjective };
  if (hasNewContract) patch.verificationContract = proposed.verificationContract;
  else if (clearsContract) patch.verificationContract = "";
  // omitted clause → no verificationContract key in the patch: preserved.
  // v0.34.61: contract-scoped revision bump — one of exactly two sites
  // (the other: complete_goal newObjective). persistState no longer bumps.
  state.goal = bumpGoalRevision(current);
  updateGoal(patch, ctx);
  appendLedger(ctx.cwd, "goal_tweaked", {
    goalId: current.id,
    objective: newObjective,
    via: mode === "list" ? "/list tweak" : "/goal tweak",
  });
  if (mode === "list") {
    ctx.ui.notify("List item tweaked; it remains paused. /list resume to continue.", "info");
    return;
  }
  ctx.ui.notify("Goal tweaked. The loop continues against the new objective.", "info");
  scheduleContinuation(ctx, true);
}

// =================================================================
// /list commands (loop 2)
// =================================================================

/**
 * The ONE enqueue path (v0.8.4): bulk import, items[] drafting, and the
 * agent's list_add tool all funnel here. Texts → ListItems (with per-item
 * contract extraction) → appended to the queue → persisted → first item
 * activated when nothing is running. Returns the count enqueued.
 */
// v0.29.1: zombie-twin guard. A draft/enqueue whose objective matches a
// goal COMPLETED in the last 24h re-creates just-finished work — field-
// observed in junk-runner: the INFRA-NEW-18 close was re-drafted 3 minutes
// after the auditor approved it and autoaccept waved the twin straight in,
// where it stormed for 9h against a dead provider. Normalized compare (goal
// ids stripped), 24h lookback, loud skip — never silent.
const DUPLICATE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const LEDGER_TAIL_BYTES = 256 * 1024;
function recentlyCompletedObjectives(cwd: string): Set<string> {
  const done = new Set<string>();
  try {
    const p = ledgerPath(cwd);
    const size = fs.statSync(p).size;
    const buf = Buffer.alloc(Math.min(size, LEDGER_TAIL_BYTES));
    const fd = fs.openSync(p, "r");
    fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    fs.closeSync(fd);
    const cutoff = Date.now() - DUPLICATE_LOOKBACK_MS;
    for (const line of buf.toString("utf-8").split("\n")) {
      if (!line.includes('"goal_archived"') || !line.includes('"complete"')) continue;
      try {
        const e = JSON.parse(line);
        if (e?.type !== "goal_archived" || e.value?.status !== "complete") continue;
        if (!(Date.parse(e.ts ?? "") >= cutoff)) continue;
        // v0.29.1+ entries carry the objective inline; older entries fall
        // back to the archived goal file (## Objective → "> …" line).
        let objective = typeof e.value?.objective === "string" ? e.value.objective : "";
        if (!objective && e.value?.goalId) {
          try {
            const md = fs.readFileSync(archivedGoalPath(cwd, e.value.goalId), "utf-8");
            objective = md.split("## Objective")[1]?.split("\n").find((l: string) => l.startsWith("> "))?.slice(2) ?? "";
          } catch { /* archived file gone — skip */ }
        }
        if (objective) done.add(normalizeObjective(objective));
      } catch { /* malformed line — skip */ }
    }
  } catch { /* no ledger yet */ }
  return done;
}

function enqueueItems(ctx: ExtensionContext, texts: string[], source: string, opts?: { autoActivate?: boolean }): number {
  const recentlyDone = recentlyCompletedObjectives(ctx.cwd);
  const fresh = texts.filter((t) => !recentlyDone.has(normalizeObjective(extractVerificationContract(t).objective)));
  const skipped = texts.length - fresh.length;
  if (skipped > 0) {
    const first = texts.find((t) => recentlyDone.has(normalizeObjective(extractVerificationContract(t).objective))) ?? "";
    appendLedger(ctx.cwd, "list_duplicate_skipped", { source, count: skipped, objective: first.slice(0, 200) });
    ctx.ui.notify(`Skipped ${skipped} item(s) duplicating work COMPLETED in the last 24h (zombie-twin guard): ${first.slice(0, 90)}`, "warning");
  }
  if (fresh.length === 0) return 0;
  const items = fresh.map((text) => {
    const extracted = extractVerificationContract(text);
    return { id: newGoalId(), objective: extracted.objective, verificationContract: extracted.verificationContract || undefined, addedAt: nowIso() };
  });
  // v0.34.60: disk-first write order. Each item lands on disk BEFORE any
  // in-memory state mutation, so /list survives a stale extension handle
  // (e.g. /reload, plugin re-init, RAM-only state loss). The
  // .queue.json sidecar is atomic (temp + rename) and idempotent (skips
  // existing files rather than overwriting).
  const written = items.map((item) => writeQueueItemFile(ctx.cwd, item));
  state = { ...state, list: [...listQueue(), ...items] };
  const diskFirst = written.filter((w) => w.wrote).length === items.length;
  appendLedger(ctx.cwd, "list_queue_disk_first", { source, count: items.length, diskFirst });
  persistState(ctx);
  appendLedger(ctx.cwd, "list_imported", { source, count: items.length });
  if (!state.goal || state.goal.status === "complete" || state.goal.status === "aborted") {
    // v0.28.28: unsolicited sources (the reviewer) do NOT auto-start the
    // head unless autoResume is on — "I cancelled a goal and the next one
    // started itself" was the field complaint. User-driven imports keep
    // the immediate-start behavior (opts default true).
    if (opts?.autoActivate === false) {
      ctx.ui.notify(`Queued ${items.length} item(s) from ${source} — /list next when ready (auto-start is opt-in: enable Auto-resume in /glla settings).`, "info");
      appendLedger(ctx.cwd, "list_autoactivation_held", { source, count: items.length });
    } else {
      activateNextListItem(ctx);
    }
  }
  return items.length;
}

/** Bulk-enqueue parsed items: one Confirm for the whole batch, never drafts. */
async function bulkAddItems(ctx: ExtensionContext, parsed: string[], sourceName: string): Promise<void> {
  if (parsed.length === 0) {
    ctx.ui.notify("No items found (headings/blank lines don't count).", "warning");
    return;
  }
  // v0.23.7: show ALL items in full — a Confirm the user can't fully
  // read is not a gate (same rule as the draft dialog, v0.23.5).
  const preview = parsed.map((t, i) => `  ${i + 1}. ${t}`).join("\n");
  let confirmed = true;
  if (ctx.hasUI) {
    try {
      confirmed = await ctx.ui.confirm(
        "Import into list?",
        `${parsed.length} items from ${sourceName}:\n${preview}`,
      );
    } catch {
      confirmed = false;
    }
  }
  if (!confirmed) {
    ctx.ui.notify("Import cancelled.", "info");
    return;
  }
  const n = enqueueItems(ctx, parsed, sourceName);
  if (state.goal && state.goal.status === "active") {
    ctx.ui.notify(`Imported ${n} items (${listQueue().length} waiting in the list).`, "info");
  }
}

/** Bulk-enqueue from a file: read, parse, delegate to bulkAddItems. */
async function bulkAddFromFile(ctx: ExtensionContext, abs: string): Promise<void> {
  let content: string;
  try {
    content = fs.readFileSync(abs, "utf-8");
  } catch {
    ctx.ui.notify(`Cannot read: ${abs}`, "warning");
    return;
  }
  await bulkAddItems(ctx, parseListImport(content), path.basename(abs));
}

async function cmdList(args: string, ctx: ExtensionContext): Promise<void> {
  // v0.28.1 (S3): honest staleness warning; read-only subcommands still work.
  const staleEntry = warnIfStaleAtEntry(ctx, "/list");
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] ?? "").toLowerCase();
  const rest = args.trim().slice(sub.length).trim();

  // v0.34.51: mutating subcommands are REFUSED on a stale handle. An
  // add/clear/cancel/next/remove in a doomed process would persist state the
  // stale session can neither announce nor run — an idle-queue add even
  // activates a goal that can never start, without the interrupt marker
  // goStaleTerminal stamps on send failures. The entry probe already printed
  // the honest recovery result; the user's command belongs to the fresh
  // instance after the lifecycle replacement.
  if (staleEntry && LIST_MUTATING_SUBCOMMANDS.has(sub)) {
    appendLedger(ctx.cwd, "list_mutation_refused_stale", { sub });
    return;
  }

  if (sub === "audit") {
    // v0.31.0: /list audit [focus] — collect-then-drain (user design
    // 2026-07-31: "run a project audit, collect a bunch of tasks, then do
    // them all too"). The audit item COLLECTS findings (changes no code);
    // its completion fans each open finding out into the queue and the
    // list drains them fix by fix, each with its own isolated audit.
    // Distinct from /goal audit (fix-in-pass, one audited unit) and
    // /loop audit (forever fix-first cadence).
    // v0.31.1: an active audit loop is already draining this findings file —
    // a collect pass would double-hunt the same ground.
    if (state.loop?.active && state.loop.target.includes(LOOP_AUDIT_MARKER)) {
      appendLedger(ctx.cwd, "audit_stack_warn", { have: "loop", starting: "list" });
      ctx.ui.notify("An audit loop is already draining findings here — /list audit would double-hunt the same ground. /loop status to see it.", "warning");
    }
    const objective = listAuditCollectTarget(rest || undefined);
    const n = enqueueItems(ctx, [objective], "/list audit");
    if (n === 0) return; // zombie-twin guard already explained itself
    ctx.ui.notify(
      "Audit collection item queued — it CHANGES NO CODE: it appends findings to " +
        AUDIT_FINDINGS_REL +
        ", and on completion each open finding becomes its own list item (fixes drain one audited commit at a time). DECIDE findings are presented to you, never queued.",
      "info",
    );
    return;
  }

  if (sub === "depth") {
    // v0.25.3: long-running state at a glance — queue depth, oldest item
    // age, average item duration from archived list-policy goals.
    let entries: Array<{ type: string; value?: any }> = [];
    try {
      entries = parseLedgerEntries(fs.readFileSync(ledgerPath(ctx.cwd), "utf-8"));
    } catch {
      /* no ledger yet */
    }
    const stats = computeListDepth(listQueue(), entries, Date.now());
    ctx.ui.notify(`/list depth: ${formatListDepth(stats)}`, "info");
    return;
  }

  if (sub === "tweak") {
    await cmdTweak(rest, ctx, "list");
    return;
  }

  if (sub === "pause") {
    if (!state.goal || state.goal.policy !== "list") {
      ctx.ui.notify(
        state.goal ? "The active work is a standalone goal — /goal pause to pause it." : "No active list item to pause. /list show to see the list.",
        "info",
      );
      return;
    }
    await cmdPause(ctx);
    return;
  }

  if (sub === "resume") {
    // Resume the list's head. The head activates AS the active goal, so this
    // is the same motion as /goal resume — named for the surface the user is
    // looking at (v0.22.7: "we would just unpause, and that is next").
    // An unacknowledged continuation leaves a list item ACTIVE with an
    // interruption marker (the work was not user-paused). Treat that exact
    // recovery state as resumable here; otherwise /list resume would reject
    // the one command that can release its dispatch stand-down.
    const listDispatchRecovery = state.goal
      && state.goal.policy === "list"
      && state.goal.status === "active"
      && (!!state.goal.interruptedAt || continuationDispatchStoodDown);
    if (!state.goal || (state.goal.status !== "paused" && !listDispatchRecovery)) {
      const terminalListItem = state.goal?.policy === "list"
        && (state.goal.status === "complete" || state.goal.status === "aborted");
      ctx.ui.notify(
        terminalListItem
          ? `The last list item is ${statusLabel(state.goal!.status)} and archived${state.goal!.stopReason ? ` (${displaySlice(state.goal!.stopReason, 90)})` : ""}; nothing to resume. Re-add it with /list or activate a waiting item with /list next.`
          : "No paused list item to resume. /list show to see the list.",
        "info",
      );
      return;
    }
    if (state.goal.policy !== "list") {
      ctx.ui.notify(`The paused goal didn't come from the list — ${activeGoalSurfaceCommand("resume")} to continue it.`, "info");
      return;
    }
    await cmdResume(ctx);
    return;
  }

  if (!sub || sub === "show") {
    const memQueue = listQueue();
    // v0.34.60: stale-handle fallback. If in-memory is empty but disk has
    // queue sidecar files (a fresh pi session that hasn't yet reparsed
    // active.jsonl, or a torn jsonl write), recover from
    // .pi-glla/goals/*.queue.json instead of falsely reporting "list is
    // empty". Exclude any goalId that's already active or archived so we
    // don't re-show active/finished work as queued.
    let queue = memQueue;
    if (queue.length === 0) {
      const exclude = new Set<string>();
      if (state.goal?.id) exclude.add(state.goal.id);
      const diskQueue = readQueueFromDisk(ctx.cwd, exclude);
      if (diskQueue.length > 0) {
        appendLedger(ctx.cwd, "list_recovered_from_disk", { count: diskQueue.length });
        queue = diskQueue;
      }
    }
    const lines: string[] = [];
    if (state.goal) {
      const terminal = state.goal.status === "complete" || state.goal.status === "aborted";
      lines.push(`${terminal ? "Last" : "Active"}: [${state.goal.policy}] ${displaySlice(state.goal.objective, 80)} (${statusLabel(state.goal.status)})`);
    } else {
      lines.push("Active: (none)");
    }
    if (queue.length === 0) {
      lines.push("List: empty. /list <describe your tasks, or a plan file> — the agent shapes dumps into items, files import directly.");
    } else {
      lines.push(`List (${queue.length}):`);
      const PAGE = 15;
      queue.slice(0, PAGE).forEach((item, i) => lines.push(`  ${i + 1}. ${displaySlice(item.objective, 90)}`));
      if (queue.length > PAGE) {
        lines.push(`  … and ${queue.length - PAGE} more. /list remove <n> to prune, /list clear to empty.`);
      }
    }
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }


  // v0.19.0: `add` and `import` are pure no-op aliases — the verb changes
  // nothing, detection routes everything. `/list plan.md` and
  // `/list add plan.md` both import; `/list fix x, do y` and
  // `/list add fix x, do y` both draft. Rationale: a list item activates
  // RAW when it reaches the head, so the drafting interview is the only
  // quality gate an item ever gets — a verb whose only job was skipping
  // that gate was a leak, not an escape hatch. The direct path is an
  // explicit "Done when:" clause (user already did the contract work).
  if (sub === "add" || sub === "import") {
    if (!rest) {
      await startDrafting(ctx, "list");
      return;
    }
    const aliased = routeListText(ctx.cwd, rest.replace(/^["']|["']$/g, ""));
    if (aliased.kind === "file") {
      await bulkAddFromFile(ctx, aliased.path);
      return;
    }
    if (aliased.kind === "batch") {
      await bulkAddItems(ctx, aliased.items, "pasted text");
      return;
    }
    if (aliased.kind === "direct") {
      addSingleItem(ctx, aliased.text);
      return;
    }
    await startDrafting(ctx, "list", aliased.seed);
    return;
  }

  if (sub === "clear") {
    // v0.34.61: delete the sidecars of every removed item BEFORE clearing
    // state. The /list disk-recovery fallback scans .pi-glla/goals/*.queue.json
    // when memQueue is empty; without this, a /list clear followed by a
    // stale-handle reload would resurrect the cleared items.
    const dropped = listQueue();
    for (const item of dropped) deleteQueueItemFile(ctx.cwd, item.id);
    state = { ...state, list: [] };
    persistState(ctx);
    appendLedger(ctx.cwd, "list_cleared", { count: dropped.length });
    ctx.ui.notify(`List cleared. Active goal (if any) is untouched — ${activeGoalSurfaceCommand("cancel")} for that, /list cancel to stop the whole list.`, "info");
    return;
  }

  // v0.24.1: ONE verb for "stop this whole list" — aborts the active item
  // when it's list-sourced AND drops the waiting items. Before this the user
  // had to know to combine /goal cancel + /list clear.
  if (sub === "cancel") {
    const waiting = listQueue().length;
    const activeIsListItem = state.goal?.policy === "list" && (state.goal.status === "active" || state.goal.status === "paused");
    if (waiting === 0 && !activeIsListItem) {
      ctx.ui.notify(`No list to cancel — nothing waiting, and the active goal (if any) isn't a list item. ${activeGoalSurfaceCommand("cancel")} aborts a standalone goal.`, "info");
      return;
    }
    const dropped = waiting;
    // v0.34.61: delete sidecars for every dropped item before clearing
    // state — see /list clear above for the same reason. cancel drops the
    // whole waiting list, so every sidecar must go.
    for (const item of listQueue()) deleteQueueItemFile(ctx.cwd, item.id);
    state = { ...state, list: [] };
    persistState(ctx);
    if (activeIsListItem) {
      archiveCurrentGoal(ctx, "aborted", "list cancelled");
      ctx.abort();
    }
    appendLedger(ctx.cwd, "list_cancelled", { abortedActive: activeIsListItem, dropped });
    ctx.ui.notify(
      `List cancelled: ${activeIsListItem ? "active item aborted + " : ""}${dropped} waiting item(s) dropped.${!activeIsListItem && state.goal && state.goal.status === "active" ? ` Active goal is not a list item — untouched (${activeGoalSurfaceCommand("cancel")} for that).` : ""}`,
      "info",
    );
    return;
  }

  if (sub === "next") {
    // Skip the current active goal (abort it) and activate a queued item.
    // Bare = the head (FIFO default); /list next <n> = item n (shopping-list
    // semantics: order is the default, not the law).
    const n = rest ? Number.parseInt(rest, 10) : 1;
    if (!Number.isInteger(n) || n < 1) {
      ctx.ui.notify(`Usage: /list next [1-${listQueue().length || 1}]`, "info");
      return;
    }
    // v0.28.14: one-active-thing — /list next must not jump a live loop.
    if (isLoopActive()) {
      ctx.ui.notify("A loop is active — /loop stop it before activating a list item.", "warning");
      return;
    }
    if (state.goal && state.goal.status === "active") {
      archiveCurrentGoal(ctx, "aborted", `skipped via /list next ${n > 1 ? n : ""}`.trim());
    }
    if (!activateNextListItem(ctx, n)) {
      ctx.ui.notify(listQueue().length === 0 ? "List is empty — nothing to activate." : `No item #${n} (list has ${listQueue().length}).`, "info");
    }
    return;
  }

  if (sub === "remove" || sub === "rm") {
    const n = Number.parseInt(rest, 10);
    const queue = listQueue();
    if (!Number.isFinite(n) || n < 1 || n > queue.length) {
      ctx.ui.notify(`Usage: /list remove <1-${queue.length}>`, "info");
      return;
    }
    const removed = queue[n - 1]!;
    // v0.34.61: delete the sidecar so the /list disk-recovery fallback
    // cannot resurrect the removed item. Without this, the new fallback
    // (cmdList → readQueueFromDisk) would show the removed item after
    // a stale-handle /list, contradicting the user's explicit remove.
    deleteQueueItemFile(ctx.cwd, removed.id);
    state = { ...state, list: queue.filter((_, i) => i !== n - 1) };
    persistState(ctx);
    appendLedger(ctx.cwd, "list_removed", { id: removed.id, objective: removed.objective });
    ctx.ui.notify(`Removed: ${displaySlice(removed.objective, 80)}`, "info");
    return;
  }

  // v0.34.53: /list settings is not a list verb — it used to fall into the
  // natural-language dump and start a drafting interview with seed
  // "settings". Settings live under /glla: the bare command opens the
  // settings table and the action verbs (status, resume, wipe, …) live
  // there too. Redirect explicitly — never draft from a settings query.
  // Read-only: works on a stale handle too, like the /glla read-only actions.
  if (sub === "settings") {
    appendLedger(ctx.cwd, "list_settings_redirect", {});
    ctx.ui.notify(
      "Settings are under /glla, not /list — bare /glla opens the settings table (status/log/stats/audits and the actions live there too).",
      "info",
    );
    return;
  }

  // v0.18.0: an unknown first word isn't an error — it's a natural-language
  // dump. "/list fix the login bug, add dark mode, write docs" should MAKE
  // a list, not print usage. Detection chain: file → batch → contract →
  // conversational decomposition (drafting). The explicit verb for adding
  // one item verbatim is /list add.
  let raw = args.trim();
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    raw = raw.slice(1, -1).trim();
  }
  // The dump fallthrough is always mutating — refuse it on a stale handle.
  if (staleEntry) {
    appendLedger(ctx.cwd, "list_mutation_refused_stale", { sub: "dump" });
    return;
  }
  const route = routeListText(ctx.cwd, raw);
  if (route.kind === "file") {
    await bulkAddFromFile(ctx, route.path);
    return;
  }
  if (route.kind === "batch") {
    await bulkAddItems(ctx, route.items, "pasted text");
    return;
  }
  if (route.kind === "direct") {
    addSingleItem(ctx, route.text);
    return;
  }
  await startDrafting(ctx, "list", route.seed);
}

/** Append one objective to the list; activate immediately when idle. */
function addSingleItem(ctx: ExtensionContext, raw: string): void {
  const { objective, verificationContract } = extractVerificationContract(raw);
  const item = { id: newGoalId(), objective, verificationContract: verificationContract || undefined, addedAt: nowIso() };
  // v0.34.61: disk-first — write the sidecar BEFORE mutating state so the
  // item survives an orchestrator-turn death between state mutation and
  // persistState (the original bug for /list add "<direct text>").
  writeQueueItemFile(ctx.cwd, item);
  state = { ...state, list: [...listQueue(), item] };
  persistState(ctx);
  appendLedger(ctx.cwd, "list_added", { id: item.id, objective: item.objective });
  // Nothing active → activate immediately.
  if (!state.goal || state.goal.status === "complete" || state.goal.status === "aborted") {
    activateNextListItem(ctx);
  } else {
    ctx.ui.notify(`Added to the list (${listQueue().length} waiting): ${displaySlice(objective, 80)}`, "info");
  }
}

/**
 * Push notification, folded IN by default (v0.28.34 — user: "leaving it to
 * the user to set up sucks, cause then they won't have it"). Resolution:
 *   notifyCmd === "off"   → silent (explicit opt-out)
 *   notifyCmd set         → that command, message passed as $1
 *   notifyCmd unset       → auto-detect ONCE per session: notify-send
 *                           (Linux) or osascript (macOS); none → silent.
 * Pushes fire only where there is something to DO — pauses, auditor
 * verdicts, storms, wedge, persistence degradation — never per-turn noise.
 * Fire-and-forget: a broken notifier never blocks the loop.
 */
let autoNotifyCmd: string | null | undefined; // undefined = not probed yet

function probeAutoNotify(ctx: ExtensionContext): void {
  if (autoNotifyCmd !== undefined || !extensionApi) return;
  autoNotifyCmd = null; // probing sentinel — drops at most the first push
  void extensionApi
    .exec("bash", ["-c", "command -v notify-send || command -v osascript || true"], { cwd: ctx.cwd })
    .then((r) => {
      const found = String((r as { stdout?: string }).stdout ?? "").trim();
      if (found.endsWith("notify-send")) autoNotifyCmd = `notify-send "pi-goal-list-loop-audit" "$1"`;
      // env-var handoff: the message never touches AppleScript quoting.
      else if (found.endsWith("osascript")) autoNotifyCmd = `GLLA_MSG="$1" osascript -e 'display notification (system attribute "GLLA_MSG") with title "pi-goal-list-loop-audit"'`;
      else autoNotifyCmd = null;
    })
    .catch(() => {
      autoNotifyCmd = null;
    });
}

function notifyExternal(ctx: ExtensionContext, message: string): void {
  try {
    // A stale or handoff-bound runtime has no valid pi exec API. The TUI
    // warning may still be best-effort, but never call the old pi handle.
    if (sessionHandoffPending || extensionApiStale) return;
    const settings = loadSettings(ctx.cwd);
    if (settings.notifyCmd === "off" || !extensionApi) return;
    const cmd = settings.notifyCmd ?? autoNotifyCmd;
    if (!cmd) {
      if (settings.notifyCmd === undefined && autoNotifyCmd === undefined) probeAutoNotify(ctx);
      return;
    }
    void extensionApi.exec("bash", ["-c", cmd, "pi-goal-list-loop-audit", sanitizeDisplayText(message)], { cwd: ctx.cwd }).catch(() => {});
  } catch {
    // non-fatal by design
  }
}

// =================================================================
// Loop 3: /loop — metric-driven process loop (never completes)
//
// The anti-doorknob law: the loop only believes a number. The orchestrator
// runs the user's measure command (via pi.exec) after every agent turn;
// the agent never self-reports progress. Termination: plateau, iteration
// cap, or /loop stop. There is NO auditor in loop 3 — the metric is the
// verdict.
// =================================================================

let loopTimer: NodeJS.Timeout | null = null;

function clearLoopTimer(): void {
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
}

function isLoopActive(): boolean {
  return !!state.loop?.active;
}

/** Run the user's measure command. Orchestrator-side, never agent-side. */
async function runMeasure(ctx: ExtensionContext, cmd: string): Promise<number | null> {
  if (!extensionApi || extensionApiStale) return null;
  try {
    const result = await extensionApi.exec("bash", ["-c", cmd], { cwd: ctx.cwd, timeout: MEASURE_TIMEOUT_MS });
    const stdout = (result as any)?.stdout ?? "";
    return parseMetric(String(stdout));
  } catch {
    return null;
  }
}

/** git wrapper for branch=1 mode. Returns {ok, stdout}; never throws. */
async function runGit(ctx: ExtensionContext, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  if (!extensionApi) return { ok: false, stdout: "" };
  try {
    const result = await extensionApi.exec("git", args, { cwd: ctx.cwd });
    const r = result as any;
    const code = typeof r?.code === "number" ? r.code : (r?.exitCode ?? 1);
    return { ok: code === 0, stdout: String(r?.stdout ?? "").trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function loopPrompt(loop: LoopState, regressionNote: string, strategyNote: string, boundsNote: string, interventionNote = "", variantNote = "", hypothesisNote = "", refineHintNote = ""): string {
  // v0.23.0: metricless loops get their own prompt — no metric section,
  // anti-doorknob rules instead of anti-gaming rules.
  const metricless = !loop.measureCmd;
  const tmplPath = path.resolve(__dirname, "..", "..", "prompts", metricless ? "goal-loop-forever-metricless.md" : "goal-loop-forever.md");
  let tmpl: string;
  try {
    tmpl = fs.readFileSync(tmplPath, "utf-8");
  } catch {
    tmpl = metricless
      ? `[LOOP ITERATION ${loop.iteration + 1}] Target: ${loop.target}. Metricless spec loop — make ONE real, inspectable change advancing the target. No cosmetic churn. ${variantNote} ${interventionNote}`
      : `[LOOP ITERATION ${loop.iteration + 1}] Target: ${loop.target}. Measure: ${loop.measureCmd} (${loop.direction}). Make ONE small change to improve the metric. ${interventionNote}`;
  }
  return tmpl
    .replace(/\$\{ITERATION\}/g, String(loop.iteration + 1))
    .replace(/\$\{TARGET\}/g, loop.target)
    .replace(/\$\{MEASURE_CMD\}/g, loop.measureCmd ?? "none")
    .replace(/\$\{DIRECTION\}/g, loop.direction ?? "none")
    .replace(/\$\{DIRECTION_WORD\}/g, loop.direction === "min" ? "lower is better" : "higher is better")
    .replace(/\$\{LAST_VALUE\}/g, loop.lastValue === null ? "(none yet)" : String(loop.lastValue))
    .replace(/\$\{BEST_VALUE\}/g, loop.bestValue === null ? "(none yet)" : String(loop.bestValue))
    .replace(/\$\{STALL_COUNT\}/g, String(loop.stallCount))
    .replace(/\$\{PLATEAU_WINDOW\}/g, String(loop.plateauWindow))
    .replace(/\$\{REGRESSION_NOTE\}/g, regressionNote)
    .replace(/\$\{STRATEGY_NOTE\}/g, strategyNote)
    .replace(/\$\{BOUNDS_NOTE\}/g, boundsNote)
    .replace(/\$\{INTERVENTION_NOTE\}/g, interventionNote)
    .replace(/\$\{VARIANT_NOTE\}/g, variantNote)
    .replace(/\$\{HYPOTHESIS_NOTE\}/g, hypothesisNote)
    .replace(/\$\{REFINE_HINT\}/g, refineHintNote);
}

function scheduleLoopTick(ctx: ExtensionContext): void {
  if (mainModelRecoveryActive()) return;
  if (sessionHandoffPending || initialSessionLoadPending || extensionApiStale || staleTerminalDone || zombieStoodDown || continuationDispatchStoodDown || pendingContinuationDispatch || !isLoopActive()) return;
  rememberCtx(ctx);
  clearLoopTimer();
  let delay = 0;
  try {
    delay = ctx.isIdle() && !ctx.hasPendingMessages() ? 0 : BACKOFF_IDLE_RETRY_MS;
  } catch {
    return;
  }
  loopTimer = scheduleSessionTimeout(() => sendLoopTurn(), delay);
}

function sendLoopTurn(): void {
  if (mainModelRecoveryActive()) return;
  if (sessionHandoffPending || initialSessionLoadPending || extensionApiStale || staleTerminalDone || zombieStoodDown || continuationDispatchStoodDown || pendingContinuationDispatch) return;
  loopTimer = null;
  if (!isLoopActive() || !extensionApi) return;
  const ctx = freshCtx();
  if (!ctx || !ctx.isIdle() || ctx.hasPendingMessages()) {
    if (!ctx) {
      // v0.33.1: mirror sendContinuation — probe the handle (terminal exit)
      // and advance the streak so the cadence backs off instead of spinning
      // a flat 50ms below every watchdog.
      if (probeExtensionApiStale()) return;
      loopRearmStreak++;
    } else accountSendRearm(ctx, "loop");
    loopTimer = scheduleSessionTimeout(() => sendLoopTurn(), sendRearmDelayMs(loopRearmStreak)); // v0.28.29: backing-off cadence
    return;
  }
  const loop = state.loop!;
  // v0.29.10: "regressed" = the last two measurements moved the WRONG way
  // — not merely "didn't beat best". The old trigger (any non-improving
  // iteration) cried REGRESSED on stalls and on the audit loop's
  // degenerate baseline-0, telling agents to undo GOOD fixes (junk-runner
  // 2026-07-30: 17→16 was real progress; the prompt demanded a revert).
  const hist = loop.history;
  const prevValue = hist.length >= 2 ? hist[hist.length - 2]!.value : null;
  const lastHistValue = hist.length >= 1 ? hist[hist.length - 1]!.value : null;
  const trueRegression = prevValue !== null && lastHistValue !== null && loop.direction !== undefined &&
    (loop.direction === "min" ? lastHistValue > prevValue : lastHistValue < prevValue);
  const regressionNote = trueRegression
    ? loop.kind === "audit"
      ? "**The closed-findings count went DOWN last iteration — a checked finding was reopened or findings.md was rewritten (both forbidden). Restore the closed entries, then keep fixing the highest-severity OPEN items.**"
      : "**Your last change REGRESSED the metric. Undo it first, then try a different small change.**"
    : "";
  // Strategy rotation (from pi-loop-mode's one good idea): one stall before
  // the plateau window closes, stop polishing and change approach entirely.
  const strategyNote = loop.stallCount >= loop.plateauWindow - 1 && loop.stallCount > 0
    ? "**You are one stall from a plateau stop. Small tweaks are not working — try a FUNDAMENTALLY different approach: different file, different technique, or revert and rethink the angle of attack.**" +
      // v0.33.2: a metric flat AT BEST may mean the spec stopped capturing
      // "better" — the loop holds the evidence, so it says so (was: the
      // prompt said "call propose_loop_refine" but the loop never suggested it).
      (loop.lastValue !== null && loop.lastValue === loop.bestValue
        ? " **The metric has been flat at best — if the spec no longer captures 'better' (saturated metric, drifted target), call propose_loop_refine.**"
        : "")
    : "";
  // v0.34.0: divergence bail (pi-auto-review's one good idea) — N consecutive
  // iterations moving the metric the WRONG way means the changes themselves
  // are hurting (audit loops: fixes breaking things / findings reopening).
  // Note-only: the agent reassesses; nothing auto-stops.
  let trailingRegressions = 0;
  if (loop.direction) {
    for (let i = hist.length - 1; i > 0; i--) {
      const a = hist[i - 1]!.value, b = hist[i]!.value;
      if (a === null || b === null) break; // metricless ticks carry no value
      const regressed = loop.direction === "min" ? b > a : b < a;
      if (regressed) trailingRegressions++; else break;
    }
  }
  const divergenceNote = trailingRegressions >= 3
    ? `**${trailingRegressions} consecutive regressions — every recent change moved the metric the WRONG way. Stop making small edits and reassess the whole approach: are the fixes breaking things, or is the measure being gamed? If the target itself is drifting, call propose_loop_refine or recommend /loop stop.**`
    : "";
  const strategyNote2 = strategyNote + (strategyNote && divergenceNote ? " " : "") + divergenceNote;
  // v0.15.0: arbitrary bounds (never "completion") — surface what's armed.
  // v0.23.0: for metricless loops the bounds are the ONLY stop (no
  // plateau), so the note names that — and an unbounded metricless loop
  // gets the furnace warning.
  const metricless = !loop.measureCmd;
  const bounds: string[] = [];
  if (loop.timeLimitHours !== undefined) bounds.push(`${loop.timeLimitHours}h`);
  if (loop.tokenBudget !== undefined) bounds.push(`${loop.tokenBudget.toLocaleString()} tokens (used ${(loop.tokensUsed ?? 0).toLocaleString()})`);
  let boundsNote = "";
  if (metricless) {
    if (loop.maxIterations > 0) bounds.unshift(`${loop.maxIterations} iterations`);
    boundsNote = bounds.length
      ? `\n- Bounds armed: the loop ends after ${bounds.join(" or ")} — or /loop stop. There is NO plateau stop.`
      : `\n- NO bounds armed — this loop ends only at /loop stop. Spend each iteration like it costs money; it does.`;
  } else if (bounds.length) {
    boundsNote = `\n- Arbitrary bounds: the loop also stops after ${bounds.join(" or ")}`;
  }
  // v0.24.0: a stuck intervention REPLACES the pep talk — the rotating
  // directive names why the loop is stuck and what rung of the ladder it's on.
  // v0.29.19: a plateau reprieve's one-shot shove takes priority over the
  // stuck directive (they can't both be meaningful in the same iteration).
  const reprieveNote = loop.auditReprieveNote ?? "";
  if (reprieveNote) loop.auditReprieveNote = undefined;
  const interventionNote = reprieveNote || ((loop.consecutiveStuck ?? 0) > 0 && loop.lastStuckReason
    ? loopInterventionDirective(loop.consecutiveStuck!, loop.lastStuckReason, loop.recentTexts ?? [])
    : "");
  // v0.24.0: identical prompts invite identical answers — rotate the base
  // instruction (metricless loops; metric loops already vary via values).
  const variantNote = metricless ? continueVariant(loop.iteration) : "";
  // v0.33.2: one-shot prompt payloads, consumed on use.
  const hypothesisNote = loop.hypothesisFeedback ?? "";
  if (hypothesisNote) loop.hypothesisFeedback = undefined;
  const refineHintNote = loop.refineHint
    ? `**The operator suggests refining the spec:** ${loop.refineHint} — if the current spec no longer captures "better", call propose_loop_refine (target and/or measureCmd${loop.specFile ? " and/or specText/specAppend" : ""}); if it still stands, say why in one line and keep working.`
    : "";
  if (refineHintNote) loop.refineHint = undefined;
  try {
    let loopResync = "";
    if (postCompactResyncPending) { try { loopResync = buildPostCompactResync(); } catch { loopResync = ""; } } // v0.33.1
    const attempt = dispatchPrepare(ctx, {
      generation: sessionGeneration,
      ownerSessionId: sessionManagerId(ctx),
      kind: "loop",
      iteration: loop.iteration + 1,
      marker: `[LOOP ITERATION ${loop.iteration + 1}]`,
      resync: Boolean(loopResync),
    });
    if (!attempt) return;
    extensionApi.sendMessage({
      customType: GOAL_EVENT_ENTRY,
      content: loopResync + loopPrompt(loop, regressionNote, strategyNote2, boundsNote, interventionNote, variantNote, hypothesisNote, refineHintNote),
      display: false,
    }, { triggerTurn: true, deliverAs: "followUp" });
    if (!dispatchAccepted(ctx, attempt)) return;
    // v0.26.1: the send path is ledgered — the hegemon zombie spun 619
    // refires with zero visibility into whether sends were landing.
    loopRearmStreak = 0; loopRearmSince = 0; // v0.28.5 (E3): an accepted dispatch clears the storm
    appendLedger(ctx.cwd, "loop_turn_sent", { iteration: loop.iteration, attemptId: attempt.id, generation: attempt.generation });
    if (pendingContinuationDispatch === null) return; // before_agent_start acked synchronously
    lastContinuationSentAt = attempt.sentAt;
    armQueueStuckProbe(lastContinuationSentAt);
  } catch (err) {
    // stale API — next agent_end reschedules (but if none comes, the
    // heartbeat's stall escalation stops the spin — v0.26.1).
    if (pendingContinuationDispatch) dispatchFailed(ctx, pendingContinuationDispatch, err instanceof Error ? err.message : String(err));
    appendLedger(ctx.cwd, "loop_turn_send_failed", { error: err instanceof Error ? err.message : String(err) });
    // v0.26.7: stale runtime is terminal, not transient — go loud now.
    if (isStaleApiError(err)) goStaleTerminal(ctx, "sendLoopTurn");
  }
}

/** agent_end hook for loop 3: measure → judge → continue or stop. */
async function runLoopTick(initialCtx: ExtensionContext, event?: any): Promise<void> {
  // v0.34.20: measurement/git work is asynchronous. Rebind the local
  // context after every await or abandon the tick; never let a replacement
  // session inherit the agent_end context.
  const generation = sessionGeneration;
  const initial = freshCtxForGeneration(generation);
  if (!initial) return;
  let ctx: ExtensionContext = initial;
  const rebind = (): boolean => {
    const current = freshCtxForGeneration(generation);
    if (!current) return false;
    ctx = current;
    return true;
  };
  const loop = state.loop!;
  // v0.15.0: token budget is an arbitrary bound; accumulate orchestrator-side.
  if (event?.messages) {
    loop.tokensUsed = (loop.tokensUsed ?? 0) + sumNewAssistantTokens(event.messages as unknown[], countedLoopTokenMessages);
  }
  const metricless = !loop.measureCmd;
  const value = metricless ? null : await runMeasure(ctx, loop.measureCmd!);
  if (!rebind()) return;
  // Hypothesis line (pi-autoresearch's good idea): the agent's stated intent
  // for the turn goes into the ledger, making loop history auditable.
  let hypothesis: string | undefined;
  let lastAssistantText = "";
  if (event) {
    const last = [...(event.messages as any[])].reverse().find((m) => m.role === "assistant");
    lastAssistantText = last && Array.isArray(last.content) ? last.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : "";
    hypothesis = lastAssistantText.match(/^HYPOTHESIS:\s*(.+)$/m)?.[1]?.trim().slice(0, 200);
  }
  // v0.24.0 anti-repetition: roll the behavior windows, then classify. The
  // plateau stop watches the NUMBER; this watches the WORK — a metricless
  // loop (no number) has no other defense against doorknob-polishing.
  const toolsUsed = loop.toolsThisTurn ?? 0;
  loop.toolsThisTurn = 0;
  loop.toollessStreak = toolsUsed === 0 ? (loop.toollessStreak ?? 0) + 1 : 0;
  // v0.25.1 multi-signal stuck gate: gather the iteration's progress
  // signals BEFORE classifying — file writes (tool_result bumps), git
  // commits since the iteration began (HEAD advance), spec_item_progress
  // ledger events since the iteration began. ANY positive signal exempts
  // the iteration: stable verification from a shipping loop is the goal
  // state of a metricless loop, not the stuck state.
  const iterStartHead = loop.iterMetrics?.iterationStartHead;
  const iterStartAt = loop.iterMetrics?.iterationStartAt;
  const currentHeadRes = await runGit(ctx, ["rev-parse", "HEAD"]);
  if (!rebind()) return;
  const currentHead = currentHeadRes.ok ? currentHeadRes.stdout : undefined;
  let gitCommits = 0;
  if (iterStartHead && currentHead && iterStartHead !== currentHead) {
    const countRes = await runGit(ctx, ["rev-list", "--count", `${iterStartHead}..HEAD`]);
    if (!rebind()) return;
    const n = Number.parseInt(countRes.stdout, 10);
    if (countRes.ok && Number.isFinite(n) && n > 0) gitCommits = n;
  }
  let specItemProgress = 0;
  if (iterStartAt) {
    try {
      const ledgerPath = path.join(ctx.cwd, ".pi-glla", "active.jsonl");
      const lines = fs.readFileSync(ledgerPath, "utf-8").split("\n");
      for (const line of lines) {
        if (!line.includes("spec_item_progress")) continue;
        try {
          const entry = JSON.parse(line) as { at?: string };
          if (entry.at && entry.at >= iterStartAt) specItemProgress++;
        } catch { /* malformed line */ }
      }
    } catch { /* no ledger yet */ }
  }
  // v0.33.2: respec spec drift + checkbox progress — hash compared per
  // tick (external edits ledger spec_updated); newly checked boxes emit
  // the spec_item_progress signal the stuck gate already consumes (it was
  // consumed-but-never-emitted until now).
  if (loop.specFile) {
    const hash = specFileHash(loop.specFile);
    if (hash && loop.specHash && loop.specHash !== hash) {
      appendLedger(ctx.cwd, "spec_updated", { via: "external", iteration: loop.iteration });
      ctx.ui.notify("Spec file changed mid-loop — drift ledgered (spec_updated).", "info");
    }
    if (hash) loop.specHash = hash;
    const checked = countCheckedSpecItems(loop.specFile);
    if (checked !== null && loop.specChecked !== undefined && checked > loop.specChecked) {
      appendLedger(ctx.cwd, "spec_item_progress", { iteration: loop.iteration, newlyChecked: checked - loop.specChecked, totalChecked: checked });
    }
    if (checked !== null) loop.specChecked = checked;
  }
  const iterSignals = {
    fileWrites: loop.iterMetrics?.fileWrites ?? 0,
    gitCommits,
    specItemProgress,
    currentHead,
  };
  const previousText = loop.recentTexts && loop.recentTexts.length > 0 ? loop.recentTexts[loop.recentTexts.length - 1] : undefined;
  if (lastAssistantText) {
    loop.recentPrints = pushRepetitionCapped(loop.recentPrints ?? [], textFingerprint(lastAssistantText), REPETITION.printWindow);
    loop.recentTexts = pushRepetitionCapped(loop.recentTexts ?? [], lastAssistantText, REPETITION.textWindow);
  }
  const stuckReason = isActuallyStuck({
    assistantText: lastAssistantText,
    recentPrints: loop.recentPrints ?? [],
    previousText,
    recentToolResults: loop.recentToolResults ?? [],
    toollessStreak: loop.toollessStreak ?? 0,
    fileWriteCount: iterSignals.fileWrites,
    gitCommitCount: iterSignals.gitCommits,
    specItemProgressCount: iterSignals.specItemProgress,
  }, loop.toolSameRepeat);
  // Reset the accumulators so the NEXT iteration measures only itself.
  loop.iterMetrics = {
    fileWrites: 0,
    iterationStartHead: iterSignals.currentHead ?? loop.iterMetrics?.iterationStartHead,
    iterationStartAt: nowIso(),
  };
  if (stuckReason) {
    loop.consecutiveStuck = (loop.consecutiveStuck ?? 0) + 1;
    loop.lastStuckReason = stuckReason;
    appendLedger(ctx.cwd, "loop_stuck", { iteration: loop.iteration, reason: stuckReason, consecutive: loop.consecutiveStuck });
    if (loop.consecutiveStuck === 1 || loop.consecutiveStuck >= REPETITION.hardResetAfter) {
      ctx.ui.notify(`Loop stuck (${loop.consecutiveStuck}×): ${stuckReason}`, "warning");
    }
  } else {
    loop.consecutiveStuck = 0;
    loop.lastStuckReason = undefined;
  }
  let outcome: LoopTickOutcome = metricless ? applyMetriclessTick(loop, nowIso()) : applyMeasurement(loop, value, nowIso());
  // v0.33.2: close the hypothesis feedback loop — the prediction went into
  // the ledger; now the VERDICT rides the next iteration's prompt.
  if (loop.lastHypothesis) {
    const h = loop.history;
    const cur = h.length >= 1 ? h[h.length - 1]!.value : null;
    const prev = h.length >= 2 ? h[h.length - 2]!.value : null;
    if (metricless || cur === null) {
      loop.hypothesisFeedback = `Last iteration you predicted: "${loop.lastHypothesis}". ${metricless ? "Metricless loop — no number to verify it against; say honestly whether the prediction landed." : "The measure printed no number — the prediction is unverifiable."}`;
    } else {
      const moved = prev === null
        ? `first measurement ${cur}`
        : cur === prev
          ? `flat at ${cur}`
          : loop.direction === "min"
            ? (cur < prev ? `improved ${prev} → ${cur}` : `regressed ${prev} → ${cur}`)
            : (cur > prev ? `improved ${prev} → ${cur}` : `regressed ${prev} → ${cur}`);
      loop.hypothesisFeedback = `Last iteration you predicted: "${loop.lastHypothesis}". Result: metric ${moved} (best ${loop.bestValue}).`;
    }
  }
  loop.lastHypothesis = hypothesis;
  persistState(ctx);
  appendLedger(ctx.cwd, "loop_measured", {
    iteration: loop.iteration,
    value,
    best: loop.bestValue,
    stall: loop.stallCount,
    hypothesis,
    stuck: stuckReason,
  });
  // branch=1 mode: commit improvements, hard-reset regressions — always and
  // only on the scratch branch. v0.23.0: a metricless loop has no regression
  // signal, so every iteration stands and is committed.
  if (loop.branchName && outcome.kind === "continue") {
    if (metricless || outcome.improved) {
      await runGit(ctx, ["add", "-A"]);
      if (!rebind()) return;
      const committed = await runGit(ctx, ["commit", "-m", metricless ? `pi-glla-loop: iteration ${loop.iteration}` : `pi-glla-loop: iteration ${loop.iteration} (${loop.direction}=${loop.bestValue})`]);
      if (!rebind()) return;
      appendLedger(ctx.cwd, "loop_git", { action: "commit", iteration: loop.iteration, ok: committed.ok });
    } else {
      const reset = await runGit(ctx, ["reset", "--hard", "HEAD"]);
      if (!rebind()) return;
      appendLedger(ctx.cwd, "loop_git", { action: "reset", iteration: loop.iteration, ok: reset.ok });
    }
    persistState(ctx);
  }
  // v0.24.0: the top of the stuck ladder — bounded and surfaced, same
  // philosophy as a plateau stop. The loop ends WITH the reason, not in silence.
  // v0.25.0: aggressiveMode raises the ladder (default 5 → 10, explicit wins).
  const maxStuckInterventions = resolveEffectiveAggressiveSettings(loadSettings(ctx.cwd)).stuckMaxInterventions;
  if (outcome.kind !== "stop" && (loop.consecutiveStuck ?? 0) >= maxStuckInterventions) {
    loop.active = false;
    loop.stopReason = `stuck — ${loop.lastStuckReason} (${loop.consecutiveStuck} consecutive interventions)`;
    persistState(ctx);
    await finishLoopGit(ctx, loop);
    if (!rebind()) return;
    ctx.ui.notify(`Loop stopped: ${loop.stopReason}. ${loop.history.length} iterations recorded.`, "warning");
    appendLedger(ctx.cwd, "loop_stopped", { reason: loop.stopReason, iterations: loop.iteration, best: loop.bestValue });
    notifyExternal(ctx, `Loop stopped: ${loop.stopReason}`);
    return;
  }
  if (outcome.kind === "stop") {
    // v0.29.19: an audit loop's plateau is only honest when the well is
    // ACTUALLY dry. Plateauing with open findings means the agent fumbled
    // (or the provider ate) N turns — not "nothing left" (field: hegemon
    // stopped at best 74 with 13 OPEN boxes; polis at best 46 with 3+).
    // Stand the stop down with a strategy shove — bounded: the plateau
    // after the last reprieve stops with an honest blocked-named reason.
    if (loop.kind === "audit" && outcome.reason.startsWith("plateau —")) {
      const open = countOpenAuditFindings(ctx.cwd);
      if (open > 0) {
        const reprieves = (loop.auditPlateauReprieves ?? 0) + 1;
        if (reprieves <= AUDIT_PLATEAU_MAX_REPRIEVES) {
          loop.active = true;
          loop.stopReason = undefined;
          loop.stallCount = 0;
          loop.auditPlateauReprieves = reprieves;
          const topFinding = topOpenAuditFinding(ctx.cwd); // v0.33.2: name what to close, not just the count
          loop.auditReprieveNote = `PLATEAU REPRIEVE (${reprieves}/${AUDIT_PLATEAU_MAX_REPRIEVES}): ${open} finding(s) still OPEN in ${AUDIT_FINDINGS_REL} — the plateau stop does not fire while the well isn't dry. Stop hunting and stop narrating: pick the smallest OPEN finding and CLOSE it this iteration (fix commit + checked box).${topFinding ? ` Top open: ${topFinding}` : ""} ${AUDIT_PLATEAU_MAX_REPRIEVES - reprieves} reprieve(s) remain.`;
          persistState(ctx);
          appendLedger(ctx.cwd, "audit_plateau_reprieve", { open, reprieves, best: loop.bestValue });
          ctx.ui.notify(`Audit loop plateau reprieve (${reprieves}/${AUDIT_PLATEAU_MAX_REPRIEVES}): ${open} open findings — the well isn't dry, continuing.`, "info");
          scheduleLoopTick(ctx);
          return;
        }
        const honest = `plateau — no closure in ${loop.plateauWindow}×${reprieves} iterations despite ${open} open findings (treat as blocked; /loop resume to push again)`;
        loop.stopReason = honest;
        persistState(ctx);
        outcome = { kind: "stop", reason: honest };
      }
    }
    await finishLoopGit(ctx, loop);
    if (!rebind()) return;
    ctx.ui.notify(`Loop stopped: ${outcome.reason}. ${loop.history.length} iterations recorded.`, "info");
    appendLedger(ctx.cwd, "loop_stopped", { reason: outcome.reason, iterations: loop.iteration, best: loop.bestValue });
    notifyExternal(ctx, `Loop stopped: ${outcome.reason}`);
    return;
  }
  scheduleLoopTick(ctx);
}

/** On loop stop (any reason): return to the original branch, tell the user
 * where the work lives and how to merge it. Scratch branch is never deleted. */
async function finishLoopGit(ctx: ExtensionContext, loop: LoopState): Promise<void> {
  if (!loop.branchName) return;
  const generation = sessionGeneration;
  // Uncommitted remnants (final stalled iterations were reset already, but be safe).
  await runGit(ctx, ["reset", "--hard", "HEAD"]);
  const afterReset = freshCtxForGeneration(generation);
  if (!afterReset) return;
  ctx = afterReset;
  if (loop.originalBranch) {
    await runGit(ctx, ["checkout", loop.originalBranch]);
    const afterCheckout = freshCtxForGeneration(generation);
    if (!afterCheckout) return;
    ctx = afterCheckout;
  }
  ctx.ui.notify(
    `Loop work is on branch ${loop.branchName} (${loop.iteration} iterations, best ${loop.bestValue ?? "n/a"}).\nMerge with: git merge ${loop.branchName} — or delete with: git branch -D ${loop.branchName}`,
    "info",
  );
  appendLedger(ctx.cwd, "loop_git", { action: "finish", branch: loop.branchName, returnedTo: loop.originalBranch });
}

interface LoopConfig {
  target: string;
  /** Empty string = metricless spec loop (v0.23.0). */
  measureCmd: string;
  direction?: "min" | "max";
  plateauWindow: number;
  maxIterations: number;
  branch: boolean;
  force?: boolean;
  timeLimitHours?: number;
  tokenBudget?: number;
  /** v0.25.1: /loop start toolsamerepeat=N (0 = disable legacy check). */
  toolSameRepeat?: number;
  /** v0.29.10: don't seed bestValue from the pre-work baseline measure —
   * the first REAL measurement becomes the baseline. For loops whose
   * metric is created BY the first iteration (the audit loop: 0 open
   * findings just means findings.md doesn't exist yet); a seeded 0 pins
   * best at a value no iteration can beat, stalling every iteration. */
  deferBaseline?: boolean;
  /** v0.29.10: audit loops get audit-flavoured regression wording. */
  kind?: "audit";
  /** v0.33.2: respec loops carry their spec file (drift detection,
   * checkbox progress, refine specText writes). */
  specFile?: string;
}

/** Shared loop-start path: /loop start AND propose_loop_draft (after Confirm). */
async function startLoopFromConfig(ctx: ExtensionContext, cfg: LoopConfig): Promise<boolean> {
  releaseInitialSessionLoadBarrier();
  // branch=1 mode: scratch branch ONLY. Refuse on non-git or dirty tree —
  // we never mix uncommitted user work into the loop's branch.
  let branchName: string | undefined;
  let originalBranch: string | undefined;
  if (cfg.branch) {
    const isRepo = await runGit(ctx, ["rev-parse", "--is-inside-work-tree"]);
    if (!isRepo.ok) {
      ctx.ui.notify("branch=1 requires a git repository.", "warning");
      return false;
    }
    const dirty = await runGit(ctx, ["status", "--porcelain"]);
    if (!dirty.ok || dirty.stdout.length > 0) {
      ctx.ui.notify("branch=1 requires a clean working tree — commit or stash your changes first.", "warning");
      return false;
    }
    const current = await runGit(ctx, ["rev-parse", "--abbrev-ref", "HEAD"]);
    originalBranch = current.ok ? current.stdout : undefined;
    branchName = loopBranchName(nowIso(), cfg.target);
    const created = await runGit(ctx, ["checkout", "-b", branchName]);
    if (!created.ok) {
      ctx.ui.notify(`Failed to create scratch branch ${branchName}.`, "warning");
      return false;
    }
  }
  // Baseline measurement before the first agent turn. A measure that
  // produces no number is a footgun: without a baseline the loop burns stall
  // iterations before plateau stops it. Refuse fast (force=1 overrides for
  // measures that only work after the agent builds something first).
  // v0.23.0: metricless loops skip the baseline entirely — there is no
  // measure to run, and no plateau to protect.
  const metricless = !cfg.measureCmd;
  const baseline = metricless || cfg.deferBaseline ? null : await runMeasure(ctx, cfg.measureCmd);
  if (!metricless && !cfg.deferBaseline && baseline === null && !(cfg as { force?: boolean }).force) {
    ctx.ui.notify(
      `/loop start refused: the measure produced no number.\nCommand: ${cfg.measureCmd}\nFix it so it prints exactly one number, or re-run with force=1 if it only works after the agent builds something first.\n(Non-numeric goal — research, docs, features? Use /goal: the independent auditor verifies semantically. /loop only believes a number.)`,
      "warning",
    );
    return false;
  }
  resolveCarryover(ctx, "loop"); // v0.28.14: surface/clear stale leftovers
  releaseContinuationDispatchStandDown();
  state = {
    ...state,
    loop: {
      target: cfg.target,
      measureCmd: cfg.measureCmd || undefined,
      direction: cfg.direction,
      iteration: 0,
      maxIterations: cfg.maxIterations,
      plateauWindow: cfg.plateauWindow,
      stallCount: 0,
      bestValue: cfg.deferBaseline ? null : baseline,
      lastValue: cfg.deferBaseline ? null : baseline,
      kind: cfg.kind,
      active: true,
      history: [],
      startedAt: nowIso(),
      timeLimitHours: cfg.timeLimitHours,
      tokenBudget: cfg.tokenBudget,
      tokensUsed: 0,
      branchName,
      originalBranch,
      toolSameRepeat: cfg.toolSameRepeat,
      specFile: cfg.specFile,
      specHash: cfg.specFile ? specFileHash(cfg.specFile) ?? undefined : undefined,
      specChecked: cfg.specFile ? countCheckedSpecItems(cfg.specFile) ?? undefined : undefined,
      iterMetrics: { fileWrites: 0, iterationStartAt: nowIso() },
    },
  };
  persistState(ctx);
  appendLedger(ctx.cwd, "loop_started", { target: cfg.target, measureCmd: cfg.measureCmd || "none", direction: cfg.direction ?? "none", baseline, branch: branchName, timeLimitHours: cfg.timeLimitHours, tokenBudget: cfg.tokenBudget });
  ctx.ui.notify(
    metricless
      ? `Loop started (metricless spec loop — NO plateau stop): ${displaySlice(cfg.target, 60)}\nEnds only at ${cfg.maxIterations > 0 ? `max ${cfg.maxIterations} iterations` : "no iteration cap"}${cfg.timeLimitHours ? ` · ${cfg.timeLimitHours}h` : ""}${cfg.tokenBudget ? ` · ${cfg.tokenBudget.toLocaleString()} tokens` : ""} · /loop stop. Every iteration must make ONE real, inspectable change — cosmetic churn is the doorknob failure.` +
        (branchName ? `\nbranch mode: committing each iteration to ${branchName}` : "")
      : `Loop started: ${displaySlice(cfg.target, 60)}\nBaseline: ${cfg.deferBaseline ? "deferred — the first real measurement seeds it" : (baseline ?? "(forced without a number — first turn must produce one)")} · direction ${cfg.direction} · window ${cfg.plateauWindow} · ${cfg.maxIterations > 0 ? `max ${cfg.maxIterations}` : "no iteration cap"}` +
        (branchName ? `\nbranch mode: committing improvements to ${branchName}` : ""),
    "info",
  );
  scheduleLoopTick(ctx);
  return true;
}

async function cmdLoop(args: string, ctx: ExtensionContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] ?? "").toLowerCase();
  const rest = args.trim().slice(sub.length).trim();

  if (!sub || sub === "resume") {
    releaseInitialSessionLoadBarrier();
    if (state.mainModelRecovery?.manualResumeRequired && state.mainModelRecovery.kind === "loop") {
      manuallyResumeMainModelRecovery(ctx);
      return;
    }
    if (state.mainModelRecovery?.retryAt && state.mainModelRecovery.kind === "loop") {
      clearMainModelRecoveryTimer();
      continuationDispatchStoodDown = false;
      ctx.ui.notify("Retrying the saved main-model recovery now — one provider probe, then the configured backups if needed.", "info");
      void probeMainModelRecovery(ctx);
      return;
    }
    // /loop with no args (or /loop resume, v0.28.22) → resume a held loop
    // if one is waiting; otherwise draft the loop config (metric design is
    // the whole game for a long-running loop; never start one blind).
    if (isLoopActive()) {
      if (continuationDispatchStoodDown) {
        releaseContinuationDispatchStandDown();
        scheduleLoopTick(ctx);
        ctx.ui.notify("Loop dispatch stand-down cleared — retrying one continuation explicitly.", "info");
      } else {
        ctx.ui.notify("A loop is already active — /loop status to inspect, /loop stop to end it.", "info");
      }
      return;
    }
    const stored = state.loop;
    // v0.29.20: plain plateau stops are resumable too — pre-gate plateaus
    // could be false (hegemon/polis stopped 2026-07-31 with open findings
    // on 429-dead turns), and an explicit resume is the user's call; the
    // v0.29.19 gate + re-armed counters make the resumed run honest.
    const RESUMABLE_STOP = (r?: string): boolean =>
      r === HELD_ON_RESTORE ||
      !!r?.startsWith("provider errors —") ||
      !!r?.startsWith("stopped by user —") ||
      !!r?.startsWith("plateau —") ||
      !!r?.startsWith("stalled:") ||
      !!r?.startsWith("stuck —");
    if (stored && !stored.active && RESUMABLE_STOP(stored.stopReason)) {
      // v0.28.14: one-active-thing — a held loop must not resume over an
      // active goal/list-item (this was the last unguarded stacking path).
      if (state.goal && state.goal.status === "active") {
        ctx.ui.notify(`A goal is active — the held loop stays held. ${activeGoalSurfaceCommand("pause")} or ${activeGoalSurfaceCommand("cancel")} it first, then /loop resume.`, "warning");
        return;
      }
      // An explicit resume re-arms the counters: fresh stall window,
      // cleared dead-turn/stuck streaks, reprieves restored — the user
      // saying "push again" wins over the ladder's memory (v0.29.19).
      state.loop = { ...stored, active: true, stopReason: undefined, consecutiveErrors: 0, consecutiveStuck: 0, lastStuckReason: undefined, stallCount: 0, auditPlateauReprieves: 0 };
      persistState(ctx);
      releaseContinuationDispatchStandDown();
      scheduleLoopTick(ctx);
      ctx.ui.notify(
        `Loop resumed: iteration ${stored.iteration}/${stored.maxIterations > 0 ? stored.maxIterations : "∞"} · best ${stored.bestValue ?? "n/a"} — ${displaySlice(stored.target, 60)}`, 
        "info",
      );
      return;
    }
    if (sub === "resume") {
      ctx.ui.notify("No held loop to resume. /loop to draft one, or /loop start \"<target>\" for an infinite metricless loop.", "info");
      return;
    }
    await startDrafting(ctx, "loop");
    return;
  }

  if (sub === "status") {
    const loop = state.loop;
    if (!loop) {
      ctx.ui.notify("No loop. /loop to draft one, /loop start \"<target>\" for an infinite metricless loop, or add measure=\"<cmd>\" direction=min|max for a metric loop [window=5] [max=50] [time=<hours>] [tokens=<budget>]", "info");
      return;
    }
    const lines = [
      `Loop: ${loop.active ? "active" : "stopped"} — ${displaySlice(loop.target, 80)}`, 
      `Metric: ${loop.measureCmd ? `${loop.measureCmd} (${loop.direction})` : "none — metricless spec loop (no plateau)"}`,
      `Iteration ${loop.iteration}/${loop.maxIterations > 0 ? loop.maxIterations : "∞"} · best ${loop.bestValue ?? "n/a"} · last ${loop.lastValue ?? "n/a"} · stall ${loop.stallCount}/${loop.plateauWindow}`,
    ];
    const bounds: string[] = [];
    if (loop.timeLimitHours !== undefined) bounds.push(`time ≤ ${loop.timeLimitHours}h`);
    if (loop.tokenBudget !== undefined) bounds.push(`tokens ${(loop.tokensUsed ?? 0).toLocaleString()}/${loop.tokenBudget.toLocaleString()}`);
    if (bounds.length) lines.push(`Bounds: ${bounds.join(" · ")}`);
    if (loop.refinements?.length) lines.push(`Spec refined ${loop.refinements.length}× (latest: iteration ${loop.refinements[loop.refinements.length - 1]!.iteration})`);
    if (loop.stopReason) lines.push(`Stopped: ${loop.stopReason}`);
    const tail = loop.history.slice(-5);
    if (tail.length > 0) {
      lines.push("Recent: " + tail.map((h) => `${h.value ?? "ERR"}${h.improved ? "↑" : ""}`).join(" "));
    }
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  if (sub === "start") {
    if (state.goal && state.goal.status === "active") {
      ctx.ui.notify(`A goal is active — ${activeGoalSurfaceCommand("cancel")} or ${activeGoalSurfaceCommand("pause")} it before starting a loop.`, "warning");
      return;
    }
    if (isLoopActive()) {
      ctx.ui.notify("A loop is already active. /loop stop first.", "warning");
      return;
    }
    let cfg;
    try {
      cfg = parseLoopStartArgs(rest);
    } catch (err) {
      ctx.ui.notify(
        `/loop start: ${err instanceof Error ? err.message : String(err)}\n(Non-numeric goal — research, docs, features? Use /goal: the auditor verifies semantically. /loop only believes a number. Or /loop with no args to draft.)`,
        "warning",
      );
      return;
    }
    await startLoopFromConfig(ctx, cfg);
    return;
  }

  // v0.28.14: /loop cancel is a first-class alias — users reached for
  // /goal cancel to kill loops because "cancel" is the verb they know.
  if (sub === "refine" || sub === "polish") {
    // v0.33.2: the operator's respec verb. The refine flow stays
    // agent-proposed + user-confirmed (propose_loop_refine) — this command
    // queues the operator's suggestion into the next iteration's prompt.
    // ("polish" accepted as an alias: the widget footer advertised it
    // before the command existed — now it does.)
    if (!isLoopActive()) {
      ctx.ui.notify("No active loop to refine — /loop start first.", "warning");
      return;
    }
    const hint = rest.trim();
    if (!hint) {
      ctx.ui.notify("Usage: /loop refine <what the spec should capture better> — the suggestion rides the next iteration's prompt; the agent proposes via propose_loop_refine and you confirm.", "info");
      return;
    }
    state.loop!.refineHint = hint.slice(0, 300);
    persistState(ctx);
    appendLedger(ctx.cwd, "loop_refine_hint", { iteration: state.loop!.iteration, hint: state.loop!.refineHint });
    ctx.ui.notify("Refine hint queued — it rides the next iteration's prompt.", "info");
    return;
  }

  if (sub === "stop" || sub === "cancel") {
    if (!state.loop) {
      ctx.ui.notify("No loop to stop.", "info");
      return;
    }
    clearLoopTimer();
    if (state.mainModelRecovery?.kind === "loop") {
      clearMainModelRecoveryTimer();
      state.mainModelRecovery = undefined;
      mainModelAbortForRecovery = false;
      continuationDispatchStoodDown = false;
    }
    state.loop = { ...state.loop, active: false, stopReason: state.loop.stopReason ?? `stopped by user (/loop ${sub})` };
    persistState(ctx);
    const stopGeneration = sessionGeneration;
    await finishLoopGit(ctx, state.loop);
    const afterFinish = freshCtxForGeneration(stopGeneration);
    if (!afterFinish) return;
    ctx = afterFinish;
    appendLedger(ctx.cwd, "loop_stopped", { reason: "user", iterations: state.loop.iteration, best: state.loop.bestValue });
    ctx.ui.notify(
      `Loop stopped after ${state.loop.iteration} iterations. Best: ${state.loop.bestValue ?? "n/a"}.`,
      "info",
    );
    notifyExternal(ctx, `Loop stopped by user after ${state.loop.iteration} iterations (best: ${state.loop.bestValue ?? "n/a"})`);
    return;
  }

  // v0.25.1: a CLEAN end — "completed: <reason>", distinct from
  // stuck/plateau/stopped-by-user. Additive: /loop stop is untouched.
  if (sub === "finish") {
    if (!state.loop) {
      ctx.ui.notify("No loop to finish.", "info");
      return;
    }
    clearLoopTimer();
    if (state.mainModelRecovery?.kind === "loop") {
      clearMainModelRecoveryTimer();
      state.mainModelRecovery = undefined;
      mainModelAbortForRecovery = false;
      continuationDispatchStoodDown = false;
    }
    const reason = loopFinishStopReason(rest);
    state.loop = { ...state.loop, active: false, stopReason: reason };
    persistState(ctx);
    const finishGeneration = sessionGeneration;
    await finishLoopGit(ctx, state.loop);
    const afterFinish = freshCtxForGeneration(finishGeneration);
    if (!afterFinish) return;
    ctx = afterFinish;
    appendLedger(ctx.cwd, "loop_stopped", { reason, iterations: state.loop.iteration, best: state.loop.bestValue });
    ctx.ui.notify(
      `Loop finished (${reason}) after ${state.loop.iteration} iterations. Best: ${state.loop.bestValue ?? "n/a"}.`,
      "info",
    );
    notifyExternal(ctx, `Loop finished: ${reason}`);
    return;
  }

  if (sub === "audit") {
    // v0.29.0: the project-audit loop (user design: "the looper running
    // audits to see where to progress and what to fix — the thing that
    // fires at the end of goals and lists"). Unlike respec this is a
    // METRIC loop: the orchestrator counts CLOSED findings every iteration,
    // direction=max (v0.29.14 — open-count/min punished discovery), and the
    // plateau stop is the termination — no fixes landing for the window =
    // the well is dry. User typed the command = the act (same auto-start
    // rule as respec).
    if (state.goal && state.goal.status === "active") {
      ctx.ui.notify(`A goal is active — ${activeGoalSurfaceCommand("cancel")} or ${activeGoalSurfaceCommand("pause")} it before starting a loop.`, "warning");
      return;
    }
    // v0.31.1: a paused/active one-shot audit goal + this loop = two stacked
    // audit initiatives (junk-runner 2026-07-31: the held one-shot read as
    // "stalled" for 8h while the loop did all the work — the agent conflated
    // them and proposed completing the goal for the loop's work). Warn, name
    // the supersession, don't block — the user's agency, the user's call.
    if (state.goal && state.goal.objective.includes(GOAL_AUDIT_ONESHOT_MARKER)) {
      appendLedger(ctx.cwd, "audit_stack_warn", { have: "goal", starting: "loop", goalStatus: state.goal.status });
      ctx.ui.notify(
        `Heads up: a ${state.goal.status} one-shot audit goal exists in this session — the audit loop SUPERSEDES it (one pass + fixes IS the loop's job). ${activeGoalSurfaceCommand("cancel")} clears it; one audit initiative per session.`,
        "warning",
      );
    }
    if (isLoopActive()) {
      ctx.ui.notify("A loop is already active. /loop stop first.", "warning");
      return;
    }
    await startLoopFromConfig(ctx, {
      target: auditTarget(),
      measureCmd: auditMeasureCmd(),
      direction: "max",
      plateauWindow: LOOP_DEFAULTS.plateauWindow,
      maxIterations: 0,
      branch: false,
      force: false,
      // v0.29.10: the audit loop's metric is CREATED by iteration 1 —
      // seeding best from the pre-discovery 0 stalls every iteration and
      // plateau-stops mid-work at the window. Defer the baseline.
      deferBaseline: true,
      kind: "audit",
    });
    return;
  }

  if (sub === "respec") {
    // v0.24.3: reconcile the codebase against the root spec, forever.
    // Same auto-start path as /loop start (the user typed the command —
    // that IS the act); metricless + unbounded by design. No limit-nagging:
    // bounds exist on /loop start for whoever wants them.
    if (state.goal && state.goal.status === "active") {
      ctx.ui.notify(`A goal is active — ${activeGoalSurfaceCommand("cancel")} or ${activeGoalSurfaceCommand("pause")} it before starting a loop.`, "warning");
      return;
    }
    if (isLoopActive()) {
      ctx.ui.notify("A loop is already active. /loop stop first.", "warning");
      return;
    }
    const specs = resolveSpecFiles(ctx.cwd);
    if (specs.length === 0) {
      // No spec → the target is undetermined; grill instead of dead-ending
      // on an error (v0.24.4).
      ctx.ui.notify("No SPEC.md / spec.md in the project root — drafting the loop target with you (or bootstrap a spec first).", "info");
      await startDrafting(
        ctx,
        "loop",
        "reconcile the codebase against the project spec — but NO SPEC.md / spec.md exists in the root. Grill the user: should the first work be bootstrapping a SPEC.md from the current code (then reconcile against it), or is the reconciliation target better stated in prose? Challenge vague answers.",
      );
      return;
    }
    let specPath = specs[0]!;
    if (specs.length > 1) {
      // Two specs = ambiguous — never silently pick (v0.24.4). One
      // slash-bar select, plus a nudge to consolidate.
      const names = specs.map((p) => path.basename(p));
      const choice = await ctx.ui.select(
        "Both SPEC.md and spec.md exist in the root — which one is the spec?",
        names,
      );
      if (choice === undefined) {
        ctx.ui.notify("respec cancelled.", "info");
        return;
      }
      specPath = specs[names.indexOf(choice)]!;
      ctx.ui.notify(
        `Using ${path.basename(specPath)} as the spec. Both files exist — worth consolidating; the loop treats only ${path.basename(specPath)} as the spec.`,
        "info",
      );
    }
    const target = respecTarget(path.basename(specPath));
    await startLoopFromConfig(ctx, {
      target,
      measureCmd: "",
      direction: undefined,
      plateauWindow: LOOP_DEFAULTS.plateauWindow,
      maxIterations: 0,
      branch: false,
      force: false,
      specFile: specPath, // v0.33.2
    });
    return;
  }

  // Anything else is a natural-language target (v0.22.4): draft it — the
  // metric is the whole game for a loop, and /loop start with full params
  // is the skip-drafting path. Previously this fell through to a usage
  // line, so "/loop make the tests faster" did nothing useful.
  if (isLoopActive()) {
    ctx.ui.notify("A loop is already active — /loop status to inspect, /loop stop to end it.", "info");
    return;
  }
  await startDrafting(ctx, "loop", args.trim());
}

// =================================================================
// Tools exposed to the agent
// =================================================================

const STALE_TOOL_CONTEXT_MESSAGE =
  "This tool call crossed a session replacement before it could run. No stale context was used; wait for a fresh session_start and retry.";

function staleToolResult(): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
  return { content: [{ type: "text", text: STALE_TOOL_CONTEXT_MESSAGE }], details: {} };
}

/**
 * v0.34.20: registerAgentTools runs once per extension instance, but pi
 * invokes the registered tool with the current event context. Never use the
 * context captured when the tools were registered after a reload/rebind.
 * Prefer the invocation context, validate it cheaply, and fall back only to
 * the current fresh context — never to the registration-time ctx.
 */
function currentToolContext(execCtx: unknown): ExtensionContext | null {
  const candidate = execCtx as ExtensionContext | undefined;
  if (candidate) {
    try {
      candidate.isIdle();
      return candidate;
    } catch {
      // The invocation itself may be a late event; try the current binding.
    }
  }
  return freshCtx();
}

function registerAgentTools(pi: any): void {
  pi.registerTool(defineTool({
    name: "complete_goal",
    label: "Complete goal",
    description: "Mark the active goal as complete. Queues a detached auditor worker to verify without holding the main pi turn. Use only when the objective is genuinely satisfied.",
    parameters: Type.Object({
      completionSummary: Type.Optional(Type.String({ description: "1-paragraph completion claim" })),
      verificationSummary: Type.Optional(Type.String({ description: "Per-item evidence for the verification contract" })),
      newObjective: Type.Optional(Type.String({ description: "v0.25.0 (contract item 15): when the work has legitimately shifted, pass the new objective here — it atomically replaces the goal objective AND the audit proceeds against the NEW objective in this same call. Do not use to dodge a legitimate disapproval; the auditor sees the change." })),
    }),
    async execute(_id, params, signal, _onUpdate, execCtx) {
      const foreign0 = foreignToolGuard(execCtx);
      if (foreign0) return { content: [{ type: "text", text: foreign0 }], details: {} };
      const toolCtx = currentToolContext(execCtx);
      if (!toolCtx) return staleToolResult();
      let ctx: ExtensionContext = toolCtx;
      const auditGeneration = sessionGeneration;
      if (!state.goal || state.goal.status !== "active") {
        return { content: [{ type: "text", text: "No active goal." }], details: {} };
      }
      const p = params as { completionSummary?: string; verificationSummary?: string; newObjective?: string };
      // v0.25.0 (contract item 15): atomic objective update + audit in one
      // call — the objective-drift disapprove loop (ship shifted work →
      // auditor disapproves the ORIGINAL objective) ends here. Ledgered so
      // the shift is auditable.
      if (p.newObjective?.trim()) {
        const oldObjective = state.goal.objective;
        const { objective: cleanObj, verificationContract } = extractVerificationContract(p.newObjective.trim());
        // v0.34.61: contract-scoped revision bump — one of exactly two
        // sites (the other: cmdTweak). persistState no longer bumps, so
        // the settle writes of THIS call keep the audited revision stable.
        state.goal = bumpGoalRevision(state.goal);
        updateGoal({ objective: cleanObj, ...(verificationContract ? { verificationContract } : {}) }, ctx);
        appendLedger(ctx.cwd, "goal_tweaked", { via: "complete_goal.newObjective", from: oldObjective.slice(0, 200), to: cleanObj.slice(0, 200) });
        ctx.ui.notify(`Objective updated (complete_goal newObjective): ${cleanObj.slice(0, 80)}`, "info");
      }
      // v0.34.60 (steal #3): revision-bound audit validity — an approval
      // from an older contract must not be cited against the current one.
      // The gate compares the goal's CURRENT revision against the revision
      // the LAST audit in history ran at: a contract change since that
      // audit (/goal tweak, or any objective mutation) invalidates the
      // prior verdict, and the claim is refused until the current contract
      // gets its own audit. Two escapes: (1) the claim itself carries the
      // contract change (newObjective above) — its audit covers the NEW
      // contract in this same call, so the gate skips; (2) /goal verify
      // audits the current state explicitly, after which the latest
      // audited revision matches and complete_goal proceeds. Legacy
      // history entries without a revision field pass unchanged.
      const lastAudited = state.goal.auditHistory?.[state.goal.auditHistory.length - 1];
      const currentRevision = state.goal.revision ?? 0;
      if (!(p.newObjective?.trim() ?? "") && lastAudited && typeof lastAudited.revision === "number" && lastAudited.revision !== currentRevision) {
        appendLedger(ctx.cwd, "complete_goal_revision_rejected", {
          goalId: state.goal.id,
          currentRevision,
          auditedRevision: lastAudited.revision,
          auditedAt: lastAudited.at,
          objective: state.goal.objective.slice(0, 200),
        });
        return {
          content: [{
            type: "text",
            text: `complete_goal REJECTED — revision mismatch: the goal's contract changed since its last audit (audited at revision ${lastAudited.revision}, now revision ${currentRevision}). An approval from the old contract cannot be cited against the new one. Run ${activeGoalRoot()} verify to audit the current contract, then call complete_goal again.`,
          }],
          details: {},
        };
      }
      // v0.34.20/v0.34.21: persist the completion claim AND an explicit
      // running-attempt record BEFORE the isolated auditor starts. If session
      // replacement lands during the audit, a fresh session can immediately
      // distinguish the interrupted claim from an active run and retry the
      // exact claim without allowing the old generation to archive anything.
      const completionClaim = beginCompletionAudit(ctx, {
        completionSummary: p.completionSummary,
        verificationSummary: p.verificationSummary,
        at: nowIso(),
      }, "complete-goal");
      updateGoal({ pendingTasks: undefined }, ctx);
      const auditGoal = state.goal;
      if (!auditGoal) return staleToolResult();
      const auditGoalId = auditGoal.id;
      const auditAttemptId = completionClaim.attemptId!;
      const settings = loadSettings(ctx.cwd);
      const { model: auditorModel, error: modelError, via, fallbackModels } = resolveAuditorModel(ctx, settings.auditorModel, settings.auditorModelFallback, settings.auditorSameSessionSwap !== false);
      if (modelError) {
        ctx.ui.notify(`Auditor model issue: ${modelError}`, "warning");
      }
      const auditorCandidates: AuditorModelCandidate[] = [{ model: auditorModel, via: via ?? "unset" }, ...(fallbackModels ?? [])];
      ctx.ui.notify(`Auditor queued (detached worker, model: ${via ?? "setting"}) — the claim is durable; verdict will arrive asynchronously.`, "info");
      // The detached worker must not keep complete_goal's pi turn open. The
      // rest of this callback deliberately runs after the tool has returned;
      // every state/UI access below rebinds through the generation guard.
      completionAuditInFlight = true;
      completionAuditGeneration = auditGeneration;
      latestAuditProgress = { label: "queued", lastEventAt: Date.now() };
      refreshUI(ctx);
      void (async () => {
      const runAudit = (candidate: AuditorModelCandidate) =>
        runDetachedGoalCompletionAuditor({
          cwd: ctx.cwd,
          goal: auditGoal,
          completionSummary: p.completionSummary,
          verificationSummary: p.verificationSummary,
          model: candidate.model,
          thinkingLevel: (settings.auditorThinkingLevel ?? "high") as any, // may be "max" — pi ≥0.83 understands it; the dev-types predate it
          runtime: { attemptId: () => newDetachedAuditJobAttemptId(completionClaim.attemptId!), wallTimeoutMs: AUDITOR_WALL_TIMEOUT_MS },
          onProgress: (progress) => {
            publishDetachedAuditProgress(auditGeneration, auditGoalId, auditAttemptId, progress);
          },
          // v0.34.57: the parent-side heartbeat-without-progress watchdog
          // fired — persist the auditor_stalled ledger event so the recovery
          // path can distinguish "wedged worker" from other timeouts.
          onStalled: (info) => {
            const current = detachedAuditContext(auditGeneration, auditGoalId, auditAttemptId);
            if (!current) return;
            appendLedger(current.cwd, "auditor_stalled", { goalId: auditGoalId, attemptId: auditAttemptId, ...info });
          },
        });
      // v0.25.4 (post-audit fix): a retriable infra failure (stream error,
      // auth blip — NOT user abort, NOT missing model) gets ONE automatic
      // retry with backoff before we report "auditor infrastructure error
      // (retried once)". Neither attempt is a verdict on the work.
      const auditStartMs = Date.now();
      let result: Awaited<ReturnType<typeof runAudit>>;
      let retriedOnce = false;
      let fallbackUsed = false;
      try {
        ({ result, retriedOnce, fallbackUsed } = await runDetachedCompletionWithFallback(auditorCandidates, runAudit, {
          shouldRetry: () => detachedAuditContext(auditGeneration, auditGoalId, auditAttemptId) !== null,
          onRetry: (candidate, err) => {
            const current = detachedAuditContext(auditGeneration, auditGoalId, auditAttemptId);
            if (!current) return;
            latestAuditProgress = { label: `infra error (${err.slice(0, 40)}) — retrying once`, lastEventAt: Date.now() };
            refreshUI(current);
            appendLedger(current.cwd, "audit_infra_retry", { goalId: auditGoalId, model: auditorCandidateLabel(candidate), error: err.slice(0, 200) });
          },
          onFallback: (from, to, err) => {
            const current = detachedAuditContext(auditGeneration, auditGoalId, auditAttemptId);
            if (!current) return;
            appendLedger(current.cwd, "auditor_runtime_model_fallback", { goalId: auditGoalId, from: auditorCandidateLabel(from), to: auditorCandidateLabel(to), error: err.slice(0, 200) });
            current.ui.notify(`Detached auditor failed on ${auditorCandidateLabel(from)} — retrying with ${auditorCandidateLabel(to)}. This is infrastructure, not a verdict.`, "warning");
          },
        }));
      } finally {
        if (ownsDetachedAudit(auditGeneration, auditGoalId, auditAttemptId)) {
          clearDetachedAuditProgress(auditGeneration, auditGoalId, auditAttemptId);
          completionAuditInFlight = false;
          completionAuditGeneration = null;
        }
      }
      const auditContextAfterRun = freshCtxForGeneration(auditGeneration);
      if (!auditContextAfterRun || !state.goal || state.goal.id !== auditGoalId) {
        clearDetachedAuditProgress(auditGeneration, auditGoalId, auditAttemptId);
        return staleToolResult();
      }
      if (state.goal.pendingCompletion?.attemptId !== auditAttemptId) {
        return staleToolResult();
      }
      ctx = auditContextAfterRun;
      const auditDurationMs = Date.now() - auditStartMs;
      latestAuditProgress = null;
      // Audit history: record REAL verdicts only — a non-empty report is the
      // evidence the auditor actually inspected something. Empty-report runs
      // (abort, auth failure, no model) are surfaced via pauseReason, not
      // logged as disapprovals.
      const auditorRan = result.output.trim().length > 0;
      // v0.28.5 (E2): a REAL auditor run clears the infra-error streak.
      // v0.34.14: …but only a CLEAN one. A STALLED run returns the partial
      // output it streamed before the abort — non-empty, so auditorRan is
      // true — while result.error still marks it an infrastructure failure.
      // Clearing the streak on those meant the 3-strike breaker at :3874
      // NEVER engaged: pully 2026-08-01 looped 10-min stall cycles for 4h
      // (the auditor hung on an ssh/sudo verification every attempt).
      if (auditorRan && !result.error && (state.goal.auditInfraStreak ?? 0) > 0) updateGoal({ auditInfraStreak: undefined }, ctx);
      const history = state.goal.auditHistory ?? [];
      if (auditorRan) {
        // v0.25.4: strip think-block leakage (MiniMax-M3 `</think>`
        // fragments + reasoning spillover) before anything stores or
        // displays the report.
        const cleanOutput = stripThinkBlocks(result.output);
        result.output = cleanOutput;
        history.push({
          at: nowIso(),
          approved: result.approved,
          disapproved: result.disapproved,
          impossible: result.impossible,
          impossibleReason: result.impossibleReason,
          model: result.model,
          thinkingLevel: result.thinkingLevel,
          report: cleanOutput,
          error: result.error,
          regressionShieldPassed: result.regressionShieldPassed,
          regressionShieldMissing: result.regressionShieldMissing,
          // v0.34.60 (steal #3): the revision the worker audited.
          revision: result.goalRevision?.revision ?? state.goal.revision ?? 0,
          durationMs: auditDurationMs,
        } as any);
        // Cap history — 39 infra errors taught us unbounded growth is real.
        if (history.length > 20) history.splice(0, history.length - 20);
        // v0.25.4: durable append-only audit log — survives state-snapshot
        // rotation; the review surface for "where are we weak".
        const verdict: AuditLogEntry["verdict"] =
          result.error && !result.approved && !result.disapproved
            ? "error"
            : result.approved && result.regressionShieldPassed === false
              ? "shield_blocked"
              : result.approved
                ? "approved"
                : result.impossible
                  ? "impossible"
                  : "disapproved";
        appendAuditLog(ctx.cwd, {
          at: nowIso(),
          goalId: state.goal.id,
          objective: state.goal.objective.slice(0, 200),
          verdict,
          model: result.model,
          thinkingLevel: result.thinkingLevel ?? "(default)",
          report: cleanOutput,
          impossibleReason: result.impossibleReason,
          error: result.error,
          durationMs: auditDurationMs,
          retriedOnce,
          fallbackUsed,
        } as AuditLogEntry);
      }

      // Escape hatch: the user aborted the audit (Esc). Offer the explicit
      // choice — complete WITHOUT audit, or keep working. (pi-goal-x parity.)
      if (result.error === "Auditor aborted.") {
        updateGoal({ status: "active", auditHistory: history, pendingCompletion: undefined, pauseReason: "audit aborted by user (Esc)" }, ctx);
        const abortConfirmCtx = freshCtxForGeneration(auditGeneration);
        if (!abortConfirmCtx) return staleToolResult();
        ctx = abortConfirmCtx;
        let completeAnyway = false;
        try {
          completeAnyway = await ctx.ui.confirm(
            "Audit aborted",
            "You aborted the auditor (Escape).\n\nYes = mark the goal COMPLETE WITHOUT AUDIT (you take responsibility for verification).\nNo = continue working; the auditor will verify on the next complete_goal.",
          );
        } catch {
          completeAnyway = false;
        }
        const afterAbortConfirmCtx = freshCtxForGeneration(auditGeneration);
        if (!afterAbortConfirmCtx) return staleToolResult();
        ctx = afterAbortConfirmCtx;
        if (completeAnyway) {
          updateGoal({ auditHistory: history, pendingCompletion: undefined }, ctx);
          archiveCurrentGoal(ctx, "complete", "completed without audit (user choice after Esc)");
          return { content: [{ type: "text", text: "Goal marked complete without audit (user choice)." }], details: {} };
        }
        scheduleContinuation(ctx, true);
        return {
          content: [{ type: "text", text: "Audit aborted; continuing. Call complete_goal again when ready — the auditor will re-run." }],
          details: {},
        };
      }

      if (result.approved && result.regressionShieldPassed !== false) {
        updateGoal({ auditHistory: history, pendingCompletion: undefined }, ctx);
        const objective = state.goal.objective;
        archiveCurrentGoal(ctx, "complete", `auditor ${result.model} approved`);
        notifyExternal(ctx, `Goal complete (auditor approved): ${displaySlice(objective, 120)}`);
        return { content: [{ type: "text", text: `Goal approved by auditor ${result.model}.` }], details: {} };
      }

      // IMPOSSIBLE (v0.24.2, Claude-Code lesson): the auditor's escape hatch
      // for goals that can NEVER be satisfied as stated. Not a disapproval —
      // continuing would burn tokens on a provably unwinnable objective.
      // Bounded and surfaced: the goal pauses and the user decides.
      if (result.impossible) {
        const reason = result.impossibleReason || "(no reason given)";
        // v0.25.0 (contract item 23): under aggressiveMode, a PARTIAL
        // impossible (some items can't ship) keeps the loop going — the
        // agent narrows to the remainder. A FULL impossible still pauses:
        // auto-resuming a provably unwinnable objective just burns tokens.
        const effectiveImp = resolveEffectiveAggressiveSettings(loadSettings(ctx.cwd));
        if (effectiveImp.aggressiveMode && classifyImpossibleReason(reason) === "partial") {
          updateGoal({
            status: "active",
            auditHistory: history,
            pendingCompletion: undefined,
            pauseReason: `auditor verdict: IMPOSSIBLE (partial) — ${reason}`,
            pauseSuggestedAction: `Narrow the objective past the impossible part (complete_goal newObjective or ${activeGoalSurfaceCommand("tweak")}) and continue`,
          }, ctx);
          ctx.ui.notify(`Auditor: part of the goal is IMPOSSIBLE — ${reason.slice(0, 100)}. aggressiveMode: narrowing and continuing.`, "warning");
          appendLedger(ctx.cwd, "impossible_partial_continue", { reason: reason.slice(0, 200) });
          scheduleContinuation(ctx, true);
          return {
            content: [{
              type: "text",
              text: `The auditor says PART of this goal can never be satisfied: ${reason}\n\naggressiveMode is ON, so the goal stays ACTIVE. Do NOT keep attempting the impossible part. Narrow the objective to the remaining shippable items — pass newObjective to complete_goal at completion time (or pause_goal proposing ${activeGoalSurfaceCommand("tweak")} if the narrowing needs the user's call) — and continue working the rest now.`,
            }],
            details: {},
          };
        }
        updateGoal({
          status: "paused",
          auditHistory: history,
          pendingCompletion: undefined,
          pauseKind: "decision",
          pauseOptions: [`Tweak the objective — ${activeGoalSurfaceCommand("tweak")} <new text>`, `Cancel the goal (${activeGoalSurfaceCommand("cancel")})`],
          pauseRecommended: 1,
          pauseReason: `auditor verdict: IMPOSSIBLE — ${reason}`,
          pauseSuggestedAction: `The auditor says this goal can never be satisfied as stated. ${activeGoalSurfaceCommand("tweak")} the objective (or ${activeGoalSurfaceCommand("cancel")}), then ${activeGoalSurfaceCommand("resume")}.`,
        }, ctx);
        ctx.ui.notify(`Auditor: goal IMPOSSIBLE — ${reason}. Goal paused; ${activeGoalSurfaceCommand("tweak")} or ${activeGoalSurfaceCommand("cancel")}, then ${activeGoalSurfaceCommand("resume")}.`, "warning");
        maybeDecisionPopup(ctx);
        appendLedger(ctx.cwd, "goal_paused", { reason: `auditor impossible: ${reason}` });
        notifyExternal(ctx, `Goal paused (auditor: impossible): ${reason.slice(0, 120)}`);
        return {
          content: [{
            type: "text",
            text: `The auditor's verdict is IMPOSSIBLE: ${reason}\n\nThis is not a disapproval — the auditor says the objective can never be satisfied as stated. The goal is now PAUSED. Do not call complete_goal again. Report the verdict to the user and suggest ${activeGoalSurfaceCommand("tweak")} (narrow or correct the objective) or ${activeGoalSurfaceCommand("cancel")}.`,
          }],
          details: {},
        };
      }

      // THREE-WAY SPLIT (v0.9.9): infrastructure failure is NOT a verdict.
      // The wild-caught case: 6 silent "disapprovals" that were really a dead
      // auditor model. The agent must be able to tell the difference.
      if (result.error && !result.disapproved && result.regressionShieldPassed !== false) {
        // Watchdog timeouts are infrastructure failures, but retain the exact
        // completion claim so /goal resume can retry the isolated auditor
        // directly. A timeout is not a verdict and must not be fed back into
        // the normal agent continuation path.
        if (isAuditorTimeoutError(result.error)) {
          const pending: PendingCompletion = {
            ...completionClaim,
            phase: "recovery-pending",
            recoveryAt: nowIso(),
            recoveryReason: result.error.startsWith("Auditor exceeded") ? "wall-timeout" : "inactivity-timeout",
          };
          updateGoal({
            status: "paused",
            auditHistory: history,
            pendingCompletion: pending,
            pauseKind: "error",
            pauseReason: `completion audit timed out — ${result.error}`,
            pauseSuggestedAction: `The claim is stored. Check long-running verification commands, then ${activeGoalSurfaceCommand("resume")} to retry the isolated auditor.`,
          }, ctx);
          appendLedger(ctx.cwd, result.error.startsWith("Auditor exceeded") ? "audit_wall_timeout" : "audit_inactivity_timeout", { goalId: auditGoalId, attemptId: auditAttemptId, error: result.error.slice(0, 240) });
          ctx.ui.notify(`Completion auditor timed out (infrastructure, not a verdict). The stored claim is safe; fix the command/model and ${activeGoalSurfaceCommand("resume")} to retry it.`, "warning");
          return {
            content: [{ type: "text", text: `The completion auditor timed out (infrastructure, not a verdict). The stored claim is safe; fix the command/model and ${activeGoalSurfaceCommand("resume")} to retry it.` }],
            details: {},
          };
        }
        // v0.34.51: ANY infrastructure failure enters the durable bounded
        // retry plan — error text is not trusted to pick quota vs other
        // failures (a miss-classified quota wall is the common case), so
        // "still failing" pauses with a one-shot scheduled retry at the
        // upstream's own Retry-After hint (default quotaRetryMinutes).
        if (result.error && !result.disapproved) {
          const settingsNow = loadSettings(ctx.cwd);
          const defaultMinutes = settingsNow.quotaRetryMinutes ?? DEFAULT_QUOTA_RETRY_MINUTES;
          const quota = parseQuotaError(result.error, defaultMinutes * 60);
          const plan = auditorQuotaRetryPlan(completionClaim, quota, defaultMinutes);
          quota.retryAfterSec = plan.retryAfterSec; // retain the legacy source/API shape after clamping
          const pending = {
            ...completionClaim,
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
              auditInfraStreak: undefined,
              pendingCompletion: pending,
              pauseKind: "blocked",
              pauseResumeAt: undefined,
              pauseReason: `auditor retry: automatic retry horizon reached (${plan.attempt} attempts)`,
              pauseSuggestedAction: `The completion claim is stored, but automatic auditor probes are stopped. Check the provider reset/billing state, then ${activeGoalSurfaceCommand("resume")} to start a fresh bounded window.`,
            }, ctx);
            appendLedger(ctx.cwd, "auditor_retry_capped", { streak: plan.attempt, autoRetryUntil: plan.autoRetryUntil, requestedSec: plan.requestedSec });
            ctx.ui.notify(`Automatic auditor retries stopped after ${plan.attempt} bounded attempts — the claim stays stored; check the provider, then ${activeGoalSurfaceCommand("resume")}.`, "warning");
            return {
              content: [{ type: "text", text: `The auditor hit an infrastructure wall (NOT a verdict). Automatic probes stopped after ${plan.attempt} bounded attempts; the exact completion claim is stored. Check the provider, then ${activeGoalSurfaceCommand("resume")}.` }],
              details: {},
            };
          }
          const retryMin = Math.max(1, Math.round(quota.retryAfterSec / 60));
          updateGoal({
            status: "paused",
            auditHistory: history,
            auditInfraStreak: undefined, // durable retry owns the wait — infra streak broken
            // v0.28.26: store the claim — the retry re-runs the auditor
            // DIRECTLY with it (no agent turn to confuse).
            pendingCompletion: pending,
            pauseKind: "wait",
            pauseResumeAt: new Date(Date.now() + quota.retryAfterSec * 1000).toISOString(),
            pauseReason: `auditor retry: ${result.error}`,
            pauseSuggestedAction: `Auto-retry in ${retryMin}m${providerHint} — or ${activeGoalSurfaceCommand("resume")} to retry now`,
          }, ctx);
          appendLedger(ctx.cwd, "goal_paused", { reason: `auditor retry: retry in ${quota.retryAfterSec}s (${quota.fromUpstream ? "upstream hint" : "bounded default"})`, attempt: plan.attempt, autoRetryUntil: plan.autoRetryUntil });
          scheduleQuotaRetryForSession(ctx, quota.retryAfterSec, result.error, (fresh) => {
            // Re-check: only auto-resume if STILL paused for the retry
            // reason (a user /goal pause during the window is not stomped).
            if (state.goal && state.goal.status === "paused" && (state.goal.pauseReason ?? "").startsWith("auditor retry:")) {
              // v0.28.26: a stored claim retries the AUDITOR directly — the
              // agent is not needed to re-submit an unchanged claim, and
              // re-engaging it produced hallucinated-closure loops.
              if (state.goal.pendingCompletion) {
                void retryStoredCompletionAudit();
                return;
              }
              updateGoal({ status: "active" }, fresh);
              appendLedger(fresh.cwd, "goal_resumed", { via: "quota-retry" });
              if (resolveEffectiveAggressiveSettings(loadSettings(fresh.cwd)).aggressiveMode) {
                fresh.ui.notify("Auto-resume fired (event: auditor quota window elapsed). Continue working.", "info");
              }
              scheduleContinuation(fresh, true);
            }
          });
          return {
            content: [{
              type: "text",
              text: `The auditor hit an infrastructure error (NOT a verdict): ${result.error}\nThe goal is PAUSED with an automatic retry scheduled in ${retryMin} minute(s)${quota.fromUpstream ? " (upstream hint)" : " (bounded default — edit Quota retry minutes in /glla settings)"}${providerHint}. Your completion claim was not evaluated; do not change your deliverable for this. ${activeGoalSurfaceCommand("resume")} retries immediately.`,
            }],
            details: {},
          };
        }
        // v0.34.51: the durable bounded retry plan above owns ALL infra
        // failures now (timeouts keep their own branch). The old 3-strike
        // "auditor model is likely broken" stop is gone: "keep retrying"
        // until the plan's horizon, then the blocked pause asks the user.
      }

      // Shield-blocked approval (v0.22.6): the auditor APPROVED but the
      // regression shield found contract items the evidence never
      // referenced. NOT a verdict on the work — the next audit is told
      // exactly what to quote. (The hegemon case: three genuine approvals
      // shield-blocked on vocabulary mismatches read as a "parser bug".)
      if (result.regressionShieldPassed === false) {
        const missing = result.regressionShieldMissing ?? [];
        const detail = missing.length > 0
          ? `the report's evidence never referenced these contract items:\n${missing.map((i) => `- ${i}`).join("\n")}`
          : "the report did not include a valid <evidence> block";
        updateGoal({
          status: "active",
          auditHistory: history,
          pendingCompletion: undefined,
          pauseReason: "regression shield: auditor approved, but the evidence contract was not satisfied",
          pauseSuggestedAction: "call complete_goal again — the next auditor run is told exactly which evidence the shield requires",
        }, ctx);
        ctx.ui.notify(
          `Regression shield blocked completion: the auditor approved, but ${detail}.\n\nCall complete_goal again; the next audit will be told to quote raw evidence for each item.`,
          "warning",
        );
        scheduleContinuation(ctx, true);
        return {
          content: [{
            type: "text",
            text: `The auditor APPROVED, but the orchestrator's regression shield blocked completion: ${detail}.\n\nThis is NOT a verdict on your work — do not change your deliverable for this. Call complete_goal again; the next audit is explicitly told to quote raw evidence for each of these items.`,
          }],
          details: {},
        };
      }

      const noContractHint = state.goal.verificationContract?.trim()
        ? ""
        : `\n\nNote: this goal has no verification contract, so the auditor inferred done-criteria from the objective text. For sharper verdicts, ${activeGoalSurfaceCommand("tweak")} the objective to add a 'Done when: ...' clause.`;
      // v0.24.2 (Claude-Code lesson — their stop-hook blocks cap at 8): a
      // goal the auditor can NEVER approve used to re-continue forever.
      // auditCap consecutive disapprovals → pause + notify, bounded and
      // surfaced like every other stop in this stack.
      const effectiveCap = resolveEffectiveAggressiveSettings(settings);
      const auditCap = effectiveCap.auditCap;
      const configuredFeedbackChars = settings.auditFeedbackChars;
      const auditFeedbackChars = Number.isInteger(configuredFeedbackChars) && configuredFeedbackChars! >= 0
        ? configuredFeedbackChars!
        : DEFAULT_AUDIT_FEEDBACK_CHARS;
      const auditFeedback = auditFeedbackExcerpt(result.output, auditFeedbackChars);
      const auditFeedbackIsFull = auditFeedbackChars === 0 || result.output.length <= auditFeedbackChars;
      const auditFeedbackLabel = auditFeedbackIsFull
        ? "full report"
        : `last ${auditFeedbackChars} chars (Required-fixes tail)`;
      const auditFeedbackTruncationHint = auditFeedbackIsFull
        ? ""
        : `\n\nReport truncated at the configured limit. ${activeGoalStatusCommand()} shows the full report; change Audit feedback chars in /glla settings (0 = full report).`; 
      const trailingDisapprovals = countTrailingDisapprovals(history);
      if (auditCap > 0 && trailingDisapprovals >= auditCap) {
        // v0.25.0 (contract item 22): aggressiveMode turns the cap into a
        // TODO list and keeps going — the objections become pendingTasks
        // rendered into every continuation until addressed. OFF preserves
        // the pause (contract item 24 test 2).
        if (effectiveCap.aggressiveMode) {
          const pendingTasks = extractPendingTasks(result.output, 5);
          updateGoal({
            status: "active",
            auditHistory: history,
            pendingCompletion: undefined,
            pendingTasks,
            pauseReason: `auditor disapproved ${trailingDisapprovals}× consecutively (cap ${auditCap}) — aggressiveMode: continuing with TODOs`,
          }, ctx);
          const todoBlock = pendingTasks.length > 0
            ? pendingTasks.map((t, i) => ` ${i + 1}. ${t}`).join("\n")
            : " (no discrete objections extracted — re-read the latest report in ${activeGoalStatusCommand()})";
          ctx.ui.notify(`Auditor disapproved ${trailingDisapprovals}× (cap). Treating as TODOs:\n${todoBlock}`, "warning");
          appendLedger(ctx.cwd, "audit_cap_keep_going", { trailingDisapprovals, auditCap, pendingTasks });
          scheduleContinuation(ctx, true);
          return {
            content: [{
              type: "text",
              text: `The auditor has disapproved ${trailingDisapprovals} times in a row (cap ${auditCap}), but aggressiveMode is ON — the goal stays ACTIVE and the objections are now your TODO list:\n${todoBlock}\n\nLatest report (${auditFeedbackLabel}):\n${auditFeedback}\n\nWork the TODOs in order. If the auditor is WRONG about an objection, follow WHEN THE AUDITOR DISAPPROVES: investigate, quote its objection, compare against what you shipped, and present the user YOUR ASSESSMENT. If the objective itself has drifted, pass newObjective to complete_goal.`,
            }],
            details: {},
          };
        }
        updateGoal({
          status: "paused",
          auditHistory: history,
          pendingCompletion: undefined,
          pauseKind: "decision",
          pauseOptions: [`Fix the disapproval gap, then continue (${activeGoalSurfaceCommand("resume")})`, `Tweak the objective — ${activeGoalSurfaceCommand("tweak")} <new text>`, `Cancel the goal (${activeGoalSurfaceCommand("cancel")})`],
          pauseRecommended: 1,
          pauseReason: `auditor disapproved ${trailingDisapprovals}× consecutively (cap ${auditCap})`,
          pauseSuggestedAction: `Read the audit history (${activeGoalStatusCommand()}), fix the actual gap or ${activeGoalSurfaceCommand("tweak")} the objective, then ${activeGoalSurfaceCommand("resume")}. Raise Audit cap in /glla settings.`,
        }, ctx);
        ctx.ui.notify(`${goalNoun()} paused: auditor disapproved ${trailingDisapprovals}× consecutively (cap ${auditCap}). ${activeGoalStatusCommand()} for the reports; ${activeGoalSurfaceCommand("resume")} to continue.`, "warning");
          maybeDecisionPopup(ctx);
        appendLedger(ctx.cwd, "goal_paused", { reason: `disapproval cap: ${trailingDisapprovals} consecutive (cap ${auditCap})` });
        notifyExternal(ctx, `Goal paused: ${trailingDisapprovals} consecutive auditor disapprovals`);
        return {
          content: [{
            type: "text",
            text: `The auditor has now disapproved ${trailingDisapprovals} times in a row (cap ${auditCap}). The goal is PAUSED — continuing to re-attempt without addressing the pattern wastes tokens.\n\nBefore asking the user, INVESTIGATE:\n1. Read the audit history (the auditor's previous reports — ${activeGoalStatusCommand()} shows them; state.goal.auditHistory holds them).\n2. Identify the SPECIFIC objections — quote them.\n3. Compare against what you actually shipped (commits, diffs, test output, screenshots).\n4. Form a clear opinion: is the auditor right, wrong, or partially right?\n5. Present the user YOUR ASSESSMENT with quoted objections and shipped evidence — not a generic menu of options.\n\nLatest report (${auditFeedbackLabel}):\n${auditFeedback}\n\nDo not call complete_goal again until the pattern is addressed. ${activeGoalSurfaceCommand("resume")} resumes; ${activeGoalSurfaceCommand("tweak")} fixes a drifted objective.`,
          }],
          details: {},
        };
      }
      updateGoal({
        status: "active",
        auditHistory: history,
        pendingCompletion: undefined,
        pauseReason: "auditor disapproved",
        pauseSuggestedAction: "Inspect auditor feedback and fix the actual gap before calling complete_goal again",
      }, ctx);
      // The returned tool text reaches the executor only if a continuation
      // turn starts. Surface a bounded report directly as well, so a missing
      // turn-start acknowledgement cannot turn a real disapproval into an
      // apparently empty red card.
      const userFeedback = auditFeedbackExcerpt(result.output, 1200)
        .replace(/<\/?(?:approved|disapproved|impossible)\s*\/?>/gi, "")
        .trim()
        || "(no actionable feedback returned; use /glla audits full to inspect the raw report)";
      ctx.ui.notify(`Auditor disapproved. Report excerpt:\n${userFeedback}`, "warning");
      scheduleContinuation(ctx, true);
      return {
        content: [{
          type: "text",
          text: `Auditor disapproved. Report (${auditFeedbackLabel}):\n${auditFeedback}${auditFeedbackTruncationHint}${noContractHint}`,
        }],
        details: {},
      };
      })().catch((error) => {
        const current = freshCtxForGeneration(auditGeneration);
        if (!current || !state.goal || state.goal.id !== auditGoalId || state.goal.pendingCompletion?.attemptId !== auditAttemptId) return;
        updateGoal({
          status: "paused",
          pendingCompletion: { ...completionClaim, phase: "recovery-pending", recoveryAt: nowIso(), recoveryReason: "auditor-infrastructure" },
          pauseKind: "error",
          pauseReason: `completion auditor infrastructure failure — ${error instanceof Error ? error.message : String(error)}`,
          pauseSuggestedAction: `Fix the auditor worker/model, then ${activeGoalSurfaceCommand("resume")} to retry the stored claim.`,
        }, current);
        appendLedger(current.cwd, "audit_infra_waiting", { goalId: auditGoalId, attemptId: auditAttemptId, error: String(error).slice(0, 240) });
        current.ui.notify(`Completion auditor worker failed to settle (infrastructure, not a verdict). The stored claim is safe; ${activeGoalSurfaceCommand("resume")} retries it.`, "warning");
      });
      return {
        content: [{ type: "text", text: `Completion claim persisted; detached auditor queued (model: ${via ?? "setting"}). The verdict will be applied asynchronously.` }],
        details: {},
      };
    },
  }));

  pi.registerTool(defineTool({
    name: "pause_goal",
    label: "Pause goal",
    description: "Pause the active goal with a reason and suggested action. Use when blocked on user input or unable to make progress. When the user must CHOOSE between options, pass kind=\"decision\" with the options list (recommended = 1-based index of the best one) — decision pauses render as a prominent DECISION NEEDED card. Time-gated waits (retry at a specific time) use kind=\"wait\" with resumeAt (ISO). Operational failures use kind=\"error\". VOCABULARY (v0.28.24): decision options and reasons must reference REAL commands only — /goal resume, /goal cancel, /goal tweak \"<new text>\", /list remove N, /list next, /list resume, /loop stop, /loop resume. These all act on the ACTIVE goal/item: there is NO /goal drop and NO command takes a goal id. Never show goal ids to the user — name the thing ('the active goal', 'list item \"<short name>\"'); ids are internal plumbing the user cannot act on.",
    parameters: Type.Object({
      reason: Type.String({ description: "Why the work is paused" }),
      suggestedAction: Type.Optional(Type.String({ description: "What the user should do next" })),
      kind: Type.Optional(Type.Union([Type.Literal("decision"), Type.Literal("error"), Type.Literal("wait"), Type.Literal("blocked")], { description: "Pause class: decision (user picks an option), error (operational failure), wait (time-gated), blocked (generic)" })),
      options: Type.Optional(Type.Array(Type.String(), { description: "For kind=decision: the options the user picks between (one line each)" })),
      recommended: Type.Optional(Type.Number({ description: "For kind=decision: 1-based index of the recommended option" })),
      resumeAt: Type.Optional(Type.String({ description: "For kind=wait: ISO time the pause lifts (countdown is shown)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign1 = foreignToolGuard(execCtx);
      if (foreign1) return { content: [{ type: "text", text: foreign1 }], details: {} };
      const ctx = currentToolContext(execCtx);
      if (!ctx) return staleToolResult();
      const p = params as { reason: string; suggestedAction?: string; kind?: "decision" | "error" | "wait" | "blocked"; options?: string[]; recommended?: number; resumeAt?: string };
      if (!state.goal) return { content: [{ type: "text", text: "No active goal." }], details: {} };
      // A late model/tool call from the previous turn must not overwrite a
      // paused or auditing lifecycle. That race made a genuine stop look
      // repeatable and could erase an in-flight detached-auditor state.
      if (state.goal.status !== "active") {
        return { content: [{ type: "text", text: `Goal is already ${state.goal.status}; pause request ignored.` }], details: {} };
      }
      updateGoal({
        status: "paused",
        pauseReason: p.reason,
        pauseSuggestedAction: p.suggestedAction,
        pauseKind: p.kind,
        pauseOptions: p.kind === "decision" && p.options && p.options.length > 0 ? p.options : undefined,
        pauseRecommended: p.kind === "decision" && p.recommended && p.recommended >= 1 ? Math.floor(p.recommended) : undefined,
        pauseResumeAt: p.kind === "wait" && p.resumeAt ? p.resumeAt : undefined,
      }, ctx);
      if (p.kind === "decision" && p.options && p.options.length > 0) maybeDecisionPopup(ctx);
      // v0.27.1: surface the FULL pause contract — reason AND suggested
      // action. Before, the action only appeared in /goal status and the
      // widget truncated both at ~60 chars, so decision-pauses ("choose a
      // or b") reached the user as an unreadable fragment.
      ctx.ui.notify(`${goalNoun()} paused: ${p.reason}${p.suggestedAction ? `\n\n→ ${p.suggestedAction}` : ""}`, "info");
      notifyExternal(ctx, `${goalNoun()} paused: ${(p.suggestedAction ? `${p.reason} → ${p.suggestedAction}` : p.reason).slice(0, 200)}`);
      return { content: [{ type: "text", text: `Goal paused. ${activeGoalSurfaceCommand("resume")} to continue.` }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "complete_task",
    label: "Complete task",
    description: "Mark a task in the active goal's task list as complete (does not stop the turn).",    parameters: Type.Object({
      id: Type.String({ description: "Task id to complete" }),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign7 = foreignToolGuard(execCtx);
      if (foreign7) return { content: [{ type: "text", text: foreign7 }], details: {} };
      const ctx = currentToolContext(execCtx);
      if (!ctx) return staleToolResult();
      const p = params as { id: string };
      if (!state.goal || !state.goal.taskList) {
        return { content: [{ type: "text", text: "No task list in this goal." }], details: {} };
      }
      const tl = state.goal.taskList;
      const queue: any[] = [...tl.tasks];
      while (queue.length > 0) {
        const t = queue.shift();
        if (t.id === p.id && t.status !== "complete") {
          t.status = "complete";
          updateGoal({ taskList: tl }, ctx);
          return { content: [{ type: "text", text: `Task ${p.id} marked complete.` }], details: {} };
        }
        if (t.subtasks) queue.push(...t.subtasks);
      }
      return { content: [{ type: "text", text: `Task ${p.id} not found.` }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "update_task_status",
    label: "Update task status",
    description: "Update a task's status (pending/in_progress/complete).",
    parameters: Type.Object({
      id: Type.String(),
      status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("complete")]),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign8 = foreignToolGuard(execCtx);
      if (foreign8) return { content: [{ type: "text", text: foreign8 }], details: {} };
      const ctx = currentToolContext(execCtx);
      if (!ctx) return staleToolResult();
      const p = params as { id: string; status: "pending" | "in_progress" | "complete" };
      if (!state.goal || !state.goal.taskList) {
        return { content: [{ type: "text", text: "No task list in this goal." }], details: {} };
      }
      const tl = state.goal.taskList;
      const queue: any[] = [...tl.tasks];
      while (queue.length > 0) {
        const t = queue.shift();
        if (t.id === p.id) {
          t.status = p.status;
          updateGoal({ taskList: tl }, ctx);
          return { content: [{ type: "text", text: `Task ${p.id} → ${p.status}` }], details: {} };
        }
        if (t.subtasks) queue.push(...t.subtasks);
      }
      return { content: [{ type: "text", text: `Task ${p.id} not found.` }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "propose_goal_draft",
    label: "Propose goal draft",
    description: "During goal drafting (/goal with no args), propose the clarified goal contract. Opens the user's Confirm dialog — nothing activates until they confirm. BLOCKED until the user has replied to at least one of your interview questions.",
    parameters: Type.Object({
      objective: Type.String({ description: "The clarified, concrete objective (single item) or a summary when items[] is used" }),
      verificationContract: Type.Optional(Type.String({ description: "Checkable done-criteria (commands, file states, test outcomes)" })),
      items: Type.Optional(Type.Array(Type.String(), { description: "LIST drafting only: many objectives at once (e.g. 'queue these 50 things'). Each becomes a list item; per-item 'Done when:' clauses are honored." })),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign2 = foreignToolGuard(execCtx);
      if (foreign2) return { content: [{ type: "text", text: foreign2 }], details: {} };
      const p = params as { objective: string; verificationContract?: string; items?: string[] };
      let liveCtx = currentToolContext(execCtx);
      if (!liveCtx) return staleToolResult();
      if (draftingTarget !== "goal" && draftingTarget !== "list") {
        return {
          content: [{ type: "text", text: "Not in goal drafting mode. The user starts drafting with /goal or /list add (no args), or activates directly with /goal <objective>." }],
          details: {},
        };
      }
      const draftGeneration = sessionGeneration;
      const staleDraftEntry = draftingTarget === "list"
        ? warnIfStaleAtEntry(liveCtx, "list drafting")
        : warnIfStaleAtEntry(liveCtx, "goal drafting");
      if (staleDraftEntry) {
        clearDraftingState();
        return { content: [{ type: "text", text: DRAFT_SESSION_INTERRUPTED_MESSAGE }], details: {} };
      }
      // v0.28.14: one-active-thing EARLY guard — refuse the whole interview
      // when a loop is live (the post-confirm backstop below stays: state
      // can change mid-interview).
      if (isLoopActive()) {
        return { content: [{ type: "text", text: "A loop is active — one active thing at a time. The user must /loop stop it before a goal or list item can activate; do not re-propose until then." }], details: {} };
      }
      // v0.14.0: the interview floor — no Confirm until the user replied.
      // v0.23.8: Auto-accept drafts = on in /glla settings skips the floor
      // AND the Confirm —
      // the seed carries the intent (unattended rigs). Default off.
      const autoAccept = loadSettings(liveCtx.cwd).autoAcceptDrafts === true;
      if (!autoAccept) {
        if (draftingUserReplies === 0) draftingBlockedProposals++;
        const block = draftProposalBlock(draftingUserReplies, draftingBlockedProposals);
        if (block) {
          return { content: [{ type: "text", text: block }], details: {} };
        }
      }
      // Multi-item drafts are LIST-only: a goal is single by definition.
      if (p.items && p.items.length > 0 && draftingTarget !== "list") {
        return {
          content: [{ type: "text", text: "items[] is only valid in /list drafting — a goal is a single objective. Propose one objective, or ask the user to switch to /list." }],
          details: {},
        };
      }
      // Multi-item list draft: one Confirm for the whole batch.
      if (p.items && p.items.length > 0) {
        // v0.23.7: show ALL items in full — the user approves the whole
        // batch; hidden items would be approved blind.
        const preview = p.items.map((t, i) => `  ${i + 1}. ${t}`).join("\n");
        const batchActivates = !state.goal || state.goal.status === "complete" || state.goal.status === "aborted";
        let batchConfirmed = false;
        if (autoAccept) {
          batchConfirmed = true;
          liveCtx.ui.notify(`List batch auto-accepted (Auto-accept drafts = on in /glla settings): ${p.items.length} items${batchActivates ? " — item 1 ACTIVATES now" : ""}.`, "info");
          appendLedger(liveCtx.cwd, "draft_autoaccepted", { kind: "batch", count: p.items.length });
        } else {
          const c = await confirmDraft(
            liveCtx,
            "Confirm list batch",
            `${p.items.length} items:\n${preview}${batchActivates ? "\n\n(List is empty — confirming ACTIVATES item 1 immediately as the active goal.)" : ""}`,
          );
          const afterConfirm = freshCtxForGeneration(draftGeneration);
          if (!afterConfirm) {
            clearDraftingState();
            return { content: [{ type: "text", text: DRAFT_SESSION_INTERRUPTED_MESSAGE }], details: {} };
          }
          liveCtx = afterConfirm;
          if (c === "stale") {
            // v0.28.1 (T1): a stale dialog is NOT a rejection — nothing was
            // refused; the dialog simply can't render in a doomed process.
            clearDraftingState();
            extensionApiStale = true;
            appendLedger(liveCtx.cwd, "extension_api_stale", { where: "batch confirm" });
            return { content: [{ type: "text", text: "The Confirm dialog could not render: pi invalidated this session's extension handle (session replacement). This is NOT a rejection — do NOT refine or re-propose. Wait for a fresh session_start, then re-run the drafting flow." }], details: {} };
          }
          batchConfirmed = c === "yes";
        }
        if (!batchConfirmed) {
          return {
            content: [{ type: "text", text: "Batch rejected by the user. Ask what to change, refine the item list, and propose again." }],
            details: {},
          };
        }
        draftingTarget = null;
        const wasIdle = !state.goal || state.goal.status === "complete" || state.goal.status === "aborted";
        const n = enqueueItems(liveCtx, p.items, "drafted batch");
        if (wasIdle) {
          return { content: [{ type: "text", text: `${n} items confirmed; first activated (list was empty). Begin work now.` }], details: {} };
        }
        return { content: [{ type: "text", text: `${n} items confirmed and added to the list (${listQueue().length} waiting).` }], details: {} };
      }
      const normContract = p.verificationContract?.trim() ? normalizeDraftContract(p.verificationContract) : "";
      const checkCount = normContract ? draftContractItemCount(normContract) : 0;
      const contractBlock = normContract
        ? `\n\nDone when${checkCount > 0 ? ` — ${checkCount} check${checkCount === 1 ? "" : "s"}` : ""}:\n${normContract}`
        : "\n\n(No verification contract — the auditor will infer done-criteria from the objective. Consider adding one.)";
      // v0.22.6: a list draft that will activate immediately must SAY so in
      // the Confirm dialog — "I started a list and ended up with a running
      // goal" was a real surprise. Title + trailing note name the outcome.
      const isListDraft = draftingTarget === "list";
      const willActivate = isListDraft && (!state.goal || state.goal.status === "complete" || state.goal.status === "aborted");
      const activationNote = isListDraft
        ? willActivate
          ? "\n\n(List is empty — confirming ACTIVATES this immediately as the active goal. Reject if you only wanted to add it, not start it.)"
          : "\n\n(Goes into the list, waiting behind the active goal.)"
        : "";
      let confirmed = false;
      if (autoAccept) {
        confirmed = true;
        liveCtx.ui.notify(`Draft auto-accepted (Auto-accept drafts = on in /glla settings)${willActivate ? " — ACTIVATING now" : ""}: ${displaySlice(p.objective.trim(), 90)}`, "info");
        appendLedger(liveCtx.cwd, "draft_autoaccepted", { kind: isListDraft ? "list" : "goal", objective: p.objective.trim().slice(0, 200) });
      } else {
        const c = await confirmDraft(liveCtx, isListDraft ? "Confirm list item" : "Confirm goal", `${sanitizeDisplayText(p.objective.trim())}${sanitizeDisplayText(contractBlock)}${activationNote}`);
        const afterConfirm = freshCtxForGeneration(draftGeneration);
        if (!afterConfirm) {
          clearDraftingState();
          return { content: [{ type: "text", text: DRAFT_SESSION_INTERRUPTED_MESSAGE }], details: {} };
        }
        liveCtx = afterConfirm;
        if (c === "stale") {
          // v0.28.1 (T1): a stale dialog is NOT "Draft rejected by the user".
          clearDraftingState();
          extensionApiStale = true;
          appendLedger(liveCtx.cwd, "extension_api_stale", { where: "draft confirm" });
          return { content: [{ type: "text", text: "The Confirm dialog could not render: pi invalidated this session's extension handle (session replacement). This is NOT a rejection — do NOT refine or re-propose. Wait for a fresh session_start, then re-run the drafting flow." }], details: {} };
        }
        confirmed = c === "yes";
      }
      if (!confirmed) {
        return {
          content: [{ type: "text", text: "Draft rejected by the user. Ask what to change, refine, and propose again. Do not repeat the identical draft." }],
          details: {},
        };
      }
      // v0.29.1: zombie-twin guard — a draft (auto-accepted OR confirmed)
      // whose objective duplicates a goal COMPLETED in the last 24h is
      // re-creating finished work. The Confirm dialog never said it was a
      // duplicate, so the gate belongs here. Junk-runner field case: the
      // just-approved INFRA-NEW-18 close re-drafted itself 3 minutes later.
      if (recentlyCompletedObjectives(liveCtx.cwd).has(normalizeObjective(p.objective.trim()))) {
        draftingTarget = null;
        appendLedger(liveCtx.cwd, "draft_duplicate_skipped", { kind: isListDraft ? "list" : "goal", objective: p.objective.trim().slice(0, 200) });
        liveCtx.ui.notify(`Draft REJECTED (zombie-twin guard): this objective matches a goal completed in the last 24h. Tell the user the work is already done.`, "warning");
        return {
          content: [{ type: "text", text: "This draft duplicates a goal that was COMPLETED within the last 24 hours (normalized objective match). Do NOT re-propose the same work. Report to the user that the objective is already done (see /glla audits or the archive) and ask what genuinely new work to take on instead." }],
          details: {},
        };
      }
      const confirmedTarget = draftingTarget;
      draftingTarget = null;
      const full = p.objective.trim() + (normContract ? `\nDone when:\n${normContract}` : "");
      // The user has just confirmed this activation; release the blank-start
      // barrier before the direct goal path schedules its first continuation.
      releaseInitialSessionLoadBarrier();
      // v0.28.14: one-active-thing — no goal/list activation over a live loop.
      if (isLoopActive()) {
        return { content: [{ type: "text", text: "A loop is active — one active thing at a time. The user must /loop stop it before a goal or list item can activate; do not re-propose until then." }], details: {} };
      }
      resolveCarryover(liveCtx, "goal"); // v0.28.14: surface/clear stale leftovers
      // List drafting: the confirmed contract goes into the QUEUE, not active.
      if (confirmedTarget === "list") {
        const extracted = extractVerificationContract(full);
        const item = { id: newGoalId(), objective: extracted.objective, verificationContract: extracted.verificationContract || undefined, addedAt: nowIso() };
        // v0.34.61: disk-first — same invariant as addSingleItem. The list
        // draft path was the second-missed place: previously the in-memory
        // state mutated without a sidecar, so a torn-rename or post-mutation
        // crash could drop the drafted item.
        writeQueueItemFile(liveCtx.cwd, item);
        state = { ...state, list: [...listQueue(), item] };
        persistState(liveCtx);
        appendLedger(liveCtx.cwd, "list_added", { id: item.id, objective: item.objective, drafted: true });
        if (!state.goal || state.goal.status === "complete" || state.goal.status === "aborted") {
          // v0.29.4: an auto-accepted draft STARTS — autoAcceptDrafts is the
          // pre-consent (the user asked for the draft in-session). The
          // 0.28.28 autoResume hold is lifted: that setting now gates ONLY
          // launch-time restore. The 0.29.1 zombie-twin guard already
          // refused duplicates of just-completed work upstream.
          activateNextListItem(liveCtx);
          return { content: [{ type: "text", text: "Confirmed and activated (list was empty). Begin work now." }], details: {} };
        }
        return { content: [{ type: "text", text: `Confirmed and added to the list (${listQueue().length} waiting). It activates when the current goal completes.` }], details: {} };
      }
      const goal = createGoal(full, liveCtx);
      setGoal(goal, liveCtx, autoAccept ? "draft-autoaccepted" : "draft-confirmed");
      // v0.29.4: auto-accepted drafts START (autoAcceptDrafts is the
      // pre-consent — the user asked for the draft in-session). autoResume
      // no longer gates draft starts; it gates ONLY launch-time restore of
      // persisted state ("load it but not auto start it"). Zombie twins of
      // just-completed work are refused upstream (0.29.1).
      iterationCounter = 0;
      consecutiveErrorIterations = 0;
      consecutiveAbortIterations = 0;
      scheduleContinuation(liveCtx, true);
      return {
        content: [{ type: "text", text: `Goal confirmed and activated (id ${goal.id}). Begin work now; call complete_goal only when the objective is genuinely satisfied.` }],
        details: {},
      };
    },
  }));

  pi.registerTool(defineTool({
    name: "propose_loop_draft",
    label: "Propose loop draft",
    description: "During loop drafting (/loop with no args), propose the loop configuration. The orchestrator test-runs the measure command ONCE and shows the user real output + parsed number in a Confirm dialog. A measure producing no number is auto-rejected. Omit measureCmd (or pass \"none\") for a metricless spec loop — no plateau stop; ends only at bounds or /loop stop.",
    parameters: Type.Object({
      target: Type.String({ description: "What to improve, concretely" }),
      measureCmd: Type.Optional(Type.String({ description: 'Shell command that prints ONE number representing progress — or the literal "none" for a metricless spec loop' })),
      direction: Type.Optional(Type.Union([Type.Literal("min"), Type.Literal("max")], { description: "min = lower is better, max = higher is better (omit for a metricless loop)" })),
      window: Type.Optional(Type.Number({ description: "Plateau stop after N non-improving iterations (default 5)" })),
      max: Type.Optional(Type.Number({ description: "Iteration cap (default 50)" })),
      time: Type.Optional(Type.Number({ description: "Arbitrary bound: stop after this many hours" })),
      tokens: Type.Optional(Type.Number({ description: "Arbitrary bound: stop after this many tokens (input+output)" })),
      branch: Type.Optional(Type.Boolean({ description: "branch=true: scratch-branch mode (clean git tree required)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign3 = foreignToolGuard(execCtx);
      if (foreign3) return { content: [{ type: "text", text: foreign3 }], details: {} };
      const p = params as { target: string; measureCmd?: string; direction?: "min" | "max"; window?: number; max?: number; time?: number; tokens?: number; branch?: boolean };
      const liveCtx = currentToolContext(execCtx);
      if (!liveCtx) return staleToolResult();
      if (warnIfStaleAtEntry(liveCtx, "loop drafting")) {
        clearDraftingState();
        return { content: [{ type: "text", text: DRAFT_SESSION_INTERRUPTED_MESSAGE }], details: {} };
      }
      if (draftingTarget !== "loop") {
        return {
          content: [{ type: "text", text: "You cannot start or draft a loop — only the user can, from the slash bar (the Confirm is the product). Do NOT write draft files or wait for the user to say 'start' in chat; that dead-ends. Instead hand the user the exact command: /loop start \"<target>\" (bare = infinite metricless; add measure=\"<cmd>\" direction=min|max for a metric loop), or /loop respec to reconcile against the root spec, or /loop with no args to draft interactively." }],
          details: {},
        };
      }
      // v0.28.14: one-active-thing EARLY guard — refuse before the
      // interview floor (a live goal blocks any loop proposal).
      if (state.goal && state.goal.status === "active") {
        return { content: [{ type: "text", text: `A goal is active — one active thing at a time. The user must ${activeGoalSurfaceCommand("pause")} or ${activeGoalSurfaceCommand("cancel")} it before a loop can start; do not re-propose until then.` }], details: {} };
      }
      // v0.14.0: the interview floor — no Confirm until the user replied.
      if (draftingUserReplies === 0) draftingBlockedProposals++;
      const loopBlock = draftProposalBlock(draftingUserReplies, draftingBlockedProposals);
      if (loopBlock) {
        return { content: [{ type: "text", text: loopBlock }], details: {} };
      }
      if (!p.target?.trim()) {
        return { content: [{ type: "text", text: "target is required." }], details: {} };
      }
      // v0.23.0: measureCmd omitted or "none" → metricless spec loop.
      const metricless = !p.measureCmd?.trim() || p.measureCmd.trim().toLowerCase() === "none";
      if (!metricless && p.direction !== "min" && p.direction !== "max") {
        return { content: [{ type: "text", text: 'direction=min|max is required for a measured loop (omit measureCmd or pass "none" for a metricless spec loop).' }], details: {} };
      }
      // v0.28.14: one-active-thing — refuse to even test-run a loop measure
      // while a goal/list-item is active (the /loop start COMMAND guards
      // this; the tool path used to skip it and stack a loop over a goal).
      if (state.goal && state.goal.status === "active") {
        return { content: [{ type: "text", text: `A goal is active — one active thing at a time. The user must ${activeGoalSurfaceCommand("pause")} or ${activeGoalSurfaceCommand("cancel")} it before a loop can start; do not re-propose until then.` }], details: {} };
      }
      // THE TEST-RUN: orchestrator runs the proposed measure once. The user
      // sees the real number before a single iteration burns tokens.
      // (Metricless loops skip this — there is no measure to test-run.)
      let rawOutput = "";
      let parsed: number | null = null;
      if (!metricless && extensionApi) {
        try {
          const result = await extensionApi.exec("bash", ["-c", p.measureCmd!], { cwd: liveCtx.cwd });
          rawOutput = String((result as any)?.stdout ?? "").trim();
          parsed = parseMetric(rawOutput);
        } catch (err) {
          rawOutput = `(measure command failed: ${err instanceof Error ? err.message : String(err)})`;
        }
      }
      if (!metricless && parsed === null) {
        return {
          content: [{
            type: "text",
            text: `Measure test-run produced NO number — proposal auto-rejected.\nCommand: ${p.measureCmd}\nOutput: ${rawOutput.slice(0, 300) || "(empty)"}\nFix the command so it prints exactly one number, sanity-check it against the repo, and propose again.`,
          }],
          details: {},
        };
      }
      const window = p.window && p.window > 0 ? Math.floor(p.window) : 5;
      // v0.23.0: explicit max=0 = truly unbounded (no iteration cap).
      // v0.23.8: metricless + no explicit max = UNBOUNDED here too — the
      // drafter path was still defaulting to 50 after v0.23.6 flipped the
      // CLI default.
      const max = p.max !== undefined && Number.isFinite(p.max) && p.max >= 0 ? Math.floor(p.max) : metricless ? 0 : 50;
      const autoAccept = loadSettings(liveCtx.cwd).autoAcceptDrafts === true;
      let confirmed = false;
      if (autoAccept) {
        confirmed = true;
        liveCtx.ui.notify(`Loop draft auto-accepted (Auto-accept drafts = on in /glla settings): ${displaySlice(p.target.trim(), 90)}`, "info");
        appendLedger(liveCtx.cwd, "draft_autoaccepted", { kind: "loop", target: p.target.trim().slice(0, 200), metricless });
      } else {
        try {
          const c = await confirmDraft(
          liveCtx,
          "Confirm loop",
          metricless
            ? `Target: ${sanitizeDisplayText(p.target.trim())}\n\nMeasure: NONE — metricless spec loop. There is NO plateau stop: the loop ends only at ${max > 0 ? `${max} iterations` : "NO iteration cap"}${typeof p.time === "number" && p.time > 0 ? ` · Time bound: ${p.time}h` : ""}${typeof p.tokens === "number" && p.tokens > 0 ? ` · Token bound: ${p.tokens.toLocaleString()}` : ""} · /loop stop.${p.branch ? "\nbranch mode: scratch branch, every iteration committed (clean tree required)" : ""}\n\nEvery iteration must make ONE real, inspectable change — cosmetic churn is the known failure mode (doorknob-polishing). Start it?`
            : `Target: ${sanitizeDisplayText(p.target.trim())}\n\nMeasure: ${sanitizeDisplayText(p.measureCmd ?? "")}\nTest-run output: ${sanitizeDisplayText(rawOutput).slice(0, 200)}\nParsed number: ${parsed} (${p.direction === "min" ? "lower is better" : "higher is better"})\n\nPlateau stop: ${window} non-improving iterations · Cap: ${max > 0 ? `${max} iterations` : "none (unbounded)"}${typeof p.time === "number" && p.time > 0 ? ` · Time bound: ${p.time}h` : ""}${typeof p.tokens === "number" && p.tokens > 0 ? ` · Token bound: ${p.tokens.toLocaleString()}` : ""}${p.branch ? "\nbranch mode: scratch branch (clean tree required)" : ""}\n\nThe loop never completes — it runs until one of these bounds, plateau, or /loop stop. Start it?`,
          );
          confirmed = c === "yes";
        } catch {
          confirmed = false;
        }
      }
      if (!confirmed) {
        return {
          content: [{ type: "text", text: "Loop draft rejected by the user. Ask what to change — target, metric, direction, or window/max — and propose again." }],
          details: {},
        };
      }
      draftingTarget = null;
      const started = await startLoopFromConfig(liveCtx, {
        target: p.target.trim(),
        measureCmd: metricless ? "" : p.measureCmd!.trim(),
        direction: metricless ? undefined : p.direction,
        plateauWindow: window,
        maxIterations: max,
        timeLimitHours: typeof p.time === "number" && Number.isFinite(p.time) && p.time > 0 ? p.time : undefined,
        tokenBudget: typeof p.tokens === "number" && Number.isFinite(p.tokens) && p.tokens > 0 ? Math.floor(p.tokens) : undefined,
        branch: p.branch === true,
      });
      if (!started) {
        return { content: [{ type: "text", text: "Loop could not start (see the warning above — likely a git/dirty-tree issue with branch mode)." }], details: {} };
      }
      return {
        content: [{ type: "text", text: metricless ? "Loop confirmed and started (metricless — no plateau). Make ONE real, inspectable change per turn." : `Loop confirmed and started. Baseline ${parsed}. Make ONE small change per turn to move the metric ${p.direction === "min" ? "down" : "up"}.` }],
        details: {},
      };
    },
  }));

  pi.registerTool(defineTool({
    name: "propose_loop_refine",
    label: "Propose loop spec refinement",
    description: "While a loop is ACTIVE, propose refining the loop's spec — sharpen the target and/or change the measure command — when the current spec no longer captures 'better'. The user confirms; on a measure change the orchestrator test-runs the new command and re-baselines. Never edit the measure command or its inputs directly — that is gaming the metric.",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "The sharpened target text (omit to keep the current target)" })),
      measureCmd: Type.Optional(Type.String({ description: "The new measure command printing ONE number (omit to keep the current metric)" })),
      specText: Type.Optional(Type.String({ description: "v0.33.2: full replacement text for the loop's spec file (respec loops only) — the orchestrator owns the write on user confirm" })),
      specAppend: Type.Optional(Type.String({ description: "v0.33.2: lines to append to the loop's spec file (respec loops only)" })),
      rationale: Type.String({ description: "Why the current spec no longer captures 'better' — shown to the user in the Confirm dialog" }),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign4 = foreignToolGuard(execCtx);
      if (foreign4) return { content: [{ type: "text", text: foreign4 }], details: {} };
      const p = params as { target?: string; measureCmd?: string; specText?: string; specAppend?: string; rationale: string };
      const liveCtx = currentToolContext(execCtx);
      if (!liveCtx) return staleToolResult();
      const loop = state.loop;
      if (!loop?.active) {
        return { content: [{ type: "text", text: "No active loop to refine. propose_loop_refine is only valid while a loop is running." }], details: {} };
      }
      const newTarget = p.target?.trim() || loop.target;
      const newMeasure = p.measureCmd?.trim() || loop.measureCmd || "";
      // v0.23.0: a metricless loop can't be refined into a measured one
      // (no direction, no baseline semantics) — stop and restart instead.
      if (!loop.measureCmd && p.measureCmd?.trim()) {
        return { content: [{ type: "text", text: "This loop is metricless — refining it into a measured loop isn't supported. /loop stop, then /loop start with a metric." }], details: {} };
      }
      const specChange = (p.specText?.trim() || p.specAppend?.trim()) ? true : false;
      if (specChange && !loop.specFile) {
        return { content: [{ type: "text", text: "This loop has no spec file (specText/specAppend apply to /loop respec loops). Refine the target instead." }], details: {} };
      }
      if (newTarget === loop.target && newMeasure === loop.measureCmd && !specChange) {
        return { content: [{ type: "text", text: "Refinement proposed no changes — provide a new target, a new measureCmd, a spec change, or any combination." }], details: {} };
      }
      // Measure change → orchestrator test-runs the new command first.
      let newBaseline: number | null = null;
      let testOutput = "";
      if (newMeasure !== loop.measureCmd) {
        if (!extensionApi) return { content: [{ type: "text", text: "No extension API available." }], details: {} };
        try {
          const result = await extensionApi.exec("bash", ["-c", newMeasure], { cwd: liveCtx.cwd });
          testOutput = String((result as any)?.stdout ?? "");
        } catch (e) {
          return { content: [{ type: "text", text: `New measure command failed to run: ${String(e).slice(0, 200)}` }], details: {} };
        }
        newBaseline = parseMetric(testOutput);
        if (newBaseline === null) {
          return {
            content: [{ type: "text", text: `New measure produced NO number — refinement auto-rejected.\nCommand: ${newMeasure}\nOutput: ${testOutput.slice(0, 300) || "(empty)"}\nFix it and propose again.` }],
            details: {},
          };
        }
      }
      let confirmed = false;
      if (loadSettings(liveCtx.cwd).autoAcceptDrafts === true) {
        confirmed = true;
        liveCtx.ui.notify("Loop spec refinement auto-accepted (Auto-accept drafts = on in /glla settings).", "info");
        appendLedger(liveCtx.cwd, "draft_autoaccepted", { kind: "loop-refine" });
      } else {
        try {
          confirmed = (await confirmDraft(
            liveCtx,
            "Confirm loop spec refinement",
          `Rationale: ${sanitizeDisplayText(p.rationale)}\n\nTarget:\n  old: ${displaySlice(loop.target, 120)}\n  new: ${displaySlice(newTarget, 120)}\n\nMeasure:\n  old: ${sanitizeDisplayText(loop.measureCmd ?? "none")}\n  new: ${sanitizeDisplayText(newMeasure)}${newMeasure !== loop.measureCmd ? `\n  test-run: ${sanitizeDisplayText(testOutput).slice(0, 120)} → ${newBaseline}` : ""}${specChange ? `\n\nSpec file (${sanitizeDisplayText(loop.specFile ?? "")}:\n  ${p.specText?.trim() ? `REPLACE with ${p.specText!.trim().length} chars` : ""}${p.specText?.trim() && p.specAppend?.trim() ? " + " : ""}${p.specAppend?.trim() ? `APPEND: ${sanitizeDisplayText(p.specAppend!.trim()).slice(0, 120)}` : ""}` : ""}\n\nThe loop keeps running against the refined spec (iteration ${loop.iteration} so far). Apply?`,
          )) === "yes";
        } catch {
          confirmed = false;
        }
      }
      if (!confirmed) {
        return { content: [{ type: "text", text: "Refinement rejected by the user. The loop continues against the current spec — keep improving the metric as defined." }], details: {} };
      }
      applyRefinement(loop, {
        at: nowIso(),
        iteration: loop.iteration,
        oldTarget: loop.target,
        newTarget,
        oldMeasureCmd: loop.measureCmd ?? "",
        newMeasureCmd: newMeasure,
      }, newBaseline);
      // v0.33.2: the orchestrator owns the spec write (honesty stays
      // inspectable — the agent never edits the spec it's judged against
      // outside a confirmed refine).
      if (specChange && loop.specFile) {
        try {
          if (p.specText?.trim()) fs.writeFileSync(loop.specFile, p.specText.trim() + "\n");
          if (p.specAppend?.trim()) fs.appendFileSync(loop.specFile, (p.specText?.trim() ? "" : "\n") + p.specAppend.trim() + "\n");
          loop.specHash = specFileHash(loop.specFile) ?? undefined;
          appendLedger(liveCtx.cwd, "spec_updated", { via: "refine", iteration: loop.iteration, replaced: Boolean(p.specText?.trim()), appended: Boolean(p.specAppend?.trim()) });
        } catch (e) {
          return { content: [{ type: "text", text: `Spec file write failed: ${String(e).slice(0, 200)}. The target/measure refinement was applied; re-propose the spec change.` }], details: {} };
        }
      }
      persistState(liveCtx);
      appendLedger(liveCtx.cwd, "loop_refined", { iteration: loop.iteration, newTarget, newMeasureCmd: newMeasure, newBaseline, specChanged: specChange || undefined });
      liveCtx.ui.notify(`Loop spec refined at iteration ${loop.iteration}.${newBaseline !== null ? ` New baseline: ${newBaseline}.` : ""}${specChange ? " Spec file updated." : ""}`, "info");
      return { content: [{ type: "text", text: "Refinement confirmed and applied. Continue improving against the NEW spec — one small change per turn." }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "list_add",
    label: "Add to list",
    description: "Add one or many objectives to the /list list (loop 2). Use when the user asks to add work — 'add these to my list', 'queue these 10 things', 'put this on the backlog'. The list is a POOL, not a FIFO: order is the default, not the law — any item can be activated next. Each item becomes an audited goal; per-item 'Done when:' clauses are honored. The first item activates automatically when nothing is running. The list is UNBOUNDED — hundreds of small items are fine; propose them all.",
    parameters: Type.Object({
      items: Type.Array(Type.String(), { description: "Objectives to add — no count limit; large plans belong in ONE call." }),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign5 = foreignToolGuard(execCtx);
      if (foreign5) return { content: [{ type: "text", text: foreign5 }], details: {} };
      const p = params as { items: string[] };
      const liveCtx = currentToolContext(execCtx);
      if (!liveCtx) return staleToolResult();
      if (listMutationBlocked(draftingTarget)) {
        return { content: [{ type: "text", text: LIST_DRAFTING_BLOCK_MESSAGE }], details: {} };
      }
      if (!Array.isArray(p.items) || p.items.length === 0) {
        return { content: [{ type: "text", text: "No items given." }], details: {} };
      }
      const clean = p.items.map((t) => t.trim()).filter((t) => t.length > 0);
      const wasIdle = !state.goal || state.goal.status === "complete" || state.goal.status === "aborted";
      const n = enqueueItems(liveCtx, clean, "agent list_add");
      return {
        content: [{
          type: "text",
          text: wasIdle
            ? `${n} item(s) added; the first is now active. Work it normally and call complete_goal when done — the next item activates automatically.`
            : `${n} item(s) queued (${listQueue().length} waiting behind the active goal).`,
        }],
        details: {},
      };
    },
  }));

  pi.registerTool(defineTool({
    name: "list_activate",
    label: "Activate list item",
    description: "Activate a specific item from the /list queue by position (1-based). Order is the default, not the law: use this when a different item should be worked next (e.g. you want to research item 5 while item 1 waits). Aborts the currently active goal if one is running.",
    parameters: Type.Object({
      n: Type.Number({ description: "1-based position in the queue (1 = head)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign6 = foreignToolGuard(execCtx);
      if (foreign6) return { content: [{ type: "text", text: foreign6 }], details: {} };
      const p = params as { n: number };
      const liveCtx = currentToolContext(execCtx);
      if (!liveCtx) return staleToolResult();
      if (listMutationBlocked(draftingTarget)) {
        return { content: [{ type: "text", text: LIST_DRAFTING_BLOCK_MESSAGE }], details: {} };
      }
      const n = Math.floor(p.n);
      if (!Number.isInteger(n) || n < 1) {
        return { content: [{ type: "text", text: "n must be a positive integer (1-based position)." }], details: {} };
      }
      // v0.28.14: one-active-thing — a list item must not jump a live loop.
      if (isLoopActive()) {
        return { content: [{ type: "text", text: "A loop is active — one active thing at a time. The user must /loop stop it before a list item can activate." }], details: {} };
      }
      if (state.goal && state.goal.status === "active") {
        archiveCurrentGoal(liveCtx, "aborted", "skipped via list_activate");
      }
      if (!activateNextListItem(liveCtx, n)) {
        return { content: [{ type: "text", text: listQueue().length === 0 ? "List is empty." : `No item #${n} (list has ${listQueue().length} items).` }], details: {} };
      }
      return { content: [{ type: "text", text: `Item #${n} activated. Work it normally; call complete_goal when done.` }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "list_status",
    label: "List status",
    description: "Show the active or last terminal list item and the /list list (loop 2) as text: what's running, what's waiting.",
    parameters: Type.Object({}),
    async execute() {
      const lines: string[] = [];
      if (state.goal) {
        const terminal = state.goal.status === "complete" || state.goal.status === "aborted";
        lines.push(`${terminal ? "Last" : "Active"} [${state.goal.policy}] (${statusLabel(state.goal.status)}): ${sanitizeDisplayText(state.goal.objective)}`);
      } else {
        lines.push("Active: (none)");
      }
      const queue = listQueue();
      if (queue.length === 0) {
        lines.push("List: empty.");
      } else {
        lines.push(`List (${queue.length}):`);
        queue.slice(0, 20).forEach((item, i) => lines.push(`${i + 1}. ${sanitizeDisplayText(item.objective)}`));
        if (queue.length > 20) lines.push(`… and ${queue.length - 20} more`);
      }
      if (state.loop) {
        lines.push(`Loop: ${state.loop.active ? "active" : "stopped"} — ${sanitizeDisplayText(state.loop.target)} (best ${state.loop.bestValue ?? "n/a"}, iteration ${state.loop.iteration})`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "propose_task_list",
    label: "Propose task list",
    description: "Propose a task breakdown for the active goal. Opens the user's Confirm dialog. Limits: 20 top-level tasks, 5 subtasks per task.",
    parameters: Type.Object({
      tasks: Type.Array(Type.Object({
        title: Type.String(),
        subtasks: Type.Optional(Type.Array(Type.String())),
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign9 = foreignToolGuard(execCtx);
      if (foreign9) return { content: [{ type: "text", text: foreign9 }], details: {} };
      if (!state.goal || state.goal.status !== "active") {
        return { content: [{ type: "text", text: "No active goal to break down." }], details: {} };
      }
      if (state.goal.taskList && state.goal.taskList.tasks.length > 0) {
        return { content: [{ type: "text", text: "A task list already exists. Use update_task_status / complete_task to work it." }], details: {} };
      }
      const p = params as { tasks: TaskProposal[] };
      const liveCtx = currentToolContext(execCtx);
      if (!liveCtx) return staleToolResult();
      const invalid = validateTaskProposal(p.tasks);
      if (invalid) {
        return { content: [{ type: "text", text: invalid }], details: {} };
      }
      const preview = p.tasks.map((t, i) => {
        const subs = (t.subtasks ?? []).map((s, j) => `   ${i + 1}.${j + 1} ${s}`).join("\n");
        return `${i + 1}. ${t.title}` + (subs ? `\n${subs}` : "");
      }).join("\n");
      const autoAcceptTasks = loadSettings(liveCtx.cwd).autoAcceptDrafts === true;
      let confirmed = false;
      if (autoAcceptTasks) {
        confirmed = true;
        liveCtx.ui.notify(`Task list auto-accepted (Auto-accept drafts = on in /glla settings): ${p.tasks.length} tasks.`, "info");
        appendLedger(liveCtx.cwd, "draft_autoaccepted", { kind: "tasks", count: p.tasks.length });
      } else {
        try {
          confirmed = (await confirmDraft(liveCtx, "Confirm task list", preview)) === "yes";
        } catch {
          confirmed = false;
        }
      }
      if (!confirmed) {
        return { content: [{ type: "text", text: "Task list rejected by the user. Adjust and propose again." }], details: {} };
      }
      const taskList = buildTaskList(p.tasks);
      updateGoal({ taskList }, liveCtx);
      const subCount = taskList.tasks.reduce((n, t) => n + (t.subtasks?.length ?? 0), 0);
      return {
        content: [{ type: "text", text: `Task list set: ${taskList.tasks.length} tasks, ${subCount} subtasks. Track progress with complete_task / update_task_status.` }],
        details: {},
      };
    },
  }));
}

// =================================================================
// Settings (auditor model, thinking level)
// =================================================================

/**
 * Session thinking level with a "high" floor (v0.8.5): the auditor follows
 * the thinking level the user selected in pi; if none is set, audits run at
 * "high" — the auditor is the verification gate, depth beats speed there.
 */
/**
 * Resolve the ordered auditor model candidates. The user controls the pins:
 * primary auditor model from `/glla` settings, optional fallback pin, then
 * the pi
 * session model as the final candidate. Runtime failures advance through the
 * same list in `runDetachedCompletionWithFallback`; the plugin never silently
 * invents a provider or falls back into the parent in-process session.
 *
 * If the session model's provider is extension-registered, the detached
 * extension-less worker may not be able to auth it; that failure remains a
 * loud, bounded infrastructure result with the exact model-fix guidance.
 */
/** v0.31.3: the auditor model chain — pinned primary, pinned fallback,
 * session model LAST (user design 2026-07-31: "it can be the primary auditor
 * and the session model is always the last; we can have a fallback auditor
 * too" + "if the session model is the same as the auditor we auto fallback").
 * Two explicit pins and a cascade — no preference tables, no strategy
 * resolution (the v0.31.2 diverse-strategy machinery cost more complexity than it
 * bought; it lasted one version). Every hop is LOUD (ledger + notify): the
 * v0.9.12 no-SILENT-substitution law.
 */
/** v0.31.8: the auditor thinking options are derived from the PICKED
 * model, not a hardcoded list — same rule as pi's own thinking selector
 * (pi-ai getSupportedThinkingLevels): non-reasoning models expose only
 * "off"; xhigh/max exist only when the model maps them (thinkingLevelMap).
 * Replicated inline so the extension's older pi-ai dev-types don't matter —
 * the fields are read at runtime from the user's installed pi. */
function auditorThinkingLevels(model: any): string[] {
  const ALL = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  if (!model?.reasoning) return ["off"];
  const map = model.thinkingLevelMap as Record<string, string | null> | undefined;
  return ALL.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function resolveAuditorModel(ctx: ExtensionContext, ref?: string, fallbackRef?: string, sameSessionSwap = true): { model: any; error?: string; via?: string; fallbackModels?: AuditorModelCandidate[] } {
  const sessionModel = ctx.model as any;
  const tryRef = (trimmed: string): { model?: any; reason?: string } => {
    const slash = trimmed.indexOf("/");
    if (slash > 0) {
      const provider = trimmed.slice(0, slash);
      const model = ctx.modelRegistry.find(provider, trimmed.slice(slash + 1));
      if (!model) return { reason: "model not found" };
      // v0.29.17: an unkeyed provider counts as unavailable. (Quota-exhausted
      // keys stay on the quota-retry path — the model IS available there;
      // the key's window is the failure, not the model.)
      if (!ctx.modelRegistry.hasConfiguredAuth(model)) return { reason: `no configured auth for ${provider}` };
      return { model };
    }
    const matches = ctx.modelRegistry.getAvailable().filter((m: any) => m.id === trimmed || m.name === trimmed);
    return matches[0] ? { model: matches[0] } : { reason: "no available model matching" };
  };
  const isSession = (m: any) => sessionModel && m.provider === sessionModel.provider && m.id === sessionModel.id;
  const modelKey = (m: any): string => {
    if (!m || typeof m !== "object") return String(m ?? "(unset)");
    return `${m.provider ?? ""}/${m.id ?? ""}`;
  };
  const candidates: AuditorModelCandidate[] = [];
  const seen = new Set<string>();
  const addCandidate = (model: any, via: string): void => {
    const key = modelKey(model);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ model, via });
  };
  // v0.32.0: per-pin source labels — when the primary is unset, pins[0] IS
  // the fallback and the old i===0→"setting" map mislabeled it.
  const pins: Array<{ pin: string; src: "setting" | "fallback-pin" }> = [];
  if (ref?.trim()) pins.push({ pin: ref.trim(), src: "setting" });
  if (fallbackRef?.trim()) pins.push({ pin: fallbackRef.trim(), src: "fallback-pin" });
  for (let i = 0; i < pins.length; i++) {
    const { pin } = pins[i]!;
    const r = tryRef(pin);
    if (!r.model) {
      // Unavailable pin → cascade: next pin, then the session model (LOUD).
      appendLedger(ctx.cwd, "auditor_model_fallback", { configured: pin, reason: r.reason });
      // v0.32.0: the last pin no longer pre-announces the session fallback —
      // the post-loop block does that (it notified twice before).
      ctx.ui.notify(`Auditor model "${pin}" is unavailable (${r.reason})${i + 1 < pins.length ? " — trying the fallback pin" : ""}. Fix via /glla → Auditor model.`, "warning");
      continue;
    }
    if (sameSessionSwap && isSession(r.model) && i + 1 < pins.length) {
      // The pin IS the session model — the verifier would be the executor's
      // own model; auto-swap down the chain (the user's move).
      appendLedger(ctx.cwd, "auditor_model_same_as_session", { model: `${r.model.provider}/${r.model.id}`, fallback: pins[i + 1]!.pin });
      ctx.ui.notify(`Session model IS the pinned auditor (${r.model.provider}/${r.model.id}) — auditor auto-swapped to ${pins[i + 1]!.pin} so the verifier differs.`, "info");
      continue;
    }
    // v0.32.0: the nudge must fire when the LAST pin stands on the session
    // model — the old `!fallbackRef` guard went SILENT when the fallback pin
    // itself resolved to the session model (verifier == executor, and hop 0's
    // notify had just claimed "auto-swapped so the verifier differs" — false).
    if (sameSessionSwap && isSession(r.model) && i + 1 >= pins.length) {
      // Last resort reached and it IS the session model, with no fallback
      // ever pinned — the model stands (the session IS the last resort);
      // one loud nudge so the user can wire the swap.
      appendLedger(ctx.cwd, "auditor_model_same_as_session", { model: `${r.model.provider}/${r.model.id}`, fallback: null });
      ctx.ui.notify(`The session model IS the pinned auditor (${r.model.provider}/${r.model.id}) — pin a different /glla → Auditor fallback model so the verifier can differ.`, "warning");
    }
    addCandidate(r.model, pins[i]!.src);
  }
  if (sessionModel) addCandidate(sessionModel, pins.length > 0 ? "session-fallback" : "session");
  if (candidates.length > 0) {
    const first = candidates[0]!;
    if (first.via === "session-fallback") {
      appendLedger(ctx.cwd, "auditor_model_fallback", { configured: pins.map((p) => p.pin).join(" → ") || "(none)", reason: "all pins exhausted" });
      ctx.ui.notify("All pinned auditor models are unavailable — falling back to the session model. Fix via /glla → Auditor model.", "warning");
    }
    return { model: first.model, via: first.via, fallbackModels: candidates.slice(1) };
  }
  return { model: undefined, error: "no session model and no auditorModel configured — set one with /glla → Auditor model" };
}

// Model selection is explicit and bounded: primary pin → optional fallback
// pin → session model. A resolved primary can still fail after launch, so the
// completion path walks the same ordered candidates after one same-model
// retry; every candidate remains a detached extension-less audit. There is
// no in-process fallback into the parent session and no silent tier ranking.

/**
 * The /glla interactive settings UI (v0.8.0): a menu loop over pi's dialog
 * primitives. Pick a setting → edit it → saved to GLOBAL → back to the menu.
 * Done/Esc exits. Settings are edited here; `/glla <action>` is reserved for
 * operational commands such as status, resume, stats, and audits.
 */
/**
 * v0.28.0: open the /glla settings menu as a TUI table (top tabs row +
 * 4-column body: KEY | VALUE | SOURCE | DESCRIPTION). Loops until the user
 * exits (Esc / undefined from confirm or cancel) or until a handler returns.
 *
 * The dispatcher (handleSettingChoice, below) takes a stable id and calls the
 * per-key editor (input/select/confirm dialog) used by the pick. The prior
 * v0.27.0 dispatcher used `choice.startsWith(label)` strings; the new id-based
 * switch is contract-equal in behavior and unit-testable via
 * extensions/settings-menu.ts.
 */
async function openSettingsUI(ctx: ExtensionContext, initialSection?: SettingsSectionId): Promise<void> {
  for (;;) {
    const settings = loadSettings(ctx.cwd);
    const prov = settingsProvenance(ctx.cwd);
    const rows = buildSettingsRows(settings, prov);
    const id = await promptSettingsMenu(ctx, rows, initialSection);
    // The section is only an entry-point hint; after the first render the
    // table owns navigation and keeps all grouped settings available.
    initialSection = undefined;
    if (!id) return;
    try {
      await handleSettingChoice(id, ctx);
    } catch {
      return;
    }
  }
}

/**
 * Show the table-rendered settings menu and return the user's pick id (or
 * undefined for cancel). Wraps `ctx.ui.custom` so openSettingsUI stays a thin
 * loop. Falls back to a select-based legacy menu when the runtime has no
 * `ctx.ui.custom` (the `ctx.hasUI` guard already protects this path elsewhere;
 * this is a second-line defense for headless custom-only shards).
 */
async function promptSettingsMenu(
  ctx: ExtensionContext,
  rows: SettingsRow[],
  initialSection?: SettingsSectionId,
): Promise<string | undefined> {
  const title = `pi-goal-list-loop-audit settings — global: ${globalSettingsPath()}`;
  if (typeof (ctx.ui as { custom?: unknown }).custom !== "function") {
    // Headless / no custom shard — fall back to the legacy flat-row select
    // for any environment that lacks the new primitive. This is rare and
    // effectively an emergency hatch; the new UI is the supported path.
    const flat = rows.map((r) => `[${r.section}] ${r.label} — ${r.valueText} [${r.sourceText.replace(/^\[|\]$/g, "")}] — ${r.description}`);
    flat.push("Done");
    const v = await ctx.ui.select(title, flat);
    if (!v || v === "Done") return undefined;
    // v0.34.25: resolve by the full constructed prefix (section + label),
    // not a bare startsWith(label) — a label-prefix collision used to be
    // able to open the wrong editor silently.
    return rows.find((r) => v.startsWith(`[${r.section}] ${r.label} —`))?.id;
  }
  return await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    return new SettingsMenuComponent({ rows, title, initialSection }, () => tui.requestRender(), theme, keybindings, done);
  });
}

/**
 * v0.28.0: per-key dispatch for the settings menu. The id comes from
 * `buildSettingsRows` (e.g. "autoResume", "auditorModel", "subagentModelOverrides.Explore").
 * Same handlers as v0.27.0's if/else chain — only the trigger changed from
 * `startsWith(label)` strings to stable ids.
 */
// v0.28.7 (T4): exported for the behavioral settings-editor tests
// (tests/settings-editors.test.ts drives each editor class end-to-end).
/**
 * v0.29.17: /model-style fuzzy picker for model-valued settings. Builds the
 * item list from the registry (configured-auth providers only — a pick
 * from this list can never be a dead provider) and hosts the picker via
 * ctx.ui.custom. Falls back to the typed input when the runtime has no
 * custom shard (headless) — typing stays the emergency hatch there.
 * Returns { kind: "session" } to clear the override, { kind: "ref" } with
 * provider/id, or undefined for cancel.
 */
async function promptModelRef(
  ctx: ExtensionContext,
  title: string,
  emptyLabel: string,
): Promise<{ kind: "session" } | { kind: "ref"; ref: string } | undefined> {
  if (typeof (ctx.ui as { custom?: unknown }).custom !== "function" || !ctx.modelRegistry) {
    const v = await ctx.ui.input(title, "provider/model-id — empty keeps the default");
    if (v === undefined) return undefined;
    return v.trim() ? { kind: "ref", ref: v.trim() } : { kind: "session" };
  }
  const sessionModel = ctx.model as any;
  const sessionLabel = sessionModel ? `${sessionModel.provider}/${sessionModel.id}` : "pi session model";
  const models = ctx.modelRegistry
    .getAvailable()
    .filter((m: any) => ctx.modelRegistry.hasConfiguredAuth(m));
  const items = buildModelPickItems(models, sessionLabel);
  const pick = await ctx.ui.custom<ModelPickItem | undefined>((tui, theme, keybindings, done) => {
    return new ModelPickerComponent({ title, items }, () => tui.requestRender(), theme, keybindings, done);
  });
  if (!pick) return undefined;
  if (pick.kind === "session") return { kind: "session" };
  if (pick.kind === "model" && pick.ref) return { kind: "ref", ref: pick.ref };
  // manual escape hatch — typed provider/model, validated like before
  const v = await ctx.ui.input(title, emptyLabel);
  if (v === undefined) return undefined;
  return v.trim() ? { kind: "ref", ref: v.trim() } : { kind: "session" };
}

export async function handleSettingChoice(id: string, ctx: ExtensionContext): Promise<void> {
  switch (id) {
    case "autoResume": {
      const v = await ctx.ui.select("Auto-resume on session start — a LOADED session waits for an explicit resume; on reload/fork the machinery still rebinds so work never strands", [
        "default — hold on load, rebind on reload/fork",
        "on — auto-resume on EVERY session start (unattended rigs)",
        "off — never auto-resume; explicit resume only",
      ]);
      if (v) saveSettings("global", ctx.cwd, { autoResume: v.startsWith("on") ? true : v.startsWith("off") ? false : undefined });
      return;
    }
    case "carryover": {
      const v = await ctx.ui.select("Carryover — a NEW goal/loop meets stale paused work from a previous session", [
        "pause — one summary; archive the stale goal, keep the list + held loop (default)",
        "clear — also drop the stale queue and dismiss the held loop",
        "resume — legacy silent stacking, no summary",
      ]);
      if (v) saveSettings("global", ctx.cwd, { carryover: v.startsWith("clear") ? "clear" : v.startsWith("resume") ? "resume" : undefined });
      return;
    }
    case "autoAcceptDrafts": {
      const v = await ctx.ui.select("Auto-accept goal/loop drafts", [
        "off — the Confirm dialog gates every draft",
        "on — drafts activate immediately, no Confirm (unattended rigs)",
      ]);
      if (v) saveSettings("global", ctx.cwd, { autoAcceptDrafts: v.startsWith("on") ? true : undefined });
      return;
    }
    case "decisionPopup": {
      const v = await ctx.ui.select("Decision popup — what a decision-class pause does", [
        "on — a decision pause opens the picker; the widget card is the Escape fallback",
        `off — widget card only; ${activeGoalSurfaceCommand("decide")} opens the picker on demand`,
      ]);
      if (v) saveSettings("global", ctx.cwd, { decisionPopup: v.startsWith("off") ? false : undefined });
      return;
    }
    case "aggressiveMode": {
      const v = await ctx.ui.select("Aggressive mode — flips DEFAULTS: autoResume, audit cap 10, stuck max 10, wedge alerts off, quota auto-retry, cap objections become a TODO list (explicit per-key settings still win)", [
        "off — current behavior: pause at the audit cap, wedge alerts, manual resume",
        "on — keep-going defaults; the goal does not park at the audit cap",
      ]);
      if (v) {
        saveSettings("global", ctx.cwd, { aggressiveMode: v.startsWith("on") });
        ctx.ui.notify(`Aggressive mode ${v.startsWith("on") ? "ON — goals keep going past the audit cap; objections become TODOs" : "off"}.`, "info");
      }
      return;
    }
    case "mainModelFallbacks": {
      const current = normalizeModelRefs(loadGlobalSettings().mainModelFallbacks);
      const v = await ctx.ui.input(
        "Main session model backups — ordered, comma-separated provider/model refs",
        current.length ? current.join(",") : "provider/model-a,provider/model-b — empty clears backups",
      );
      if (v === undefined) return;
      const refs = normalizeModelRefs(v);
      saveSettings("global", ctx.cwd, { mainModelFallbacks: refs });
      ctx.ui.notify(refs.length ? `Main model backups saved in order: ${refs.join(" → ")}` : "Main model backups cleared — quota recovery will keep probing the current model.", "info");
      return;
    }
    case "forbiddenModels": {
      const current = normalizeModelRefs(loadGlobalSettings().forbiddenModels);
      const v = await ctx.ui.input(
        "Forbidden models — comma-separated provider/model refs; any switch to one is ledgered as forbidden_model_switch and (by default) reverted",
        current.length ? current.join(",") : "gpt-5.5,sonnet,opus",
      );
      if (v === undefined) return;
      const refs = normalizeModelRefs(v);
      saveSettings("global", ctx.cwd, { forbiddenModels: refs });
      ctx.ui.notify(refs.length ? `Forbidden models saved: ${refs.join(", ")}` : "Forbidden models cleared — every model is allowed (policy gate off).", "info");
      return;
    }
    case "blockForbiddenModelSwitches": {
      const v = await ctx.ui.select("Block forbidden model switches — revert a forbidden selection to the previous model", [
        "on — forbidden selections are reverted to the previous model (default)",
        "off — the switch stands; the forbidden_model_switch ledger entry still records the violation",
      ]);
      if (v) saveSettings("global", ctx.cwd, { blockForbiddenModelSwitches: v.startsWith("off") ? false : undefined });
      return;
    }
    case "mainModelRetryMinutes": {
      const v = await ctx.ui.input("Main session model recovery wait", "positive integer minutes; empty = default 15 (backs off to hourly)");
      if (v !== undefined) {
        const raw = v.trim();
        const n = Number.parseInt(raw, 10);
        if (Number.isInteger(n) && n > 0) saveSettings("global", ctx.cwd, { mainModelRetryMinutes: n });
        else if (!raw) saveSettings("global", ctx.cwd, { mainModelRetryMinutes: undefined });
        else ctx.ui.notify(`main model retry minutes must be a positive integer, got: ${v}`, "warning");
      }
      return;
    }
    case "auditorModel": {
      const pick = await promptModelRef(ctx, "Auditor model override", "provider/model-id — empty keeps the pi session model");
      if (pick === undefined) return;
      saveSettings("global", ctx.cwd, { auditorModel: pick.kind === "session" ? undefined : pick.ref });
      // v0.31.4: thinking is chosen WITH the model (user: "we are setting
      // the thinking when we select the model now or we should") — there is
      // no standalone thinking row to forget about. Esc keeps the level.
      // v0.31.7: the select must be UNMISTAKABLY the auditor's — the user
      // Esc'd through it because it read like pi's own (general) thinking
      // dialog, and nothing was ever saved.
      // v0.31.8: the options come from the PICKED MODEL's info (user: "we
      // are not using the model information cause it has no max") — a model
      // that maps xhigh/max offers them; a non-reasoning model is told, not asked.
      let pickedModel: any = pick.kind === "session" ? (ctx.model as any) : undefined;
      if (pick.kind === "ref" && pick.ref) {
        const parts = pick.ref.split("/");
        try {
          pickedModel = parts.length === 2 ? (ctx.modelRegistry?.find?.(parts[0]!, parts[1]!) as any) : (ctx.modelRegistry?.getAvailable?.().filter((m: any) => m.id === pick.ref)[0] as any);
        } catch { pickedModel = undefined; } // levels fall back to the full ladder below
      }
      const curThinking = loadSettings(ctx.cwd).auditorThinkingLevel;
      const levels = auditorThinkingLevels(pickedModel);
      if (levels.length <= 1) {
        ctx.ui.notify(`Auditor model: ${pick.kind === "session" ? "session model (override cleared)" : pick.ref} — this model exposes no thinking levels (auditor runs with thinking off).`, "info");
        return;
      }
      const DESCR: Record<string, string> = { off: "no reasoning", minimal: "~1k tokens", low: "~2k tokens", medium: "~8k tokens", high: "the default; the gate must not ride the session's coding dial", xhigh: "~32k tokens", max: "maximum reasoning" };
      const t = await ctx.ui.select(
        "Auditor thinking — DETACHED auditor worker ONLY (your session model's thinking is untouched)",
        levels.map((lv) => `${lv} — ${DESCR[lv] ?? ""}${lv === (curThinking ?? "high") ? " (current)" : ""}`),
      );
      if (t) saveSettings("global", ctx.cwd, { auditorThinkingLevel: t.split(" ")[0] as Settings["auditorThinkingLevel"] });
      ctx.ui.notify(`Auditor model: ${pick.kind === "session" ? "session model (override cleared)" : pick.ref}${t ? ` · thinking ${t.split(" ")[0]}` : ""}`, "info");
      return;
    }
    case "auditorModelFallback": {
      const pick = await promptModelRef(ctx, "Auditor fallback model (runtime failure or same-session swap)", "provider/model-id — empty clears the fallback");
      if (pick === undefined) return;
      saveSettings("global", ctx.cwd, { auditorModelFallback: pick.kind === "session" ? undefined : pick.ref });
      if (pick.kind === "session") ctx.ui.notify("Auditor fallback cleared — a session on the pinned auditor model keeps that model.", "info");
      return;
    }
    case "auditorSameSessionSwap": {
      const v = await ctx.ui.select("Same-model swap — when the pinned auditor IS the session model, walk the fallback pin (a same-family model shares the executor's blind spots)", [
        "on — the verifier differs from the executor (default)",
        "off — same-model audits stand; isolation + evidence contract still apply",
      ]);
      if (v) saveSettings("global", ctx.cwd, { auditorSameSessionSwap: v.startsWith("off") ? false : undefined });
      return;
    }
    case "auditCap": {
      const v = await ctx.ui.input("Consecutive auditor disapprovals before the goal pauses", "non-negative integer; 0 = unlimited, empty = default 5");
      if (v !== undefined) {
        const n = Number.parseInt(v.trim(), 10);
        if (Number.isFinite(n) && n >= 0) saveSettings("global", ctx.cwd, { auditCap: n });
        else if (!v.trim()) saveSettings("global", ctx.cwd, { auditCap: undefined });
        else ctx.ui.notify(`Not a non-negative integer: ${v}`, "warning");
      }
      return;
    }
    case "auditFeedbackChars": {
      const v = await ctx.ui.input("Auditor feedback returned to the executor (characters)", "non-negative integer cap; 0 or empty = full report (default)");
      if (v !== undefined) {
        const raw = v.trim();
        const n = Number(raw);
        if (/^\d+$/.test(raw) && Number.isSafeInteger(n)) saveSettings("global", ctx.cwd, { auditFeedbackChars: n });
        else if (!v.trim()) saveSettings("global", ctx.cwd, { auditFeedbackChars: undefined });
        else ctx.ui.notify(`Not a non-negative integer: ${v}`, "warning");
      }
      return;
    }
    case "quotaRetryMinutes": {
      const v = await ctx.ui.input("Minutes before auto-retrying a quota-exhausted auditor", `positive integer; empty = default ${DEFAULT_QUOTA_RETRY_MINUTES}`);
      if (v !== undefined) {
        const n = Number.parseInt(v.trim(), 10);
        if (Number.isFinite(n) && n > 0) saveSettings("global", ctx.cwd, { quotaRetryMinutes: n });
        else if (!v.trim()) saveSettings("global", ctx.cwd, { quotaRetryMinutes: undefined });
        else ctx.ui.notify(`Not a positive integer: ${v}`, "warning");
      }
      return;
    }
    case "wedgeAlertMinutes": {
      const v = await ctx.ui.input("Wedge alert threshold (minutes)", "non-negative integer; 0 = off, empty = default 30");
      if (v !== undefined) {
        const n = Number.parseInt(v.trim(), 10);
        if (Number.isFinite(n) && n >= 0) saveSettings("global", ctx.cwd, { wedgeAlertMinutes: n });
        else if (!v.trim()) saveSettings("global", ctx.cwd, { wedgeAlertMinutes: undefined });
        else ctx.ui.notify(`Not a non-negative integer: ${v}`, "warning");
      }
      return;
    }
    case "stuckMaxInterventions": {
      const v = await ctx.ui.input("Consecutive stuck interventions before a loop stops", "positive integer; empty = default 5 (10 under aggressiveMode)");
      if (v !== undefined) {
        const n = Number.parseInt(v.trim(), 10);
        if (Number.isFinite(n) && n > 0) saveSettings("global", ctx.cwd, { stuckMaxInterventions: n });
        else if (!v.trim()) saveSettings("global", ctx.cwd, { stuckMaxInterventions: undefined });
        else ctx.ui.notify(`Not a positive integer: ${v}`, "warning");
      }
      return;
    }
    case "stallEscalationRefires": {
      const v = await ctx.ui.input("Heartbeat refires without a turn before the goal pauses / loop stops", "non-negative integer; 0 = never escalate, empty = default 5");
      if (v !== undefined) {
        const n = Number.parseInt(v.trim(), 10);
        if (Number.isFinite(n) && n >= 0) saveSettings("global", ctx.cwd, { stallEscalationRefires: n });
        else if (!v.trim()) saveSettings("global", ctx.cwd, { stallEscalationRefires: undefined });
        else ctx.ui.notify(`Not a non-negative integer: ${v}`, "warning");
      }
      return;
    }
    case "stallShortWords": {
      const v = await ctx.ui.input("Stall short words threshold", "non-negative integer; 0 = off, empty = default 15");
      if (v !== undefined) {
        const n = Number.parseInt(v.trim(), 10);
        if (Number.isFinite(n) && n >= 0) saveSettings("global", ctx.cwd, { stallShortWords: n });
        else if (!v.trim()) saveSettings("global", ctx.cwd, { stallShortWords: undefined });
        else ctx.ui.notify(`Not a non-negative integer: ${v}`, "warning");
      }
      return;
    }
    case "stallSimilarityThreshold": {
      const v = await ctx.ui.input("Stall similarity threshold (0..1)", "decimal between 0 and 1; empty = default 0.6");
      if (v !== undefined) {
        const n = Number(v.trim());
        if (Number.isFinite(n) && n >= 0 && n <= 1) saveSettings("global", ctx.cwd, { stallSimilarityThreshold: n });
        else if (!v.trim()) saveSettings("global", ctx.cwd, { stallSimilarityThreshold: undefined });
        else ctx.ui.notify(`Not a decimal between 0 and 1: ${v}`, "warning");
      }
      return;
    }
    case "subagentModelStrategy": {
      const v = await ctx.ui.select("Subagent model (pi-subagents default agents)", [
        "inherit-parent — share your session model + quota pool (recommended)",
        "agent-default — use the upstream pi-subagents default agents",
      ]);
      if (v) {
        const strategy: SubagentModelStrategy = v.startsWith("agent-default") ? "agent-default" : "inherit-parent";
        saveSettings("global", ctx.cwd, { subagentModelStrategy: strategy });
        ctx.ui.notify("Subagent model strategy saved — applies to NEW pi sessions (pi-subagents registers agents at session start).", "info");
      }
      return;
    }
    case "subagentModelOverrides.Explore":
    case "subagentModelOverrides.Plan":
    case "subagentModelOverrides.general-purpose": {
      const agentType = id.slice("subagentModelOverrides.".length);
      const pick = await promptModelRef(ctx, `Model pin for ${agentType} subagents`, "provider/model-id e.g. minimax/MiniMax-M3 — always wins over strategy; empty = follow strategy");
      if (pick === undefined) return;
      const current = loadSettings(ctx.cwd).subagentModelOverrides ?? {};
      const next = { ...current };
      if (pick.kind === "ref") next[agentType] = pick.ref;
      else delete next[agentType];
      saveSettings("global", ctx.cwd, { subagentModelOverrides: Object.keys(next).length > 0 ? next : undefined });
      ctx.ui.notify(`${agentType} model pin saved — applies to NEW pi sessions.`, "info");
      return;
    }
    case "subagentResolved":
      // Read-only (effective resolution row) — no editor; row just shows the
      // current effective subagent models. Treat as no-op.
      return;
    case "notifyCmd": {
      const v = await ctx.ui.input("Notify command — the event message is passed as $1", "custom command · empty = auto-detect (notify-send/osascript) · 'off' = silent");
      if (v !== undefined) saveSettings("global", ctx.cwd, { notifyCmd: v.trim() || undefined });
      return;
    }
    case "tokenLimit": {
      const v = await ctx.ui.input("Per-goal token budget", "non-negative integer; 0 or empty = off (no cap)");
      if (v !== undefined) {
        const n = Number.parseInt(v.trim(), 10);
        if (Number.isFinite(n) && n >= 0) saveSettings("global", ctx.cwd, { tokenLimit: n });
        else if (!v.trim()) saveSettings("global", ctx.cwd, { tokenLimit: undefined });
        else ctx.ui.notify(`Not a non-negative integer: ${v}`, "warning");
      }
      return;
    }
    case "postaudit":
      await cmdReviewerSettings(ctx);
      return;
    default:
      // Unknown id — keep the menu looping. Surface a soft warning so the
      // user knows a row existed but had no handler (better than silently
      // swallowing it).
      ctx.ui.notify(`/glla: unknown setting id "${id}" — please report this.`, "warning");
      return;
  }
}

/** v0.26.0: /review <archived-goal-id> — manual reviewer invocation. */
async function cmdReview(args: string, ctx: ExtensionContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const id = parts[0] ?? "";
  const modeArg = parts[1];
  const validModes = ["off", "on", "auto", "aggressive"] as const;
  const mode = (validModes as readonly string[]).includes(modeArg ?? "")
    ? (modeArg as typeof validModes[number])
    : undefined;
  if (modeArg && !mode) {
    ctx.ui.notify(`Unknown mode "${modeArg}" — use off | on | auto | aggressive.`, "warning");
    return;
  }
  if (!id) {
    ctx.ui.notify(`Usage: /review <goal-id> [${validModes.join("|")}] — see /goal archive for ids.`, "info");
    return;
  }
  // Resolve the id against the archive (suffix match allowed).
  let goalId = id;
  let objective = "(archived goal)";
  try {
    const files = fs.readdirSync(archiveDir(ctx.cwd)).filter((f) => f.endsWith(".md"));
    const match = files.find((f) => f === `${id}.md`) ?? files.find((f) => f.includes(id));
    if (!match) {
      ctx.ui.notify(`No archived goal matching "${id}". /goal archive lists them.`, "warning");
      return;
    }
    goalId = match.replace(/\.md$/, "");
    const md = fs.readFileSync(path.join(archiveDir(ctx.cwd), match), "utf-8");
    const objMatch = md.match(/## Objective\n\n> ([\s\S]*?)(?:\n\n|$)/);
    if (objMatch) objective = objMatch[1]!.replace(/\n/g, " ").slice(0, 300);
  } catch {
    ctx.ui.notify(`No archive found for ${id}.`, "warning");
    return;
  }
  fireReviewer(ctx, { kind: "goal", goalId, objective, terminal: "goal-complete" }, { manual: true, mode });
}

/** v0.27.9: /glla tooloverride <action> [args] — per-tool override menu.
 * Actions:
 *   list                                show current allow/hide/perToolConfig
 *   allow <tool>                        force <tool> visible despite modlist
 *   hide <tool>                         force <tool> hidden despite session
 *   unallow <tool>                      remove from allow list
 *   unhide <tool>                       remove from hide list
 *   set <tool> <key>=<value>            write perToolConfig[tool][key]
 *   unset <tool> <key>                  remove perToolConfig[tool][key]
 * Example: /glla tooloverride allow bash hide write_file set bash timeout=60 */
async function cmdToolOverride(args: string, ctx: ExtensionContext): Promise<void> {
  const settings = loadSettings(ctx.cwd);
  const current = settings.toolOverrides ?? {};
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const action = parts[0];
  if (!action || action === "list" || action === "show") {
    const allow = current.allow ?? [];
    const hide = current.hide ?? [];
    const cfg = current.perToolConfig ?? {};
    const out = `toolOverrides (project):\n  allow: ${allow.length ? allow.join(", ") : "(none)"}\n  hide: ${hide.length ? hide.join(", ") : "(none)"}\n  perToolConfig: ${Object.keys(cfg).length ? JSON.stringify(cfg) : "(none)"}`;
    ctx.ui.notify(out, "info");
    return;
  }
  const apply = (patch: Partial<NonNullable<Settings["toolOverrides"]>>) => {
    saveSettings("project", ctx.cwd, { toolOverrides: { ...current, ...patch } });
  };
  if (action === "allow" || action === "hide" || action === "unallow" || action === "unhide") {
    const tool = parts[1];
    if (!tool) {
      ctx.ui.notify(`Usage: /glla tooloverride ${action} <tool>`, "warning");
      return;
    }
    if (action === "allow") {
      const allow = current.allow ?? [];
      if (!allow.includes(tool)) apply({ allow: [...allow, tool] });
      ctx.ui.notify(`"${tool}" is now always visible to the agent (project override saved).`, "info");
    } else if (action === "hide") {
      const hide = current.hide ?? [];
      if (!hide.includes(tool)) apply({ hide: [...hide, tool] });
      ctx.ui.notify(`"${tool}" is now always hidden from the agent (project override saved).`, "info");
    } else if (action === "unallow") {
      apply({ allow: (current.allow ?? []).filter((t) => t !== tool) });
      ctx.ui.notify(`"${tool}" visibility override removed — the session decides again.`, "info");
    } else {
      apply({ hide: (current.hide ?? []).filter((t) => t !== tool) });
      ctx.ui.notify(`"${tool}" hide override removed — the session decides again.`, "info");
    }
    return;
  }
  if (action === "set" || action === "unset") {
    const tool = parts[1];
    const kv = parts[2];
    if (!tool || !kv) {
      ctx.ui.notify(`Usage: /glla tooloverride ${action} <tool> <key>[=<value>]`, "warning");
      return;
    }
    const cfg = { ...(current.perToolConfig ?? {}) };
    const toolCfg = { ...(cfg[tool] ?? {}) };
    if (action === "set") {
      const eq = kv.indexOf("=");
      if (eq < 0) {
        ctx.ui.notify(`set needs key=value: got "${kv}"`, "warning");
        return;
      }
      const k = kv.slice(0, eq);
      const v: unknown = parseToolOverrideValue(kv.slice(eq + 1));
      toolCfg[k] = v;
    } else {
      delete toolCfg[kv];
    }
    cfg[tool] = toolCfg;
    apply({ perToolConfig: cfg });
    ctx.ui.notify(
      action === "set"
        ? `"${tool}" setting saved: ${kv.slice(0, kv.indexOf("="))} = ${JSON.stringify(toolCfg[kv.slice(0, kv.indexOf("="))])} (project override).`
        : `"${tool}" setting "${kv}" removed — back to the built-in default.`,
      "info",
    );
    return;
  }
  ctx.ui.notify(`Unknown tooloverride action: ${action}. Use: list | allow | hide | unallow | unhide | set | unset.`, "warning");
}

/** Parse a tool-override value: numbers, booleans, JSON objects/arrays, else string. */
function parseToolOverrideValue(s: string): unknown {
  const trimmed = s.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  return trimmed;
}

/** v0.27.5: /glla reviewer | postaudit — the post-completion audit config menu
 * (project-scoped). Reads the dual-write settings (postaudit wins over the
 * legacy reviewer key), and writes back to whichever key was read first —
 * so we don't drift two parallel config blocks. */
async function cmdReviewerSettings(ctx: ExtensionContext): Promise<void> {
  const settings = loadSettings(ctx.cwd);
  const block = (settings.postaudit ?? settings.reviewer) as Partial<ReviewerConfig> | undefined;
  const settingsKey: "postaudit" | "reviewer" = settings.postaudit !== undefined ? "postaudit" : "reviewer";
  if (!ctx.hasUI) {
    const cfg = resolveReviewerConfig(block);
    ctx.ui.notify(`${settingsKey} (project): ${JSON.stringify(cfg, null, 2)}`, "info");
    return;
  }
  const load = () => resolveReviewerConfig(loadSettings(ctx.cwd)[settingsKey] as Partial<ReviewerConfig> | undefined);
  const save = (patch: Partial<ReviewerConfig>) =>
    saveSettings("project", ctx.cwd, { [settingsKey]: { ...load(), ...patch } as Record<string, unknown> });
  for (;;) {
    const cfg = load();
    let choice: string | undefined;
    try {
      choice = await ctx.ui.select("Postaudit — post-completion follow-up enqueuer (project settings)", reviewerMenuOptions(cfg));
    } catch {
      return;
    }
    if (!choice || choice === "Done") return;
    try {
      if (choice.startsWith("Enabled")) save({ enabled: !cfg.enabled });
      else if (choice.startsWith("Mode")) {
        // v0.27.9: 4-state cycle off → on → auto → aggressive → off
        const order: Array<"off" | "on" | "auto" | "aggressive"> = ["off", "on", "auto", "aggressive"];
        const i = order.indexOf(cfg.mode as typeof order[number]);
        const next = order[(i + 1) % order.length]!;
        save({ mode: next });
      }
      else if (choice.startsWith("Leverage mode")) save({ leverageMode: cfg.leverageMode === "fix-without-confirm" ? "confirm-all" : "fix-without-confirm" });
      else if (choice.startsWith("Fire on goal-complete")) save({ fireOn: cfg.fireOn.includes("goal-complete") ? cfg.fireOn.filter((e) => e !== "goal-complete") : [...cfg.fireOn, "goal-complete"] });
      else if (choice.startsWith("Fire on list-complete")) save({ fireOn: cfg.fireOn.includes("list-complete") ? cfg.fireOn.filter((e) => e !== "list-complete") : [...cfg.fireOn, "list-complete"] });
      else if (choice.startsWith("Cascade: audit-on-clean")) save({ cascade: cfg.cascade.includes("fire-audit-on-clean") ? cfg.cascade.filter((c) => c !== "fire-audit-on-clean") : [...cfg.cascade, "fire-audit-on-clean"] });
      else if (choice.startsWith("Max findings")) {
        const v = await ctx.ui.input("Max findings per review", "1-50");
        const n = Number(v?.trim());
        if (Number.isSafeInteger(n) && n >= 1 && n <= 50) save({ maxFindingsPerReview: n });
      } else if (choice.startsWith("Max reviews")) {
        const v = await ctx.ui.input("Max reviewer fires per day", "1-100");
        const n = Number(v?.trim());
        if (Number.isSafeInteger(n) && n >= 1 && n <= 100) save({ maxReviewsPerDay: n });
      }
    } catch (err) {
      // v0.28.11 (E7): a swallowed save failure made the user believe the
      // toggle landed. Loud now.
      ctx.ui.notify(`Postaudit setting NOT saved: ${err instanceof Error ? err.message : String(err)} — check .pi-glla/settings.json permissions.`, "warning");
    }
  }
}

/**
 * v0.25.2: /glla stats — one command, every project's rollup. Args:
 *   (none)            markdown table, all discovered projects
 *   json              machine-readable rollup (same schema as the table)
 *   premature         only projects with premature_success > 0, ratio-sorted
 *   project=<path>    limit the scan to one project
 */
function cmdStats(args: string, ctx: ExtensionContext): void {
  const asJson = /\bjson\b/.test(args);
  const prematureOnly = /\bpremature\b/.test(args);
  const projectMatch = args.match(/project=(\S+)/);
  let rollups: ProjectRollup[] = [];
  if (projectMatch) {
    const p = projectMatch[1]!.replace(/^~/, os.homedir());
    const r = rollupProject(p);
    if (!r) {
      ctx.ui.notify(`/glla stats: no .pi-glla/active.jsonl under ${p}`, "warning");
      return;
    }
    rollups = [r];
  } else {
    const projects = discoverGllaProjects({ cwd: ctx.cwd });
    for (const p of projects) {
      const r = rollupProject(p);
      if (r) rollups.push(r);
    }
    if (rollups.length === 0) {
      ctx.ui.notify("/glla stats: no projects with .pi-glla/active.jsonl found on this rig.", "info");
      return;
    }
  }
  if (prematureOnly) rollups = filterPremature(rollups);
  const out = asJson ? formatRollupJson(rollups) : formatRollupTable(rollups);
  ctx.ui.notify(`glla stats — ${rollups.length} project(s)${prematureOnly ? " (premature filter)" : ""}\n${out}`, "info");
}

/**
 * v0.25.4: /glla audits [N|full] — browse the durable per-project audit
 * log (.pi-glla/audits.jsonl). Default: last 10 verdicts, one line each.
 * "full" prints the latest report in full.
 */
/**
 * v0.28.28: /glla log [N] — human-readable tail of the event ledger (the
 * forensic trail: who created/resumed/paused goals, from where). Skips the
 * high-frequency noise entries (state snapshots, re-arm internals) unless
 * "all" is passed. N defaults to 15.
 */
const LOG_NOISE = new Set(["state", "send_rearm_start", "heartbeat_suppressed_tick"]);
function cmdLog(args: string, ctx: ExtensionContext): void {
  const all = /\ball\b/.test(args);
  const nMatch = args.match(/\b(\d+)\b/);
  const n = Math.min(Math.max(parseInt(nMatch?.[1] ?? "15", 10) || 15, 1), 100);
  let entries: Array<{ type: string; at?: string; value?: any }> = [];
  try {
    entries = parseLedgerEntries(fs.readFileSync(ledgerPath(ctx.cwd), "utf-8"));
  } catch {
    ctx.ui.notify("No ledger yet — .pi-glla/active.jsonl doesn't exist.", "info");
    return;
  }
  const visible = all ? entries : entries.filter((e) => !LOG_NOISE.has(e.type));
  const tail = visible.slice(-n);
  if (tail.length === 0) {
    ctx.ui.notify("Ledger is empty (no non-noise events yet).", "info");
    return;
  }
  const lines = tail.map((e) => {
    const t = (e.at ?? "").slice(11, 19);
    const v = e.value ?? {};
    const detail = Object.entries(v)
      .filter(([k]) => k !== "goalId" && k !== "report")
      .map(([k, val]) => `${k}=${typeof val === "string" ? val.slice(0, 60) : JSON.stringify(val)?.slice(0, 60)}`)
      .join(" ");
    return `${t}  ${e.type}${detail ? `  ${detail}` : ""}`;
  });
  ctx.ui.notify(`Ledger tail (last ${tail.length}${all ? "" : " non-noise"} events — /glla log <N> for more, /glla log all to include noise):\n${lines.join("\n")}`, "info");
}

/** v0.34.57: /glla switchlog [N] — the model-switch trail (model_switch +
 * forbidden_model_switch ledger events). Read-only: works on a stale
 * handle, like the other /glla read-only actions. */
function cmdSwitchlog(args: string, ctx: ExtensionContext): void {
  const nMatch = args.match(/\b(\d+)\b/);
  const n = Math.min(Math.max(parseInt(nMatch?.[1] ?? "15", 10) || 15, 1), 100);
  let entries: Array<{ type: string; at?: string; value?: any }> = [];
  try {
    entries = parseLedgerEntries(fs.readFileSync(ledgerPath(ctx.cwd), "utf-8"));
  } catch {
    ctx.ui.notify("No ledger yet — .pi-glla/active.jsonl doesn't exist.", "info");
    return;
  }
  const switches = entries.filter((e) => e.type === "model_switch" || e.type === "forbidden_model_switch");
  const tail = switches.slice(-n);
  if (tail.length === 0) {
    ctx.ui.notify("No model switches recorded yet — /glla switchlog shows the model_switch / forbidden_model_switch trail.", "info");
    return;
  }
  const lines = tail.map((e) => {
    const t = (e.at ?? "").slice(11, 19);
    const v = e.value ?? {};
    const arrow = `${v.from ?? "(unknown)"} → ${v.to ?? "(unknown)"}`;
    const tag = e.type === "forbidden_model_switch" ? "FORBIDDEN" : "switch";
    const outcome = v.blocked === true ? " (BLOCKED)" : v.blocked === false ? " (violation)" : "";
    const reason = v.reason ? ` [${v.reason}]` : "";
    return `${t}  ${tag}  ${arrow}${outcome}${reason}`;
  });
  ctx.ui.notify(`Model-switch trail (last ${tail.length} — /glla switchlog <N> for more):\n${lines.join("\n")}`, "info");
}

/**
 * v0.28.31 (renamed v0.28.33): /glla wipe — ONE confirmed command that leaves a project with
 * zero live glla state. User directive: "make sure we only have one goal or
 * loop or list at a time — many of my older projects have leftovers" (the
 * fleet scan found queued lists up to 56 deep, held loops at iter 50, and
 * paused goals across ~10 projects). The goal is archived HONESTLY (aborted
 * — lands in goals/ + the archive, reviewer's abort-suppression applies),
 * the list is cleared, the loop record is wiped after a graceful stop.
 * History stays in .pi-glla; only the live state goes.
 */
async function cmdGllaWipe(ctx: ExtensionContext): Promise<void> {
  const g = state.goal;
  const live = g && (g.status === "active" || g.status === "paused" || g.status === "auditing");
  const n = listQueue().length;
  const loop = state.loop;
  if (!g && n === 0 && !loop) {
    ctx.ui.notify("glla state is already clean — no goal, no list, no loop.", "info");
    return;
  }
  const parts: string[] = [];
  if (live) parts.push(`goal archived as aborted: ${displaySlice(g!.objective, 70)}`);
  else if (g) parts.push(`terminal goal record cleared (${g.status})`);
  if (n > 0) parts.push(`list cleared (${n} item${n === 1 ? "" : "s"})`);
  if (loop) parts.push(`loop ${loop.active ? "stopped" : "cleared"} (iter ${loop.iteration}${loop.bestValue !== null && loop.bestValue !== undefined ? `, best ${loop.bestValue}` : ""})`);
  if (ctx.hasUI) {
    try {
      const ok = await ctx.ui.confirm("Wipe glla state?", `${parts.map((p) => `  ${p}`).join("\n")}\n\nHistory stays in .pi-glla (archive + ledger); the live state is wiped.`);
      if (!ok) {
        ctx.ui.notify("Wipe cancelled.", "info");
        return;
      }
    } catch {
      ctx.ui.notify("Wipe cancelled.", "info");
      return;
    }
  }
  appendLedger(ctx.cwd, "glla_wipe", { goalId: live ? g!.id : undefined, listCleared: n, loop: loop ? { iteration: loop.iteration, active: loop.active } : undefined });
  if (live) {
    archiveCurrentGoal(ctx, "aborted", "user wipe (/glla wipe)");
    ctx.abort();
  } else if (g) {
    state = { ...state, goal: null };
  }
  if (n > 0) {
    // v0.34.61: delete sidecars of every cleared item before the state
    // mutation. /glla wipe is the nuclear option — leaving disk sidecars
    // behind would let a later /list disk-fallback surface them again,
    // undoing the wipe.
    for (const item of listQueue()) deleteQueueItemFile(ctx.cwd, item.id);
    state = { ...state, list: [] };
    appendLedger(ctx.cwd, "list_cleared", { via: "glla_wipe", count: n });
  }
  if (loop) {
    clearLoopTimer();
    state.loop = undefined;
    const wipeGeneration = sessionGeneration;
    await finishLoopGit(ctx, loop);
    const afterFinish = freshCtxForGeneration(wipeGeneration);
    if (!afterFinish) return;
    ctx = afterFinish;
    appendLedger(ctx.cwd, "loop_stopped", { reason: "user wipe (/glla wipe)", iterations: loop.iteration, best: loop.bestValue });
  }
  persistState(ctx);
  ctx.ui.notify(`glla wipe done: ${parts.join(" · ")}. Clean slate.`, "info");
  notifyExternal(ctx, "glla state wiped by user — clean slate.");
}

/**
 * v0.28.32: /glla resume — resume WHATEVER is resumable, without the user
 * needing to know whether they're supervising a goal, a list item, or a
 * held loop. Safe because one-active-thing is enforced (v0.28.14+): at
 * most one thing can be ACTIVE, so the only ambiguity is paused-goal +
 * held-loop coexisting (nothing running, two resumables — e.g. polis
 * today) → the v0.28.23 decision-picker pattern. Verbs whose semantics
 * genuinely differ per type (tweak/finish/next/decide/refine) stay typed.
 */
async function cmdGllaResume(ctx: ExtensionContext): Promise<void> {
  // v0.29.12: a zombie instance (handle dead after session replacement)
  // used to answer "Nothing to resume" — the resume path must name the
  // real recovery (/reload rebuilds extensions in place), not mislead.
  if (warnIfStaleAtEntry(ctx, "/glla resume")) return;
  releaseInitialSessionLoadBarrier();
  if (manuallyResumeMainModelRecovery(ctx)) return;
  if (state.mainModelRecovery?.retryAt) {
    clearMainModelRecoveryTimer();
    continuationDispatchStoodDown = false;
    ctx.ui.notify("Retrying the saved main-model recovery now — one provider probe, then the configured backups if needed.", "info");
    void probeMainModelRecovery(ctx);
    return;
  }
  const g = state.goal;
  const goalResumable = g && g.status === "paused";
  const loopResumable = state.loop && !state.loop.active && state.loop.stopReason === HELD_ON_RESTORE;
  if (goalResumable && loopResumable) {
    if (ctx.hasUI) {
      try {
        const loopLabel = `Resume the held loop (iter ${state.loop!.iteration}, best ${state.loop!.bestValue ?? "n/a"}): ${displaySlice(state.loop!.target, 80)}`;
        const pick = await ctx.ui.select("Two things can resume — which one?", [
          `Resume the ${g!.policy === "list" ? "list item" : "goal"}: ${displaySlice(g!.objective, 80)}`, 
          loopLabel,
        ]);
        if (pick === undefined) {
          ctx.ui.notify("Resume cancelled.", "info");
          return;
        }
        if (pick === loopLabel) {
          await cmdLoop("resume", ctx);
          return;
        }
        await cmdResume(ctx);
        return;
      } catch {
        // picker failed — fall through to goal-first
      }
    }
    await cmdResume(ctx);
    return;
  }
  if (goalResumable) {
    await cmdResume(ctx);
    return;
  }
  if (loopResumable) {
    await cmdLoop("resume", ctx);
    return;
  }
  // v0.34.3: an ACTIVE-but-idle goal is exactly what the user means by
  // "resume" (hellhunter 2026-08-01: widget said "list item · active", the
  // agent sat idle after a prose-only turn — the continuation that should
  // drive the new head never landed — and /glla resume shrugged "Nothing to
  // resume"). Re-kick the continuation instead of shrugging.
  if (g && g.status === "active") {
    appendLedger(ctx.cwd, "resume_rekick", { goalId: g.id, policy: g.policy });
    // v0.34.7: the re-kick fulfills the stale-handle marker's promise too
    // (junk-runner/polis/neonbreak 2026-08-01: actively working with the
    // ⚠ interrupted banner still screaming — the v0.34.2 clear only lived
    // in the paused-resume path; the staleness entry-guard above already
    // filtered out a stale session reaching this branch).
    if (g.interruptedAt) updateGoal({ interruptedAt: undefined, interruptedReason: undefined }, ctx);
    ctx.ui.notify(
      `The ${g.policy === "list" ? "list item" : "goal"} is ACTIVE but idle — re-firing its continuation: ${displaySlice(g.objective, 70)}`,
      "info",
    );
    scheduleContinuation(ctx, true);
    return;
  }
  if (g && g.status === "auditing") {
    if (!g.pendingCompletion) {
      ctx.ui.notify("A detached completion auditor is in flight — wait for its verdict (the status line shows auditor running). /glla cancel discards the pending claim.", "info");
      return;
    }
    if (completionAuditInFlight) {
      ctx.ui.notify("The detached completion auditor is already running — wait for its verdict or /glla cancel to discard the pending claim.", "info");
      return;
    }
    markCompletionAuditRecoveryPending(ctx, "manual-resume");
    completionAuditRecoveryArmed = true;
    ctx.ui.notify("Resuming the stored completion claim — starting a detached auditor (no agent turn needed).", "info");
    void retryStoredCompletionAudit("manual");
    return;
  }
  if (state.loop?.active) {
    appendLedger(ctx.cwd, "resume_rekick", { loop: true, iteration: state.loop.iteration });
    if (continuationDispatchStoodDown) releaseContinuationDispatchStandDown();
    ctx.ui.notify(`The loop is ACTIVE — re-firing its tick (iteration ${state.loop.iteration}). If it wedges again, /loop status for the diagnostics.`, "info");
    scheduleLoopTick(ctx);
    return;
  }
  ctx.ui.notify("Nothing to resume — no paused goal/list-item, no held loop. /goal, /list, or /loop to start something.", "info");
}

/**
 * v0.28.32: /glla cancel — cancel the ONE live thing, uniformly: a goal or
 * list item is archived as aborted (its queue is untouched), an active or
 * held loop is stopped. Same outcome shape regardless of hidden type —
 * the user's caveat ("this sucks if one command doesn't work for others")
 * is why /list cancel (item + drop queue) and /glla wipe (nuke all)
 * remain the power verbs instead of being folded in.
 */
async function cmdGllaCancel(ctx: ExtensionContext): Promise<void> {
  const g = state.goal;
  if (g && (g.status === "active" || g.status === "paused" || g.status === "auditing")) {
    await cmdCancel(ctx);
    return;
  }
  if (state.loop) {
    await cmdLoop("stop", ctx);
    return;
  }
  ctx.ui.notify("Nothing to cancel — no active/paused goal/list-item, no loop. Queued list items: /list clear; everything: /glla wipe.", "info");
}

function cmdAudits(args: string, ctx: ExtensionContext): void {
  const full = /\bfull\b/.test(args);
  const all = /\b(?:all|global|log)\b/.test(args);
  const nMatch = args.match(/\b(\d+)\b/);
  if (full) {
    // Latest report — active goal's history first, then the log.
    const fromGoal = state.goal?.auditHistory?.at(-1);
    if (fromGoal?.report) {
      ctx.ui.notify(`Latest audit on this goal — ${fromGoal.model} (${fromGoal.at})\n${fromGoal.report}`, "info");
      return;
    }
    const latest = readAuditLog(ctx.cwd).at(-1);
    ctx.ui.notify(latest ? `Latest audit — ${latest.verdict} (${latest.model}, ${latest.at})\n${latest.report}` : "No audits logged yet.", "info");
    return;
  }
  // Default: the ACTIVE goal's own audit history (with per-audit elapsed);
  // "all"/"global"/"log" browses the durable cross-goal log.
  if (!all && state.goal?.auditHistory && state.goal.auditHistory.length > 0) {
    ctx.ui.notify(
      `glla audits — this goal's history (${state.goal.auditHistory.length} verdict(s); /glla audits all for the project log)\n${formatGoalAuditHistory(state.goal)}`,
      "info",
    );
    return;
  }
  const n = nMatch ? Number(nMatch[1]) : 10;
  const entries = readAuditLog(ctx.cwd, n);
  ctx.ui.notify(`glla audits — last ${entries.length} verdict(s) in ${ctx.cwd}\n${formatAuditLog(entries)}`, "info");
}

// v0.29.8: /glla status — the unified "what's running" surface (user: "we
// need to type goal status [to check], so that command at least is missing
// for checking on whatever active process we have"). Read-only aggregate of
// the ONE state — goal, list queue, loop, pending decisions — with pointers
// to the deep surfaces.
function cmdGllaStatus(ctx: ExtensionContext): void {
  const lines: string[] = [];
  const g = state.goal;
  if (g) {
    const tok = (g.usage?.tokensUsed ?? 0) > 0 ? ` · ${g.usage!.tokensUsed} tok` : "";
    const audit = g.status === "auditing"
      ? isCompletionAuditRecoveryPending(g) ? " (audit recovery pending)" : completionAuditInFlight && latestAuditProgress?.label === "queued" ? " (detached auditor queued)" : completionAuditInFlight ? " (detached auditor running…)" : " (audit awaiting lifecycle recovery)"
      : "";
    const pause = g.status === "paused" && g.pauseReason ? ` — ${displaySlice(g.pauseReason, 90)}` : "";
    lines.push(`goal [${g.policy}] ${g.status}${audit}${tok}: ${displaySlice(g.objective, 90)}${pause}`);
  } else {
    lines.push("goal: none");
  }
  const q = listQueue();
  lines.push(`list: ${q.length === 0 ? "empty" : `${q.length} queued — head: ${displaySlice(q[0]?.objective ?? "", 70)}`}`);
  const l = state.loop;
  if (l) {
    lines.push(`loop: ${l.active ? "ACTIVE" : `held/stopped — ${sanitizeDisplayText(l.stopReason ?? "n/a")}`} · iter ${l.iteration}/${l.maxIterations > 0 ? l.maxIterations : "∞"} · best ${l.bestValue ?? "n/a"} · stall ${l.stallCount} — ${displaySlice(l.target, 60)}`);
  } else {
    lines.push("loop: none");
  }
  if (g?.status === "paused" && g.pauseKind === "decision" && g.pauseOptions?.length) {
    lines.push(`decision pending (${g.pauseOptions.length} options) — ${activeGoalSurfaceCommand("decide")}`);
  }
  lines.push("deep: /goal status · /list · /loop status · /glla stats · /glla audits · /glla log");
  ctx.ui.notify(`glla status\n${lines.join("\n")}`, "info");
}

async function cmdSettings(args: string, ctx: ExtensionContext): Promise<void> {
  // v0.34.52: settings entry probe — mirror of cmdList's stale gate. Bare
  // /glla is a settings surface every choice of which writes state, and
  // wipe/reset/cancel/resume/reviewer/postaudit/tooloverride mutate
  // directly; on a stale handle (pi session replacement) those writes
  // would land from a doomed process that can neither announce nor run
  // them. Refuse with the standard recovery message from the entry probe
  // and a ledger trail; read-only surfaces (status/log/stats/audits) and
  // the unknown-action notice stay usable for inspection.
  const staleEntry = warnIfStaleAtEntry(ctx, "/glla");
  // `/glla` is the settings surface. Arguments belong to the action namespace
  // below (status, resume, stats, etc.); settings are edited in the table
  // rather than through noisy inline assignments.
  const trimmed = args.trim();
  const verb = trimmed ? trimmed.split(/\s+/)[0]!.toLowerCase() : "ui";
  if (staleEntry && (verb === "ui" || SETTINGS_MUTATING_ACTIONS.has(verb))) {
    appendLedger(ctx.cwd, "settings_mutation_refused_stale", { sub: verb });
    return;
  }
  // v0.25.2: /glla stats sub-mode — cross-project telemetry rollups.
  if (/^stats(?:\s|$)/.test(trimmed)) {
    cmdStats(trimmed.slice("stats".length).trim(), ctx);
    return;
  }
  if (/^audits(?:\s|$)/.test(trimmed)) {
    cmdAudits(trimmed.slice("audits".length).trim(), ctx);
    return;
  }
  if (/^status(?:\s|$)/.test(trimmed)) {
    cmdGllaStatus(ctx);
    return;
  }
  if (/^log(?:\s|$)/.test(trimmed)) {
    cmdLog(trimmed.slice("log".length).trim(), ctx);
    return;
  }
  if (/^switchlog(?:\s|$)/.test(trimmed)) {
    cmdSwitchlog(trimmed.slice("switchlog".length).trim(), ctx);
    return;
  }
  if (/^wipe(?:\s|$)/.test(trimmed)) {
    await cmdGllaWipe(ctx);
    return;
  }
  if (/^reset(?:\s|$)/.test(trimmed)) {
    ctx.ui.notify("/glla reset is now /glla wipe (renamed — too close to /glla resume). Nothing was done.", "info");
    return;
  }
  if (/^resume(?:\s|$)/.test(trimmed)) {
    await cmdGllaResume(ctx);
    return;
  }
  if (/^cancel(?:\s|$)/.test(trimmed)) {
    await cmdGllaCancel(ctx);
    return;
  }
  if (/^reviewer(?:\s|$)/.test(trimmed)) {
    await cmdReviewerSettings(ctx);
    return;
  }
  if (/^postaudit(?:\s|$)/.test(trimmed)) {
    await cmdReviewerSettings(ctx);
    return;
  }
  if (/^tooloverride(?:\s|$)/.test(trimmed)) {
    await cmdToolOverride(trimmed.slice("tooloverride".length).trim(), ctx);
    return;
  }
  if (trimmed) {
    ctx.ui.notify(
      `Unknown /glla action "${trimmed}". Use /glla to open settings; command arguments are reserved for actions.`,
      "warning",
    );
    return;
  }
  if (ctx.hasUI) {
    await openSettingsUI(ctx);
    return;
  }
  // Headless fallback: read-only effective values with provenance. Writes
  // require the interactive settings table so the command namespace stays
  // unambiguous and action-oriented.
  const prov = settingsProvenance(ctx.cwd);
  const fmt = (k: keyof Settings, label: string) => {
    const p = prov[k];
    const v = p.value === undefined ? "(unset)" : String(p.value);
    return `${label}: ${v}  [${p.source}]`;
  };
  ctx.ui.notify(
    [
      fmt("mainModelFallbacks", "mainModelBackups"),
      fmt("mainModelRetryMinutes", "mainModelRetryMinutes"),
      fmt("forbiddenModels", "forbiddenModels"),
      fmt("blockForbiddenModelSwitches", "blockForbidden"),
      fmt("auditorModel", "auditorModel"),
      fmt("auditorThinkingLevel", "thinking"),
      fmt("notifyCmd", "notify"),
      fmt("tokenLimit", "tokenLimit"),
      fmt("autoResume", "autoResume"),
      fmt("autoAcceptDrafts", "autoAccept"),
      fmt("auditCap", "auditCap"),
      fmt("auditFeedbackChars", "auditFeedbackChars"),
      fmt("aggressiveMode", "aggressiveMode"),
      fmt("quotaRetryMinutes", "quotaRetryMinutes"),
      fmt("stuckMaxInterventions", "stuckMaxInterventions"),
      fmt("stallEscalationRefires", "stallEscalation"),
      fmt("wedgeAlertMinutes", "wedgeAlert"),
      fmt("stallShortWords", "stallShortWords"),
      fmt("stallSimilarityThreshold", "stallSimilarityThreshold"),
      // v0.27.5: post-completion auditor config — read either the new
      // `postaudit` key or the legacy `reviewer` key (postaudit wins).
      `postaudit: ${JSON.stringify(loadSettings(ctx.cwd).postaudit ?? loadSettings(ctx.cwd).reviewer ?? {}) || '(unset — defaults)'}`,
      // v0.25.6: effective per-type subagent model resolution.
      ...["Explore", "Plan", "general-purpose"].map(
        (t) => `subagent ${t}: ${resolveEffectiveSubagentModel(t, loadSettings(ctx.cwd), (ctx.model as any)?.id ? `${(ctx.model as any).provider}/${(ctx.model as any).id}` : undefined)}`,
      ),
      `\nglobal:  ${globalSettingsPath()}`,
      `project: ${projectSettingsPath(ctx.cwd)}`,
      "Edit settings by opening /glla in an interactive session.",
    ].join("\n"),
    "info",
  );
}

// =================================================================
// Command-collision detector (PLAN.md D1)
//
// pi's runner.js resolveRegisteredCommands() never throws on duplicate
// command names: the first registrant keeps the bare name, later ones
// become "goal:2", "list:3", etc. So a collision degrades UX silently.
// We detect duplicates at session start and warn loudly once.
// =================================================================

const OUR_COMMANDS = ["goal", "glla", "list", "loop"];
let collisionWarned = false;

// Providers known to pi core. The detached worker receives only provider/id
// and resolves credentials in its extension-less child process. A provider
// defined in ~/.pi/agent/models.json with auth.json credentials works; a
// provider registered only in the parent extension runtime may not. Unknown
// providers get a soft one-time conditional notice: if audits error with auth
// failures, choose an explicit auditor model in the /glla settings table.
const KNOWN_BUILTIN_PROVIDERS = new Set([
  "anthropic", "google", "google-vertex", "google-gemini-cli", "openai", "openai-codex",
  "openrouter", "opencode", "azure-openai-responses", "groq", "cerebras", "xai", "zai",
  "minimax", "minimax-cn", "moonshotai", "kimi-coding", "github-copilot", "mistral", "huggingface",
]);
let providerWarned = false;

function warnIfAuditorProviderRisky(ctx: ExtensionContext): void {
  if (providerWarned) return;
  providerWarned = true;
  try {
    const settings = loadSettings(ctx.cwd);
    if (settings.auditorModel) return; // explicit auditor model — user's call
    const provider = (ctx.model as any)?.provider as string | undefined;
    if (!provider || KNOWN_BUILTIN_PROVIDERS.has(provider)) return;
    ctx.ui.notify(
      `pi-goal-list-loop-audit: session provider "${provider}" is not a known built-in. The auditor inherits the resolved model in-process, so this usually works — but if audits error with auth/provider failures, choose an explicit auditor model in /glla settings.`, 
      "info",
    );
  } catch {
    // non-fatal by design
  }
}

function warnOnCommandCollision(ctx: ExtensionContext): void {
  if (collisionWarned) return;
  collisionWarned = true;
  try {
    if (!extensionApi) return;
    const counts = new Map<string, number>();
    for (const cmd of extensionApi.getCommands() as any[]) {
      const name = String(cmd.invocationName ?? cmd.name ?? "").split(":")[0] ?? "";
      if (OUR_COMMANDS.includes(name)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([n]) => `/${n}`);
    if (dupes.length > 0) {
      const first = dupes[0] ?? "goal";
      ctx.ui.notify(
        `pi-goal-list-loop-audit: command collision on ${dupes.join(", ")}. Another extension registered the same name; ours may be reachable as /${first.slice(1)}:2. Consider disabling the other plugin.`,
        "warning",
      );
    }
  } catch {
    // getCommands unavailable or shape changed — stay silent, collision is non-fatal.
  }
}

// =================================================================
// Public extension entry
// =================================================================
// Model-switch ledger (v0.34.57 — bug #1.14)
// =================================================================

/** v0.34.57: model-switch ledger + forbidden-model gate. Writes the
 * `model_switch` entry for every real provider/model change (the
 * model_select event OR turn-boundary drift), and the
 * `forbidden_model_switch` violation entry when the target is forbidden.
 * Returns true when the switch was BLOCKED (the caller holds the previous
 * Model object and should revert it).
 *
 * Blocking is skipped while the plugin's own recovery rotation is in
 * flight (mainModelSwitchInFlight — that path is the AUTHORIZED switch
 * channel; reverting it would wedge recovery against itself) and never
 * applies to turn-boundary drift (the turn already started — detection
 * and the violation record are the honest actions there). The violation
 * entry always lands either way. */
function observeModelChange(ctx: ExtensionContext, from: string | undefined, to: string | undefined, reason: string, source: string | undefined): boolean {
  if (!from || !to || from === to) return false;
  const settings = loadSettings(ctx.cwd);
  const forbidden = isForbiddenModel(to, settings.forbiddenModels);
  const at = Date.now();
  const blocked = forbidden && settings.blockForbiddenModelSwitches !== false && reason !== "turn-boundary" && !mainModelSwitchInFlight;
  if (forbidden) {
    // The switch either stands (blocked: false) or was reverted (blocked:
    // true) — one event tells the whole story; a model_switch entry would
    // falsely claim the forbidden model took over.
    appendLedger(ctx.cwd, "forbidden_model_switch", {
      ...modelSwitch(from, to, reason, at),
      ...(source ? { source } : {}),
      blocked,
    });
  } else {
    appendLedger(ctx.cwd, "model_switch", {
      ...modelSwitch(from, to, reason, at),
      ...(source ? { source } : {}),
    });
  }
  state.lastModelRef = to;
  persistState(ctx);
  return blocked;
}

/** v0.34.57: turn-boundary model observation — the session is about to run
 * a turn on a different model than last observed. The first observation in
 * a process just baselines (no ledger entry); a change baselines AND
 * records drift that arrived without a model_select event (a fresh pi
 * launch with a changed default model fires none). */
function observeTurnBoundaryModel(ctx: ExtensionContext): void {
  const current = modelRef(ctx.model);
  if (!current) return;
  const last = state.lastModelRef;
  if (last && last !== current) {
    observeModelChange(ctx, last, current, "turn-boundary", undefined);
  } else if (!last) {
    state.lastModelRef = current;
    persistState(ctx);
  }
}

export default function (pi: ExtensionAPI): void {
  extensionApi = pi;
  extensionApiStale = false; // a fresh factory run means a fresh runtime (reload path)
  resetLengthContinue(); // v0.27.2: fresh runtime, fresh truncation streak
  startHeartbeat();
  startUITicker();
  // Four top-level commands, that's all (v0.8.0 consolidation):
  //   /goal  — set/draft + status|pause|resume|cancel|tweak|archive subcommands
  //   /list — the list (add|show|tweak|next|remove|clear)
  //   /loop  — the metric loop (draft|start|status|stop)
  //   /glla   — the settings UI; nonempty arguments are actions
  // v0.22.5: subcommand autocomplete for the /-menu.
  // v0.27.4: pi's applyCompletion does NOT add a trailing space for argument
  // completions (it does for the top-level /goal itself). Without a trailing
  // space the user has to press Space before typing — and if they forget
  // they end up with `/goal startasdahlasf` (goal.ts:3545 area). Items whose
  // value ends in `=` get no space; everything else gets a single trailing
  // space. `label` stays clean for the picker display. The glla namespace
  // itself exposes actions only; settings live in the `/glla` table.
  const completions = (items: Array<[string, string]>) => (prefix: string) =>
    items
      .filter(([value]) => value.startsWith(prefix))
      .map(([value, description]) => ({
        value: value.endsWith("=") ? value : value + " ",
        label: value,
        description,
      }));

  pi.registerCommand("goal", {
    description: "Set/draft a goal, or /goal status|pause|resume|cancel|tweak <text>|archive|start <objective>. Objectives without a 'Done when:' clause are grilled into a contract first; include the clause or use /goal start to skip the interview and activate instantly.",
    getArgumentCompletions: completions([
      ["start", "skip drafting — /goal start <objective> activates immediately"],
      ["audit", "one-shot project audit goal: /goal audit [focus] — fix the non-decisions, present the decisions (v0.29.8)"],
      ["verify", "run the isolated auditor on the current goal NOW (v0.28.27, renamed from /goal audit)"],
      ["status", "show the active goal and its task list"],
      ["pause", "pause the active goal"],
      ["resume", "resume a paused goal (and the list, when items are queued)"],
      ["cancel", "abort the active goal"],
      ["decide", "re-open the decision picker for a decision pause"],
      ["tweak", "change the objective: /goal tweak <text>"],
      ["archive", "list archived goals"],
    ]),
    handler: (args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdGoal(args, ctx); },
  });
  const settingsHandler = (args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdSettings(args, ctx); };
  pi.registerCommand("glla", {
    description: "Open the settings UI for goals, loops, lists, and the auditor. `/glla` opens settings; arguments are reserved for actions.",
    getArgumentCompletions: completions([
      // Operational verbs only. Settings and section navigation belong in
      // the bare `/glla` table, so they do not compete with action completion.
      ["status", "show goal, list, loop, and pending decisions"],
      ["log", "show the recent event trail"],
      ["resume", "resume the paused or held live thing"],
      ["cancel", "cancel the one live thing"],
      ["wipe", "wipe goal, list, and loop state"],
      ["stats", "show per-project ledger rollups"],
      ["audits", "browse the audit log"],
      ["switchlog", "show the model-switch trail (model_switch / forbidden_model_switch)"],
      ["tooloverride", "configure agent-tool visibility"],
    ]),
    handler: settingsHandler,
  });
  pi.registerCommand("review", {
    description: "Manually run the postaudit on an archived goal: /review <goal-id> [off|on|auto|aggressive] — extracts findings, writes a report to .pi-glla/reviews/, cascades per the mode (auto/aggressive = no Confirms). Bypasses the trigger gates (explicit user request).",
    handler: (args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdReview(args, ctx); },
  });
  pi.registerCommand("list", {
    description: "Loop 2: the list of audited goals — order is the default, not the law. /list <describe tasks or name a plan file> (dumps get shaped into items, files import, 'Done when:' adds directly) | /list audit [focus] (collect findings, then drain them as items) | /list show | /list resume | /list tweak <text> | /list next [n] | /list remove <n> | /list clear | /list cancel. Settings are under /glla, not /list — bare /glla opens the settings table.",
    getArgumentCompletions: completions([
      ["show", "display the waiting items"],
      ["settings", "settings live under /glla — bare /glla opens the settings table"],
      ["audit", "collect-then-drain: audit the project, queue every finding as its own item"],
      ["resume", "resume the paused list item (the list's head)"],
      ["tweak", "change the paused list item: /list tweak <text>"],
      ["next", "activate the next item (or /list next <n> for position n)"],
      ["remove", "remove an item: /list remove <n>"],
      ["clear", "empty the list"],
      ["depth", "queue depth, oldest item age, average item duration"],
      ["cancel", "stop the whole list: abort the active item + drop all waiting"],
    ]),
    handler: (args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdList(args, ctx); },
  });
  pi.registerCommand("loop", {
    description: "Loop 3: metric-driven process — it never completes. /loop <target> drafts the metric with you · /loop start \"<target>\" = infinite metricless loop (no plateau, no cap; ends at time=/tokens= or /loop stop) · /loop respec = infinite metricless reconcile against the root SPEC.md · add measure=\"<cmd>\" direction=min|max [window=5] [max=50] [branch=1] for a metric loop · /loop status · /loop stop (alias /loop cancel). 'Improve until X' is a /goal, not a loop.",
    getArgumentCompletions: completions([
      ["start", "skip drafting: /loop start \"<target>\" measure=\"<cmd>\" direction=min|max [window=5] [max=50]"],
      ["respec", "infinite metricless loop reconciling the codebase against the root SPEC.md"],
      ["audit", "project-audit loop: each iteration audits fresh, appends findings, fixes the top ones — plateau stops when the well is dry (v0.29.0)"],
      ["status", "show metric, iteration, best/last values, stall count"],
      ["stop", "end the loop (keeps the best state)"],
      ["cancel", "alias of /loop stop — end the loop"],
      ["finish", "end the loop cleanly: /loop finish [reason] → stopReason 'completed: <reason>'"],
    ]),
    handler: (args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdLoop(args, ctx); },
  });

  // Tool registration is lazy: done on the first session event, when a
  // context exists. Tools show even without an active goal (and return
  // "no active goal" if called).
  // Tool definitions are re-registered at lifecycle boundaries; the current
  // invocation context is resolved inside each execute handler.
  let toolsRegistered = false;

  // v0.24.5 tool-visibility self-heal: surface the notify exactly once
  // per session so the user learns about an external allowlist once and
  // can fix their profile to silence it.
  // v0.27.9: also applies toolOverrides.allow / toolOverrides.hide from
  // .pi-glla/settings.json — the project's per-tool policy wins over the
  // external allowlist (allow) or over the session default (hide).
  let toolHealNotified = false;
  function ensureAgentToolsActive(pi: ExtensionAPI, ctx: ExtensionContext): void {
    try {
      const active = pi.getActiveTools();
      const missing = missingGllaTools(active);
      const overrides = loadSettings(ctx.cwd).toolOverrides;
      let next = [...active, ...missing];
      let changed = missing.length > 0;
      // Apply per-tool allowlist — force tools visible despite an external modlist.
      if (overrides?.allow && overrides.allow.length > 0) {
        const toAdd = overrides.allow.filter((t) => !next.includes(t));
        if (toAdd.length > 0) {
          next = [...next, ...toAdd];
          changed = true;
        }
      }
      // Apply per-tool hide — force tools hidden even when the session allows them.
      if (overrides?.hide && overrides.hide.length > 0) {
        const before = next.length;
        next = next.filter((t) => !overrides.hide!.includes(t));
        if (next.length !== before) changed = true;
      }
      if (changed) pi.setActiveTools(next);
      if (!toolHealNotified && missing.length > 0) {
        // v0.29.3: the notify used to fire even when NOTHING was missing —
        // "glla: 0 agent tool(s) were hidden … re-activated ()" at every pi
        // start (field-observed in darklord). Warn only on a real heal.
        toolHealNotified = true;
        const list = missing.join(", ");
        ctx.ui.notify(
          `glla: ${missing.length} agent tool(s) were hidden by an external tool allowlist (e.g. a modlist profile) and have been re-activated (${list}). Add them to your allowlist profile to silence this.`,
          "warning",
        );
      }
    } catch {
      // Older pi without getActiveTools/setActiveTools — nothing we can do.
    }
  }

  // v0.26.1: compaction ends WITHOUT an agent_end (the compaction turn is
  // not an agent turn), so the continuation chain can dangle until the
  // 60s heartbeat notices. Re-arm it as soon as pi settles post-compact.
  pi.on("session_compact", async (_event: any, ctx: ExtensionContext) => {
    // v0.34.25: a compact event from the live replacement session is the
    // field's most common post-swap contact — absorb it BEFORE the gates
    // drop it (post-park the owner is nulled, so it is not even "foreign").
    if (!tryAbsorbHostSuccessor(ctx, "session_compact") && isForeignCtx(ctx)) return;
    // A late compact event can arrive after pi has already invalidated this
    // extension. It must not reclaim the old ctx or schedule settle refires.
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) return;
    rememberCtx(ctx);
    if (!isSupervising()) return;
    appendLedger(ctx.cwd, "session_compact", {});
    // v0.28.24: a compaction is LEGITIMATE busy time — reset the send-rearm
    // storm streaks (π-web nearly escalated a "send-retry storm" pause during
    // a 3.5-minute compact) and open the post-compaction stall grace.
    continuationRearmStreak = 0; continuationRearmSince = 0;
    loopRearmStreak = 0; loopRearmSince = 0;
    compactionGraceUntil = Date.now() + COMPACTION_GRACE_MS;
    lastCompactionAt = Date.now();
    // v0.32.1: arm the resume debt + the resync block (the settle probes
    // below stay as the fast path; the heartbeat now retries the debt on
    // EVERY post-grace tick until agent_start discharges it).
    postCompactResumeOwed = true;
    postCompactResyncPending = true;
    scheduleSessionTimeout(() => {
      const c = freshCtx();
      if (!c) return;
      try {
        if (c.isIdle() && !c.hasPendingMessages() && continuationTimer === null && loopTimer === null && isSupervising() && !abortedStandDown) {
          appendLedger(c.cwd, "compaction_refire", {});
          if (isLoopActive()) scheduleLoopTick(c);
          else scheduleContinuation(c, true);
        }
      } catch {
        /* settle race — the 60s heartbeat covers it */
      }
    }, 2000);
    // v0.29.21: a SECOND settle at grace expiry. The 2s settle almost
    // always loses (pi is mid-compact / mid-resumed-turn then), and the
    // heartbeat's first post-grace tick lands up to one interval late —
    // meanwhile the continuation chain can dangle with ZERO rearm
    // attempts (field: hellhunter 2026-07-31 — auto-compact 04:31 at
    // 195.8k after two output-limit turns, zero rearms after the compact
    // event, recovery only at 04:34:48 via the post-grace heartbeat;
    // ~4 min that read as a stoppage). Refire the moment the grace ends.
    scheduleSessionTimeout(() => {
      const c = freshCtx();
      if (!c) return;
      try {
        if (c.isIdle() && !c.hasPendingMessages() && continuationTimer === null && loopTimer === null && isSupervising() && !abortedStandDown) {
          appendLedger(c.cwd, "compaction_grace_refire", {});
          if (isLoopActive()) scheduleLoopTick(c);
          else scheduleContinuation(c, true);
        }
      } catch {
        /* settle race — the 60s heartbeat covers it */
      }
    }, COMPACTION_GRACE_MS + 2_000);
  });

  pi.on("message_start", async (event: any, ctx: ExtensionContext) => {
    // v0.34.27: a replacement may first become visible on the user's next
    // message. Absorb it before the drafting-only handler can ignore it.
    if (tryAbsorbHostSuccessor(ctx, "message_start")) return;
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown || isForeignCtx(ctx)) return;
    // v0.14.0 drafting floor: count real user replies while drafting. Our
    // own injected draft prompt arrives as a user message — skip that one.
    if (draftingTarget === null) return;
    if (event?.message?.role !== "user") return;
    if (draftingSeedInFlight) {
      draftingSeedInFlight = false;
      return;
    }
    draftingUserReplies++;
  });

  // v0.15.1: ask_user_question answers arrive as tool results, not chat
  // messages — count answered (non-cancelled) questionnaires as replies too.
  pi.on("tool_result", async (event: any, eventCtx: ExtensionContext) => {
    // v0.34.27: tool results are another valid first contact after a silent
    // host swap; absorb before stale/foreign filtering and never let a worker
    // session mutate the main loop's repetition/telemetry state.
    if (tryAbsorbHostSuccessor(eventCtx, "tool_result")) return;
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown || isForeignCtx(eventCtx)) return;
    noteToolResult(event); // v0.33.0: slim widget "last action" feed
    // v0.24.0: roll loop tool-result fingerprints (same-tool-same-result
    // detection) — recorded for ANY tool result while a loop is active.
    if (isLoopActive()) {
      const loop = state.loop!;
      const out = event?.output ?? event?.result ?? event?.details ?? "";
      const text = typeof out === "string" ? out : JSON.stringify(out) ?? "";
      loop.recentToolResults = pushRepetitionCapped(
        loop.recentToolResults ?? [],
        { tool: String(event?.toolName ?? "?"), hash: textFingerprint(text), isError: Boolean(event?.isError ?? event?.error) },
        REPETITION.toolWindow,
      );
      // v0.25.1: file-write progress signal for the multi-signal stuck
      // gate — a loop that is WRITING files is shipping, not stuck.
      if (isLoopWriteTool(String(event?.toolName ?? ""))) {
        const metrics = loop.iterMetrics ?? { fileWrites: 0 };
        metrics.fileWrites++;
        loop.iterMetrics = metrics;
      }
    }
    // v0.25.2: per-goal tool telemetry (/glla stats premature detection).
    if (state.goal && state.goal.status === "active") {
      const toolName = String(event?.toolName ?? "");
      if (isLoopWriteTool(toolName) || toolName === "bash") {
        const t = state.goal.telemetry ?? { turns: 0, fileWrites: 0, bashCalls: 0 };
        if (isLoopWriteTool(toolName)) t.fileWrites++;
        if (toolName === "bash") t.bashCalls++;
        state.goal.telemetry = t;
      }
    }
    // v0.25.6: subagent quota errors (the pi-subagents#175 shape —
    // Explore's upstream haiku pin 403s on shared keys). Surface the
    // repair path immediately; the continuation prompt's WHEN SUBAGENTS
    // HIT QUOTA ERRORS section carries the full guidance.
    if (isSubagentQuotaResult(String(event?.toolName ?? ""), Boolean(event?.isError ?? event?.error), event?.output ?? event?.result ?? event?.details ?? "")) {
      const errText = typeof (event?.output ?? event?.result) === "string" ? (event?.output ?? event?.result) : JSON.stringify(event?.output ?? event?.result ?? event?.details ?? "");
      const current = currentToolContext(eventCtx);
      if (current) {
        appendLedger(current.cwd, "subagent_quota_error", { error: String(errText).slice(0, 200) });
        current.ui.notify(
          "Subagent hit a quota error (403/limit). Repair: re-spawn with an explicit model= on your quota pool, or do the work inline — see the continuation prompt's WHEN SUBAGENTS HIT QUOTA ERRORS. Explore's upstream haiku pin is the usual cause (pi-subagents#175); glla's inherit-parent strategy removes it for NEW sessions.",
          "warning",
        );
      }
    }
    if (draftingTarget === null) return;
    if (askUserQuestionAnswered(String(event?.toolName ?? ""), event?.details)) {
      draftingUserReplies++;
    }
  });

  pi.on("session_shutdown", async (event: any, ctx: ExtensionContext) => {
    if (isForeignCtx(ctx)) return;
    // v0.30.0: attribution + rebind window. pi announces WHY the session
    // is being replaced (reload/resume/new/fork/quit) — the ledger can
    // now answer "what killed the handle?" without guesswork (hegemon's
    // 5-hour orphan silence 2026-07-31 was unattributable). The window
    // tells the stale probe that a rebind (session_start) is imminent.
    const shutdownReason = typeof event?.reason === "string" ? event.reason : "unknown";
    if (state.goal?.status === "auditing" && state.goal.pendingCompletion) {
      const oldAttemptId = state.goal.pendingCompletion.attemptId;
      markCompletionAuditRecoveryPending(ctx, `session_shutdown:${shutdownReason}`);
      if (oldAttemptId && cancelDetachedGoalCompletionAuditor(ctx.cwd, oldAttemptId)) {
        appendLedger(ctx.cwd, "audit_worker_cancelled", { goalId: state.goal.id, attemptId: oldAttemptId, reason: shutdownReason });
      }
      completionAuditRecoveryArmed = false;
    }
    appendLedger(ctx.cwd, "session_shutdown", { reason: shutdownReason });
    markSessionOwnerShutdown(ctx.cwd, shutdownReason);
    writeSessionHandoff(ctx, shutdownReason);
    sessionReplacementUntil = Date.now() + SESSION_REBIND_GRACE_MS;
    clearDraftingState();
    clearSessionOwnedTimers();
    toolsRegistered = false;
    toolHealNotified = false;
  });

  pi.on("session_start", async (event: any, ctx: ExtensionContext) => {
    // v0.23.8: subagent sessions (pi-subagents binds extensions there too)
    // are workers — never run the restore gate or reschedule the loop from
    // a foreign session. Host replacement events are the exception: pi can
    // deliver /new, /resume, /fork, or /reload with a new SessionManager and
    // no session_shutdown, so rejecting them here would permanently lose the
    // only fresh context that can rebind the loop (v0.34.23).
    // v0.34.27: a real file-backed successor can report plain `startup`
    // after pi invalidated the old handle. Recognize that contact before the
    // foreign-session gate; in-memory subagent startup remains refused.
    const hostSuccessorStart = isHostSuccessorContact(ctx);
    const lifecycleSignal = isHostLifecycleSessionStart(event);
    const sameOwnerStart = ownerSession !== null && ctx.sessionManager === ownerSession;
    // A lifecycle reason is evidence from pi, not proof that an arbitrary
    // in-memory SessionManager is the MAIN host. New managers must still be
    // file-backed (the pi host shape); subagent workers remain refused even
    // if they manufacture a reload/resume-looking event.
    const hostLifecycleStart = hostSuccessorStart || sameOwnerStart || (lifecycleSignal && isHostSuccessorCtx(ctx));
    // `ownerSession` is intentionally nulled at a stale/shutdown terminal,
    // so isForeignCtx() alone cannot protect the parked plane. Compare with
    // the retained dead owner too: an in-memory subagent startup must not
    // consume the recovery event and erase the host's successor proof.
    const recordedOwner = ownerSession ?? deadOwnerSession;
    const foreignRecordedSession = recordedOwner !== null && ctx.sessionManager !== recordedOwner;
    if (foreignRecordedSession && !hostLifecycleStart) return;
    if (hostLifecycleStart && ownerSession !== null && ctx.sessionManager !== ownerSession) {
      // No shutdown means the old timers were not cleared by pi. Clear them
      // before claiming the replacement, then reopen the handoff gate below.
      clearSessionOwnedTimers();
      sessionHandoffPending = false;
      appendLedger(ctx.cwd, "session_rebind_without_shutdown", {
        reason: typeof event?.reason === "string" ? event.reason : "unknown",
      });
    }
    extensionApi = pi;
    sessionHandoffPending = false;
    // Reset terminal ownership before rememberCtx: this is the only event
    // allowed to bind a context after a stale/shutdown handoff.
    staleTerminalDone = false; // v0.33.1: a rebound session can go terminal again
    zombieStoodDown = false;
    deadOwnerSession = null; // v0.34.25: a real session_start supersedes the silent-swap record
    deadOwnerCwd = null;
    sessionGeneration++;
    clearDraftingState();
    // An auditor belonging to the disposed generation cannot block the fresh
    // session's recovery gate; its finally block is generation-guarded too.
    completionAuditInFlight = false;
    completionAuditGeneration = null;
    completionAuditRecoveryArmed = false;
    latestAuditProgress = null;
    streamActivityObserved = false;
    // Ephemeral watchdog counters belong to the old session, not the
    // persisted goal. Reset them so a stale boundary cannot make the next
    // fresh session inherit a false stall count.
    heartbeatNudges = 0;
    consecutiveStalls = 0;
    const startReason = typeof event?.reason === "string" ? event.reason : "unknown";
    initialSessionLoadPending = isBlankInitialStartup(ctx, startReason);
    rememberCtx(ctx);
    startHeartbeat();
    startUITicker();
    // v0.30.0: rebind bookkeeping — claim ownership, close any replacement
    // window, and reset a stale flag left over from the PREVIOUS session's
    // invalidation. pi rebinds THIS module to the new session (switch) or
    // re-imports it (/reload — fresh module, flag already false); either
    // way the fresh ctx makes the old poison flag wrong. Re-probe to
    // confirm the new handle actually works.
    writeOwnerFile(ctx.cwd);
    sessionReplacementUntil = 0;
    postCompactResumeOwed = false; // v0.33.1: a compact from a previous session must not resync THIS one
    postCompactResyncPending = false;
    appendLedger(ctx.cwd, "session_rebound", { reason: startReason });
    if (extensionApiStale) {
      extensionApiStale = false; // fresh ctx delivered — re-probe
      const stillStale = probeExtensionApiStale();
      appendLedger(ctx.cwd, "stale_flag_reset_on_rebind", { reason: startReason, stillStale });
      if (stillStale) {
        ctx.ui.notify("glla: session rebound but the extension handle is still stale — waiting for another fresh session_start; restart pi normally only if no replacement arrives, then /glla resume.", "warning");
      }
    }
    state = readState(ctx.cwd);
    clearMainModelRecoveryTimer();
    mainModelAbortForRecovery = false;
    lastMainModelFailure = null;
    continuationDispatchStoodDown = false;
    clearContinuationStartWatchdog();
    const recoveredDispatch = readDispatchRecord(ctx.cwd);
    if (recoveredDispatch) {
      appendLedger(ctx.cwd, "continuation_dispatch_recovered", {
        id: recoveredDispatch.id,
        phase: recoveredDispatch.phase,
        kind: recoveredDispatch.kind,
        generation: recoveredDispatch.generation,
      });
      clearDispatchRecord(ctx.cwd);
    } else if (fs.existsSync(dispatchRecordPath(ctx.cwd))) {
      appendLedger(ctx.cwd, "continuation_dispatch_invalid", {});
      clearDispatchRecord(ctx.cwd);
    }
    // v0.28.14: snapshot carryover BEFORE any restore logic mutates state —
    // a paused goal, waiting list items, or a loop that was live/held when
    // the last session ended. Resolved once at the first NEW activation.
    carryoverSnapshot = {
      pausedGoal: state.goal && state.goal.status === "paused" ? state.goal.objective.slice(0, 60) : undefined,
      pausedGoalPolicy: state.goal && state.goal.status === "paused" ? state.goal.policy : undefined,
      listCount: listQueue().length,
      heldLoop: state.loop && (state.loop.active || state.loop.stopReason === HELD_ON_RESTORE) ? state.loop.target.slice(0, 60) : undefined,
    };
    carryoverResolved = !(carryoverSnapshot.pausedGoal || carryoverSnapshot.listCount > 0 || carryoverSnapshot.heldLoop);
    if (!toolsRegistered) {
      registerAgentTools(pi);
      toolsRegistered = true;
    }
    ensureAgentToolsActive(pi, ctx);
    warnOnCommandCollision(ctx);
    warnIfAuditorProviderRisky(ctx);
    // v0.24.6: sync the pi-subagents model override (managed Explore.md) with
    // settings. Idempotent; applies to NEW sessions (pi-subagents registers
    // its agents at its own session start).
    try {
      const s = loadSettings(ctx.cwd);
      const sync = syncSubagentModelOverrides({
        agentDir: defaultAgentDir(),
        strategy: s.subagentModelStrategy ?? "inherit-parent",
        overrides: s.subagentModelOverrides,
      });
      for (const skip of sync.skipped) {
        ctx.ui.notify(`glla subagent override skipped [${skip.name}]: ${skip.reason}`, "warning");
      }
      // v0.25.6: notify-with-repair — a managed override that went missing
      // or was altered externally (pi update, manual edit, sync churn) is
      // re-written AND surfaced, not silently restored.
      if (sync.repaired.length > 0) {
        ctx.ui.notify(
          `glla repaired managed subagent override(s): ${sync.repaired.join(", ")} — the file(s) were missing or altered externally; re-written per your subagent settings.`,
          "warning",
        );
      }
    } catch (err) {
      ctx.ui.notify(`glla subagent override sync failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
    }
    // Consume ownership markers before the startup barrier so a later loaded
    // session cannot mistake this placeholder runtime for a rebind. The
    // owner sidecar carries the predecessor generation and identity that the
    // handoff must match; a proper shutdown never gets the looser same-pid
    // rebind consent on its own.
    const recoveryResume = consumeRecoveryResume(ctx.cwd);
    const ownerClaim = claimSessionOwnerAndDetectRebind(ctx.cwd, sessionGeneration, sessionManagerId(ctx));
    sessionGeneration = ownerClaim.generation;
    const handoffResume = consumeSessionHandoff(ctx.cwd, ownerClaim.previousGeneration, ownerClaim.previousOwnerSessionId);
    if (handoffResume) appendLedger(ctx.cwd, "session_handoff_resumed", { pid: process.pid, reason: startReason });
    const rebindResume = ownerClaim.rebind;
    if (rebindResume) appendLedger(ctx.cwd, "rebind_resume", { pid: process.pid });
    const explicitRecovery = handoffResume || recoveryResume || rebindResume;
    if (initialSessionLoadPending && !explicitRecovery) {
      // Even a blank startup must not leave a stored completion claim in the
      // old AUDITING state: there is no worker verdict to wait for after a
      // session boundary. Release it before the transcript-load barrier;
      // the later explicit /goal resume can retry from the durable claim.
      if (state.goal?.status === "auditing" && state.goal.pendingCompletion) {
        markCompletionAuditRecoveryPending(ctx, "session_start:blank-load");
        ctx.ui.notify(`Completion audit blocked — no verdict. The claim is safe; load the session, then ${activeGoalSurfaceCommand("resume")} to retry.`, "warning");
      }
      appendLedger(ctx.cwd, "session_waiting_for_load", { reason: startReason });
      ctx.ui.notify(`glla: pi has not loaded a conversation yet — waiting before auto-resume. Load/resume the session, or explicitly run ${activeGoalSurfaceCommand("resume")} or /loop start.`, "info");
      return;
    }
    // An explicit lifecycle handoff/rebind is continuation consent even if
    // pi reported a blank startup context. Release the barrier before any
    // scheduling path below can observe it.
    initialSessionLoadPending = false;
    // v0.29.6: stacked-state auto-arbitration FIRST — one live artifact
    // survives before the restore gate decides hold-vs-resume for it.
    autoArbitrateStackedState(ctx);
    // Restore gate (v0.26.9 tri-state): a human LOADING a session
    // ("startup"/"new"/"resume", or no reason) HOLDS — the popup shows what
    // is waiting and nothing starts until they resume explicitly. In-session
    // machinery ("reload"/"fork") auto-resumes. Enable Auto-resume in
    // /glla settings to opt into startup auto-resume.
    // into auto-resume everywhere (unattended rigs); autoresume=off never
    // auto-resumes. v0.29.5: the setting is GLOBAL-only — project-level
    // autoResume keys are ignored. Once running, the chain auto-continues
    // forever unless a super-stuck brake (stall escalation / stale-api /
    // latch) stops it loudly.
    const autoResumeSetting = resolveEffectiveAggressiveSettings(loadGlobalSettings()).autoResume;
    const autoResume = shouldAutoResumeOnSessionStart(event?.reason, autoResumeSetting);
    const mainRecovery = state.mainModelRecovery;
    if (mainRecovery?.manualResumeRequired) {
      const recoveryResumeCmd = mainRecovery.kind === "loop" ? "/loop resume" : state.goal?.policy === "list" ? "/list resume" : "/goal resume";
      ctx.ui.notify(`Main-model recovery stopped automatic probes — the work is safe; ${recoveryResumeCmd} starts a fresh bounded window after you check the provider.`, "warning");
    } else if (mainRecovery?.retryAt) {
      const retryAtMs = Date.parse(mainRecovery.retryAt);
      const recoveryConsent = autoResume || explicitRecovery;
      if (recoveryConsent) {
        const delay = Number.isFinite(retryAtMs) ? Math.max(0, retryAtMs - Date.now()) : 0;
        ctx.ui.notify(`Restored main-model recovery (${mainRecovery.kind}) — ${delay > 0 ? `next probe in ${Math.max(1, Math.ceil(delay / 60_000))}m` : "probe is due now"}.`, "info");
        if (delay > 0) scheduleMainModelRecoveryTimer(ctx, delay);
        else void probeMainModelRecovery(ctx);
      } else {
        const recoveryResumeCmd = mainRecovery.kind === "loop" ? "/loop resume" : state.goal?.policy === "list" ? "/list resume" : "/goal resume";
        ctx.ui.notify(`Main-model recovery is waiting with the work safe — ${recoveryResumeCmd} retries the provider, or enable Auto-resume in /glla settings.`, "info");
      }
    }
    // Stored completion-auditor quota waits are also durable. The old timer
    // dies with the session, so a reload must restore only the same bounded
    // probe when auto-resume/rebind consent exists; otherwise the claim waits
    // for an explicit /goal resume.
    const quotaClaim = state.goal?.pendingCompletion;
    if (state.goal?.status === "paused" && quotaClaim?.phase === "quota-waiting" && state.goal.pauseKind === "wait" && state.goal.pauseResumeAt) {
      const quotaConsent = autoResume || explicitRecovery;
      const quotaResumeCmd = state.goal.policy === "list" ? "/list resume" : "/goal resume";
      const quotaAtMs = Date.parse(state.goal.pauseResumeAt);
      if (quotaConsent) {
        const delay = Number.isFinite(quotaAtMs) ? Math.max(0, quotaAtMs - Date.now()) : 0;
        if (delay > 0) {
          scheduleQuotaRetryForSession(ctx, delay / 1_000, state.goal.pauseReason ?? "auditor quota", () => {
            if (state.goal?.status === "paused" && state.goal.pendingCompletion?.phase === "quota-waiting") void retryStoredCompletionAudit("session-recovery");
          });
        } else {
          void retryStoredCompletionAudit("session-recovery");
        }
      } else {
        ctx.ui.notify(`Stored completion claim is waiting on an auditor quota probe — ${quotaResumeCmd} retries it, or enable Auto-resume in /glla settings.`, "info");
      }
    }
    // v0.25.0 (contract item 6): aggressiveMode announces every auto-event.
    if (
      autoResume &&
      resolveEffectiveAggressiveSettings(loadSettings(ctx.cwd)).aggressiveMode &&
      (isLoopActive() || (state.goal && state.goal.status === "active") || listQueue().length > 0)
    ) {
      ctx.ui.notify("Auto-resume fired (event: session start). Continue working.", "info");
    }
    // v0.29.11: loops stopped by the stale-handle terminal or the stall
    // escalation told the user "restart pi, then /loop start" — but a
    // fresh start discards iteration/best/history. Hold them on load like
    // any restore-held loop: /loop resume continues from the saved state.
    if (state.loop && !state.loop.active &&
        (state.loop.stopReason?.startsWith("extension api stale") || state.loop.stopReason?.startsWith("stalled:") || state.loop.stopReason?.startsWith("send-retry storm:"))) {
      appendLedger(ctx.cwd, "loop_held_for_resume", { was: (state.loop.stopReason ?? "").slice(0, 40) });
      state.loop = { ...state.loop, stopReason: HELD_ON_RESTORE };
      persistState(ctx);
    }
    // v0.29.14: migrate live/held audit loops off the open-count/min
    // metric — it punished DISCOVERY (11 new real findings read as a
    // regression; iter 27→38→37 nearly plateau-stopped mid-work). Flip to
    // closed-count/max, null the pinned best (the next closed-count
    // measure becomes the honest baseline), reset the stall streak. This
    // supersedes the v0.29.10 baseline-0 reseed (every old-measure loop
    // gets nulled here).
    if (state.loop && state.loop.measureCmd?.includes("audit-loop/findings.md") && state.loop.measureCmd?.includes("\\[ \\]")
      && state.loop.direction !== "max") {
      state.loop = { ...state.loop, measureCmd: auditMeasureCmd(), direction: "max", bestValue: null, stallCount: 0, kind: state.loop.kind ?? "audit" };
      persistState(ctx);
      appendLedger(ctx.cwd, "audit_loop_metric_migrated", { from: "open-count/min", to: "closed-count/max" });
    }
    // v0.29.18: migrate live/held audit loops to the FIX-FIRST target —
    // the audit-every-iteration template made discovery (8-12/iter)
    // outpace fixes (1/iter) and allowed "no new action" iterations with
    // open boxes (field: hegemon iter 26 — the user watched it find and
    // present instead of fix). Target-only swap: the metric (closed
    // count/max) is unchanged, so best/stall stay.
    if (state.loop?.kind === "audit" && state.loop.target?.includes("Every iteration: (1) run a FRESH audit pass")) {
      state.loop = { ...state.loop, target: auditTarget() };
      persistState(ctx);
      appendLedger(ctx.cwd, "audit_loop_target_migrated", { from: "audit-every-iteration", to: "fix-first" });
    }
    // v0.34.15 compatibility: the legacy recovery marker and v0.34.16
    // rebind marker were consumed before the startup barrier above.
    if (isLoopActive()) {
      const l = state.loop!;
      if (autoResume || recoveryResume || rebindResume || handoffResume) {
        ctx.ui.notify(
          `Resuming loop (iteration ${l.iteration}/${l.maxIterations > 0 ? l.maxIterations : "∞"}, best ${l.bestValue ?? "n/a"}, stall ${l.stallCount}/${l.plateauWindow}): ${displaySlice(l.target, 60)}`,
          "info",
        );
        scheduleLoopTick(ctx);
      } else {
        state.loop = { ...l, active: false, stopReason: HELD_ON_RESTORE };
        persistState(ctx);
        ctx.ui.notify(
          `Loop held on restore: ${displaySlice(l.target, 60)} — /loop resume to continue, or enable Auto-resume in /glla settings for session-load recovery.`, 
          "info",
        );
      }
    } else if (state.goal && state.goal.status === "active" && state.goal.autoContinue) {
      const wasInterrupted = !!state.goal.interruptedAt;
      // v0.28.21: the 0.28.3 interrupted-goal exemption is SUPERSEDED —
      // the default is now hold-everything on session load (user directive:
      // "load it but not auto start it"). Interrupted goals hold like
      // everything else; autoresume=on (unattended rigs) still auto-resumes
      // them, and the marker is cleared only on that promised auto-resume.
      if (autoResume || recoveryResume || rebindResume || handoffResume) {
        // v0.28.1 (S2): clear the stale-handle interrupt marker — this IS
        // the auto-resume the marker promised.
        if (wasInterrupted) updateGoal({ interruptedAt: undefined, interruptedReason: undefined }, ctx);
        ctx.ui.notify(
          `Resuming ${state.goal.policy === "list" ? "list item" : "goal"}: ${displaySlice(state.goal.objective, 70)}${listQueue().length > 0 ? ` (+${listQueue().length} queued)` : ""}${wasInterrupted ? " — auto-resumed after the stale-handle interrupt" : ""}`,
          "info",
        );
        // v0.28.4 (P3): skip nudge accounting for the first recovery turns.
        postRestoreGraceTurns = 2;
        scheduleContinuation(ctx, true);
      } else {
        const queued = listQueue().length;
        // v0.22.7: name WHAT is held — a list head resumes through /list.
        const isListItem = state.goal.policy === "list";
        const resumeCmd = isListItem ? "/list resume" : "/goal resume";
        const resumeHint = `${resumeCmd} to continue${queued > 0 ? ` (+${queued} waiting in the list)` : ""} · enable Auto-resume in /glla settings for load-time recovery`;
        // v0.31.1: name the supersession — a held one-shot audit whose work a
        // live audit loop now owns reads as "stalled" for HOURS otherwise
        // (junk-runner: 8h21m of "held for explicit resume" on a goal the
        // loop had superseded). The widget surface must say so.
        const auditSuperseded =
          state.goal.objective.includes(GOAL_AUDIT_ONESHOT_MARKER) &&
          !!state.loop &&
          (state.loop.active || state.loop.stopReason === HELD_ON_RESTORE) &&
          !!state.loop.target?.includes(LOOP_AUDIT_MARKER);
        updateGoal({
          status: "paused",
          pauseKind: "blocked",
          pauseReason: auditSuperseded
            ? "restored on session load — SUPERSEDED by the audit loop in this session"
            : "restored on session load — held for explicit resume",
          pauseSuggestedAction: auditSuperseded
            ? `${activeGoalSurfaceCommand("cancel")} clears it (the loop already owns the audit) · ${resumeHint} if you disagree`
            : resumeHint,
        }, ctx);
        ctx.ui.notify(
          `${isListItem ? "List item" : "Goal"} held on restore: ${displaySlice(state.goal.objective, 70)}${queued > 0 ? ` (+${queued} waiting in the list)` : ""} — ${resumeCmd} to continue.`,
          "info",
        );
      }
    } else if (state.goal && state.goal.status === "active") {
      // Active but autoContinue off: nothing auto-fires — just surface it.
      ctx.ui.notify(
        `Restored ${state.goal.policy === "list" ? "list item" : "goal"}: ${displaySlice(state.goal.objective, 70)}${listQueue().length > 0 ? ` (+${listQueue().length} queued)` : ""}`,
        "info",
      );
    } else if ((!state.goal || state.goal.status === "complete" || state.goal.status === "aborted") && listQueue().length > 0) {
      if (autoResume) {
        // Session restarted with a non-empty queue but no active goal.
        activateNextListItem(ctx);
      } else {
        ctx.ui.notify(`List has ${listQueue().length} item(s) waiting — /list next to activate the head.`, "info");
      }
    }
    // v0.35.x: an interrupted stored completion claim is released from the
    // MAIN's auditing wait before any recovery policy is considered. A valid
    // handoff/rebind or global autoResume may then start one fresh attempt;
    // cold/manual sessions remain paused until /goal resume.
    if (state.goal?.status === "auditing" && state.goal.pendingCompletion) {
      markCompletionAuditRecoveryPending(ctx, `session_start:${startReason}`);
      const canRecoverNow = explicitRecovery || autoResume;
      const recoveredClaim = state.goal?.pendingCompletion;
      if (canRecoverNow && recoveredClaim) {
        completionAuditRecoveryArmed = true;
        void retryStoredCompletionAudit("session-recovery");
      } else {
        ctx.ui.notify(`Completion audit blocked — no verdict. The stored claim is safe; ${activeGoalSurfaceCommand("resume")} retries the isolated auditor.`, "warning");
      }
    }
    // v0.29.6: the 0.28.21 loop-vs-goal decision picker is SUPERSEDED by
    // auto-arbitration above — stacked states resolve deterministically
    // (most recent activity keeps the slot; the loser is archived) before
    // the restore gate, so a live loop and a live goal cannot coexist here.
    // Always paint on session load (v0.22.1): the branches above only reach
    // refreshUI via persistState, so a goal that was ALREADY paused (or any
    // state that doesn't mutate on load) rendered nothing — "can't tell if
    // it's on" is a bug. Painting unconditionally also clears/refreshes any
    // stale widget carried over from a previous in-process session.
    refreshUI(ctx);
  });

  pi.on("agent_end", async (event: any, ctx: ExtensionContext) => {
    // A late agent_end from the disposed session is not a fresh turn. Do not
    // account it, run length continuation, or schedule another send after a
    // stale terminal/handoff.
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) {
      // v0.34.25: pi's silent swap means the first live sign may be the
      // replacement session's own turn events. Absorb a file-backed host
      // successor — the absorb already scheduled the recovery continuation
      // from durable state, so this half-known turn is never also accounted.
      tryAbsorbHostSuccessor(ctx, "agent_end");
      return;
    }
    rememberCtx(ctx);
    // v0.23.8: a subagent finishing must not drive the main session's
    // continuation loop.
    if (isForeignCtx(ctx)) return;
    noteActivity(true);
    dispatchStartAcknowledged(ctx, "agent_end");
    lastStreamActivityAt = Date.now();
    streamActivityObserved = true;
    // v0.27.2: folded-in length-continue (standalone pi-length-continue is
    // deprecated). A response cut by the per-response output cap is NOT a
    // completed turn (no telemetry), NOT a stall (no no-tool nudge), and
    // must not run the loop measure or the normal goal continuation on half
    // a response — re-trigger immediately with split-smaller guidance and
    // skip ALL turn bookkeeping; the NEXT agent_end processes the run.
    // Works with no goal active (plain sessions truncate too).
    // v0.27.3: enrich lastA with text + priorText for the smarter nudge
    // accounting below.
    const assistants = (event.messages as any[]).filter((m: any) => m.role === "assistant");
    const rawLastA = assistants.length ? assistants[assistants.length - 1] : null;
    const rawPriorA = assistants.length >= 2 ? assistants[assistants.length - 2] : null;
    const extractText = (m: any): string => (m && Array.isArray(m.content)) ? m.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : "";
    const lastA = rawLastA ? { stopReason: rawLastA.stopReason, text: extractText(rawLastA), priorText: extractText(rawPriorA) } : null;
    // v0.34.19: pi-ai clamps max_tokens to the remaining context before the
    // provider call. At ~99% context that clamp can be 1 token, which the
    // provider reports as stopReason "length" — but this is NOT an overlong
    // assistant response. Extension agent_end runs BEFORE pi's own
    // auto-compaction check (agent-session.js _handlePostAgentRun), so sending
    // LENGTH_CONTINUE_TEXT here queues another 1-token request and delays the
    // real cure. Defer to pi compaction; session_compact's resume debt owns
    // the next continuation. Older pi/test doubles without getContextUsage()
    // fail open to the legacy true-length path.
    const contextUsage = (() => {
      try { return typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined; } catch { return undefined; }
    })();
    const contextStarvedLength = isContextStarvedLengthStop(rawLastA, contextUsage);
    const lc = tickLengthContinue(lastA?.stopReason === "length" && !contextStarvedLength);
    if (contextStarvedLength) {
      appendLedger(ctx.cwd, "length_continue_deferred_context_full", {
        outputTokens: rawLastA?.usage?.output,
        contextTokens: contextUsage?.tokens ?? null,
        contextWindow: contextUsage?.contextWindow ?? null,
        contextPercent: contextUsage?.percent ?? null,
      });
      ctx.ui.notify("glla: output-token stop was context starvation (tiny output at a nearly full context) — yielding to pi auto-compaction instead of re-sending.", "info");
      return;
    }
    if (lc.giveUpNow) {
      // v0.34.26: exhaustion is a DURABLE failure state, not a transient
      // notify. Pre-fix the goal stayed green-active while every heartbeat
      // re-kick silently truncated again (the tracker stays gaveUp, so no
      // fire, no state, no card) — an invisible infinite ping-pong.
      appendLedger(ctx.cwd, "length_continue_exhausted", { consecutive: lc.consecutive });
      ctx.ui.notify(`glla: response hit the output-token cap ${LENGTH_CONTINUE_MAX}× in a row — stepping aside. Ask the model to split the work into smaller pieces.`, "warning");
      if (state.goal && state.goal.status === "active") {
        notifyExternal(ctx, `Response truncated ${LENGTH_CONTINUE_MAX}× in a row — ${goalNoun()} paused; split the work, then ${activeGoalSurfaceCommand("resume")}.`);
        updateGoal({
          status: "paused",
          pauseKind: "error",
          pauseReason: `output-token limit — ${LENGTH_CONTINUE_MAX} responses in a row were truncated mid-artifact; auto-continue exhausted`,
          pauseSuggestedAction: `Re-scope the current artifact into smaller pieces (several smaller write/edit calls across turns instead of one giant response), then ${activeGoalSurfaceCommand("resume")} — the truncation budget restarts fresh.`,
        }, ctx);
        // The pause is the durable record; an explicit recovery gets a full
        // fresh truncation budget (otherwise the sticky gaveUp flag would
        // make the resumed turn silently dead on the first truncation).
        resetLengthContinue();
      } else if (state.loop?.active) {
        notifyExternal(ctx, `Response truncated ${LENGTH_CONTINUE_MAX}× in a row — loop stopped; /loop resume after re-scoping.`);
        state.loop.active = false;
        state.loop.stopReason = `output-token limit — ${LENGTH_CONTINUE_MAX} consecutive truncated responses (iteration ${state.loop.iteration} preserved; /loop resume after re-scoping the work into smaller pieces)`;
        persistState(ctx);
        appendLedger(ctx.cwd, "loop_stopped", { reason: state.loop.stopReason, iterations: state.loop.iteration, best: state.loop.bestValue });
        resetLengthContinue();
      } else {
        notifyExternal(ctx, "Response truncated 3× in a row — giving up auto-continue.");
      }
    }
    if (lastA?.stopReason === "length") {
      if (lc.fire && !ctx.hasPendingMessages()) sendLengthContinue(ctx, lc.consecutive);
      return;
    }
    if (await handleMainModelAgentEnd(ctx, rawLastA, lastA)) return;
    // v0.25.2: per-goal turn telemetry (/glla stats).
    if (state.goal && state.goal.status === "active") {
      const t = state.goal.telemetry ?? { turns: 0, fileWrites: 0, bashCalls: 0 };
      t.turns++;
      state.goal.telemetry = t;
    }
    if (!toolsRegistered) {
      registerAgentTools(pi);
      toolsRegistered = true;
    }
    ensureAgentToolsActive(pi, ctx);
    // v0.27.3: nudge accounting — substantive analytical turns (long, novel
    // text) reset the counter even with no tool calls. Polis-session
    // incident showed the tool-only check fired on real investigation work.
    if (isSupervising()) {
      if (postRestoreGraceTurns > 0) {
        // v0.28.4 (P3): the first turns after a session_start restore are
        // recovery chatter (orientation reads, plan narration) — counting
        // them toward the stall brake paused restored goals mid-recovery.
        postRestoreGraceTurns--;
        appendLedger(ctx.cwd, "post_restore_grace", { remaining: postRestoreGraceTurns });
      } else if (lastA?.stopReason === "error") {
        // v0.28.13 (endless-td 429 incident 2026-07-28): provider-error
        // turns (429 quota exhaustion, 5xx) are NOT model unproductivity —
        // the model never got a say. Counting them tripped the brake on a
        // healthy goal mid-CDP-capture (4 MiniMax-M3 429s → wrong
        // "unproductive turns" pause). pi's own retry owns the backoff;
        // the nudge counter neither increments nor resets on these turns.
        appendLedger(ctx.cwd, "stall_nudge_exempt_error", { nudgesSoFar: heartbeatNudges });
      } else if (lastA?.stopReason === "aborted") {
        // v0.29.4: user aborts are not model unproductivity either — the
        // user pressed Esc. Counting the interrupt tripped the stall brake
        // on the USER's action (pully field case: Esc-spam → STALL WARNING
        // 1/3, 2/3 → a bogus "stalled" pause). Neither increment nor reset.
        appendLedger(ctx.cwd, "stall_nudge_exempt_aborted", { nudgesSoFar: heartbeatNudges });
      } else {
      const s = loadSettings(ctx.cwd);
      const shortWordsThr = s.stallShortWords ?? DEFAULT_STALL_SHORT_WORDS;
      const simThr = s.stallSimilarityThreshold ?? DEFAULT_STALL_SIM_THRESHOLD;
      heartbeatNudges = accountTurnForNudgesRich(
        { toolCalls: toolCallsThisTurn, text: lastA?.text ?? "", priorText: lastA?.priorText ?? "", shortWords: shortWordsThr, simThreshold: simThr },
        heartbeatNudges,
      );
      if (heartbeatNudges >= HEARTBEAT_MAX_NUDGES) {
        heartbeatNudges = 0;
        if (isLoopActive()) {
          clearLoopTimer();
          state.loop = { ...state.loop!, active: false, stopReason: `stalled: ${HEARTBEAT_MAX_NUDGES} consecutive unproductive turns (no tools, short or repetitive)` };
          persistState(ctx);
          ctx.ui.notify(`Loop stopped: stalled (${HEARTBEAT_MAX_NUDGES} unproductive turns). /loop start to begin a new one.`, "warning");
          notifyExternal(ctx, "Loop stopped: stalled (no tool calls).");
          return;
        }
        if (state.goal) {
          updateGoal({
            status: "paused",
            pauseKind: "decision",
            pauseOptions: [`Retry — ${activeGoalSurfaceCommand("resume")}`, `Tweak the objective — ${activeGoalSurfaceCommand("tweak")} <new text>`, `Cancel the goal (${activeGoalSurfaceCommand("cancel")})`],
            pauseRecommended: 1,
            pauseReason: `stalled: ${HEARTBEAT_MAX_NUDGES} consecutive unproductive turns (no tools, short or repetitive)`,
            pauseSuggestedAction: `Inspect the goal — ${activeGoalSurfaceCommand("resume")} to retry, ${activeGoalSurfaceCommand("tweak")} to narrow it, ${activeGoalSurfaceCommand("cancel")} to abort.`,
          }, ctx);
          ctx.ui.notify(`${goalNoun()} paused: stalled (${HEARTBEAT_MAX_NUDGES} unproductive turns).`, "warning");
          maybeDecisionPopup(ctx);
          notifyExternal(ctx, "Goal paused: stalled (no tool calls).");
          return;
        }
      }
      // v0.28.4 (P1): graduated escalation — before the brake can fire,
      // tell the model exactly what closes the turn. A done-but-unclosed
      // goal gets "call complete_goal NOW", not a silent count. Replaces
      // this turn's normal continuation (the escalation IS the entry).
      if (heartbeatNudges >= 1 && state.goal && state.goal.status === "active" && !isLoopActive()) {
        toolCallsThisTurn = 0;
        sendStallEscalation(ctx, heartbeatNudges);
        return;
      }
      } // end post-restore grace else
    }
    toolCallsThisTurn = 0;
    // Loop 3 runs on the same heartbeat: measure after every agent turn.
    if (isLoopActive()) {
      clearLoopTimer();
      // v0.29.19: provider-error / user-abort turns are NOT iterations —
      // the model never got a say, so a dead turn carries no stall/stuck/
      // plateau signal (field 2026-07-31, MiniMax token-plan 429 storm:
      // hegemon false-plateau'd with 13 open findings, polis with 3+,
      // hellhunter stuck-stopped at iter 93 — every counted turn was a
      // dead 429 turn; the v0.28.13/v0.29.4 exemptions only covered the
      // goal nudge counter). Skip the measure and refire — bounded, so a
      // real outage stops the loop honestly instead of burning turns.
      const sr = lastA?.stopReason;
      if (sr === "error" || sr === "aborted") {
        const loop = state.loop!;
        loop.consecutiveErrors = (loop.consecutiveErrors ?? 0) + 1;
        persistState(ctx);
        appendLedger(ctx.cwd, "loop_turn_exempt_error", { stopReason: sr, consecutive: loop.consecutiveErrors, iteration: loop.iteration });
        const cap = sr === "aborted" ? LOOP_MAX_CONSECUTIVE_ABORTS : LOOP_MAX_CONSECUTIVE_ERRORS;
        if (loop.consecutiveErrors >= cap) {
          if (sr === "error" && lastMainModelFailure && lastMainModelFailure.kind !== "non-recoverable") {
            // v0.34.51: any provider failure parks into durable recovery, not
            // just quota — error text is not trusted to gate the envelope.
            parkMainModelAfterFailure(ctx, lastMainModelFailure);
            if (state.mainModelRecovery) return;
          }
          loop.active = false;
          loop.stopReason = sr === "aborted"
            ? `stopped by user — ${loop.consecutiveErrors} consecutive aborts (iteration ${loop.iteration} preserved; /loop resume to continue)`
            : `provider errors — ${loop.consecutiveErrors} consecutive error turns (iteration ${loop.iteration} preserved; /loop resume when the provider recovers)`;
          persistState(ctx);
          ctx.ui.notify(`Loop stopped: ${loop.stopReason}`, "warning");
          appendLedger(ctx.cwd, "loop_stopped", { reason: loop.stopReason, iterations: loop.iteration, best: loop.bestValue });
          notifyExternal(ctx, `Loop stopped: ${sr === "aborted" ? "user aborts" : "provider errors"} (${loop.consecutiveErrors}×)`);
          return;
        }
        scheduleLoopTick(ctx);
        return;
      }
      if ((state.loop!.consecutiveErrors ?? 0) > 0) state.loop!.consecutiveErrors = 0; // a real turn clears the streak (runLoopTick persists)
      await runLoopTick(ctx, event);
      return;
    }
    if (!state.goal) return;
    if (state.goal.status !== "active") return;
    clearContinuationTimer();

    const last = [...(event.messages as any[])].reverse().find((m) => m.role === "assistant");
    const text = last && Array.isArray(last.content) ? last.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : "";
    const stopReason = last?.stopReason;
    iterationCounter++;

    // Token accounting + cost guard: accumulate this turn's assistant tokens
    // (deduped — agent_end may replay seen messages). Crossing the goal's
    // token limit pauses it; raise Token limit in /glla settings.
    const newTokens = sumNewAssistantTokens(event.messages as unknown[], countedTokenMessages);
    if (newTokens > 0) {
      const used = (state.goal.usage?.tokensUsed ?? 0) + newTokens;
      const limit = state.goal.usage?.tokensLimit ?? DEFAULT_TOKEN_LIMIT;
      // v0.12.0: the guard is opt-in — limit 0/unset means never pause.
      if (limit > 0 && used > limit) {
        updateGoal({
          usage: { tokensUsed: used, tokensLimit: limit },
          status: "paused",
          pauseKind: "error",
          pauseReason: `token limit exceeded (${used.toLocaleString()} > ${limit.toLocaleString()})`,
          pauseSuggestedAction: `Raise Token limit in /glla settings (or set 0 to disable), then ${activeGoalSurfaceCommand("resume")}`,
        }, ctx);
        ctx.ui.notify(`${goalNoun()} paused: token limit exceeded (${used.toLocaleString()} > ${limit.toLocaleString()}). Raise Token limit in /glla settings, or set it to 0 to disable.`, "warning");
        notifyExternal(ctx, `Goal paused: token limit exceeded (${used} > ${limit}).`);
        return;
      }
      updateGoal({ usage: { tokensUsed: used, tokensLimit: limit } }, ctx);
    }

    if (stopReason === "error") {
      consecutiveErrorIterations++;
      consecutiveAbortIterations = 0;
      if (consecutiveErrorIterations >= 5) {
        // v0.28.5 (E8): carry the REAL error text — the pause used to say
        // literally "5 consecutive errors: error" (stopReason, not the
        // provider error). And give transient flakes ONE auto-resume per brake
        // (escalating cooldown, reason re-checked) — the E8 incident lost 1.5h to a
        // 60-second provider hiccup waiting on a manual /goal resume.
        const rawErrorText = [rawLastA?.errorMessage, text]
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .join(" — ");
        const detail = rawErrorText ? ` (last: ${rawErrorText.replace(/\s+/g, " ").slice(0, 160)})` : "";
        // v0.34.26: an output-token-limit rejection is NOT a generic provider
        // flake — the same prompt shape deterministically fails, so
        // "transient flake auto-resume" and "switch provider / wait out the
        // window" guidance are both wrong for it. Name the real wall.
        const outputLimitWall = /output[ -]?token|max_?tokens|length limit|output length|too many tokens/i.test(detail);
        const reason = outputLimitWall
          ? `output-token limit — the provider rejected ${consecutiveErrorIterations} overlong responses${detail}`
          : `5 consecutive errors${detail}`;
        // v0.34.15: the streak now lives ON THE GOAL so it survives the
        // auto-recovery /reloads that used to zero the module counter —
        // hegemon 2026-08-01: a hard-exhausted MiniMax plan churned 1-minute
        // probes for an hour because every reload reset the ladder to rung 1
        // and the 6-brake park (v0.29.9) could never engage.
        const brakeStreak = state.goal!.errorBrakeStreak ?? 0;
        // v0.34.15: a quota/rate-limit wall is NOT a flake — the card must
        // say "resuming won't help; switch /model or wait out the window"
        // (the raw 429 text was in `detail` but nobody parses JSON on a card).
        const quotaWall = /rate.?limit|usage limit|quota|insufficient|credits/i.test(detail);
        // v0.34.26: deterministic output-limit wall — durable error pause,
        // no flake ladder, no hourly probes. Only re-scoping the work helps.
        if (outputLimitWall) {
          updateGoal({
            status: "paused",
            pauseKind: "error",
            pauseReason: reason,
            errorBrakeStreak: brakeStreak + 1,
            pauseSuggestedAction: `Deterministic wall — the provider rejects this response shape every time, so blind retries never help. Re-scope the work into smaller pieces (several smaller write/edit calls across turns), then ${activeGoalSurfaceCommand("resume")}.`,
          }, ctx);
          ctx.ui.notify(`Goal paused: ${reason}. Re-scope into smaller pieces, then ${activeGoalSurfaceCommand("resume")}.`, "warning");
          notifyExternal(ctx, `Goal paused: ${reason}.`);
          appendLedger(ctx.cwd, "goal_paused", { reason });
          return;
        }
        // v0.29.1: brake-cycle CAP. The v0.28.25 ladder slows the thrash
        // (1m→16m) but never STOPS it — junk-runner/hellhunter/pully each
        // burned 4+ pause↔retry cycles against provider windows that last
        // hours. After 6 consecutive brakes: park. v0.29.9: the park keeps
        // probing at the top of each hour (clock-aligned window resets).
        if (brakeStreak >= 6) {
          // v0.29.9: park — but keep probing at the top of each hour
          // (user: "simply adding an hourly retry … just to pick up work
          // faster assuming the retry expired"). Coding-plan rate-limit
          // windows typically expire on clock-hour boundaries, so a probe
          // scheduled for :01 catches the reset within seconds. One dunk
          // per hour, free (429s are rejected pre-billing); a successful
          // probe resets the whole error cycle. If the wall is something
          // else (auth, outage), the hourly probe is a harmless failed
          // resume attempt that re-parks via the same brake.
          updateGoal({
            status: "paused",
            pauseKind: "error",
            pauseReason: `${reason} — 6 error-brakes in a row; the provider has been erroring for an extended window`,
            pauseSuggestedAction: quotaWall
              ? "Provider quota/rate-limit wall — resuming won't help until the window resets. Hourly top-of-hour probes will pick work back up; switch /model to a different provider to continue immediately."
              : `Probing at the top of each hour — rate-limit windows typically expire on clock-hour boundaries. ${activeGoalSurfaceCommand("resume")} retries now.`,
          }, ctx);
          ctx.ui.notify(`${goalNoun()} parked: ${reason} — 6 brakes in a row. ${quotaWall ? "Quota/rate-limit wall — switching /model continues immediately; otherwise hourly" : "Hourly"} top-of-hour probes will pick work back up when the window opens.`, "warning");
          notifyExternal(ctx, `${goalNoun()} parked: provider erroring across 6 error-brake cycles — hourly top-of-hour probes scheduled.`);
          appendLedger(ctx.cwd, "error_brake_capped", { streak: brakeStreak, reason });
          const probeMs = msUntilNextHourBoundary(Date.now());
          scheduleQuotaRetryForSession(ctx, probeMs / 1000, reason, (fresh) => {
            // Re-check: only probe if STILL parked by the error-brake cap —
            // a user pause/resume/cancel meanwhile is never stomped.
            if (state.goal && state.goal.status === "paused" && state.goal.pauseKind === "error"
              && (state.goal.pauseReason ?? "").includes("error-brakes in a row")) {
              appendLedger(fresh.cwd, "hourly_rate_probe", { goalId: state.goal.id, streak: state.goal.errorBrakeStreak ?? 0 });
              updateGoal({ status: "active" }, fresh);
              appendLedger(fresh.cwd, "goal_resumed", { via: "hourly-rate-probe" });
              fresh.ui.notify("Hourly probe: resuming (rate-limit windows typically expire at the top of the hour).", "info");
              scheduleContinuation(fresh, true);
            }
          }, "Hourly rate-limit probe");
          return;
        }
        // v0.28.25: the cooldown escalates per CONSECUTIVE brake — a fleet-wide
        // 403 window is not cleared by re-braking every 60 seconds.
        const cooldownMs = 60_000 * 2 ** Math.min(brakeStreak, 4);
        const cooldownMin = Math.round(cooldownMs / 60_000);
        updateGoal({
          status: "paused",
          pauseKind: "wait",
          pauseResumeAt: new Date(Date.now() + cooldownMs).toISOString(),
          pauseReason: reason,
          errorBrakeStreak: brakeStreak + 1,
          pauseSuggestedAction: quotaWall
            ? `Provider quota/rate-limit wall — resuming won't help until the window resets. Switch /model to a different provider to continue now, or let the probe auto-resume in ${cooldownMin}m.`
            : `Transient provider flake? The goal auto-resumes once in ${cooldownMin}m if still paused for this reason — or ${activeGoalSurfaceCommand("resume")} now.`,
        }, ctx);
        ctx.ui.notify(`Goal paused: ${reason}.${quotaWall ? " Quota/rate-limit wall — resuming won't help until the window resets; switch /model to continue now." : ""}`, "warning");
        notifyExternal(ctx, `Goal paused: ${reason}.`);
        appendLedger(ctx.cwd, "goal_paused", { reason });
        scheduleQuotaRetryForSession(ctx, cooldownMs / 1000, reason, (fresh) => {
          // Re-check: only auto-resume if STILL paused for the error brake
          // (a user /goal pause during the window is not stomped).
          if (state.goal && state.goal.status === "paused" && (state.goal.pauseReason ?? "").startsWith("5 consecutive errors")) {
            updateGoal({ status: "active" }, fresh);
            appendLedger(fresh.cwd, "goal_resumed", { via: "error-brake-retry" });
            fresh.ui.notify("Auto-resumed after the 5-error brake (cooldown elapsed).", "info");
            scheduleContinuation(fresh, true);
          }
        }, "5 consecutive errors — auto-retry");
        return;
      }
      // v0.28.25: under the brake, the retry rides the exponential ladder —
      // NOT the immediate scheduleContinuation at the bottom of this handler
      // (an errored turn leaves the session idle, so the default delay is 0:
      // exactly how 5 retries fired back-to-back in dracon-utilities).
      const retryDelayMs = ERROR_RETRY_LADDER_MS[Math.min(consecutiveErrorIterations - 1, ERROR_RETRY_LADDER_MS.length - 1)];
      appendLedger(ctx.cwd, "error_retry_backoff", { attempt: consecutiveErrorIterations, delayMs: retryDelayMs });
      scheduleContinuation(ctx, true, retryDelayMs);
      return;
    } else if (stopReason === "aborted") {
      // v0.28.5 (E8): user aborts are not provider errors. Separate brake,
      // honest message, and NO auto-resume — aborting five turns in a row
      // is the user telling the goal to stop; we stay stopped.
      consecutiveAbortIterations++;
      consecutiveErrorIterations = 0;
      if (consecutiveAbortIterations >= 5) {
        updateGoal({
          status: "paused",
          pauseKind: "blocked",
          pauseReason: "5 consecutive aborts (user interrupted)",
          pauseSuggestedAction: `You interrupted 5 turns in a row — the goal stays paused until you ${activeGoalSurfaceCommand("resume")} (or ${activeGoalSurfaceCommand("cancel")}).`,
        }, ctx);
        ctx.ui.notify("Goal paused: 5 consecutive aborts (user interrupted).", "warning");
        appendLedger(ctx.cwd, "goal_paused", { reason: "5 consecutive aborts (user interrupted)" });
        return;
      }
      // v0.29.4: an abort stands the chain DOWN — no auto re-fire. The old
      // fall-through re-fired the continuation immediately, so every Esc
      // was answered by another turn under the user's hands ("it auto
      // triggered and I kept spamming esc on it" — pully, 2026-07-30).
      ctx.ui.notify(`${goalNoun()} standing down — turn aborted by user (not counted toward stalls). ${activeGoalSurfaceCommand("resume")} to continue, ${activeGoalSurfaceCommand("cancel")} to stop.`, "info");
      abortedStandDown = true; // v0.29.5: heartbeat/compaction refires must not resurrect the chain
      appendLedger(ctx.cwd, "abort_stand_down", { consecutiveAborts: consecutiveAbortIterations });
      return;
    } else {
      consecutiveErrorIterations = 0;
      consecutiveAbortIterations = 0;
      // v0.28.25/v0.34.15: a healthy turn clears the (now persisted) brake streak
      if ((state.goal?.errorBrakeStreak ?? 0) > 0) updateGoal({ errorBrakeStreak: undefined }, ctx);
    }

    // No wall-clock cap by design: a goal ends via completion, explicit
    // pause/cancel, the stall watchdog, the 5-consecutive-errors pause, or
    // the token guard — never via an elapsed-time cutoff.

    // v0.34.12: NOT immediately — agent_end is the blackhole boundary.
    scheduleContinuation(ctx, false, EAGER_CONTINUATION_SETTLE_MS);
  });

  // A model switch can happen on an agent_end before pi's core decides
  // whether its own retry budget will continue. If that budget is disabled
  // or already exhausted, settled is the safe point for exactly one fresh
  // supervised continuation — never queue it while the old run is alive.
  pi.on("agent_settled", async (_event: any, ctx: ExtensionContext) => {
    if (tryAbsorbHostSuccessor(ctx, "agent_settled")) return;
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown || isForeignCtx(ctx)) return;
    if (!state.mainModelRecovery || state.mainModelRecovery.retryAt || !lastMainModelFailure) return;
    if (!isSupervising()) return;
    lastMainModelFailure = null;
    appendLedger(ctx.cwd, "main_model_failover_continuation", { model: modelRef(ctx.model) });
    if (isLoopActive()) scheduleLoopTick(ctx);
    else if (isActionableGoal()) scheduleContinuation(ctx, true, EAGER_CONTINUATION_SETTLE_MS);
  });

  pi.on("tool_call", (event: any, ctx: ExtensionContext) => {
    // v0.34.27: ordinary tool activity can be the first observable event
    // after pi replaces a host without session_start. A file-backed,
    // same-workspace successor is absorbed; an in-memory worker is refused.
    if (tryAbsorbHostSuccessor(ctx, "tool_call")) return;
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown || isForeignCtx(ctx)) return;
    toolCallsThisTurn++;
    noteActivity(true);
    lastStreamActivityAt = Date.now();
    streamActivityObserved = true;
    noteToolCall(event); // v0.33.0
    // v0.24.0: count loop-iteration tool calls (narration-only detection).
    if (isLoopActive()) {
      state.loop!.toolsThisTurn = (state.loop!.toolsThisTurn ?? 0) + 1;
    }
  });

  // v0.29.16: stream liveness for the zombie-run watchdog — deltas, run
  // starts, and turn starts all prove the provider stream is alive.
  // v0.34.24: before_agent_start is the strongest dispatch proof because
  // pi exposes the follow-up prompt itself. The low-level start events below
  // remain compatibility proofs for older pi builds and for custom messages.
  pi.on("before_agent_start", (event: any, ctx: ExtensionContext) => {
    // v0.34.27: absorb before the stale/foreign gates. This is the strongest
    // replacement contact because pi exposes the prompt itself.
    if (tryAbsorbHostSuccessor(ctx, "before_agent_start")) return;
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown || isForeignCtx(ctx)) return;
    // v0.34.57: turn-boundary model drift (bug #1.14) — the session is about
    // to run a turn on a model different from the last observed one. Ledger
    // only: the turn already started, there is nothing to block.
    observeTurnBoundaryModel(ctx);
    dispatchStartAcknowledged(ctx, "before_agent_start", event?.prompt);
  });
  pi.on("model_select", async (event: any, ctx: ExtensionContext) => {
    if (tryAbsorbHostSuccessor(ctx, "model_select")) return;
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown || isForeignCtx(ctx)) return;
    // v0.34.57: model-switch ledger + forbidden-model gate (bug #1.14) —
    // runs for EVERY model change (user set/cycle/restore AND the plugin's
    // own recovery rotation). The recovery-cancel block below stays scoped
    // to user-driven selections exactly as before.
    const from = modelRef(event?.previousModel);
    const to = modelRef(event?.model);
    const source = typeof event?.source === "string" ? event.source : undefined;
    const reason = mainModelSwitchInFlight ? "recovery" : source === "restore" ? "restore" : source === "cycle" ? "cycle" : "manual";
    const blocked = observeModelChange(ctx, from, to, reason, source);
    if (blocked && event?.previousModel) {
      // The forbidden gate wants the selection undone. Revert to the
      // previous model — the resulting model_select is a plain switch
      // back and is ledgered normally.
      try {
        const reverted = await extensionApi?.setModel(event.previousModel);
        if (reverted) {
          ctx.ui.notify(`Forbidden model ${to} was blocked by the glla policy gate (forbiddenModels) and reverted to ${from}.`, "warning");
        } else {
          ctx.ui.notify(`Forbidden model ${to} selected — the glla policy gate blocks it, but pi did not accept the revert. Switch away manually.`, "warning");
        }
      } catch {
        // The violation is already ledgered; the session keeps the model.
      }
    }
    if (mainModelSwitchInFlight || !state.mainModelRecovery) return;
    clearMainModelRecoveryTimer();
    state.mainModelRecovery = undefined;
    continuationDispatchStoodDown = false;
    appendLedger(ctx.cwd, "main_model_recovery_cancelled", { via: "manual-model-select", model: modelRef(ctx.model) });
    persistState(ctx);
    ctx.ui.notify("Manual model selection cancelled the automatic main-model recovery cycle. Resume the goal when ready.", "info");
  });

  pi.on("message_update", (_event: any, ctx: ExtensionContext) => {
    if (tryAbsorbHostSuccessor(ctx, "message_update")) return;
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown || isForeignCtx(ctx)) return;
    lastStreamActivityAt = Date.now();
    streamActivityObserved = true;
    dispatchStartAcknowledged(ctx, "message_update");
  });
  pi.on("agent_start", (_event: any, ctx: ExtensionContext) => {
    if (tryAbsorbHostSuccessor(ctx, "agent_start")) return;
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown || isForeignCtx(ctx)) return;
    lastStreamActivityAt = Date.now();
    streamActivityObserved = true;
    // v0.32.1: a real turn started — the post-compaction resume debt is
    // discharged (the heartbeat stops retrying it).
    postCompactResumeOwed = false;
    dispatchStartAcknowledged(ctx, "agent_start");
  });
  pi.on("turn_start", (_event: any, ctx: ExtensionContext) => {
    if (tryAbsorbHostSuccessor(ctx, "turn_start")) return;
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown || isForeignCtx(ctx)) return;
    lastStreamActivityAt = Date.now();
    streamActivityObserved = true;
    dispatchStartAcknowledged(ctx, "turn_start");
  });
}
