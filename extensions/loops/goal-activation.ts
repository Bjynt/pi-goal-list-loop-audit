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
  resolveSubagentOverrideRef,
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
  recoverFromContextOverflow,
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

export function registerGoalRuntime(pi: ExtensionAPI): void {
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
    setContinuationRearmStreak(0); setContinuationRearmSince(0);
    loopRearmStreak = 0; loopRearmSince = 0;
    compactionGraceUntil = Date.now() + COMPACTION_GRACE_MS;
    lastCompactionAt = Date.now();
    // v0.34.97: persist lastCompactionAt to state so the ⏳ compacting…
    // chip survives a reload. Without this, the chip vanishes on reload
    // and the user thinks the compaction didn't happen
    // (Screenshot_20260808_003007/003024 ai-auto-writer 222,368 tokens).
    replaceState({ ...state, lastCompactionAt });
    persistState(ctx);
    // v0.34.97: surface the compaction to the user. Field evidence
    // (Screenshot_20260808_003007/003024 ai-auto-writer): a 222,368-token
    // compaction happened but the user only saw "[compaction]" on RELOAD —
    // the session_compact event fired in-process but no UI surface told
    // the user what just happened. A brief info notification on the
    // session_compact event itself makes the compaction visible
    // immediately. The widget's status line below also paints a
    // ⏳ compacting… chip while compactionGraceUntil is in the future
    // (see buildStatusText compaction check).
    try {
      ctx.ui.notify(`glla: session compacting — stall counter reset, grace timer started. The widget will show ⏳ compacting… for the next 3 minutes.`, "info");
    } catch {
      /* stale ctx best-effort */
    }
    // v0.34.82: a real compaction landed — clear the starvation refuse
    // gate. The agent_end yield path will resume deferring on the next
    // near-full length stop, and the heartbeat can refire again.
    onCompactionLanded();
    // v0.32.1: arm the resume debt + the resync block (the settle probes
    // below stay as the fast path; the heartbeat now retries the debt on
    // EVERY post-grace tick until agent_start discharges it).
    postCompactResumeOwed = true;
    postCompactResyncPending = true;
    scheduleSessionTimeout(() => {
      const c = freshCtx();
      if (!c) return;
      try {
        if (c.isIdle() && !c.hasPendingMessages() && !continuationTimerPending() && !loopTimerPending() && isSupervising() && !abortedStandDown) {
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
        if (c.isIdle() && !c.hasPendingMessages() && !continuationTimerPending() && !loopTimerPending() && isSupervising() && !abortedStandDown) {
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
    // v0.34.63: quit → fresh pi → blank startup (load barrier pending) →
    // resume. pi delivers the resumed session with a NEW SessionManager
    // object, so identity (and possibly file-backed) checks fail and the
    // resume was silently DROPPED — the goal stayed parked forever with a
    // dead countdown (dracon-platform 2026-08-07: wall at 01:18, probe at
    // 01:33 never ran). While this process is waiting on the load barrier,
    // a lifecycle start from the same workspace carrying the same session
    // identity IS that load completing — accept it before the gate.
    const barrierAwaitingLoadedSession = initialSessionLoadPending && lifecycleSignal;
    const resumeCompletesLoad = barrierAwaitingLoadedSession
      && (ownerCwd == null || ctx.cwd === ownerCwd)
      && sameSessionIdentity(ctx.sessionManager, recordedOwner);
    if (foreignRecordedSession && !hostLifecycleStart && !resumeCompletesLoad) return;
    // v0.34.73 (OPEN-ISSUES 1.12): capture the pre-rebind invalidation flags
    // BEFORE the block below clears them — the id_invalidation reason needs
    // to know which mechanism invalidated the old handle.
    const invalidationFlags = {
      staleTerminal: staleTerminalDone,
      zombieStoodDown,
      extensionApiStale,
      rebindWithoutShutdown: hostLifecycleStart && ownerSession !== null && ctx.sessionManager !== ownerSession,
    };
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
    heartbeatStaleStreak = 0;
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
    replaceState(readState(ctx.cwd));
    // v0.34.68 (bug 1.7): heal a corrupted in-memory policy BEFORE the
    // restore gate below persists state — otherwise the hold/auto-resume
    // would rewrite the durable goal .md with the corrupted policy and
    // destroy the only source the gate heal can re-parse.
    healGoalPolicy(ctx);
    clearMainModelRecoveryTimer();
    mainModelAbortForRecovery = false;
    lastMainModelFailure = null;
    setContinuationDispatchStoodDownRef(false);
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
    // v0.34.115: when subagentFallbacks[name] is set for an agent, the
    // first eligible ref in the chain is written as the override model; the
    // per-type pin (s.subagentModelOverrides[name]) still wins when the
    // chain is empty (legacy behavior unchanged).
    try {
      const s = loadSettings(ctx.cwd);
      const isForbidden = (ref: string) => isForbiddenModel(ref, s.forbiddenModels);
      const resolve = (ref: string): unknown => {
        const parts = (() => { const idx = ref.indexOf("/"); return idx > 0 ? { provider: ref.slice(0, idx), id: ref.slice(idx + 1) } : undefined; })();
        if (!parts) return undefined;
        try { return (ctx.modelRegistry as any)?.find?.(parts.provider, parts.id); } catch { return undefined; }
      };
      const fallbackOverrides: Record<string, string> = {};
      if (s.subagentFallbacks) {
        for (const [name, chain] of Object.entries(s.subagentFallbacks)) {
          const picked = resolveSubagentOverrideRef(name, chain, resolve, isForbidden);
          if (picked) fallbackOverrides[name] = picked;
        }
      }
      const mergedOverrides = { ...(s.subagentModelOverrides ?? {}), ...fallbackOverrides };
      const sync = syncSubagentModelOverrides({
        agentDir: defaultAgentDir(),
        strategy: s.subagentModelStrategy ?? "inherit-parent",
        overrides: mergedOverrides,
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
    // v0.34.73 (OPEN-ISSUES 1.12): forced rewrite/handoff — the previous
    // owner recorded a different session id in the owner sidecar (or the
    // recorded in-memory owner was invalidated). Record the old/new id pair
    // and the mechanism so active.jsonl history can repro the invalidation.
    const oldOwnerId = ownerClaim.previousOwnerSessionId ?? (recordedOwner ? sessionIdOf(recordedOwner) : null);
    emitIdInvalidation(ctx, oldOwnerId, sessionManagerId(ctx), classifyIdInvalidationReason({
      staleTerminal: invalidationFlags.staleTerminal,
      zombieStoodDown: invalidationFlags.zombieStoodDown,
      extensionApiStale: invalidationFlags.extensionApiStale,
      rebindWithoutShutdown: invalidationFlags.rebindWithoutShutdown,
      hadShutdown: ownerClaim.hadShutdown,
      previousPid: ownerClaim.previousPid,
    }), ownerClaim.previousShutdownReason);
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
      const recoveryResumeCmd = recoverySurfaceCommand(mainRecovery.kind, "resume");
      ctx.ui.notify(`Main-model recovery stopped automatic probes — the work is safe; ${recoveryResumeCmd} starts a fresh bounded window after you check the provider.`, "warning");
    } else if (mainRecovery?.retryAt) {
      const retryAtMs = Date.parse(mainRecovery.retryAt);
      const recoveryConsent = autoResume || explicitRecovery;
      if (recoveryConsent) {
        const delay = Number.isFinite(retryAtMs) ? Math.max(0, retryAtMs - Date.now()) : 0;
        ctx.ui.notify(`Restored main-model recovery (${mainRecovery.kind}) — ${delay > 0 ? `next probe in ${Math.max(1, Math.ceil(delay / 60_000))}m` : "probe is due now"}.`, "info");
        if (delay > 0) scheduleMainModelRecoveryTimer(ctx, delay);
        else void probeMainModelRecovery(ctx);
        // v0.34.92: re-arm the hourly probe ticker on session_start if the
        // session is still parked — the timer died with the old session.
        scheduleHourlyProbe(ctx);
      } else {
        const recoveryResumeCmd = recoverySurfaceCommand(mainRecovery.kind, "resume");
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
      const quotaResumeCmd = activeGoalSurfaceCommand("resume");
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
        const resumeCmd = activeGoalSurfaceCommand("resume");
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
      const starved = noteContextStarvedYield();
      appendLedger(ctx.cwd, "length_continue_deferred_context_full", {
        outputTokens: rawLastA?.usage?.output,
        contextTokens: contextUsage?.tokens ?? null,
        contextWindow: contextUsage?.contextWindow ?? null,
        contextPercent: contextUsage?.percent ?? null,
        starvedStreak: starved.streak,
      });
      // v0.34.116: when pi already tried to compact within the last 90s
      // (the COMPACTION_GRACE_MS window) and the prompt STILL does not fit,
      // the model is too small for the prompt — not the prompt too big for
      // any model. Walk the fallback chain to a larger-context ref so the
      // next turn can land. Without this, the user sees "Context overflow
      // recovery FAILED after one compact-and-retry attempt" with no
      // automated recourse (Screenshot_20260808_192604 hegemion).
      const sinceLastCompactMs = state.lastCompactionAt ? Date.now() - state.lastCompactionAt : Number.POSITIVE_INFINITY;
      if (sinceLastCompactMs < COMPACTION_GRACE_MS && mainModelFallbackRefs(ctx).length > 0) {
        const overflowMessage = `output-token stop at ${contextUsage?.percent?.toFixed(1) ?? "near-full"}% after recent compaction — model is too small for the prompt; walking fallback chain`;
        const switched = await recoverFromContextOverflow(ctx, overflowMessage);
        if (switched) {
          ctx.ui.notify("glla: rotated to a larger-context backup model. The next turn will retry on the new model.", "info");
          return;
        }
      }
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
          scheduleQuotaRetryForSession(ctx, probeMs / 1000, reason, (fresh: ExtensionContext) => {
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
        scheduleQuotaRetryForSession(ctx, cooldownMs / 1000, reason, (fresh: ExtensionContext) => {
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
    setContinuationDispatchStoodDownRef(false);
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

  // v0.34.71 — subagent_session ledger (OPEN-ISSUES 1.16: "Subagents lost
  // between restarts"): pi-subagents broadcasts a cross-extension lifecycle
  // event (pi.events) when an Agent-tool subagent transitions to running —
  // once per spawn, foreground AND background, payload { id, type,
  // description }. Ledger the spawn (session id + summary) so the parent
  // can recover the reference after a /reload: the ledger lives on disk in
  // .pi-glla/active.jsonl and survives restarts, unlike the in-process
  // agent registry. Queued/repeating observations (resume, re-run) append
  // again — fresh evidence the reference is alive.
  pi.events.on("subagents:started", (data: unknown) => {
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) return;
    const ctx = freshCtx();
    if (!ctx) return;
    const e = (data ?? {}) as { id?: unknown; type?: unknown; description?: unknown };
    const sessionId = typeof e.id === "string" && e.id.length > 0 ? e.id : undefined;
    if (!sessionId) return;
    appendLedger(ctx.cwd, "subagent_session", {
      sessionId,
      agentType: typeof e.type === "string" ? e.type : undefined,
      summary: typeof e.description === "string" ? e.description : undefined,
      goalId: state.goal?.status === "active" ? state.goal.id : undefined,
      at: nowIso(),
    });
    // v0.34.85: seed the hang-watchdog probe (spawn = baseline evidence).
    upsertSubagentHangProbe(sessionId, typeof e.type === "string" ? e.type : undefined, typeof e.description === "string" ? e.description : undefined);
  });

  // v0.34.85 — subagent hang watchdog inputs. Progress evidence (compacted =
  // the session survived a compaction → alive and working; steered = a steer
  // landed) refreshes the probe's streak; terminal events (completed/failed)
  // stop the watch. The watchdog scan itself lives in heartbeatTick.
  pi.events.on("subagents:compacted", (data: unknown) => {
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) return;
    if (!freshCtx()) return;
    const e = (data ?? {}) as { id?: unknown };
    const recordId = typeof e.id === "string" && e.id.length > 0 ? e.id : undefined;
    if (recordId) markSubagentHangProgress(recordId);
  });
  pi.events.on("subagents:steered", (data: unknown) => {
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) return;
    if (!freshCtx()) return;
    const e = (data ?? {}) as { id?: unknown };
    const recordId = typeof e.id === "string" && e.id.length > 0 ? e.id : undefined;
    if (recordId) markSubagentHangProgress(recordId);
  });
  pi.events.on("subagents:completed", (data: unknown) => {
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) return;
    if (!freshCtx()) return;
    const e = (data ?? {}) as { id?: unknown };
    const recordId = typeof e.id === "string" && e.id.length > 0 ? e.id : undefined;
    if (recordId) endSubagentHangProbe(recordId);
  });
  pi.events.on("subagents:failed", (data: unknown) => {
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) return;
    if (!freshCtx()) return;
    const e = (data ?? {}) as { id?: unknown };
    const recordId = typeof e.id === "string" && e.id.length > 0 ? e.id : undefined;
    if (recordId) endSubagentHangProbe(recordId);
  });
}
