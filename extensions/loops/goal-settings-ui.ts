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
import {
  MultiModelPickerComponent,
  type MultiModelPickerResult,
} from "../multi-model-picker.js";
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

type AuditorModelCandidate = any;

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
  // v0.34.80: `custom` is a function in EVERY pi 0.84.1 mode — RPC/noOp
  // resolve `undefined` without invoking the builder. Detect availability by
  // whether the factory RAN; a settled stub falls through to the flat-row
  // select (the host-dialog path in RPC mode).
  if (typeof (ctx.ui as { custom?: unknown }).custom === "function") {
    let factoryInvoked = false;
    try {
      const v = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
        factoryInvoked = true;
        return new SettingsMenuComponent({ rows, title, initialSection }, () => tui.requestRender(), theme, keybindings, done);
      });
      if (factoryInvoked) return v;
      appendLedger(ctx.cwd, "settings_menu_fallback_select", { via: "custom-stub" });
    } catch {
      // a non-stale custom failure degrades to the legacy select path
    }
  }
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

/** Multi-select counterpart to promptModelRef: returns an ordered string[] of
 * provider/model refs (selection order = toggle order), or undefined on Esc.
 * Falls back to a free-form comma-separated input when ctx.ui.custom /
 * ctx.modelRegistry are unavailable (headless tests).
 *
 * v0.34.118: `opts.excludeRefs` filters out a set of refs from the picker
 * (typical use: when picking backups, exclude the user's forbidden models;
 * when picking forbidden models, exclude current backups — the two lists
 * are mutually exclusive by design). Stale initial refs that are no
 * longer available/allowed are not shown as selectable; opening the picker
 * itself does not rewrite the setting, and only currently visible/allowed
 * refs are persisted when the user confirms. */
async function promptModelRefs(
  ctx: ExtensionContext,
  title: string,
  initialRefs: string[],
  opts: { excludeRefs?: string[] } = {},
): Promise<string[] | undefined> {
  const exclude = new Set(opts.excludeRefs ?? []);
  if (typeof (ctx.ui as { custom?: unknown }).custom !== "function" || !ctx.modelRegistry) {
    const v = await ctx.ui.input(title, initialRefs.length ? initialRefs.join(",") : "provider/model-a,provider/model-b");
    if (v === undefined) return undefined;
    // Enforce the same mutual exclusion in headless/free-form mode as in
    // the TUI picker; a typed forbidden ref must not sneak into a backup
    // chain (and a typed backup must not be added to forbiddenModels).
    return normalizeModelRefs(v).filter((ref) => !exclude.has(ref));
  }
  const sessionModel = ctx.model as any;
  const sessionLabel = sessionModel ? `${sessionModel.provider}/${sessionModel.id}` : "pi session model";
  const models = ctx.modelRegistry
    .getAvailable()
    .filter((m: any) => ctx.modelRegistry.hasConfiguredAuth(m));
  const items = buildModelPickItems(models, sessionLabel, {
    excludeRefs: [...exclude],
    // Ordered backup/forbidden lists contain refs, not overrides; showing
    // session/manual rows here was confusing because MultiModelPicker treats
    // both as no-op rows. Keep those rows for single-value ModelPicker only.
    includeSessionRow: false,
    includeManualRow: false,
  });
  const pick = await ctx.ui.custom<MultiModelPickerResult>((tui, theme, keybindings, done) => {
    return new MultiModelPickerComponent({ title, items, initialSelected: initialRefs }, () => tui.requestRender(), theme, keybindings, done);
  });
  if (pick === undefined) return undefined;
  return pick;
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
    case "visionAssist": {
      const v = await ctx.ui.select("Vision assist — when the agent can't see, route the check to the mmx vision CLI instead of switching models (preapproval gate: forbiddenModels)", [
        "on — continuation prompts carry the VISION-ASSIST directive; seeing = mmx vision, switches stay preapproved-only (default)",
        "off — no vision guidance injected; the forbiddenModels gate still blocks forbidden switches",
      ]);
      if (v) {
        saveSettings("global", ctx.cwd, { visionAssist: v.startsWith("off") ? false : undefined });
        ctx.ui.notify(v.startsWith("off") ? "Vision assist OFF — no mmx routing guidance; the model-switch gate still stands." : "Vision assist ON — 'can't see' checks route to mmx vision, switches stay preapproved-only.", "info");
      }
      return;
    }
    case "mainModelFallbacks": {
      const current = normalizeModelRefs(loadGlobalSettings().mainModelFallbacks);
      // v0.34.118: forbidden models cannot be valid backups, so hide them.
      const forbidden = normalizeModelRefs(loadGlobalSettings().forbiddenModels);
      const refs = await promptModelRefs(
        ctx,
        "Main session model backups — ordered (space to toggle, enter/tab to confirm); forbidden models hidden",
        current,
        { excludeRefs: forbidden },
      );
      if (refs === undefined) return;
      saveSettings("global", ctx.cwd, { mainModelFallbacks: refs });
      ctx.ui.notify(refs.length ? `Main model backups saved in order: ${refs.join(" → ")}` : "Main model backups cleared — quota recovery will keep probing the current model.", "info");
      return;
    }
    case "auditorSilent": {
      const v = await ctx.ui.select("Silent auditor stream — how the auditor's report text renders in the widget while the detached worker streams", [
        "on — final-only: the text appears once the verdict lands, never word-by-word (default)",
        "off — live tail: show the streamed report lines as they arrive",
      ]);
      if (v) {
        saveSettings("global", ctx.cwd, { auditorSilent: v.startsWith("off") ? false : undefined });
        ctx.ui.notify(v.startsWith("off") ? "Auditor stream LIVE — report lines show as they stream." : "Auditor stream SILENT — final text at the verdict.", "info");
      }
      return;
    }
    case "auditorProgressSignals": {
      const v = await ctx.ui.select("Auditor progress signals — intermediate evidence shown during silent audits (phase label + report byte-counter)", [
        "on — phase label (reading source… / writing report…) + report byte-counter (default)",
        "off — plain timer-only card, no intermediate signals",
      ]);
      if (v) {
        saveSettings("global", ctx.cwd, { auditorProgressSignals: v.startsWith("off") ? false : undefined });
        ctx.ui.notify(v.startsWith("off") ? "Auditor progress signals OFF — silent card shows only the timer." : "Auditor progress signals ON — phase + byte-counter visible during audits.", "info");
      }
      return;
    }
    case "hourlyQuotaProbe": {
      const v = await ctx.ui.select("Hourly quota probe ticker — extra recovery probe at :00:30 every hour while main-model recovery is parked (quota windows tend to refresh at the top of the hour; the ticker gives faster pickup without spamming chat)", [
        "on — fire an extra probe at :00:30 every hour while parked (default)",
        "off — rely on the normal retry cadence only (5s eager + hour-aligned attempts 2+)",
      ]);
      if (v) {
        saveSettings("global", ctx.cwd, { hourlyQuotaProbe: v.startsWith("off") ? false : undefined });
        ctx.ui.notify(v.startsWith("off") ? "Hourly quota probe OFF — only the normal retry cadence will run." : "Hourly quota probe ON — extra :00:30 probe while parked.", "info");
      }
      return;
    }
    case "forbiddenModels": {
      const current = normalizeModelRefs(loadGlobalSettings().forbiddenModels);
      // v0.34.118: a current backup cannot simultaneously be forbidden.
      // Include both the main chain and any glla-managed subagent chains.
      const global = loadGlobalSettings();
      const backups = [
        ...normalizeModelRefs(global.mainModelFallbacks),
        ...Object.values(global.subagentFallbacks ?? {}).flatMap((chain) => normalizeModelRefs(chain)),
      ];
      const refs = await promptModelRefs(
        ctx,
        "Forbidden models — every ref here is ledgered as forbidden_model_switch on a switch attempt (space to toggle, enter/tab to confirm); current backups hidden",
        current,
        { excludeRefs: backups },
      );
      if (refs === undefined) return;
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
    case "subagentFallbacks:Explore":
    case "subagentFallbacks:Plan":
    case "subagentFallbacks:general-purpose": {
      const agentType = id.slice("subagentFallbacks:".length);
      const settings = loadSettings(ctx.cwd);
      const current = settings.subagentFallbacks?.[agentType] ?? [];
      const refs = await promptModelRefs(ctx, `${agentType} fallback chain — ordered, the FIRST eligible ref is written as the override (space to toggle, enter/tab to confirm); forbidden models hidden`, current, { excludeRefs: normalizeModelRefs(loadGlobalSettings().forbiddenModels) });
      if (refs === undefined) return;
      const next = { ...(settings.subagentFallbacks ?? {}) };
      if (refs.length > 0) next[agentType] = refs;
      else delete next[agentType];
      saveSettings("global", ctx.cwd, { subagentFallbacks: Object.keys(next).length > 0 ? next : undefined });
      ctx.ui.notify(refs.length ? `${agentType} fallback chain saved: ${refs.join(" → ")} — applies to NEW pi sessions.` : `${agentType} fallback chain cleared — falls through to the legacy pin / strategy.`, "info");
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
    // v0.34.72 (note.md 2026-08-07): the too-eager-switch symptom — the
    // agent reached for an expensive model. With vision assist on, record
    // the routing alternative: seeing is an mmx vision CLI job. Advisory,
    // not a claim about the switch's motive.
    if (settings.visionAssist !== false) {
      const vr = routeVisionCheck({ targetModelRef: to, forbiddenModels: settings.forbiddenModels });
      appendLedger(ctx.cwd, "vision_assist", {
        ...visionAssistLedger(vr, { targetModelRef: to }),
        reason: "forbidden_model_switch",
      });
    }
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


/* Runtime globals: preserve the old monolith lexical links across extracted modules. */
defineGoalRuntimeGlobal("auditorThinkingLevels", { get: () => auditorThinkingLevels });
defineGoalRuntimeGlobal("resolveAuditorModel", { get: () => resolveAuditorModel });
defineGoalRuntimeGlobal("openSettingsUI", { get: () => openSettingsUI });
defineGoalRuntimeGlobal("promptSettingsMenu", { get: () => promptSettingsMenu });
defineGoalRuntimeGlobal("promptModelRef", { get: () => promptModelRef });
defineGoalRuntimeGlobal("promptModelRefs", { get: () => promptModelRefs });
defineGoalRuntimeGlobal("handleSettingChoice", { get: () => handleSettingChoice });
defineGoalRuntimeGlobal("observeModelChange", { get: () => observeModelChange });
defineGoalRuntimeGlobal("observeTurnBoundaryModel", { get: () => observeTurnBoundaryModel });
